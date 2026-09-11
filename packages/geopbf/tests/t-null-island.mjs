// t-null-island: 先頭頂点が (0,0) の環・線・点が位相構築（topology）で落ちない。
// 座標は差分符号化で原点=(0,0)＝先頭頂点が null island だと差分0になり、入口の「ゼロデルタ＝連続重複点は棄却」
// に巻き込まれて黙って消えていた（JS read() と Rust read_line の両経路・8/26 発見→9/12 根治＝1点目は必ず採用）。
// JS 経路（wasm 未初期化）→ wasm 全量経路（本番）の順に同じ検定を回す。
globalThis.ImageData ??= class ImageData { };
import { GeoPBF } from "../src/pbf-base.js";
import { topology, unPackGintBuffer } from "../src/extension/topology.js";
import { gint } from "../src/extension/gint.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const F = (type, coordinates, properties = {}) => ({ type: "Feature", properties, geometry: { type, coordinates } });
const bake = async features => { const p = await new GeoPBF({ name: "t-null-island", precision: 6 }).set({ type: "FeatureCollection", features }); return unPackGintBuffer(topology(p)); };
const deg = ([x, y]) => [+(x / gint.SCALE_E - 180).toFixed(6), +(y / gint.SCALE_E - 90).toFixed(6)];
// arc 番号（符号付き）→ 頂点列（度）。逆向き参照は反転
const arcPts = (d, s) => {
	const a = s < 0 ? ~s : s, off = d.arcMeta[a * 8], len = d.arcMeta[a * 8 + 1], out = [];
	for (let i = 0; i < len; i++) out.push(deg(gint.unpackToInt(d.arcBuffer[off + i])));
	return s < 0 ? out.reverse() : out;
};
// arc 列をつないだ1本（環なら閉合点込み）
const stitch = (d, arcs) => { const pts = []; for (const s of arcs) { const r = arcPts(d, s); pts.push(...(pts.length ? r.slice(1) : r)); } return pts; };
const ringsOf = (d, fid) => (d.polygon.find(([f]) => f === fid)?.[1] ?? []).flat().map(arcs => stitch(d, arcs));
const linesOf = (d, fid) => (d.polyline.find(([f]) => f === fid)?.[1] ?? []).map(arcs => stitch(d, arcs));
const has00 = pts => pts.some(([x, y]) => x === 0 && y === 0);
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

async function suite(label) {
	// ① 環の先頭が (0,0)
	{
		const d = await bake([F("Polygon", [sq(0, 0, 0.5, 0.5)])]);
		const [r] = ringsOf(d, 0);
		ok(r && r.length === 5 && has00(r), `${label}: 先頭 (0,0) の環＝4頂点+閉合点が残る（${JSON.stringify(r)}）`);
	}
	// ② MultiPolygon の2つ目の環が (0,0) 始まり（差分は環ごとに原点へ戻る）
	{
		const d = await bake([F("MultiPolygon", [[sq(3, 3, 3.5, 3.5)], [sq(0, 0, 0.5, 0.5)]])]);
		const rings = ringsOf(d, 0);
		ok(rings.length === 2 && rings.every(r => r.length === 5) && rings.some(has00), `${label}: MultiPolygon 2つ目の (0,0) 始まりの環も欠けない`);
	}
	// ③ 線の先頭が (0,0)
	{
		const d = await bake([F("LineString", [[0, 0], [0.3, 0.2], [0.6, 0]])]);
		const [l] = linesOf(d, 0);
		ok(l && l.length === 3 && has00(l), `${label}: 先頭 (0,0) の線＝3頂点が残る（${JSON.stringify(l)}）`);
	}
	// ④ 点が (0,0)
	{
		const d = await bake([F("Point", [0, 0]), F("Point", [1, 1])]);
		const pts = d.pointBuffer ? [...d.pointBuffer].map(m => deg(gint.unpackToInt(m))) : [];
		ok(d.pointCount === 2 && has00(pts), `${label}: (0,0) の点が落ちない（${JSON.stringify(pts)}）`);
	}
	// ⑤ 対照：先頭の (0,0) が重複していても1点に畳まれる（重複棄却は従来どおり）
	{
		const d = await bake([F("Polygon", [[[0, 0], [0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5], [0, 0]]])]);
		const [r] = ringsOf(d, 0);
		ok(r && r.length === 5 && has00(r), `${label}: 先頭 (0,0) の重複は1点に畳まれる`);
	}
	// ⑥ 対照：途中の連続重複点も従来どおり棄却
	{
		const d = await bake([F("LineString", [[0.1, 0.1], [0.2, 0.2], [0.2, 0.2], [0.3, 0.1]])]);
		const [l] = linesOf(d, 0);
		ok(l && l.length === 3, `${label}: 途中の連続重複点は棄却（${l?.length} 頂点）`);
	}
}

await suite("JS");
{
	const wasmJs = fileURLToPath(new URL("../wasm/pkg/gint_wasm.js", import.meta.url));
	const mod = await import(wasmJs);
	await mod.default({ module_or_path: readFileSync(wasmJs.replace(/\.js$/, "_bg.wasm")) });
	await gint.initialize();
}
await suite("wasm");

console.log(fails ? `\n✗ ${fails} 件失敗` : "\n全通過");
process.exit(fails ? 1 : 0);
