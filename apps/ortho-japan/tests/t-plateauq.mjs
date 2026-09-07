// PLQ（plateauq.js）の往復検定＝Node 単体。合成メッシュ（iota/explicit 両レイアウト）＋ --real で港区の実バッチ
// （ネットワーク・Draco＝draco3d 注入）を焼いて量子化誤差・index/LOD/mask の不変・gzip 後サイズを数字で見る。
//   node tests/t-plateauq.mjs          合成のみ（数十ms）
//   node tests/t-plateauq.mjs --real   実バッチ込み（数秒・要ネット）
import { packPLQ, unpackPLQ, headPLQ, weldMesh, extrudePrisms, enuBasis, PRISM_Q, bakeSlug, PLQ_VER } from "../plateauq.js";
import { existsSync, readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

let fail = 0;
const ok = (name, cond, extra = "") => { console.log(`${cond ? "ok " : "NG "} ${name}${extra ? "  " + extra : ""}`); if (!cond) fail++; };
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// 合成：nt 三角形。iota＝頂点非共有（PLATEAU 型）／shared＝正方格子の共有頂点（3DBAG 型）
function synth(nt, shared, seed = 1) {
	let pos, idx, nv;
	if (!shared) {
		nv = nt * 3; pos = new Float32Array(nv * 3); idx = new Uint32Array(nv);
		for (let i = 0; i < pos.length; i++) pos[i] = (Math.sin(seed + i * 0.37) * 5e-4);   // 単位球 origin 相対（±3km級）
		for (let i = 0; i < nv; i++) idx[i] = i;
	} else {
		const g = Math.ceil(Math.sqrt(nt / 2)) + 1; nv = g * g; pos = new Float32Array(nv * 3);
		for (let y = 0; y < g; y++) for (let x = 0; x < g; x++) { const v = (y * g + x) * 3; pos[v] = x * 1e-5; pos[v + 1] = Math.sin(x + y) * 1e-6; pos[v + 2] = y * 1e-5; }
		const tri = [];
		for (let y = 0; y < g - 1 && tri.length < nt * 3; y++) for (let x = 0; x < g - 1 && tri.length < nt * 3; x++) { const a = y * g + x; tri.push(a, a + 1, a + g, a + 1, a + g + 1, a + g); }
		idx = Uint32Array.from(tri.slice(0, nt * 3));
	}
	const nrm = new Int8Array(nv * 4);
	for (let i = 0; i < nv; i++) { nrm[i * 4] = (i * 7) % 255 - 127; nrm[i * 4 + 1] = 127; nrm[i * 4 + 2] = -(i % 100); }
	const lodCounts = [nt * 3, nt * 3, Math.floor(nt * 0.7) * 3, Math.floor(nt * 0.4) * 3, 0, 0];
	return { pos, nrm, idx, origin: [0.6, 0.5, 0.6], bbox: [139.7, 35.6, 139.8, 35.7], lodH: [0, 3, 6, 12, 24, 48], lodCounts, twoSided: 0, maskCells: Uint32Array.from([3, 4, 5, 300]) };
}
// 三角形 t の3頂点座標（idx 経由）＝レイアウトが変わっても幾何は同じでなければならない
const triPos = (m, t) => [0, 1, 2].flatMap(k => { const v = m.idx[t * 3 + k] * 3; return [m.pos[v], m.pos[v + 1], m.pos[v + 2]]; });
const triNrm = (m, t) => [0, 1, 2].flatMap(k => { const v = m.idx[t * 3 + k] * 4; return [m.nrm[v], m.nrm[v + 1], m.nrm[v + 2]]; });
const triArea = (m, t) => { const p = triPos(m, t); const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2]; return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); };
const totalArea = m => { let s = 0; for (let t = 0; t < m.idx.length / 3; t++) s += triArea(m, t); return s; };
const bboxOf = m => { const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (let i = 0; i < m.pos.length; i += 3) for (let a = 0; a < 3; a++) { b[a] = Math.min(b[a], m.pos[i + a]); b[a + 3] = Math.max(b[a + 3], m.pos[i + a]); } return b; };
// 角柱を含む出力＝三角形の順序が変わる（段ごとにメッシュ→角柱）＝順序非依存の不変量で見る
// 底（下向き水平＝上空から決して見えない）は角柱化で落ちる＝底を除いた三角形数/面積で比べる
const isBottom = (m, t, U) => { const v = m.idx[t * 3] * 4; const n = m.nrm; const l = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1; return (n[v] * U[0] + n[v + 1] * U[1] + n[v + 2] * U[2]) / l < -0.95 && (() => { const p = triPos(m, t); const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2]; const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, L = Math.hypot(nx, ny, nz) || 1; return Math.abs((nx * U[0] + ny * U[1] + nz * U[2]) / L) > 0.999; })(); };
const upArea = (m, U) => { let s = 0, nb = 0; for (let t = 0; t < m.idx.length / 3; t++) { if (isBottom(m, t, U)) { nb++; continue; } s += triArea(m, t); } return [s, nb]; };
function checkGeom(label, m, r, u8) {
	const h = headPLQ(u8), { U } = enuBasis(m.origin);
	const [a0, b0] = upArea(m, U), [a1, b1] = upArea(r, U);
	ok(`${label}: tri count (minus dropped bottoms)`, r.idx.length <= m.idx.length && r.idx.length >= m.idx.length - b0 * 3, `${r.idx.length / 3} vs ${m.idx.length / 3} (bottoms ${b0}→${b1})`);
	ok(`${label}: lodCounts consistent`, r.lodCounts[0] === r.idx.length && r.lodCounts.every((c, k) => c <= m.lodCounts[k] && (k === 0 || c <= r.lodCounts[k - 1])), `${r.lodCounts} vs ${m.lodCounts}`);
	ok(`${label}: non-bottom area ±0.5%`, Math.abs(a1 - a0) <= a0 * 0.005, `${(a1 / a0 * 100).toFixed(2)}%`);
	const bb0 = bboxOf(m), bb1 = bboxOf(r), tolB = 0.05 / 6371000;
	ok(`${label}: bbox ±5cm`, bb0.every((v, i) => Math.abs(v - bb1[i]) <= tolB));
	ok(`${label}: verts ≤ +1%`, r.pos.length / 3 <= m.pos.length / 3 * 1.01, `${m.pos.length / 3} → ${r.pos.length / 3} (prisms ${h.prisms?.n ?? 0})`);
	console.log(`     ${label}: prisms=${h.prisms?.n ?? 0} meshTris=${h.nt} plq ${(u8.length / 1e6).toFixed(2)}MB gzip ${(gzipSync(u8).length / 1e6).toFixed(2)}MB`);
}
function check(label, m, opts) {
	const u8 = packPLQ(m, opts), r = unpackPLQ(u8);
	ok(`${label}: unpack`, !!r);
	if (!r) return;
	if (headPLQ(u8)?.prisms) { checkGeom(label, m, r, u8); return r; }
	const nt = m.idx.length / 3;
	ok(`${label}: tri count`, r.idx.length === m.idx.length);
	// 量子化誤差＝各軸の範囲/65535 の半分以内（頂点の対応は三角形順で取る＝レイアウト非依存）
	const ext = [0, 1, 2].map(a => { let lo = Infinity, hi = -Infinity; for (let i = a; i < m.pos.length; i += 3) { lo = Math.min(lo, m.pos[i]); hi = Math.max(hi, m.pos[i]); } return hi - lo; });
	let maxErr = 0, nrmBad = 0;
	for (let t = 0; t < nt; t++) {
		const a = triPos(m, t), b = triPos(r, t);
		for (let i = 0; i < 9; i++) maxErr = Math.max(maxErr, Math.abs(a[i] - b[i]) / (ext[i % 3] / 65535 || 1));
		if (!same(triNrm(m, t), triNrm(r, t))) nrmBad++;
	}
	ok(`${label}: quant error ≤ 0.5 step + f32`, maxErr <= 0.51, `max=${maxErr.toFixed(3)} step`);
	ok(`${label}: normals`, nrmBad === 0);
	ok(`${label}: lod/mask/meta`, same(r.lodCounts, m.lodCounts) && same([...r.maskCells], [...m.maskCells]) && same(r.origin, m.origin) && same(r.bbox, m.bbox) && r.twoSided === m.twoSided);
	ok(`${label}: nrm stride 4`, r.nrm.length === r.pos.length / 3 * 4 && r.nrm[3] === 0);
	console.log(`     ${label}: verts ${m.pos.length / 3} → ${r.pos.length / 3}`);
	const raw = m.pos.byteLength + m.nrm.byteLength + m.idx.byteLength, gz = gzipSync(u8).length;
	console.log(`     ${label}: raw ${(raw / 1e6).toFixed(2)}MB → plq ${(u8.length / 1e6).toFixed(2)}MB → gzip ${(gz / 1e6).toFixed(2)}MB (${(gz / raw * 100).toFixed(0)}%)  layout=${JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + new DataView(u8.buffer).getUint32(4, true)))).idx}`);
	return r;
}

