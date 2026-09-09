// t-anchors: 度アンカー（1°ごとの L1）＝insertDegreeAnchors（v1機構の復元・米加国境49°線）。
// gint は保持頂点間を直線チョードで描く＝LOD後も「アンカー間の累積経緯度スパン≤1°」を保証する：
//   ①長辺（>1°）＝L1点の内挿 ②密な低rank頂点列＝1°窓ごとの既存頂点L1昇格 ③1°箱内のarc＝完全無変換。
// wasm 全量経路（topologyFullWasm→anchorFullGintBuf）で検定＝本番と同経路。
globalThis.ImageData ??= class ImageData { };
import { GeoPBF } from "../src/pbf-base.js";
import { topology, unPackGintBuffer } from "../src/extension/topology.js";
import { gint } from "../src/extension/gint.js";
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

console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
