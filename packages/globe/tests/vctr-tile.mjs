// 3D Tiles の Vector タイル（.vctr・実験的な形式）の読みの門（2026-10-31）：多角形が「最低〜最高の高さの閉じた外向きの柱」になる。
// 3d-tiles-terrain-classification（ウィーンの区画）が使う。反時計回り・時計回りの輪の両方で、辺が逆向きにちょうど 2 回ずつ使われ（閉じている）、体積が正（外向き）。
// node tests/vctr-tile.mjs
const { decodeVctr } = await import("../src/vctr-tile.ts");
const { featureProperties } = await import("../src/mesh-features.ts");
let fails = 0; const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
const D = Math.PI / 180, REGION = [16 * D, 48 * D, 16.01 * D, 48.01 * D, 100, 500];
const zig = a => { let prev = 0; return a.map(x => { const d = x - prev; prev = x; return ((d << 1) ^ (d >> 31)) & 0xFFFF; }); };
/** 四角形 1 つ（輪＝cw なら時計回り）の .vctr。ftJ の高さは JSON の配列で（binary の参照と両方の口を試すため batch id は binary） */
function make(cw) {
	const u = [0, 32767, 32767, 0], v = cw ? [32767, 32767, 0, 0] : [0, 0, 32767, 32767];
	const ftJ = { POLYGONS_LENGTH: 1, REGION, POLYGON_COUNTS: [4], POLYGON_INDEX_COUNTS: [6], POLYGON_MINIMUM_HEIGHTS: [150], POLYGON_MAXIMUM_HEIGHTS: [450], POLYGON_BATCH_IDS: { byteOffset: 0 } };
	const pad = (s, at) => s + " ".repeat((8 - (at + s.length) % 8) % 8);
	const jtxt = new TextEncoder().encode(pad(JSON.stringify(ftJ), 44)), fbin = new Uint8Array(8); new DataView(fbin.buffer).setUint16(0, 0, true);
	const btxt = new TextEncoder().encode(pad(JSON.stringify({ name: ["x"] }), 44 + jtxt.length + 8));
	const idx = new Uint32Array([0, 1, 2, 0, 2, 3]), pos = new Uint16Array([...zig(u), ...zig(v)]);
	const total = 44 + jtxt.length + fbin.length + btxt.length + idx.byteLength + pos.byteLength, ab = new ArrayBuffer(total), dv = new DataView(ab), u8 = new Uint8Array(ab);
	u8.set(new TextEncoder().encode("vctr"), 0);
	[1, total, jtxt.length, fbin.length, btxt.length, 0, idx.byteLength, pos.byteLength, 0, 0].forEach((x, i) => dv.setUint32(4 + i * 4, x, true));
	let p = 44; u8.set(jtxt, p); p += jtxt.length; u8.set(fbin, p); p += fbin.length; u8.set(btxt, p); p += btxt.length;
	u8.set(new Uint8Array(idx.buffer), p); p += idx.byteLength; u8.set(new Uint8Array(pos.buffer), p);
	return ab;
}
for (const cw of [false, true]) {
	const g = decodeVctr(make(cw)), tag = cw ? "時計回り" : "反時計回り";
	ok(g && g.parts.length === 1, `${tag}：柱 1 本（${g?.parts.length}）`);
	const q = g.parts[0];
	ok(q.id === 0 && q.shape === -1, `${tag}：batch id 0（binary の参照）・内外の判定なし（${q.id}, ${q.shape}）`);
	ok(featureProperties(g.table, 0).name === "x", `${tag}：バッチ表の名（${featureProperties(g.table, 0).name}）`);
	ok(q.idx.length === 6 * 2 + 4 * 6, `${tag}：天井 2・底 2・側面 8 の三角形（${q.idx.length / 3}）`);
	// 閉じている＝有向辺 a→b ごとに b→a がちょうど 1 本
	const E = new Map(); let open = 0;
	for (let i = 0; i < q.idx.length; i += 3) for (let k = 0; k < 3; k++) { const a = q.idx[i + k], b = q.idx[i + (k + 1) % 3], key = `${a},${b}`; E.set(key, (E.get(key) || 0) + 1); }
	for (const [key, n] of E) { const [a, b] = key.split(","); if (n !== 1 || E.get(`${b},${a}`) !== 1) open++; }
	ok(open === 0, `${tag}：閉じている（合わない辺 ${open}）`);
	// 外向き＝符号付き体積が正
	let vol = 0; const P = i => [q.pos[i * 3] + g.center[0], q.pos[i * 3 + 1] + g.center[1], q.pos[i * 3 + 2] + g.center[2]];
	for (let i = 0; i < q.idx.length; i += 3) { const a = P(q.idx[i]), b = P(q.idx[i + 1]), c = P(q.idx[i + 2]); vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; }
	const expect = (0.01 * D * 6378137) * (0.01 * D * 6378137 * Math.cos(48 * D)) * 300;
	ok(vol > 0 && Math.abs(vol / expect - 1) < 0.02, `${tag}：外向きの体積 ≈ 底面 × 300 m（${(vol / 1e6).toFixed(1)} / ${(expect / 1e6).toFixed(1)} 百万 m³）`);
	// 天井・底の高さ（楕円体の高さ）＝450・150
	const h = i => { const [x, y, z] = P(i), A = 6378137, E2 = 6.69437999014e-3, p = Math.hypot(x, y); let lat = Math.atan2(z, p * (1 - E2)), N = A, hh = 0; for (let k = 0; k < 6; k++) { N = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2); hh = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - E2 * N / (N + hh))); } return hh; };
	ok(Math.abs(h(0) - 450) < 0.5 && Math.abs(h(1) - 150) < 0.5, `${tag}：天井 450 m・底 150 m（${h(0).toFixed(1)}, ${h(1).toFixed(1)}）`);
}
ok(decodeVctr((() => { const ab = new ArrayBuffer(12), dv = new DataView(ab); new Uint8Array(ab).set(new TextEncoder().encode("vctr")); dv.setUint32(4, 1, true); return ab; })()) === null, "空のタイル（12 バイト）＝null");
if (fails) { console.error(`✗ vctr-tile: ${fails} 件`); process.exit(1); }
console.log("✓ vctr-tile 全部");
