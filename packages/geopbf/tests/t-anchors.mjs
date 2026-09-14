// t-anchors: 度アンカー（1°ごとの L1）＝insertDegreeAnchors（v1機構の復元・米加国境49°線）。v5＝内挿は大円（完全球体）。
// gint は保持頂点間を直線チョードで描く＝LOD後も「アンカー間の累積経緯度スパン≤1°」を保証する：
//   ①長辺（>1°）＝L1点の内挿 ②密な低rank頂点列＝1°窓ごとの既存頂点L1昇格 ③1°箱内のarc＝完全無変換。
// wasm 全量経路（topologyFullWasm→anchorFullGintBuf）で検定＝本番と同経路。
globalThis.ImageData ??= class ImageData { };
import { GeoPBF } from "../src/pbf-base.js";
import { topology, unPackGintBuffer } from "../src/extension/topology.js";
import { gint } from "../src/extension/gint.js";
import { identifyAt } from "../src/extension/identify.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
{
	const wasmJs = fileURLToPath(new URL("../wasm/pkg/gint_wasm.js", import.meta.url));
	const mod = await import(wasmJs);
	await mod.default({ module_or_path: readFileSync(wasmJs.replace(/\.js$/, "_bg.wasm")) });
	await gint.initialize();
}

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const F = (type, coordinates, properties = {}) => ({ type: "Feature", properties, geometry: { type, coordinates } });
const bake = async features => { const p = await new GeoPBF({ name: "t-anchors" }).set({ type: "FeatureCollection", features }); return unPackGintBuffer(topology(p)); };   // node＝worker無し＝t-large と同じ直叩き
const LIMIT = 10000000;
// arc走査の道具：頂点列（int）と rank（terminal=63）
const arcVerts = (d, a) => {
	const off = d.arcMeta[a * 8], len = d.arcMeta[a * 8 + 1], out = [];
	for (let i = 0; i < len; i++) { const m = d.arcBuffer[off - d.arcMeta[0] + i]; out.push({ xy: gint.unpackToInt(m), w: gint.getWeight(m) }); }
	return out;
};
const spans = vs => vs.slice(1).map((v, i) => { let dx = Math.abs(v.xy[0] - vs[i].xy[0]); if (dx > 1800000000) dx = 3600000000 - dx; return Math.max(dx, Math.abs(v.xy[1] - vs[i].xy[1])); });
const maxAnchorGap = vs => { let acc = 0, worst = 0; const ds = spans(vs); for (let i = 0; i < ds.length; i++) { acc += ds[i]; if (vs[i + 1].w >= 63) { worst = Math.max(worst, acc); acc = 0; } } return worst; };

