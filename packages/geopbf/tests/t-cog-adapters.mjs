#!/usr/bin/env node
// t-cog-adapters: src/maplibre-cog.js（addProtocol の手）と src/leaflet-cog.js（L.GridLayer）の配線の検定（改良点 17・2026-10-12）。
//   合成 COG（tests/cog/build-cog.mjs・EPSG:4326）を Range 対応のインメモリ HTTP から配り、Node に無い OffscreenCanvas / ImageData /
//   createImageBitmap / document / L は最小のスタブで置く＝「URL の解釈・openCog の memoize・圏外の透明 PNG・bounds・done の呼び方」を見る。
//   画素の正しさは t-cog（core）が見る。
import { createServer } from "node:http";
import { buildCog } from "./cog/build-cog.mjs";
import { makeCogProtocol, cogProtocol } from "../src/maplibre-cog.js";
import { cogGridLayer } from "../src/leaflet-cog.js";
import { lonLatToWorld } from "../src/modules/mercator.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// ---- スタブ ----
const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
globalThis.ImageData ??= class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };
let pngCalls = 0;
globalThis.OffscreenCanvas = class { constructor(w, h) { this.w = w; this.h = h; } getContext() { return { putImageData: (img) => { this.img = img; } }; } async convertToBlob() { pngCalls++; return new Blob([new Uint8Array(PNG_SIG), new Uint8Array([this.w & 255, this.h & 255, this.img?.data?.[3] ?? 0])]); } };
let bitmaps = 0;
globalThis.createImageBitmap = async (img) => { bitmaps++; return { width: img.width, height: img.height, close() { this.closed = true; } }; };

// ---- サーバ ----
const files = new Map(), log = [];
const server = createServer((req, res) => {
	const f = files.get(req.url); if (!f) { res.writeHead(404); return res.end(); }
	log.push({ path: req.url, range: req.headers.range || null });
	const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
	if (m) { const from = +m[1], to = Math.min(+m[2], f.length - 1); res.writeHead(206, { "content-range": `bytes ${from}-${to}/${f.length}` }); return res.end(Buffer.from(f.subarray(from, to + 1))); }
	res.writeHead(200); res.end(Buffer.from(f));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
// 139.0–139.32E / 35.68–36.0N・32×32・1 タイル・左半分赤
files.set("/a.tif", buildCog({ width: 32, height: 32, tileW: 32, tileH: 32, epsg: 4326, origin: [139, 36], scale: [0.01, 0.01], pixel: (x) => x < 16 ? [255, 0, 0] : [0, 0, 255] }));
const headerReqs = () => log.filter(l => l.path === "/a.tif" && l.range === "bytes=0-65535").length;
const tileAt = (z, lon, lat) => { const [wx, wy] = lonLatToWorld([lon, lat]); return [Math.floor(wx * (1 << z)), Math.floor(wy * (1 << z))]; };

// ---- maplibre-cog ----
{
	const opened = [];
	const handler = makeCogProtocol({ onOpen: (url, cog) => opened.push([url, cog]) });
	let msg = ""; try { await handler({ url: "cog://nope" }); } catch (e) { msg = e.message; }
	ok(/bad url/.test(msg), `壊れた URL は例外（${msg}）`);
	const inner = `${base}/a.tif`;
	const [x, y] = tileAt(12, 139.1, 35.9);
	const r1 = await handler({ url: `cog://${inner}/12/${x}/${y}` }, new AbortController());
	ok(r1.data instanceof Uint8Array && PNG_SIG.every((b, i) => r1.data[i] === b) && r1.data[8] === 0 && pngCalls === 1, `圏内のタイルは PNG（OffscreenCanvas 経由・256px＝${r1.data[8]}）`);
	ok(opened.length === 1 && opened[0][0] === inner && Math.abs(opened[0][1].bboxLL[0] - 139) < 1e-9 && Math.abs(opened[0][1].bboxLL[3] - 36) < 1e-9, "onOpen は 1 回・bboxLL が渡る");
	const r2 = await handler({ url: `cog://${inner}/12/${x + 1}/${y}` });
	const far = tileAt(12, 100, 0);
	const r3 = await handler({ url: `cog://${inner}/12/${far[0]}/${far[1]}` });
	ok(r3.data.length === 70 && PNG_SIG.every((b, i) => r3.data[i] === b) && pngCalls === 2, "圏外のタイルは透明 1×1 PNG（70 B・描画しない）");
	ok(opened.length === 1 && headerReqs() === 1 && r2.data.length > 8, "同じ COG は openCog が 1 回（ヘッダ読みも 1 本）＝memoize");
	const r4 = await handler({ url: `cog://${inner}/12/${far[0]}/${far[1]}` });
	ok(r4.data !== r3.data && r4.data.length === 70, "圏外の PNG は呼び出しごとに写し（slice）");
	ok(typeof cogProtocol === "function", "既定の cogProtocol は関数");
}
// ---- leaflet-cog ----
{
	let draws = 0, removed = 0;
	class GridBase { constructor(options) { this.options = options; } getTileSize() { return { x: 256, y: 256 }; } onRemove() { removed++; } static extend(def) { const C = class extends this {}; Object.assign(C.prototype, def); return C; } }
	const L = {
		GridLayer: GridBase,
		latLngBounds: (sw, ne) => ({ sw, ne }),
	};
	globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage: () => draws++ }) }) };
	const layer = await cogGridLayer(L, `${base}/a.tif`, { opacity: 0.5 });
	ok(layer.options.bounds.sw[0] === layer.cog.bboxLL[1] && layer.options.bounds.sw[1] === layer.cog.bboxLL[0] && layer.options.bounds.ne[0] === layer.cog.bboxLL[3] && layer.options.opacity === 0.5, "bounds は bboxLL から（[s,w],[n,e]）・options は通す");
	ok(typeof layer.cog.metrics === "function" && typeof layer.cog.close === "function", "layer.cog で metrics()/close() に届く");
	const [x, y] = tileAt(12, 139.1, 35.9);
	const t1 = await new Promise((res) => { const tile = layer.createTile({ z: 12, x, y }, (err, t) => res({ err, t, tile })); });
	ok(t1.err === null && t1.t === t1.tile && t1.tile.width === 256 && t1.tile.height === 256 && draws === 1 && bitmaps === 1, "圏内: renderXYZ の bitmap を canvas へ 1 回描いて done(null, tile)");
	const far = tileAt(12, 100, 0);
	const t2 = await new Promise((res) => layer.createTile({ z: 12, x: far[0], y: far[1] }, (err, t) => res({ err, t })));
	ok(t2.err === null && draws === 1, "圏外: 描かずに done(null, tile)");
	globalThis.createImageBitmap = async () => { throw new Error("boom"); };
	const t3 = await new Promise((res) => layer.createTile({ z: 12, x, y: y + 0 }, (err, t) => res({ err, t })));
	ok(t3.err && /boom/.test(t3.err.message), "描画の失敗は done(err, tile)");
	layer.onRemove({});
	ok(removed === 1, "onRemove は GridLayer の物を呼ぶ");
}
server.close();
if (fails) { console.error(`${fails} 件失敗`); process.exit(1); }
console.log("全件通過");
