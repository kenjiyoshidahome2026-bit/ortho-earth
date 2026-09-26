// t-identify-accept: identifyAt / findPolygon の accept（fid → 真偽）＝偽の地物は「無いもの」として次の候補を返す（2026-09-26）。
// 使い手＝Gint の照会とホバー（描画側の filter で隠した地物を識別から外す＝gint draw spec §4.5）。
// 同じ一点に 点・線・小さい面・大きい面を重ね、外すたびに次の候補（点→線→小→大→null）が出ることを検める。
globalThis.ImageData ??= class ImageData { };
import { GeoPBF } from "../src/pbf-base.js";
import { topology, unPackGintBuffer } from "../src/extension/topology.js";
import { gint } from "../src/extension/gint.js";
import { identifyAt, findPolygon } from "../src/extension/identify.js";
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
// properties は地物ごとに変える：topologyFullWasm は properties が完全に同じ地物を 1 つの fid に束ねる（同じ実体＝最初の添字）
let seq = 0;
const F = (type, coordinates) => ({ type: "Feature", properties: { k: seq++ }, geometry: { type, coordinates } });
const sq = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const features = [
	F("Polygon", sq(139.0, 35.0, 139.2, 35.2)),        // fid 0＝大きい面
	F("Polygon", sq(139.09, 35.09, 139.11, 35.11)),    // fid 1＝小さい面（0 の中）
	F("Point", [139.1, 35.1]),                         // fid 2＝点
	F("LineString", [[139.095, 35.1], [139.105, 35.1]]),   // fid 3＝線（点を通る）
];
const p = await new GeoPBF({ name: "t-identify-accept" }).set({ type: "FeatureCollection", features });
const self = { unPackGint: unPackGintBuffer(topology(p)) };
const at = accept => identifyAt(self, 139.1, 35.1, accept ? { accept } : {});
const not = (...fids) => fid => !fids.includes(fid);

ok(at(null) === 2, `accept 無し＝点が先（${at(null)}）`);
ok(at(not(2)) === 3, `点を外す＝線（${at(not(2))}）`);
ok(at(not(2, 3)) === 1, `点と線を外す＝小さい面（smallest-wins・${at(not(2, 3))}）`);
ok(at(not(1, 2, 3)) === 0, `小さい面も外す＝その下の大きい面（${at(not(1, 2, 3))}）`);
ok(at(() => false) === null, "全部外す＝null");
ok(at(() => true) === 2, "全部通す＝accept 無しと同じ");
{
	const d = self.unPackGint, mix = Math.round((139.1 + 180) * 1e7), miy = Math.round((35.1 + 90) * 1e7);
	ok(findPolygon(d.arcBuffer, d.arcMeta, d.polyStream, mix, miy, d.polyBboxByFid) === 1, "findPolygon（accept 無し）＝小さい面");
	ok(findPolygon(d.arcBuffer, d.arcMeta, d.polyStream, mix, miy, d.polyBboxByFid, null, not(1)) === 0, "findPolygon の accept で小さい面を外す＝大きい面");
	ok(findPolygon(d.arcBuffer, d.arcMeta, d.polyStream, mix, miy, null, null, not(1)) === 0, "bbox 台帳が無くても accept は効く");
}
console.log(fails ? `FAIL (${fails})` : "PASS");
process.exit(fails ? 1 : 0);