// ① 米加国境型＝2頂点で経度30°の直線（49°N）→ 内挿で ≥31頂点・全辺≤1°・内部は全部アンカー（rank63）
{
	const d = await bake([F("LineString", [[-130, 49], [-100, 49]])]);
	const vs = arcVerts(d, 0);
	ok(vs.length >= 31, `長辺の内挿（頂点 ${vs.length} ≥ 31）`);
	ok(spans(vs).every(s => s <= LIMIT), "全辺の張り ≤1°");
	ok(vs.every(v => v.w >= 63), "内挿点は L1 アンカー（rank63＝全LOD保持）");
}
// ② 密な低rank頂点列（0.9°刻み・微ジッタの12°線）→ 1°窓ごとに既存頂点が昇格＝アンカー間隔≤1°
{
	const pts = []; for (let i = 0; i <= 13; i++) pts.push([100 + i * 0.9, 49 + (i % 2 ? 0.001 : -0.001)]);
	const d = await bake([F("LineString", pts)]);
	const vs = arcVerts(d, 0);
	const anchors = vs.filter(v => v.w >= 63).length;
	ok(anchors >= 12, `既存頂点の昇格（アンカー ${anchors} ≥ 12）`);
	ok(maxAnchorGap(vs) <= LIMIT, "アンカー間の累積スパン ≤1°");
}
// ③ 大きな三角形ポリゴン（エディタの二重線の型）＝環にもアンカー
{
	const d = await bake([F("Polygon", [[[10, 10], [30, 10], [20, 25], [10, 10]]])]);
	const vs = arcVerts(d, 0);
	ok(vs.length >= 50 && maxAnchorGap(vs) <= LIMIT, `環も内挿+昇格（頂点 ${vs.length}・最大アンカー間隔 ≤1°）`);
}
// ④ 1°箱に収まる密ポリゴン＝完全無変換（bboxゲート＝密データはゼロ費用）
{
	const ring = []; for (let i = 0; i <= 40; i++) { const t = i / 40 * Math.PI * 2; ring.push([10.5 + 0.3 * Math.cos(t), 10.5 + 0.3 * Math.sin(t)]); }
	const d = await bake([F("Polygon", [ring])]);
	const vs = arcVerts(d, 0);
	ok(vs.length === 41 && vs.slice(1, -1).every(v => v.w < 63), `1°箱内は素通り（頂点 ${vs.length}・内部昇格なし）`);
}
// ⑤ 極付近の長辺（65°N・経度 100°）＝内挿点は始点→終点の大円面上（法線との内積≈0）・極側へ膨らむ・arc bbox も膨らみを含む
{
	const d = await bake([F("LineString", [[100, 65], [-160, 65]])]);
	const vs = arcVerts(d, 0);
	const S = 1e7, D2R = Math.PI / 180;
	const vec = ([x, y]) => { const lon = (x / S - 180) * D2R, lat = (y / S - 90) * D2R, c = Math.cos(lat); return [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)]; };
	const a = vec(vs[0].xy), b = vec(vs[vs.length - 1].xy);
	const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]], nl = Math.hypot(...n);
	const off = Math.max(...vs.map(v => { const p = vec(v.xy); return Math.abs((p[0] * n[0] + p[1] * n[1] + p[2] * n[2]) / nl); }));
	const maxLat = Math.max(...vs.map(v => v.xy[1] / S - 90));
	ok(off < 1e-6, `内挿点は大円面上（面からの最大ずれ ${off.toExponential(2)} < 1e-6）`);
	ok(maxLat > 70, `大円は極側へ膨らむ（最大緯度 ${maxLat.toFixed(2)}° > 70°）`);
	ok(spans(vs).every(s => s <= LIMIT) && vs.every(v => v.w >= 63), "極付近でも全辺 ≤1°・全点アンカー");
	ok(d.arcMeta[7] >= Math.round((maxLat + 90) * S), "arc bbox が大円の膨らみを含む");
	ok(d.bbox[3] >= maxLat - 1e-6, `全体 bbox も膨らみを含む（${d.bbox[3].toFixed(3)}）`);
}
// ⑥ 極を越える辺（[0,80]→[180,80]＝大円は北極を通る）＝経度が 0→±180 に跳ぶ特異点を免除して両側に内挿・極の点を含む・膨らまない点数
{
	const d = await bake([F("LineString", [[0, 80], [180, 80]])]);
	const vs = arcVerts(d, 0), S = 1e7;
	const lats = vs.map(v => v.xy[1] / S - 90), lons = vs.map(v => v.xy[0] / S - 180);
	ok(Math.max(...lats) >= 89.999, `極を通る（最大緯度 ${Math.max(...lats).toFixed(3)}）`);
	ok(lons.some(l => Math.abs(l) < 1e-6) && lons.some(l => Math.abs(Math.abs(l) - 180) < 1e-6), "極の両側（lon 0 側と ±180 側）に内挿点");
	ok(vs.length >= 21 && vs.length <= 400, `点数は妥当（${vs.length}）`);
	const p = await bake([F("Polygon", [[[0, 80], [90, 80], [180, 80], [-90, 80], [0, 80]]])]);   // 極を囲む環（エンコーダが柱で閉じる）＝極の柱 (180,90)→(-180,90) に内挿なし
	ok(p.arcCount >= 1 && p.bbox[3] >= 89.999 && p.bbox[0] <= -179.999 && p.bbox[2] >= 179.999, `極を囲む環＝gint に載る（bbox ${p.bbox.map(v => v.toFixed(1)).join(",")}）`);
}

// ⑨ 縫い目辺のアンカー＝+180 の枝に留まる（縫い目跨ぎの矩形・大きい円が「内側で掴めず外側で掴める」9/15 の根治）
//   東片の縫い目辺（+180・長さ 2°）に打たれる L1 が x=0（−180）へ落ちるとレイキャストの偶奇が壊れる
{
	const PERIOD = 3600000000, onW = ix => ix <= 2, onE = ix => ix >= PERIOD - 2;
	const rect = [[179, 34], [-179, 34], [-179, 36], [179, 36], [179, 34]];   // 縫い目を跨ぐ矩形（縦辺 2°）
	const p = await new GeoPBF({ name: "t-anchors" }).set({ type: "FeatureCollection", features: [F("Polygon", [rect])] });
	ok(p.features[0].geometry.type === "MultiPolygon" && p.features[0].geometry.coordinates.length === 2, "エンコーダが2片に切っている（前提）");
	const d = unPackGintBuffer(topology(p));
	let mixed = 0, seamE = 0, seamW = 0;
	for (let a = 0; a < d.arcMeta.length / 8; a++) {
		const vs = arcVerts(d, a), seam = vs.filter(v => onW(v.xy[0]) || onE(v.xy[0]));
		const e = seam.filter(v => onE(v.xy[0])).length, w = seam.filter(v => onW(v.xy[0])).length;
		if (e && w) mixed++;
		seamE += e; seamW += w;
	}
	ok(mixed === 0 && seamE >= 3 && seamW >= 3, `縫い目頂点は片ごとに同じ枝（E=${seamE} W=${seamW} 混在arc=${mixed}）`);
	const self = { unPackGint: d };
	ok(identifyAt(self, -179.5, 35) === 0 && identifyAt(self, 179.5, 35.5) === 0 && identifyAt(self, -179.9, 34.2) === 0 && identifyAt(self, 179.9, 35.9) === 0, "矩形の内側（両片・縫い目近く）で identify が当たる");
	ok(identifyAt(self, -178.5, 35) === null && identifyAt(self, 178.5, 35) === null && identifyAt(self, -179.5, 36.5) === null, "矩形の外側では当たらない");
}
console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
