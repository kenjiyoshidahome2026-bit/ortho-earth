// 点群 → Gaussian splat（cloud.ts・2026-11-06）の node の検定＝計画・ハッシュ・CPU の参照実装（面＝薄い楕円・段ごとの個数・まとめの重み・穴なし）・段の選び・色・共分散 → 尺と向き・SplatData・tileset・glb。
// WebGPU の変換器（cloud-gpu.ts）は同じ式＝実 GPU の検定は packages/globe の t-pcsplat（verify:webgpu）。node tests/t-cloud.mjs
import { gunzipSync } from "node:zlib";
import { cloudPlan, cellHash, levelFor, colorize, buildCloudCpu, covToScaleRot, cloudLevelToSplatData, enuToEcefTransform, enuToGltfAxes, cloudTileset, cloudLevelGlb, CLOUD_DEFAULTS, cloudFormatOf, encodeSpzRaw, decodeSpz, quatMat, cloudToSpz, spzPlacement, cloudTo3DTiles, zipStore, crc32 } from "../src/index.ts";
import { crc32 as zlibCrc32 } from "node:zlib";
let fails = 0;
const ok = (name, c, note = "") => { console.log(`${c ? "PASS" : "FAIL"} ${name}${note ? " " + note : ""}`); if (!c) fails++; };
const near = (a, b, e = 1e-5) => Math.abs(a - b) <= e;
const throws = f => { try { f(); return false; } catch { return true; } };
// 試料＝100 m × 60 m の地面（間隔 0.5 m・高さ＝緩い波）＋ 10 m 角の箱（壁＝鉛直の面）・色＝緑／赤
function sample() {
	const P = [], C = [];
	for (let x = -50; x < 50; x += 0.5) for (let y = -30; y < 30; y += 0.5) { P.push(x + 0.01 * Math.sin(x * 7), y, 2 * Math.sin(x / 15) * Math.cos(y / 10)); C.push(40, 180, 60, 255); }
	for (let z = 0; z < 10; z += 0.5) for (let t = 0; t < 10; t += 0.5) { P.push(10 + t, 10, z, 10 + t, 20, z, 10, 10 + t, z, 20, 10 + t, z); for (let k = 0; k < 4; k++) C.push(220, 50, 50, 255); }
	return { pts: new Float32Array(P), rgba: new Uint8Array(C), n: P.length / 3 };
}
const bbOf = (pts, n) => { const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const v = pts[i * 3 + k]; if (v < b[k]) b[k] = v; if (v > b[k + 3]) b[k + 3] = v; } return b; };

