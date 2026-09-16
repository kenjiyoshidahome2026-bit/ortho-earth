#!/usr/bin/env node
// t-purifier: 全量 wasm 経路（topology_full_wasm）の purifier＝ライン同士の交差点・T 字接触・共線重なりの端点を両線へ挿入し、
// A-B-A スパイクを落とす。JS 版 purifier（2026-09-16 撤去）を Rust へ移植した際に旧 JS 経路と 9 ケース byte-exact を確認済み。
// ここでは挙動（頂点の挿入・共有・非接触は無変化）を数字で見る。
globalThis.ImageData ??= class ImageData { };   // Node に無い（pbf-base の makeKeys が参照）＝他の検定と同じスタブ
import { GeoPBF } from "../src/pbf.js";
import { gint } from "../src/extension/gint.js";
import { topology, unPackGintBuffer } from "../src/extension/topology.js";
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
const L = (c, n) => ({ type: "Feature", properties: { n }, geometry: { type: "LineString", coordinates: c } });
const bake = async feats => unPackGintBuffer(topology(await new GeoPBF({ name: "t-purifier", precision: 7 }).set({ type: "FeatureCollection", features: feats })));
const deg = m => { const [x, y] = gint.unpackToInt(m); return [+(x / gint.SCALE_E - 180).toFixed(7), +(y / gint.SCALE_E - 90).toFixed(7)]; };
const arcPts = (d, s) => { const a = s < 0 ? ~s : s, off = d.arcMeta[a * 8], len = d.arcMeta[a * 8 + 1], out = []; for (let i = 0; i < len; i++) out.push(d.arcBuffer[off + i]); return s < 0 ? out.reverse() : out; };
const lineOf = (d, fid) => (d.polyline.find(([f]) => f === fid)?.[1] ?? []).map(arcs => arcs.flatMap((s, i) => { const r = arcPts(d, s); return i ? r.slice(1) : r; }))[0] ?? [];
// 内部頂点は VW で L2（座標を 8 単位に丸めて weight を埋める）になる＝raw u64 でなく整数座標を 8 単位の許容で比べる
const near = (m, n) => { const [ax, ay] = gint.unpackToInt(m), [bx, by] = gint.unpackToInt(n); return Math.abs(ax - bx) <= 8 && Math.abs(ay - by) <= 8; };
const shared = (a, b) => a.filter(m => b.some(n => near(m, n)));

{	// X 交差：両線に交点が 1 つ挿入され、同じ Morton 値を共有
	const d = await bake([L([[139, 35], [140, 36]], 1), L([[139, 36], [140, 35]], 2)]);
	const a = lineOf(d, 0), b = lineOf(d, 1), sh = shared(a, b);
	ok(a.length === 3 && b.length === 3 && sh.length === 1, `X 交差: 各線 3 頂点・共有 1（${a.length}/${b.length}/${sh.length}）`);
	const [x, y] = deg(sh[0]); ok(Math.abs(x - 139.5) < 2e-6 && Math.abs(y - 35.5) < 2e-6, `交点 ≈ (139.5, 35.5)（${x}, ${y}）`);
}
{	// T 字：縦線の端点が横線を 5cm（≈0.5e-6°）だけ突き抜ける＝交点は端点へスナップ（11cm 以内）され横線に挿入・縦線側は端点そのもの
	//（端点が辺の手前で止まる配置は bbox 判定で弾かれて触らない＝JS 版からの仕様）
	const d = await bake([L([[139, 35], [140, 35]], 1), L([[139.5, 34.9999995], [139.5, 36]], 2)]);
	const a = lineOf(d, 0), b = lineOf(d, 1), sh = shared(a, b);
	ok(a.length === 3 && b.length === 3 && sh.length === 1 && near(b[0], sh[0]), `T 字接触: 横線に頂点挿入・縦線の端点と共有（縦線は 1° アンカー込みで 3）（${a.length}/${b.length}/${sh.length}）`);
}
{	// 共線重なり：重なり区間の端点が相手側へ挿入される
	const d = await bake([L([[139, 35], [140, 35]], 1), L([[139.5, 35], [140.5, 35]], 2)]);
	const a = lineOf(d, 0), b = lineOf(d, 1);
	ok(a.length === 3 && b.length === 3 && shared(a, b).length === 2, `共線重なり: 両線 3 頂点・共有 2（${a.length}/${b.length}/${shared(a, b).length}）`);
}
{	// A-B-A スパイクは落ちる（4 点 → 3 点）
	const d = await bake([L([[139, 35], [140, 35], [139, 35], [141, 35]], 1)]);
	const a = lineOf(d, 0);
	ok(a.length === 3, `A-B-A スパイク除去（${a.length} 頂点）`);
}
{	// 33cm 離れ＝非接触＝無変化（2 点のまま）
	const d = await bake([L([[139, 35], [140, 35]], 1), L([[139.5, 35.000003], [139.5, 36]], 2)]);
	ok(lineOf(d, 0).length === 2 && lineOf(d, 1).length === 2 && shared(lineOf(d, 0), lineOf(d, 1)).length === 0, "11cm 超の近接は触らない");
}
{	// 80k セグ超は素通し（交差があっても挿入しない）＝JS 版と同じ閾値
	const big = [L([[139, 35], [140, 36]], 1), L([[139, 36], [140, 35]], 2)];
	for (let i = 0; i < 81; i++) big.push(L(Array.from({ length: 1001 }, (_, k) => [130 + i * 0.01, 30 + k * 1e-5]), 10 + i));   // 81×1000 セグ
	const d = await bake(big);
	ok(lineOf(d, 0).length === 2 && lineOf(d, 1).length === 2, "80k セグ超は purifier を飛ばす（交点未挿入）");
}
console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
