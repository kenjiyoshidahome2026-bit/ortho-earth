// node の検定：読み手（.ply・.splat・.spz v2/v3）・東北上への下ごしらえ（lnglat・ecef・local）・共分散・視線順の並べ替え・plugin の形。描画は globe の頁 t-psplat。
import { gzipSync } from "node:zlib";
import { parsePly, parseSplat, parseSpz, decodeSpz, toEnu, quatMat, placeMat, checkSplatData, splatPlugin, SH_C0 } from "../src/index.ts";
import { sortOrder, enuBasis } from "../src/splat-gl.ts";
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
	ok("ply.sh", d.sh?.length === 2 && d.sh[0] === 0.5);
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
// ---- 並べ替え（奥＝w の大きい物が先） ----
{
	const ctr = new Float32Array([0, 5, 0, 0, -3, 0, 0, 10, 0, 0, 0, 0]);
	const o = sortOrder(ctr, 4, [0, 1, 0]);
	ok("sort.far", [...o].join(",") === "2,0,3,1", [...o].join(","));
	const o2 = sortOrder(ctr, 4, [0, -1, 0]);
	ok("sort.turn", [...o2].join(",") === "1,3,0,2", [...o2].join(","));
	ok("sort.flat", sortOrder(new Float32Array(6), 2, [0, 0, 1]).length === 2);
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
