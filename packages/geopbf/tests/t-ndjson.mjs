#!/usr/bin/env node
// t-ndjson: NDJSON / GeoJSON Text Sequence（RS 区切り）→ GeoPBF。Feature 行・FeatureCollection 行（展開）・素の Geometry 行（包む）・
// 空行・CRLF・壊れた行（数えて飛ばす）。1 パス（set）と 2 パス（setBodyAsync 逐次）と Blob stream で同じバイト列になること。
globalThis.ImageData ??= class ImageData { };
import { GeoPBF } from "../src/pbf.js";
import { fromNdjson, linesOf } from "../src/convert/ndjson.js";
import { createHash } from "node:crypto";
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const H = b => createHash("sha1").update(new Uint8Array(b)).digest("hex").slice(0, 12);
const RS = String.fromCharCode(0x1e);
const F = (props, geometry) => JSON.stringify({ type: "Feature", properties: props, geometry });
const text = [
	F({ n: "A", v: 1, nest: { x: "é" } }, { type: "Point", coordinates: [139.5, 35.5] }),
	"",
	RS + F({ n: "B", v: 2 }, { type: "LineString", coordinates: [[139, 35], [140, 36]] }),   // RFC 8142 の RS 区切り
	JSON.stringify({ type: "FeatureCollection", features: [JSON.parse(F({ n: "C" }, { type: "Polygon", coordinates: [[[139, 35], [140, 35], [140, 36], [139, 36], [139, 35]]] })), JSON.parse(F({ n: "D" }, { type: "Point", coordinates: [1, 2] }))] }),
	JSON.stringify({ type: "MultiPoint", coordinates: [[3, 4], [5, 6]] }),   // 素の Geometry＝属性なしの Feature
	"{ this is not json",
	F({ n: "E" }, null),   // 幾何なし＝落として数える
	F({ n: "F", v: 6 }, { type: "Point", coordinates: [7, 8] }),
].join("\r\n") + "\n";
const u8 = new TextEncoder().encode(text);

const lines = []; for await (const l of linesOf(u8)) lines.push(l);
ok(lines.length === 7 && !lines.some(l => l.includes(RS) || l.includes("\r")), `linesOf: 空行を除いて 7 行・RS/CR は落ちる（${lines.length}）`);

const a = await fromNdjson(u8, { name: "t", precision: 6 });
ok(a.stats.lines === 7 && a.stats.badLines === 1 && a.stats.features === 6 && a.stats.droppedGeometries === 1, `1 パス: 行 ${a.stats.lines}・壊れ ${a.stats.badLines}・features ${a.stats.features}・幾何なし ${a.stats.droppedGeometries}`);
const gj = a.pbf.geojson;
ok(gj.features.map(f => f.properties.n ?? "-").join() === "A,B,C,D,-,F" && gj.features[4].geometry.type === "MultiPoint", `順序と型（${gj.features.map(f => f.properties.n ?? "-").join()}）`);
ok(gj.features[0].properties.nest?.x === "é" && a.pbf.keys.includes("nest.x"), "入れ子属性は a.b で keys に載る");

const b = await fromNdjson(u8, { name: "t", precision: 6, twoPassBytes: 0 });
ok(b.stats.passes === 2 && H(b.pbf.arrayBuffer) === H(a.pbf.arrayBuffer), `2 パス（setBodyAsync 逐次）も同じバイト列（${H(a.pbf.arrayBuffer)}）`);
const c = await fromNdjson(new Blob([u8]), { name: "t", precision: 6 });
ok(H(c.pbf.arrayBuffer) === H(a.pbf.arrayBuffer), "Blob stream 入力も同じバイト列");
const d = await fromNdjson(new Blob([u8]), { name: "t", precision: 6, twoPassBytes: 0 });
ok(H(d.pbf.arrayBuffer) === H(a.pbf.arrayBuffer), "Blob stream × 2 パスも同じバイト列");
// 8 KiB の細切れ chunk でも行が繋がる（stream の境界で行が割れる場合）
const big = Array.from({ length: 3000 }, (_, i) => F({ i, s: "x".repeat(i % 50) }, { type: "Point", coordinates: [139 + i * 1e-4, 35] })).join("\n");
const bigU8 = new TextEncoder().encode(big);
const chunked = new Blob(Array.from({ length: Math.ceil(bigU8.length / 8192) }, (_, k) => bigU8.subarray(k * 8192, (k + 1) * 8192)));
const e = await fromNdjson(chunked, { name: "big" }), e2 = await fromNdjson(bigU8, { name: "big" });
ok(e.stats.features === 3000 && e.stats.badLines === 0 && H(e.pbf.arrayBuffer) === H(e2.pbf.arrayBuffer), `3000 行を 8 KiB chunk の Blob で読んでも一致（features ${e.stats.features}）`);

// worker 脚本（decoder/ndjson.js）を Node で叩く＝t-encoders と同じ流儀
{
	globalThis.onmessage = null;
	const got = new Promise(resolve => { globalThis.postMessage = (m) => resolve(m); });
	await import("../src/decoder/ndjson.js?v=" + Date.now());
	globalThis.onmessage({ data: { file: new File([u8], "t.ndjson"), name: "t", precision: 6 } });
	const r = await Promise.race([got, new Promise(res => setTimeout(() => res("TIMEOUT"), 8000))]);
	ok(r && r !== "TIMEOUT" && r.type === "ndjsondec" && r.data instanceof ArrayBuffer && /1 unreadable line/.test(r.warning), `decoder worker: 返る・warning に壊れた行数（${r?.warning}）`);
	if (r?.data) { const p = await new GeoPBF().set(r.data); ok(p.length === 6, `worker 経由 6 地物（${p.length}）`); }
}
console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
