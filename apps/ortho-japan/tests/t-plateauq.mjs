// PLQ（plateauq.js）の往復検定＝Node 単体。合成メッシュ（iota/explicit 両レイアウト）＋ --real で港区の実バッチ
// （ネットワーク・Draco＝draco3d 注入）を焼いて量子化誤差・index/LOD/mask の不変・gzip 後サイズを数字で見る。
//   node tests/t-plateauq.mjs          合成のみ（数十ms）
//   node tests/t-plateauq.mjs --real   実バッチ込み（数秒・要ネット）
import { packPLQ, unpackPLQ, weldMesh, bakeSlug, PLQ_VER } from "../plateauq.js";
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
function check(label, m, opts) {
	const u8 = packPLQ(m, opts), r = unpackPLQ(u8);
	ok(`${label}: unpack`, !!r);
	if (!r) return;
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
ok("empty/garbage → null", unpackPLQ(new Uint8Array([1, 2, 3])) === null && unpackPLQ(new Uint8Array(0)) === null);
{   // 切り詰め＝null（例外を漏らさない）
	const u8 = packPLQ(synth(100, false));
	ok("truncated → null", unpackPLQ(u8.subarray(0, u8.length - 50)) === null);
}
ok("slug", bakeSlug("https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13103-bldg-lod2-notexture-latest/") === "api.plateauview.mlit.go.jp_datacatalog_3dtiles_13103-bldg-lod2-notexture-latest");
ok("slug(reearth)", bakeSlug("https://assets.cms.plateau.reearth.io/assets/55/babf04-f2a8/11100_saitama-shi_city_2025_citygml_1_op_brid_3dtiles_lod2/") === "assets.cms.plateau.reearth.io_assets_55_babf04-f2a8_11100_saitama-shi_city_2025_citygml_1_op_brid_3dtiles_lod2");
ok("ver", PLQ_VER === 1);

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
