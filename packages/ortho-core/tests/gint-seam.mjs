#!/usr/bin/env node
// 縫い目辺（antimeridian 切断の痕）の除去＝buildEdgeMeta（bakeBase 経由）。
//   ① ±180 を跨ぐ円＝エンコーダが2片に切る→同一 fid で対になる縫い目辺（両端 ix=±180）が線パスの辺メタから消える
//   ② 縫い目に無関係な四角形＝辺数不変（skip ゼロ）
//   ③ -180 に沿う正規の辺（-180〜-170 の矩形＝対にならない縫い目辺）＝無傷（落とさない）
// 使い方: node packages/ortho-core/tests/gint-seam.mjs（geopbf の wasm pkg が要る＝t-anchors と同じ）
globalThis.ImageData ??= class ImageData { };
import { GeoPBF } from "../../geopbf/src/pbf-base.js";
import { topology, unPackGintBuffer } from "../../geopbf/src/extension/topology.js";
import { gint } from "../../geopbf/src/extension/gint.js";
import { bakeBase } from "../src/gl/gint/bake.js";
import { hasSeamArc } from "../src/gl/gint/utility.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
{
	const wasmJs = fileURLToPath(new URL("../../geopbf/wasm/pkg/gint_wasm.js", import.meta.url));
	const mod = await import(wasmJs);
	await mod.default({ module_or_path: readFileSync(wasmJs.replace(/\.js$/, "_bg.wasm")) });
	await gint.initialize();
}
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const F = (type, coordinates, properties = {}) => ({ type: "Feature", properties, geometry: { type, coordinates } });
const bake = async features => { const p = await new GeoPBF({ name: "t-seam" }).set({ type: "FeatureCollection", features }); return { pbf: p, d: unPackGintBuffer(topology(p)) }; };
const IXMAX = 3600000000, onSeam = ix => ix <= 2 || ix >= IXMAX - 2;
const edgesOf = d => {   // bakeBase → 基準メタの辺 [{a,b,ixa,ixb}]（arcBuffer は先頭 arc 基準の局所添字＝bake と同じ規約）
	const base = bakeBase(d).base, out = [];
	for (let e = 0; e < base.edgeCount; e++) {
		const a = base.metaU32[e * 4], b = base.metaU32[e * 4 + 1];
		out.push({ a, b, ixa: gint.unpackToInt(d.arcBuffer[a])[0], ixb: gint.unpackToInt(d.arcBuffer[b])[0] });
	}
	return { base, edges: out };
};
const seamEdges = edges => edges.filter(e => onSeam(e.ixa) && onSeam(e.ixb));

// ① 縫い目を跨ぐ円（エディタの正規化表現）
{
	const ring = []; for (let i = 0; i <= 36; i++) { const a = i / 36 * Math.PI * 2; let x = 180 + 0.01 * Math.cos(a); x = x >= 180 ? x - 360 : x; ring.push([Math.round(x * 1e6) / 1e6, Math.round(0.01 * Math.sin(a) * 1e6) / 1e6]); }
	const { pbf, d } = await bake([F("Polygon", [ring])]);
	ok(pbf.features[0].geometry.type === "MultiPolygon" && pbf.features[0].geometry.coordinates.length === 2, "エンコーダが2片に切っている（前提）");
	ok(d.arcMeta[0] === 0, "arcBuffer の先頭 arc offset=0（bake の添字規約）");
	ok(hasSeamArc(d.arcMeta), "arc bbox が縫い目に触れる（門が開く）");
	const { base, edges } = edgesOf(d);
	ok(seamEdges(edges).length === 0, `縫い目辺が線パスの辺メタに残っていない（残り ${seamEdges(edges).length}）`);
	ok(base.seamSkipped >= 2, `対になった縫い目辺を落とした（skip=${base.seamSkipped}）`);
	ok(base.edgeCount === base.metaU32.length / 4, "edgeCount と metaU32 長が一致（詰め直し）");
	const nonSeam = edges.filter(e => !(onSeam(e.ixa) && onSeam(e.ixb)));
	ok(nonSeam.length >= 36, `円周の辺は残っている（${nonSeam.length} ≥ 36）`);
}
// ② 縫い目に無関係な四角形＝無変換
{
	const { d } = await bake([F("Polygon", [[[139.75, 35.68], [139.76, 35.68], [139.76, 35.69], [139.75, 35.69], [139.75, 35.68]]])]);
	ok(!hasSeamArc(d.arcMeta), "門が閉じている（bbox 走査だけ）");
	const { base } = edgesOf(d);
	ok(base.edgeCount === 4 && !base.seamSkipped, `四角形＝4辺・skip 0（${base.edgeCount}/${base.seamSkipped})`);
}
// ③ -180 に沿う正規の辺（対にならない）＝落とさない
{
	// 0.5° 角＝度アンカー（1°ごとの内挿）が入らず 4 辺のまま
	const { pbf, d } = await bake([F("Polygon", [[[-180, 10], [-179.5, 10], [-179.5, 10.5], [-180, 10.5], [-180, 10]]])]);
	ok(pbf.features[0].geometry.type === "Polygon", "縫い目に接するだけ＝切られない（前提）");
	const { base, edges } = edgesOf(d);
	ok(seamEdges(edges).length === 1 && !base.seamSkipped, `-180 に沿う辺は残る（seam辺 ${seamEdges(edges).length}・skip ${base.seamSkipped}）`);
	ok(base.edgeCount === 4, `矩形＝4辺（${base.edgeCount}）`);
}
console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