check("welded(synthetic 20k tris)", synth(20000, false));
check("iota(synthetic 20k tris, weld off)", synth(20000, false), { weld: false });
{   // 溶接＝箱（12三角形・36頂点・面ごとフラット法線）が 24 頂点になり、三角形ごとの幾何と法線は不変
	const box = () => {
		const c = [[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]].map(v => v.map(x => x * 1e-5));
		const faces = [[0,1,2,3,[0,0,-127]],[4,5,6,7,[0,0,127]],[0,1,5,4,[0,-127,0]],[2,3,7,6,[0,127,0]],[1,2,6,5,[127,0,0]],[0,3,7,4,[-127,0,0]]];
		const pos = [], nrm = [], idx = [];
		for (const [a,b,cc,d,n] of faces) for (const tri of [[a,b,cc],[a,cc,d]]) for (const v of tri) { idx.push(pos.length / 3); pos.push(...c[v]); nrm.push(...n, 0); }
		return { pos: Float32Array.from(pos), nrm: Int8Array.from(nrm), idx: Uint32Array.from(idx), origin: [0.6,0.5,0.6], bbox: [139,35,140,36], lodH: [0,3,6,12,24,48], lodCounts: [36,36,36,0,0,0], twoSided: 0, maskCells: null };
	};
	const m = box(), w = weldMesh(m);
	ok("weld: box 36→24 verts", w.pos.length / 3 === 24 && w.idx.length === 36, `${w.pos.length / 3}`);
	let same = true; for (let t = 0; t < 12; t++) { if (!triPos(m, t).every((v, i) => v === triPos(w, t)[i]) || !triNrm(m, t).every((v, i) => v === triNrm(w, t)[i])) same = false; }
	ok("weld: per-triangle geometry/normals preserved", same);
	ok("weld: idempotent (no-op on welded)", weldMesh(w) === w);
	const u = unpackPLQ(packPLQ(m));
	ok("weld: packed box round-trips with 24 verts", u.pos.length / 3 === 24 && u.idx.length === 36);
}
check("explicit(synthetic shared 20k tris)", synth(20000, true));
{   // 角柱（底面＋高さ）：ENU 整列の箱・L 字（6角・底なし）・穴付き（外周+穴）→ 抽出→押し出しで三角形数/面積/bbox 不変・サイズ縮小。斜め屋根はメッシュのまま
	const origin = [0.6, 0.5, 0.6];
	const mkPrismMesh = (prisms) => { const ex = extrudePrisms(prisms, origin); const nt = ex.idx.length / 3; return { ...ex, origin, bbox: [139, 35, 140, 36], lodH: [0, 3, 6, 12, 24, 48], lodCounts: [nt * 3, nt * 3, nt * 3, 0, 0, 0], twoSided: 0, maskCells: null }; };
	const cm = 1;   // PRISM_Q 単位（1cm）
	const box = { tier: 2, base: 500 * cm, h: 1000 * cm, rings: [[[0, 0], [1000, 0], [1000, 800], [0, 800]]], top: [0, 1, 2, 0, 2, 3], bottom: false };
	const L = { tier: 2, base: 0, h: 650, rings: [[[3000, 0], [4000, 0], [4000, 1000], [3500, 1000], [3500, 500], [3000, 500]]], top: [0, 1, 2, 0, 2, 3, 0, 3, 4, 0, 4, 5], bottom: false };
	const ring = { tier: 2, base: 100, h: 400, rings: [[[6000, 0], [7000, 0], [7000, 1000], [6000, 1000]], [[6300, 300], [6300, 700], [6700, 700], [6700, 300]]], top: [0, 1, 4, 4, 7, 1, 1, 2, 7, 7, 6, 2, 2, 3, 6, 6, 5, 3, 3, 0, 5, 5, 4, 0], bottom: false };
	// 底付きの箱（押し出しに底あり）→ 抽出で底は落ち、天/壁は角柱に（隣接 2 棟が壁を共有して 1 成分になっても別々に拾う）
	const boxB = { tier: 1, base: 0, h: 300, rings: [[[9000, 0], [9500, 0], [9500, 500], [9000, 500]]], top: [0, 1, 2, 0, 2, 3], bottom: true };
	const boxC = { tier: 1, base: 0, h: 500, rings: [[[9500, 0], [10000, 0], [10000, 500], [9500, 500]]], top: [0, 1, 2, 0, 2, 3], bottom: true };
	{ const mb = mkPrismMesh([boxB, boxC]); const ub = packPLQ(mb), hb = headPLQ(ub), rb = unpackPLQ(ub);
	  ok("prism: two boxes sharing a wall → 2 prisms, bottoms dropped", hb.prisms?.n === 2 && rb.idx.length === mb.idx.length - 12, `n=${hb.prisms?.n} tris ${rb?.idx.length / 3} vs ${mb.idx.length / 3}`); }
	const m = mkPrismMesh([box, L, ring]);
	const u8 = packPLQ(m), h = headPLQ(u8), r = unpackPLQ(u8);
	ok("prism: 3 prisms detected", h.prisms?.n === 3 && h.nt === 0, `n=${h.prisms?.n} meshTris=${h.nt}`);
	ok("prism: unpack", !!r);
	if (r) { ok("prism: tri count", r.idx.length === m.idx.length); ok("prism: verts 20+30+40", r.pos.length / 3 === m.pos.length / 3, `${r.pos.length / 3}`); ok("prism: area", Math.abs(totalArea(r) - totalArea(m)) < totalArea(m) * 1e-6); ok("prism: lodCounts", same(r.lodCounts, m.lodCounts)); ok("prism: positions exact (1cm grid)", (() => { const b0 = bboxOf(m), b1 = bboxOf(r); return b0.every((v, i) => Math.abs(v - b1[i]) < 1e-12); })()); }
	const u8m = packPLQ(m, { prism: false });
	console.log(`     prism: mesh-only ${u8m.length}B → prism ${u8.length}B (${(u8.length / u8m.length * 100).toFixed(0)}%)`);
	ok("prism: smaller than mesh", u8.length < u8m.length * 0.5);
	// 斜め屋根（切妻）＝角柱にならない
	const { E, N, U } = enuBasis(origin);
	const P = (e, n, u) => [e * PRISM_Q * E[0] + n * PRISM_Q * N[0] + u * PRISM_Q * U[0], e * PRISM_Q * E[1] + n * PRISM_Q * N[1] + u * PRISM_Q * U[1], e * PRISM_Q * E[2] + n * PRISM_Q * N[2] + u * PRISM_Q * U[2]];
	const gv = [P(0, 0, 0), P(1000, 0, 0), P(1000, 800, 0), P(0, 800, 0), P(0, 400, 600), P(1000, 400, 600)];   // 切妻＝棟線
	const gtri = [[0, 1, 5], [0, 5, 4], [3, 2, 5], [3, 5, 4], [0, 4, 3], [1, 2, 5], [0, 1, 2], [0, 2, 3]];
	const gpos = new Float32Array(gtri.length * 9), gnrm = new Int8Array(gtri.length * 12), gidx = new Uint32Array(gtri.length * 3);
	gtri.forEach((tr, i) => tr.forEach((v, k) => { gpos.set(gv[v], (i * 3 + k) * 3); gnrm[(i * 3 + k) * 4 + 1] = 127; gidx[i * 3 + k] = i * 3 + k; }));
	const gable = { pos: gpos, nrm: gnrm, idx: gidx, origin, bbox: [139, 35, 140, 36], lodH: [0, 3, 6, 12, 24, 48], lodCounts: [24, 24, 24, 0, 0, 0], twoSided: 0, maskCells: null };
	ok("prism: gable roof stays mesh", !headPLQ(packPLQ(gable)).prisms);
	// 焼き済み実データ（あれば）：箱の区（大田区）と屋根付き（狛江）
	for (const [name, f] of [["大田区 b0", "plateau-bake-out/v5/api.plateauview.mlit.go.jp_datacatalog_3dtiles_13111-bldg-lod2-notexture-latest/b0.plq"], ["狛江市 b0", "plateau-bake-out/v5/api.plateauview.mlit.go.jp_datacatalog_3dtiles_13219-bldg-lod2-notexture-latest/b0.plq"]]) {
		if (!existsSync(f)) continue;
		const src = unpackPLQ(new Uint8Array(readFileSync(f)));
		if (!src) continue;
		const t0 = performance.now(); const out = packPLQ(src); const t1 = performance.now(); const back = unpackPLQ(out); const t2 = performance.now();
		console.log(`     real ${name}: pack ${(t1 - t0).toFixed(0)}ms unpack ${(t2 - t1).toFixed(0)}ms; file ${(readFileSync(f).length / 1e6).toFixed(2)}MB → ${(out.length / 1e6).toFixed(2)}MB`);
		ok(`real ${name}: unpack`, !!back);
		if (back) checkGeom(`real ${name}`, src, back, out);
	}
}
ok("empty/garbage → null", unpackPLQ(new Uint8Array([1, 2, 3])) === null && unpackPLQ(new Uint8Array(0)) === null);
{   // 切り詰め＝null（例外を漏らさない）
	const u8 = packPLQ(synth(100, false));
	ok("truncated → null", unpackPLQ(u8.subarray(0, u8.length - 50)) === null);
}
ok("slug", bakeSlug("https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13103-bldg-lod2-notexture-latest/") === "api.plateauview.mlit.go.jp_datacatalog_3dtiles_13103-bldg-lod2-notexture-latest");
ok("slug(reearth)", bakeSlug("https://assets.cms.plateau.reearth.io/assets/55/babf04-f2a8/11100_saitama-shi_city_2025_citygml_1_op_brid_3dtiles_lod2/") === "assets.cms.plateau.reearth.io_assets_55_babf04-f2a8_11100_saitama-shi_city_2025_citygml_1_op_brid_3dtiles_lod2");
ok("ver", PLQ_VER === 2);

