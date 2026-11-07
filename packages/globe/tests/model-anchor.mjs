// glb 自身の錨（asset.extras.orthoEarth＝Unity との往復・docs/notes/unity-roundtrip.md §2.3・2026-11-07）：
//   atGiven=false（呼び手の at は画面中心の補い）なら錨で置く・heading も錨の物・ground="absolute" の時だけ楕円体高を乗せる。
//   atGiven=true（?at= で落とした）なら従来どおり at が勝つ。frame が enu でない・壊れた錨は無視。
import { decodeModel, orthoEarthAnchorOf } from "../src/meshdecode.ts";
globalThis.self ??= globalThis;
let fails = 0; const ok = (n, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${info ? " " + info : ""}`); if (!c) fails++; };
function glbOf(json, views) {
	const parts = []; let off = 0; json.bufferViews = []; json.buffers = [{ byteLength: 0 }];
	for (const u8 of views) { while (off % 8) { parts.push(new Uint8Array(1)); off++; } json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: u8.byteLength }); parts.push(u8); off += u8.byteLength; }
	while (off % 4) { parts.push(new Uint8Array(1)); off++; }
	json.buffers[0].byteLength = off;
	const bin = new Uint8Array(off); let o = 0; for (const p of parts) { bin.set(p, o); o += p.byteLength; }
	const js = new TextEncoder().encode(JSON.stringify(json)), jl = (js.length + 3) & ~3;
	const glb = new ArrayBuffer(28 + jl + off), dv = new DataView(glb), u8 = new Uint8Array(glb);
	dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, glb.byteLength, true);
	dv.setUint32(12, jl, true); dv.setUint32(16, 0x4E4F534A, true); u8.set(js, 20); for (let i = 20 + js.length; i < 20 + jl; i++) u8[i] = 0x20;
	dv.setUint32(20 + jl, off, true); dv.setUint32(24 + jl, 0x004E4942, true); u8.set(bin, 28 + jl);
	return glb;
}
const B = a => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
// 東へ 100 m 伸びた三角形（glTF の +X＝東）・高さ 0〜5 m
const model = (extras) => {
	const json = { asset: { version: "2.0", ...(extras && { extras }) }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] }, doubleSided: true }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
		accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [100, 5, 0] }, { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }] };
	return glbOf(json, [B(Float32Array.of(0, 0, 0, 100, 0, 0, 0, 5, 0)), B(Uint16Array.of(0, 1, 2))]);
};
const OE = { orthoEarth: { version: 1, anchor: { lon: 139.7671, lat: 35.6812, height: 40 }, frame: "enu", heading: 0 } };
const center = (bb) => [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
const near = (a, b, tol) => Math.abs(a - b) <= tol;

ok("orthoEarthAnchorOf.read", JSON.stringify(orthoEarthAnchorOf({ asset: { extras: OE } })) === JSON.stringify({ lon: 139.7671, lat: 35.6812, height: 40, heading: 0 }));
ok("orthoEarthAnchorOf.none", orthoEarthAnchorOf({ asset: {} }) === null && orthoEarthAnchorOf(null) === null);
ok("orthoEarthAnchorOf.badFrame", orthoEarthAnchorOf({ asset: { extras: { orthoEarth: { anchor: { lon: 1, lat: 2 }, frame: "ecef" } } } }) === null);
ok("orthoEarthAnchorOf.badLat", orthoEarthAnchorOf({ asset: { extras: { orthoEarth: { anchor: { lon: 1, lat: 95 } } } } }) === null);
{
	// 画面中心の補い（atGiven=false）＝glb の錨で置く
	const r = await decodeModel(model(OE), { at: [135, 34.7], atGiven: false });
	const c = center(r.stats.bbox);
	ok("extras.placed", r.stats.mode === "anchor" && r.stats.anchor?.from === "extras" && near(c[0], 139.7671 + 0.00055, 2e-4) && near(c[1], 35.6812, 1e-4), `${r.stats.mode} ${c}`);   // 東へ 100 m の三角形＝中心は錨の東 50 m（≈0.00055°）
	ok("extras.bboxEast", r.stats.bbox[2] - r.stats.bbox[0] > 0.0009 && r.stats.bbox[3] - r.stats.bbox[1] < 1e-5, String(r.stats.bbox));   // 東西 100 m・南北 ≈ 0
	// ?at= で落とした（atGiven=true）＝at が勝つ
	const g = await decodeModel(model(OE), { at: [135, 34.7], atGiven: true });
	ok("given.wins", !g.stats.anchor && near(center(g.stats.bbox)[0], 135 + 0.00055, 2e-4) && near(center(g.stats.bbox)[1], 34.7, 1e-4), String(g.stats.bbox));
	// atGiven 省略（他の呼び手）＝従来どおり at
	const d = await decodeModel(model(OE), { at: [135, 34.7] });
	ok("default.atWins", !d.stats.anchor && near(center(d.stats.bbox)[1], 34.7, 1e-4));
	// 錨の無い glb＝従来どおり
	const n = await decodeModel(model(null), { at: [135, 34.7], atGiven: false });
	ok("noExtras.at", !n.stats.anchor && near(center(n.stats.bbox)[1], 34.7, 1e-4));
}
{
	// heading＝錨の物（90°＝東向きの +X が南を向く）
	const r = await decodeModel(model({ orthoEarth: { ...OE.orthoEarth, heading: 90 } }), { at: [0, 0], atGiven: false, heading: 0 });
	const bb = r.stats.bbox;
	ok("extras.heading", r.stats.anchor?.heading === 90 && bb[3] - bb[1] > 0.0008 && bb[2] - bb[0] < 1e-5, String(bb));   // 南北 100 m・東西 ≈ 0
}
{
	// 高さ：既定（batch＝接地）は錨の高さを使わない・absolute は楕円体高 40 m を乗せる＝原点の半径が 40 m 違う
	const b = await decodeModel(model(OE), { at: [0, 0], atGiven: false }), a = await decodeModel(model(OE), { at: [0, 0], atGiven: false, ground: "absolute" });
	const rOf = m => Math.hypot(m.origin[0], m.origin[1], m.origin[2]) * 6371000;   // 世界座標（単位球・≈ 地球半径で m）
	const dr = rOf(a.batches[0].mesh) - rOf(b.batches[0].mesh);
	ok("absolute.height", near(dr, 40, 1), `Δr ${dr.toFixed(2)} m`);
}
console.log(fails ? `\nFAIL ${fails}` : "\nPASS model-anchor");
process.exit(fails ? 1 : 0);
