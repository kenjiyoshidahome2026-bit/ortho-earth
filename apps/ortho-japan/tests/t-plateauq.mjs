// PLQ（plateauq.js）の往復検定＝Node 単体。合成メッシュ（iota/explicit 両レイアウト）＋ --real で港区の実バッチ
// （ネットワーク・Draco＝draco3d 注入）を焼いて量子化誤差・index/LOD/mask の不変・gzip 後サイズを数字で見る。
//   node tests/t-plateauq.mjs          合成のみ（数十ms）
//   node tests/t-plateauq.mjs --real   実バッチ込み（数秒・要ネット）
import { packPLQ, unpackPLQ, bakeSlug, PLQ_VER } from "../plateauq.js";
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
function check(label, m) {
	const u8 = packPLQ(m), r = unpackPLQ(u8);
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
	const raw = m.pos.byteLength + m.nrm.byteLength + m.idx.byteLength, gz = gzipSync(u8).length;
	console.log(`     ${label}: raw ${(raw / 1e6).toFixed(2)}MB → plq ${(u8.length / 1e6).toFixed(2)}MB → gzip ${(gz / 1e6).toFixed(2)}MB (${(gz / raw * 100).toFixed(0)}%)  layout=${JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + new DataView(u8.buffer).getUint32(4, true)))).idx}`);
	return r;
}

check("iota(synthetic 20k tris)", synth(20000, false));
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
	check("real(港区 32 tiles)", mesh);
	// 位置誤差をメートルで（単位球×6371km）
	let maxM = 0; const nt = mesh.idx.length / 3;
	for (let t = 0; t < nt; t += 7) { const a = triPos(mesh, t), b = triPos(r, t); for (let i = 0; i < 9; i++) maxM = Math.max(maxM, Math.abs(a[i] - b[i]) * 6371000); }
	ok("real: max position error < 5cm", maxM < 0.05, `${(maxM * 100).toFixed(1)}cm`);
}
console.log(fail ? `\n✗ ${fail} failed` : "\n✓ all PASS");
process.exit(fail ? 1 : 0);
