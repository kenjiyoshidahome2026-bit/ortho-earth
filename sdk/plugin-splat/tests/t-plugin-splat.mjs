// node の検定：読み手（.ply・.splat・.spz v2/v3）・東北上への下ごしらえ（lnglat・ecef・local）・共分散・視線順の並べ替え・plugin の形。描画は globe の頁 t-psplat。
import { gzipSync } from "node:zlib";
import { parsePly, parseSplat, parseSpz, decodeSpz, toEnu, packSh, shDegreeOf, importanceRank, prepare, quatMat, placeMat, checkSplatData, splatPlugin, SH_C0 } from "../src/index.ts";
import { read } from "../src/splat-reader.ts";
import { sortOrder, enuBasis } from "../src/splat-gl.ts";
import { depthRange, lodCount, pixelsPerMeter } from "../src/splat-gpu.ts";
let fails = 0;
const ok = (name, c, note = "") => { console.log(`${c ? "PASS" : "FAIL"} ${name}${note ? " " + note : ""}`); if (!c) fails++; };
const near = (a, b, e = 1e-5) => Math.abs(a - b) <= e;
const throws = f => { try { f(); return false; } catch { return true; } };
const athrows = async f => { try { await f(); return false; } catch { return true; } };

// ---- .splat ----
{
	const b = new ArrayBuffer(64), dv = new DataView(b), u8 = new Uint8Array(b);
	[1, 2, 3].forEach((v, k) => dv.setFloat32(k * 4, v, true)); [0.5, 0.25, 0.125].forEach((v, k) => dv.setFloat32(12 + k * 4, v, true));
	u8.set([255, 0, 0, 200], 24); u8.set([255, 128, 128, 128], 28);   // w=1 → 単位
	dv.setFloat32(32, -4, true); u8.set([0, 255, 0, 255], 56); u8.set([128, 255, 128, 128], 60);   // x 軸まわり 180°（x=1）
	const d = parseSplat(b);
	ok("splat.n", d.n === 2 && d.crs === "local" && d.axes === "-y");
	ok("splat.pos", d.positions[0] === 1 && d.positions[2] === 3 && d.positions[3] === -4);
	ok("splat.scale", d.scales[0] === 0.5 && d.scales[2] === 0.125);
	ok("splat.color", d.colors[0] === 255 && d.colors[3] === 200 && d.colors[5] === 255);
	ok("splat.rot", near(d.rotations[3], 1) && near(d.rotations[4], 127 / Math.hypot(127, 0, 0, 0), 1e-6) && near(d.rotations[7], 0, 1e-6), JSON.stringify([...d.rotations]));
	ok("splat.badLen", throws(() => parseSplat(new ArrayBuffer(33))));
}
// ---- .ply ----
function makePly(rows, props) {
	const head = `ply\nformat binary_little_endian 1.0\ncomment test\nelement vertex ${rows.length}\n${props.map(p => `property float ${p}`).join("\n")}\nend_header\n`;
	const h = new TextEncoder().encode(head), b = new Uint8Array(h.length + rows.length * props.length * 4), dv = new DataView(b.buffer);
	b.set(h); rows.forEach((r, i) => props.forEach((p, k) => dv.setFloat32(h.length + (i * props.length + k) * 4, r[p] ?? 0, true)));
	return b;
}
{
	const props = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "f_rest_0", "f_rest_1", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
	const d = parsePly(makePly([{ x: 1, y: 2, z: 3, f_dc_0: 1, f_dc_1: 0, f_dc_2: -1, f_rest_0: 0.5, f_rest_1: -0.5, opacity: 0, scale_0: 0, scale_1: Math.log(2), scale_2: Math.log(0.5), rot_0: 2, rot_1: 0, rot_2: 0, rot_3: 0 }], props));
	ok("ply.n", d.n === 1 && d.positions[1] === 2);
	ok("ply.scale", near(d.scales[0], 1) && near(d.scales[1], 2) && near(d.scales[2], 0.5));
	ok("ply.alpha", d.colors[3] === 128, String(d.colors[3]));   // sigmoid(0)＝0.5
	ok("ply.dc", d.colors[0] === Math.round((0.5 + SH_C0) * 255) && d.colors[1] === 128 && d.colors[2] === Math.round((0.5 - SH_C0) * 255), JSON.stringify([...d.colors]));
	ok("ply.rot", near(d.rotations[3], 1) && near(d.rotations[0], 0));   // rot_0＝w・正規化
	ok("ply.sh", d.sh?.length === 2 && d.sh[0] === 0.5);   // 3 の倍数でない f_rest＝並べ替えない（次数は 0）
	// f_rest は色が先（R の K 個・G の K 個・B の K 個）→ 係数が先（k*3+c）に並べ替える（.spz と同じ・描き手の評価の並び）
	const rest = Array.from({ length: 9 }, (_, i) => "f_rest_" + i), row = { x: 0, y: 0, z: 0 }; rest.forEach((p, i) => { row[p] = i; });
	const d9 = parsePly(makePly([row], ["x", "y", "z", ...rest]));
	ok("ply.shOrder", d9.sh?.length === 9 && d9.sh[0] === 0 && d9.sh[1] === 3 && d9.sh[2] === 6 && d9.sh[3] === 1 && d9.sh[8] === 8, JSON.stringify([...(d9.sh ?? [])]));
	const pc = parsePly(makePly([{ x: 5, y: 6, z: 7 }], ["x", "y", "z"]));
	ok("ply.points", pc.n === 1 && pc.colors[3] === 255 && near(pc.scales[0], 0.01));
	ok("ply.ascii", throws(() => parsePly(new TextEncoder().encode("ply\nformat ascii 1.0\nelement vertex 0\nend_header\n"))));
	ok("ply.notPly", throws(() => parsePly(new Uint8Array(10))));
}
// ---- .spz（v2：回転 3 byte・v3：最大成分を落とした 4 byte） ----
function makeSpz(version, pts) {
	const n = pts.length, frac = 12, rotB = version >= 3 ? 4 : 3, b = new Uint8Array(16 + n * (9 + 1 + 3 + 3 + rotB)), dv = new DataView(b.buffer);
	dv.setUint32(0, 0x5053474e, true); dv.setUint32(4, version, true); dv.setUint32(8, n, true); b[12] = 0; b[13] = frac;
	let o = 16;
	for (const p of pts) for (const v of p.pos) { let q = Math.round(v * (1 << frac)) & 0xffffff; b[o++] = q & 255; b[o++] = (q >> 8) & 255; b[o++] = (q >> 16) & 255; }
	for (const p of pts) b[o++] = p.a;
	for (const p of pts) for (const c of p.dc) b[o++] = Math.round((c * 0.15 + 0.5) * 255);
	for (const p of pts) for (const s of p.logS) b[o++] = Math.round((s + 10) * 16);
	for (const p of pts) {
		if (version >= 3) {   // q＝[x,y,z,w]・最大成分は w（番号 3）
			let c = 3 << 30, sh = 0; const q = p.q;
			for (let k = 2; k >= 0; k--) { const mag = Math.round(Math.abs(q[k]) / Math.SQRT1_2 * 511); c |= ((mag | ((q[k] < 0 ? 1 : 0) << 9)) << sh); sh += 10; }
			// 書き出しの順は読みの逆（読みは k＝3→0 で下の bit から取る）＝k＝2 が最下位
			dv.setUint32(o, c >>> 0, true); o += 4;
		} else { for (let k = 0; k < 3; k++) b[o++] = Math.round((p.q[k] + 1) * 127.5); }
	}
	return gzipSync(b);
}
{
	const s = Math.sin(Math.PI / 8), c = Math.cos(Math.PI / 8);   // z 軸まわり 45°
	const pts = [{ pos: [1.5, -2.25, 0.125], a: 255, dc: [0, 1, -1], logS: [0, -1, -2], q: [0, 0, s, c] }];
	for (const v of [2, 3]) {
		const d = await parseSpz(makeSpz(v, pts));
		ok(`spz${v}.pos`, d.n === 1 && near(d.positions[0], 1.5, 1e-3) && near(d.positions[1], -2.25, 1e-3) && near(d.positions[2], 0.125, 1e-3), JSON.stringify([...d.positions]));
		ok(`spz${v}.scale`, near(d.scales[0], 1, 0.05) && near(d.scales[1], Math.exp(-1), 0.02));
		ok(`spz${v}.color`, d.colors[3] === 255 && near(d.colors[1], (0.5 + SH_C0) * 255, 2) && near(d.colors[0], 128, 1), JSON.stringify([...d.colors]));
		ok(`spz${v}.rot`, near(Math.abs(d.rotations[2]), s, 0.01) && near(Math.abs(d.rotations[3]), c, 0.01) && near(d.rotations[0], 0, 0.01), JSON.stringify([...d.rotations]));
		ok(`spz${v}.axes`, d.axes === "y");
	}
	ok("spz.badMagic", await athrows(() => parseSpz(gzipSync(new Uint8Array(32)))));
	const raw = new Uint8Array(16); new DataView(raw.buffer).setUint32(0, 0x5053474e, true); new DataView(raw.buffer).setUint32(4, 9, true);
	ok("spz.badVersion", throws(() => decodeSpz(raw)));
}
// ---- 共分散・置き方 ----
{
	const R = quatMat(0, 0, Math.SQRT1_2, Math.SQRT1_2);   // z 軸まわり 90°：x → y
	ok("quat.z90", near(R[0], 0) && near(R[3], 1) && near(R[1], -1));
	const d = { n: 2, crs: "lnglat", positions: new Float32Array([139.7, 35.7, 10, 139.7 + 100 / (111194.93 * Math.cos(35.7 * Math.PI / 180)), 35.7, 10]), scales: new Float32Array([2, 1, 1, 1, 1, 1]), rotations: new Float32Array([0, 0, Math.SQRT1_2, Math.SQRT1_2, 0, 0, 0, 1]), colors: new Uint8Array(8).fill(255) };
	const e = toEnu(d);
	ok("enu.anchor", near(e.anchor[0], 139.7 + 50 / (111194.93 * Math.cos(35.7 * Math.PI / 180)), 1e-6) && near(e.anchor[2], 10));
	ok("enu.ctr", near(e.ctr[0], -50, 0.5) && near(e.ctr[3], 50, 0.5) && near(e.ctr[1], 0, 1e-3), JSON.stringify([...e.ctr]));
	ok("enu.cov", near(e.cov[0], 1, 1e-5) && near(e.cov[3], 4, 1e-5) && near(e.cov[5], 1, 1e-5) && near(e.cov[1], 0, 1e-5), JSON.stringify([...e.cov.slice(0, 6)]));   // 長い軸が北へ
	ok("enu.radius", near(e.radius, 50, 0.5));   // 経緯度の Float32 は 1 m ほどの目（契約の限り）
	const loc = toEnu({ n: 1, crs: "local", axes: "-y", positions: new Float32Array([1, -10, 2]), scales: new Float32Array([1, 3, 1]), rotations: new Float32Array([0, 0, 0, 1]), colors: new Uint8Array(4) }, { origin: [140, 35] });
	ok("local.-y", near(loc.ctr[0], 1) && near(loc.ctr[1], 2) && near(loc.ctr[2], 10) && near(loc.cov[5], 9), JSON.stringify([...loc.ctr, ...loc.cov]));   // y 下・z 前＝東 1・北 2・上 10・y の尺は上下
	const hd = toEnu({ n: 1, crs: "local", positions: new Float32Array([0, 10, 0]), scales: new Float32Array([1, 1, 1]), rotations: new Float32Array([0, 0, 0, 1]), colors: new Uint8Array(4) }, { origin: [140, 35], upAxis: "z", orientation: [90, 0, 0], scale: 2 });
	ok("local.heading", near(hd.ctr[0], 20, 1e-4) && near(hd.ctr[1], 0, 1e-4));   // 北の 10 m を東へ向け 2 倍
	ok("local.noOrigin", throws(() => toEnu({ n: 0, crs: "local", positions: new Float32Array(0), scales: new Float32Array(0), rotations: new Float32Array(0), colors: new Uint8Array(0) })));
	ok("local.badAxis", throws(() => placeMat("x")));
	const ec = toEnu({ n: 1, crs: "ecef", positions: new Float32Array([6378137 + 100, 0, 0]), scales: new Float32Array([1, 1, 1]), rotations: new Float32Array([0, 0, 0, 1]), colors: new Uint8Array(4) });
	ok("ecef.anchor", near(ec.anchor[0], 0, 1e-9) && near(ec.anchor[1], 0, 1e-9) && near(ec.anchor[2], 100, 1e-3), JSON.stringify(ec.anchor));
	const op = toEnu({ ...d, colors: new Uint8Array([10, 10, 10, 200, 10, 10, 10, 100]) }, { opacity: 0.5 });
	ok("opacity", op.rgba[3] === 100 && op.rgba[7] === 50);
	const b = enuBasis(0, 0); ok("basis", near(b.U[0] * 6371000, 1) && near(Math.hypot(...b.E) * 6371000, 1));
}
// ---- SH の詰め方（8 bit・4 個／u32・係数が先）と向き（rot＝東北上 → 元の軸） ----
{
	ok("shDeg", shDegreeOf(9) === 1 && shDegreeOf(24) === 2 && shDegreeOf(45) === 3 && shDegreeOf(7) === 0);
	const sh = new Float32Array(2 * 9); sh[0] = 2; sh[1] = -1; sh[8] = 0.5; sh[9 + 4] = -2;
	const p = packSh(sh, 2);
	const b = new Int8Array(p.shq.buffer);
	ok("pack.deg1", p && p.shDeg === 1 && p.words === 3 && p.shq.length === 6 && near(p.shScale, 2), JSON.stringify(p && { d: p.shDeg, w: p.words, s: p.shScale }));
	ok("pack.q", b[0] === 127 && b[1] === -63 && b[8] === 32 && b[12 + 4] === -127 && b[9] === 0, JSON.stringify([...b]));   // 係数 i*words*4 + k＝snorm8（×scale で戻る）
	const p2 = packSh(new Float32Array(45), 1); ok("pack.deg3", p2.shDeg === 3 && p2.words === 12 && p2.shq.length === 12);
	ok("pack.cap", packSh(new Float32Array(45), 1, 1).shDeg === 1 && packSh(new Float32Array(45), 1, 0) === null && packSh(new Float32Array(7), 1) === null);
	// rot：lnglat＝単位、local の heading 90°（北の 10 m が東へ）＝東北上の東の向きは元の軸の北（y）
	const un = toEnu({ n: 1, crs: "lnglat", positions: new Float32Array([139.7, 35.7, 0]), scales: new Float32Array(3).fill(1), rotations: new Float32Array([0, 0, 0, 1]), colors: new Uint8Array(4) });
	ok("rot.lnglat", [...un.rot].every((v, i) => near(v, i % 4 === 0 ? 1 : 0)), JSON.stringify([...un.rot]));
	const hd = toEnu({ n: 1, crs: "local", positions: new Float32Array([0, 10, 0]), scales: new Float32Array([1, 1, 1]), rotations: new Float32Array([0, 0, 0, 1]), colors: new Uint8Array(4) }, { origin: [140, 35], upAxis: "z", orientation: [90, 0, 0], scale: 2 });
	const R = hd.rot, ex = [R[0] * 1 + R[1] * 0 + R[2] * 0, R[3] * 1, R[6] * 1];   // 東北上の東 (1,0,0) → 元の軸
	ok("rot.heading", near(ex[0], 0, 1e-6) && near(ex[1], 1, 1e-6) && near(ex[2], 0, 1e-6) && near(Math.hypot(R[0], R[1], R[2]), 1, 1e-6), JSON.stringify(ex));   // 尺（2）は入らない
	const ec = toEnu({ n: 1, crs: "ecef", positions: new Float32Array([6378137, 0, 0]), scales: new Float32Array([1, 1, 1]), rotations: new Float32Array([0, 0, 0, 1]), colors: new Uint8Array(4) });
	const up = [ec.rot[2], ec.rot[5], ec.rot[8]];   // 東北上の上 (0,0,1) → 地心直交＝+x
	ok("rot.ecef", near(up[0], 1, 1e-6) && near(up[1], 0, 1e-6) && near(up[2], 0, 1e-6), JSON.stringify(up));
	// 奥行きの範囲＝箱の 8 隅
	const [lo, hi] = depthRange([-1, -2, -3, 1, 2, 3], [0, 1, 0]); ok("range", lo === -2 && hi === 2);
	const [lo2, hi2] = depthRange([-1, -2, -3, 1, 2, 3], [1, 1, 1]); ok("range.diag", lo2 === -6 && hi2 === 6);
}
// ---- 並べ替え（奥＝w の大きい物が先） ----
{
	const ctr = new Float32Array([0, 5, 0, 0, -3, 0, 0, 10, 0, 0, 0, 0]);
	const o = sortOrder(ctr, 4, [0, 1, 0]);
	ok("sort.far", [...o].join(",") === "2,0,3,1", [...o].join(","));
	const o2 = sortOrder(ctr, 4, [0, -1, 0]);
	ok("sort.turn", [...o2].join(",") === "1,3,0,2", [...o2].join(","));
	ok("sort.flat", sortOrder(new Float32Array(6), 2, [0, 0, 1]).length === 2);
}
// ---- LoD（順位＝大きくて濃い物が先・個数＝足跡 × 密度を 1.25 倍の段に） ----
{
	const sc = new Float32Array([1, 1, 1, 0.1, 0.1, 0.1, 1, 1, 1, 5, 5, 5]), co = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 10, 0, 0, 0, 255]);
	const r = importanceRank(sc, co, 4);
	ok("rank.order", r[3] === 0 && r[0] === 1 && r[1] === 2 && r[2] === 3, JSON.stringify([...r]));   // 大きい 5m → 1m 濃い → 小さい 0.1m（α 1 × 0.1 m＝0.1）→ 1m 薄い（α 0.04 × 1 m＝0.04）
	ok("rank.perm", new Set(r).size === 4 && importanceRank(new Float32Array(0), new Uint8Array(0), 0).length === 0);
	const same = importanceRank(new Float32Array(6).fill(1), new Uint8Array(8).fill(255), 2);
	ok("rank.ties", new Set(same).size === 2, JSON.stringify([...same]));   // 同じ重さでも順位は重ならない
	ok("lod.all", lodCount(1e9, 100000, 2) === 100000 && lodCount(10, 3000, 2) === 3000 && lodCount(10, 100000, 0) === 100000);   // 足跡が大きい・小さい層・密度 0＝全部
	const n1 = lodCount(100, 1000000, 2), n2 = lodCount(10000, 1000000, 2);
	ok("lod.min", n1 >= 4096 && n1 <= 4096 * 1.25 && n1 < 1000000, String(n1));   // 最低 4096 を 1.25 倍の段に
	ok("lod.step", n2 === Math.round(1.25 ** 45) && n2 >= 20000 && n2 <= 25000, String(n2));   // 10000 px² × 2＝20000 → 次の 1.25 倍の段（1.25^45≈22959）
	// 画素／m：ピンホール（焦点 f px）で錨が z=10m 先＝1 m が f/10 px。mvp は列優先（col j＝東北上の j 軸・col 3＝錨）
	const f = 500, w = 1000, h = 800, mvp = [f / (w / 2), 0, 0, 0, 0, f / (h / 2), 0, 0, 0, 0, 1, 1, 0, 0, 0, 10];   // x,y → ndc＝f·x/(w/2)/w_clip・z 軸は w に効く
	ok("ppm", near(pixelsPerMeter(mvp, w, h), f / 10, 1e-6) && pixelsPerMeter([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, -1], w, h) === 0, String(pixelsPerMeter(mvp, w, h)));
}
// ---- local＋transform（列優先 4×4・file → ECEF＝3D Tiles の glTF）＝錨は重心・中心は錨からの東北上・共分散と SH の向きは transform の 3×3 ----
{
	const lon = 139.7671 * Math.PI / 180, lat = 35.6812 * Math.PI / 180, h0 = 40, a = 6378137, e2 = 0.00669437999014, N = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
	const O = [(N + h0) * Math.cos(lat) * Math.cos(lon), (N + h0) * Math.cos(lat) * Math.sin(lon), (N * (1 - e2) + h0) * Math.sin(lat)];
	const E = [-Math.sin(lon), Math.cos(lon), 0], Nn = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)], U = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
	const ENU = [...E, 0, ...Nn, 0, ...U, 0, ...O, 1];   // 列優先＝x 東・y 北・z 上
	const two = (over = {}) => ({ n: 2, crs: "local", positions: new Float32Array([0, 0, 0, 10, 0, 4]), scales: new Float32Array([1, 2, 3, 1, 2, 3]), rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), colors: new Uint8Array(8), ...over });
	const e = toEnu(two(), { transform: ENU });
	const lonC = 139.7671 + 5 / (111320 * Math.cos(lat));   // 重心＝(5, 0, 2)＝東 5m・上 2m
	ok("xf.anchor", near(e.anchor[0], lonC, 2e-7) && near(e.anchor[1], 35.6812, 2e-6) && near(e.anchor[2], 42, 0.05), JSON.stringify(e.anchor));
	ok("xf.ctr", near(e.ctr[0], -5, 1e-3) && near(e.ctr[1], 0, 1e-3) && near(e.ctr[2], -2, 1e-3) && near(e.ctr[3], 5, 1e-3) && near(e.ctr[5], 2, 1e-3), JSON.stringify([...e.ctr]));
	ok("xf.cov", near(e.cov[0], 1, 1e-4) && near(e.cov[3], 4, 1e-4) && near(e.cov[5], 9, 1e-4) && near(e.cov[1], 0, 1e-4), JSON.stringify([...e.cov.slice(0, 6)]));   // 回転無し＝対角（東 1・北 4・上 9）
	ok("xf.rot", near(e.rot[0], 1, 1e-6) && near(e.rot[4], 1, 1e-6) && near(e.rot[8], 1, 1e-6), JSON.stringify([...e.rot]));
	// glTF の Y-up（x 東・y 上・z 南）＝SWAP を畳んだ transform：局所の y が上に、z が −北に
	const SW = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];   // 列優先：(x,y,z) → (x, −z, y)
	const mul = (A, B) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = A[r] * B[c * 4] + A[4 + r] * B[c * 4 + 1] + A[8 + r] * B[c * 4 + 2] + A[12 + r] * B[c * 4 + 3]; return o; };
	const y = toEnu({ ...two(), positions: new Float32Array([0, 0, 0, 0, 10, 0]) }, { transform: mul(ENU, SW) });
	ok("xf.yup", near(y.ctr[2], -5, 1e-3) && near(y.ctr[5], 5, 1e-3) && near(y.ctr[0], 0, 1e-3), JSON.stringify([...y.ctr]));
	ok("xf.yupCov", near(y.cov[0], 1, 1e-4) && near(y.cov[3], 9, 1e-4) && near(y.cov[5], 4, 1e-4), JSON.stringify([...y.cov.slice(0, 6)]));   // 尺 (1,2,3)＝東 1・上 2（y）・北 3（z）
	ok("xf.yupRot", near(y.rot[5], 1, 1e-6) && near(y.rot[7], -1, 1e-6), JSON.stringify([...y.rot]));   // 東北上 → file：上 → y・北 → −z
	// 尺を持つ transform（2 倍）＝中心も共分散も 2 倍（共分散は 4 倍）
	const S2 = [...ENU]; for (let i = 0; i < 12; i++) S2[i] *= 2;
	const s = toEnu(two(), { transform: S2 });
	ok("xf.scale", near(s.ctr[3], 10, 1e-3) && near(s.cov[0], 4, 1e-3) && near(s.rot[0], 1, 1e-6), JSON.stringify([...s.ctr, ...s.cov.slice(0, 1)]));
	// data の transform（SplatData.transform）でも同じ・opts が勝つ
	const d2 = toEnu(two({ transform: ENU }));
	ok("xf.inData", near(d2.ctr[3], 5, 1e-3));
	ok("xf.optsWin", near(toEnu(two({ transform: ENU }), { transform: S2 }).ctr[3], 10, 1e-3));
	// prepare は origin 無しでも transform で通る・形の間違いは投げる
	const p = prepare(checkSplatData(two({ transform: ENU })), { lod: false }, false);
	ok("xf.prepare", p.n === 2 && near(p.anchor[0], lonC, 2e-7) && p.rank === null);
	ok("xf.bad", throws(() => checkSplatData(two({ transform: [1, 2, 3] }))) && throws(() => checkSplatData(two({ transform: new Array(16).fill(NaN) }))) && throws(() => toEnu(two(), { transform: [1] })));
}
// ---- 下ごしらえの一式（prepare＝main と worker で同じ）・worker の read を main で呼ぶ ----
{
	const d = checkSplatData({ positions: new Float32Array([139.7, 35.6, 10, 139.7001, 35.6, 10]), scales: new Float32Array([1, 1, 1, 3, 3, 3]), rotations: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), colors: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), sh: new Float32Array(18).fill(0.5) });
	const p = prepare(d, { shDegree: 3, lod: true }, true);
	ok("prep.shape", p.n === 2 && p.ctr.length === 6 && p.cov.length === 12 && p.rank?.length === 2 && p.sh?.shDeg === 1 && p.rgba !== d.colors, JSON.stringify({ n: p.n, rank: [...(p.rank || [])], sh: p.sh?.shDeg }));
	ok("prep.rank", p.rank[1] === 0 && p.rank[0] === 1);   // 3m の方が重い
	ok("prep.noLod", prepare(d, { lod: false }, false).rank === null && prepare(d, { shDegree: 0 }, false).sh === null);
	const b = new ArrayBuffer(32), dv = new DataView(b); [1, 2, 3].forEach((v, k) => dv.setFloat32(k * 4, v, true)); [0.5, 0.5, 0.5].forEach((v, k) => dv.setFloat32(12 + k * 4, v, true)); new Uint8Array(b).set([255, 255, 0, 255, 255, 128, 128, 128], 24);
	const rd = await read(b, "splat", { origin: [139.7, 35.6, 0], lod: true });
	ok("read.bytes", rd.n === 1 && rd.crs === "local" && near(rd.anchor[0], 139.7) && rd.rank?.length === 1, JSON.stringify({ n: rd.n, a: rd.anchor }));
	const rf = await read("http://x/a.splat", "splat", { origin: [0, 0] }, async () => ({ ok: true, arrayBuffer: async () => b }));
	ok("read.fetch", rf.n === 1 && rf.rgba[0] === 255 && rf.rgba[2] === 0);
	ok("read.http", await athrows(() => read("http://x/a.splat", "splat", { origin: [0, 0] }, async () => ({ ok: false, status: 404 }))));
	ok("read.data", (await read({ positions: new Float32Array([1, 2, 3]), scales: new Float32Array([1, 1, 1]), rotations: new Float32Array([0, 0, 0, 1]), colors: new Uint8Array([1, 2, 3, 4]) }, null, {})).n === 1);
	ok("read.noFormat", await athrows(() => read(b, null, {})));
}
// ---- 契約・plugin の形 ----
{
	ok("check.len", throws(() => checkSplatData({ n: 2, positions: new Float32Array(3), scales: new Float32Array(6), rotations: new Float32Array(8), colors: new Uint8Array(8) })));
	ok("check.crs", throws(() => checkSplatData({ n: 0, crs: "utm", positions: new Float32Array(0), scales: new Float32Array(0), rotations: new Float32Array(0), colors: new Uint8Array(0) })));
	ok("check.ok", checkSplatData({ positions: new Float32Array(3), scales: new Float32Array(3), rotations: new Float32Array(4), colors: new Uint8Array(4) }).n === 1);
	const p = splatPlugin();
	ok("plugin.shape", p.name === "plugin-splat" && p.provides.join() === "data.splat" && typeof p.install === "function");
	const added = new Map(), map = { registry: { dataKinds: { add: (k, v) => added.set(k, v), remove: k => added.delete(k) } } };
	const off = p.install(map);
	ok("plugin.install", typeof added.get("splat")?.create === "function");
	off(); ok("plugin.uninstall", !added.has("splat"));
	ok("plugin.badDecoder", throws(() => splatPlugin({ decoders: { gltf: () => null } })) && throws(() => splatPlugin({ decoders: { spz: 1 } })));
}
console.log(fails ? `${fails} FAIL` : "ALL PASS plugin-splat");
process.exit(fails ? 1 : 0);