// ---- 計画 ----
{
	const { n, pts } = sample(), bb = bbOf(pts, n), plan = cloudPlan(n, bb);
	ok("plan.spacing", near(plan.spacing, Math.sqrt(100 * 60 / n), 0.05), `${plan.spacing.toFixed(3)} (n=${n})`);   // 面の間隔 ≈ 0.5 m（箱の分だけ少し小さい）
	ok("plan.cell0", plan.cell0 === plan.spacing && near(plan.r, plan.spacing * CLOUD_DEFAULTS.radius));
	ok("plan.levels", plan.levels >= 3 && plan.levels <= 8, String(plan.levels));   // 100 m / (16 × 0.5 m) → log2(12.5) → 5 段
	ok("plan.hash", (1 << plan.hashBits) >= 2 * n && (1 << plan.hashBits) < 4 * n, String(plan.hashBits));
	ok("plan.detail", cloudPlan(n, bb, { detail: 2 }).cell0 === plan.cell0 * 2 && cloudPlan(n, bb, { levels: 2 }).levels === 2 && cloudPlan(n, bb, { levels: 99 }).levels === 8);
	ok("plan.bad", throws(() => cloudPlan(n, bb, { detail: 0 })) && throws(() => cloudPlan(n, bb, { fill: -1 })) && throws(() => cloudPlan(n, bb, { pxPerSplat: NaN })));
	ok("plan.empty", cloudPlan(0, [0, 0, 0, 0, 0, 0]).levels === 1);
	ok("hash", cellHash(0, 0, 0, 1023) === 0 && cellHash(-1, 2, -3, 1023) === cellHash(-1, 2, -3, 1023) && cellHash(1, 0, 0, 1023) !== cellHash(0, 1, 0, 1023) && cellHash(5, 5, 5, 255) < 256);
	ok("format", cloudFormatOf("a/b.LAS") === "las" && cloudFormatOf("x.copc.laz?v=1") === "laz" && cloudFormatOf("s3/08NF2392.zip") === "zip" && cloudFormatOf("room.spz") === null);
}
// ---- 段の選び ----
{
	const cells = [0.5, 1, 2, 4, 8];
	ok("level.near", levelFor(10, cells, 1.5) === 0);        // 10 px/m → 1 splat に 0.15 m で足りる＝一番細かい段
	ok("level.mid", levelFor(1, cells, 1.5) === 2);          // 1 px/m → 1.5 m 以上＝2 m の段
	ok("level.far", levelFor(0.01, cells, 1.5) === 4 && levelFor(0, cells, 1.5) === 4);   // 遠い・錨が目の後ろ＝一番粗い段
	ok("level.one", levelFor(100, [1], 1.5) === 0);
}
// ---- 色 ----
{
	const d = { n: 3, rgb: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), elev: new Float32Array([0, 50, 100]), intensity: new Uint16Array([0, 32768, 65535]), cls: new Uint8Array([2, 6, 99]) };
	const a = colorize(d, "auto", { opacity: 0.5 });
	ok("color.rgb", a[0] === 1 && a[5] === 5 && a[10] === 9 && a[3] === 128 && a[11] === 128, JSON.stringify([...a]));
	const e = colorize(d, "elevation");
	ok("color.elev", e[2] > e[0] && e[8] > e[10] && e[3] === 255, JSON.stringify([...e]));   // 低い＝青・高い＝赤
	const i = colorize(d, "intensity");
	ok("color.int", i[0] === 0 && i[4] === 128 && i[8] === 255 && i[0] === i[1]);
	const c = colorize(d, "classification");
	ok("color.cls", c[0] === 168 && c[4] === 230 && c[8] === 160);   // 地面 茶・建物 赤・知らない＝灰
	ok("color.auto.noRgb", colorize({ n: 1, rgb: null, elev: new Float32Array([1]) }, "auto")[3] === 255 && throws(() => colorize({ n: 1, rgb: null }, "rgb")) && throws(() => colorize(d, "x")));
}
// ---- CPU の参照実装 ----
{
	const { pts, rgba, n } = sample(), bb = bbOf(pts, n), plan = cloudPlan(n, bb, { levels: 4 });
	const t0 = performance.now(), L = buildCloudCpu(pts, rgba, n, plan), ms = performance.now() - t0;
	ok("cpu.levels", L.length === 4 && L[0].cell === plan.cell0 && L[3].cell === plan.cell0 * 8, `${L.map(l => l.n).join("/")} in ${ms.toFixed(0)} ms`);
	ok("cpu.count0", L[0].n > n * 0.5 && L[0].n <= n, `${L[0].n}/${n}`);   // セル ≈ 間隔＝ほぼ 1 点 1 splat（波で 2 点入るセルもある）
	ok("cpu.shrink", L[1].n < L[0].n / 2.5 && L[2].n < L[1].n / 2.5 && L[3].n < L[2].n / 2, L.map(l => l.n).join(" > "));   // 2 倍のセル＝面なら約 1/4
	ok("cpu.weights", near(L[3].cov.filter((_, k) => k % 8 === 6).reduce((a, w) => a + w, 0), n, 1e-3));   // 重み＝点の数＝全部で n
	// 地面の splat＝薄い（上下の σ ≪ 水平の σ）・水平の σ ≈ 近傍の散らばり（r＝1 m・一様 → σ ≈ r/2）
	let thin = 0, ground = 0;
	for (let i = 0; i < L[0].n; i++) {
		const x = L[0].ctr[i * 4], y = L[0].ctr[i * 4 + 1]; if (x > 5 && x < 25 && y > 5 && y < 25) continue;   // 箱の周りは除く
		const { scales } = covToScaleRot(L[0].cov, i * 8); ground++;
		const s = [...scales].sort((a, b) => a - b);
		if (s[0] < 0.4 * s[2] && s[2] > plan.r * 0.3 && s[2] < plan.r) thin++;
	}
	ok("cpu.thin", thin > ground * 0.9, `${thin}/${ground}`);
	// 壁の splat＝鉛直の面＝薄い向きが水平（法線が水平）・色は赤
	let wall = 0, wallThin = 0;
	for (let i = 0; i < L[0].n; i++) {
		const x = L[0].ctr[i * 4], y = L[0].ctr[i * 4 + 1], z = L[0].ctr[i * 4 + 2]; if (!(z > 2 && z < 8 && Math.abs(y - 10) < 0.3 && x > 12 && x < 18)) continue;
		wall++; const { scales, rot } = covToScaleRot(L[0].cov, i * 8), R = quatMat(...rot), k = scales.indexOf(Math.min(...scales)), nz = Math.abs(R[6 + k]);   // 一番薄い軸（列 k）の z 成分
		if (nz < 0.3 && (L[0].col[i] & 255) > 200) wallThin++;
	}
	ok("cpu.wall", wall > 20 && wallThin > wall * 0.8, `${wallThin}/${wall}`);
	// 粗い段＝重みつきの平均（箱の上の段の中心は箱の中・色は赤と緑の間）・範囲・半径
	ok("cpu.bb", L[0].bb[0] < -49 && L[0].bb[3] > 49 && L[0].bb[2] < -1.5 && L[0].bb[5] > 9 && near(L[0].radius, Math.max(...L[0].ctr.filter((_, k) => k % 4 !== 3).map(Math.abs)), 60), `${L[0].bb.map(v => v.toFixed(1))} r=${L[0].radius.toFixed(1)}`);
	ok("cpu.fill", L[2].cov.every((v, k) => k % 8 === 0 || k % 8 === 3 || k % 8 === 5 ? v >= (plan.fill * L[2].cell) ** 2 - 1e-6 : true));   // 対角 ≥ (fill × cell)²
	ok("cpu.cap", L[0].cov.every((v, k) => k % 8 === 6 || k % 8 === 7 ? true : Math.abs(v) <= (plan.cap * L[0].cell) ** 2 + 1e-6));
	// 決定性・空
	const L2 = buildCloudCpu(pts, rgba, n, plan);
	ok("cpu.same", L2[0].n === L[0].n && L2[1].ctr.every((v, k) => v === L[1].ctr[k]));
	ok("cpu.empty", buildCloudCpu(new Float32Array(0), new Uint8Array(0), 0, cloudPlan(0, [0, 0, 0, 0, 0, 0])).length === 1);
	ok("cpu.one", buildCloudCpu(new Float32Array([1, 2, 3]), new Uint8Array([1, 2, 3, 4]), 1, cloudPlan(1, [1, 2, 3, 1, 2, 3])).every(l => l.n === 1));
	// ---- 書き出し ----
	const d = cloudLevelToSplatData(L[1]);
	ok("data", d.n === L[1].n && d.crs === "local" && d.positions.length === d.n * 3 && d.rotations.length === d.n * 4 && d.colors[3] === 255);
	// 尺と向き → 共分散に戻す＝元と同じ（R diag(s²) Rᵀ）
	let maxErr = 0;
	for (let i = 0; i < Math.min(200, d.n); i++) {
		const R = quatMat(d.rotations[i * 4], d.rotations[i * 4 + 1], d.rotations[i * 4 + 2], d.rotations[i * 4 + 3]), s = [d.scales[i * 3] ** 2, d.scales[i * 3 + 1] ** 2, d.scales[i * 3 + 2] ** 2];
		const M = (r, c) => R[r * 3] * s[0] * R[c * 3] + R[r * 3 + 1] * s[1] * R[c * 3 + 1] + R[r * 3 + 2] * s[2] * R[c * 3 + 2];
		const back = [M(0, 0), M(0, 1), M(0, 2), M(1, 1), M(1, 2), M(2, 2)], sc = Math.max(1e-6, back[0] + back[3] + back[5]);
		for (let k = 0; k < 6; k++) maxErr = Math.max(maxErr, Math.abs(back[k] - L[1].cov[i * 8 + k]) / sc);
	}
	ok("eigen.roundtrip", maxErr < 1e-4, maxErr.toExponential(2));
	const id = covToScaleRot([4, 0, 0, 1, 0, 0.25]);
	ok("eigen.diag", near(id.scales[0], 2) && near(id.scales[1], 1) && near(id.scales[2], 0.5) && near(Math.abs(id.rot[3]), 1));
	// .spz に書いて読む＝位置・尺が戻る
	const spz = decodeSpz(encodeSpzRaw(d));
	ok("spz", spz.n === d.n && near(spz.positions[0], d.positions[0], 1e-3) && near(spz.scales[0], d.scales[0], d.scales[0] * 0.08));
	// 軸＝東北上 → glTF（x=E, y=U, z=−N）：位置と向きが同じ回転で動く
	const g = enuToGltfAxes(d), i0 = 0;
	ok("axes.pos", near(g.positions[i0 * 3], d.positions[i0 * 3]) && near(g.positions[i0 * 3 + 1], d.positions[i0 * 3 + 2]) && near(g.positions[i0 * 3 + 2], -d.positions[i0 * 3 + 1]));
	{ const Ra = quatMat(g.rotations[0], g.rotations[1], g.rotations[2], g.rotations[3]), Rb = quatMat(d.rotations[0], d.rotations[1], d.rotations[2], d.rotations[3]);
		// Ra＝M·Rb（M＝E,N,U → E,U,−N）
		const M = [1, 0, 0, 0, 0, 1, 0, -1, 0], MR = []; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) MR.push(M[r * 3] * Rb[c] + M[r * 3 + 1] * Rb[3 + c] + M[r * 3 + 2] * Rb[6 + c]);
		ok("axes.rot", MR.every((v, k) => near(v, Ra[k], 1e-4)), JSON.stringify(MR.map(v => +v.toFixed(3))) + " vs " + JSON.stringify([...Ra].map(v => +v.toFixed(3)))); }
	// 3D Tiles
	const anchor = [139.0816, 35.1082, 20], T = enuToEcefTransform(...anchor);
	ok("enu.transform", near(Math.hypot(T[12], T[13], T[14]), 6378137 - 15000, 20000) && near(T[0] * T[0] + T[1] * T[1] + T[2] * T[2], 1, 1e-9) && near(T[8] * T[12] + T[9] * T[13] + T[10] * T[14], Math.hypot(T[12], T[13], T[14]), 200));   // 上の列 ∥ 位置
	const ts = cloudTileset(L, anchor);
	const depth = t => t.children ? 1 + depth(t.children[0]) : 1;
	ok("tileset", ts.root.transform.length === 16 && depth(ts.root) === 4 && ts.root.content.uri === "level3.glb" && ts.root.children[0].children[0].children[0].content.uri === "level0.glb" && ts.root.children[0].children[0].children[0].geometricError === 0 && ts.root.geometricError > ts.root.children[0].geometricError, JSON.stringify({ ge: ts.root.geometricError, uri: ts.root.content.uri }));
	ok("tileset.empty", throws(() => cloudTileset([], anchor)));
	const glb = cloudLevelGlb(enuToGltfAxes(d), new Uint8Array([1, 2, 3, 4, 5]));
	const dv = new DataView(glb.buffer), jl = dv.getUint32(12, true), json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jl)));
	ok("glb", String.fromCharCode(...glb.subarray(0, 4)) === "glTF" && dv.getUint32(8, true) === glb.length && json.meshes[0].primitives[0].extensions.KHR_gaussian_splatting_compression_spz_2.bufferView === 0 && json.accessors[0].count === d.n && json.bufferViews[0].byteLength === 5 && glb[20 + jl + 8] === 1 && glb.length % 4 === 0);
	// 書き出し（cloud-export.ts）＝.spz（gzip）・置き場・3D Tiles の一式・無圧縮 zip
	const cloud = { anchor, levels: L };
	const spzGz = await cloudToSpz(cloud, 1);
	ok("export.spz", spzGz[0] === 0x1f && spzGz[1] === 0x8b && decodeSpz(gunzipSync(spzGz)).n === L[1].n);
	const pl = spzPlacement(cloud);
	ok("export.placement", pl.anchor[0] === anchor[0] && pl.addData.upAxis === "z" && pl.addData.origin[2] === 20 && pl.transform.length === 16 && near(pl.transform[12], T[12]));
	const files = await cloudTo3DTiles(cloud, { prefix: "lv" });
	const ts2 = JSON.parse(new TextDecoder().decode(files[0].bytes));
	ok("export.tiles", files.length === L.length + 1 && files[0].name === "tileset.json" && files[1].name === "lv0.glb" && ts2.root.content.uri === `lv${L.length - 1}.glb` && String.fromCharCode(...files[1].bytes.subarray(0, 4)) === "glTF");
	ok("export.tiles.empty", await cloudTo3DTiles({ anchor, levels: [] }).then(() => false, () => true));
	ok("export.spz.badLevel", await cloudToSpz(cloud, 99).then(() => false, e => /no level 99/.test(e.message)));
	const zip = zipStore([{ name: "a.txt", bytes: new TextEncoder().encode("hello") }, { name: "dir/b.bin", bytes: new Uint8Array([0, 1, 2, 255]) }]);
	const zdv = new DataView(zip.buffer), eocd = zip.length - 22;
	ok("zip", zdv.getUint32(0, true) === 0x04034B50 && zdv.getUint32(eocd, true) === 0x06054B50 && zdv.getUint16(eocd + 10, true) === 2 && zdv.getUint32(14, true) === crc32(new TextEncoder().encode("hello")) && crc32(new Uint8Array([0, 1, 2, 255])) === zlibCrc32(new Uint8Array([0, 1, 2, 255])));
	ok("zip.cd", zdv.getUint32(zdv.getUint32(eocd + 16, true), true) === 0x02014B50);
}
console.log(fails ? `${fails} FAIL` : "ALL PASS cloud");
process.exit(fails ? 1 : 0);