if (process.argv.includes("--real")) {
	const { setLoaderOptions } = await import("@loaders.gl/core");
	const draco3d = (await import("draco3d")).default;
	setLoaderOptions({ modules: { draco3d } });
	const { decodeBatch, collectLeafTiles } = await import("../plateaudecode.js");
	const base = "https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13103-bldg-lod2-notexture-latest/";
	const leaves = await collectLeafTiles(base + "tileset.json");
	const bbox = [139.708705279, 35.623138305999994, 139.782376342, 35.682810279];
	const t0 = performance.now();
	const mesh = await decodeBatch(base, leaves.slice(100, 132), null, bbox, null, false, null, null);
	console.log(`real: decode ${((performance.now() - t0) / 1000).toFixed(1)}s verts=${mesh.pos.length / 3} tris=${mesh.idx.length / 3}`);
	const t1 = performance.now(); const u8 = packPLQ(mesh); const t2 = performance.now(); const r = unpackPLQ(u8); const t3 = performance.now();
	console.log(`real: pack ${(t2 - t1).toFixed(0)}ms unpack ${(t3 - t2).toFixed(0)}ms`);
	const r0 = check("real(港区 32 tiles)", mesh);
	console.log(`real: verts ${mesh.pos.length / 3} → welded ${r0.pos.length / 3} (${(r0.pos.length / 3 / (mesh.pos.length / 3) * 100).toFixed(0)}%)`);
	ok("real: welded verts ≤ 70% of 3·tris (decodeBatch welds too)", r0.pos.length / 3 < mesh.idx.length * 0.7, `${r0.pos.length / 3} of ${mesh.idx.length}`);
	check("real(港区, weld off)", mesh, { weld: false });
	// 位置誤差をメートルで（単位球×6371km）
	let maxM = 0; const nt = mesh.idx.length / 3;
	for (let t = 0; t < nt; t += 7) { const a = triPos(mesh, t), b = triPos(r, t); for (let i = 0; i < 9; i++) maxM = Math.max(maxM, Math.abs(a[i] - b[i]) * 6371000); }
	ok("real: max position error < 5cm", maxM < 0.05, `${(maxM * 100).toFixed(1)}cm`);
}
console.log(fail ? `\n✗ ${fail} failed` : "\n✓ all PASS");
process.exit(fail ? 1 : 0);
