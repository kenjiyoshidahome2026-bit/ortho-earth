// common/gintView.ts（GeoPBF を 1 枚見せる薄い層・待ち受けの自転・経緯度矩形の画像群のタイル供給）の検定。
// エンジンの口は偽物の map（呼ばれた事を記録する）で受ける＝描画なし・外部データ不要。
//   ・createSpin：経度を回して requestDraw・on の重ね掛けは 1 本・off で止まる・旗つきの map は素の map へ
//   ・show：gint の焼き・addGint の選択肢（fill:false）・hover の tip・click の pop・fit・前のデータを外す・焼いている間に次が来たら捨てる
//   ・fitTo：通常の bbox は中心と fitZoom（17 で頭打ち）・全球級は 3D 平均の重心（±180 跨ぎ）・単一の全球は概観ズーム
//   ・home：概観へ飛んで自転・飛行中に次が来たら自転しない
//   ・showRasterMeshes：分類コード（deflate-raw）→ palette の色・低ズームは縮約モザイク・query の分類・外す
import { createSpin, createGintView, showRasterMeshes } from "../src/gintView.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const sleep = ms => new Promise(r => setTimeout(r, ms));
globalThis.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 8);
globalThis.cancelAnimationFrame = id => clearTimeout(id);

function fakeMap() {
	const log = { draws: 0, tips: [], pops: [], popClears: 0, flights: [], gints: [], rasters: [], removed: [] };
	const tip = html => log.tips.push(html);
	const pop = (html, pos) => log.pops.push([html, pos]); pop.clear = () => log.popClears++;
	const map = {
		log, cam: { center: [179, 10] },
		requestDraw: () => log.draws++,
		gadget: { tip: () => tip, pop: () => pop },
		addGint(pbf, opts) {
			const h = {}, layer = { on: (t, f) => { h[t] = f; }, ready: Promise.resolve(), removed: false, remove() { this.removed = true; }, h, opts, pbf };
			log.gints.push(layer); return layer;
		},
		projectLL: (lng, lat) => [lng * 2, lat * 3],
		fitZoomForBbox: b => Math.log2(360 / Math.max(1e-9, b[2] - b[0])),
		flyTo: async (...a) => { log.flights.push(a); await sleep(5); },
		raster: { add: async (id, src, opts) => { log.rasters.push({ id, src, opts }); }, remove: id => log.removed.push(id) },
	};
	return map;
}
const pbfOf = (bbox, feats = [], o = {}) => ({ length: feats.length || 1, unPackGint: {}, bbox, name: () => "p", forEach: f => feats.forEach((_, i) => f(i)), getBbox: i => feats[i], ...o });

// ── createSpin ──
{
	const m = fakeMap(), spin = createSpin(m, 360);
	spin(true); spin(true);
	await sleep(60);
	spin(false);
	const lon = m.cam.center[0], draws = m.log.draws;
	ok("spin：経度が回る（±180 で畳む）・requestDraw", lon >= -180 && lon < 180 && lon !== 179 && draws > 0, `lon=${lon.toFixed(2)} draws=${draws}`);
	ok("spin：緯度はそのまま", m.cam.center[1] === 10);
	await sleep(40);
	ok("spin(false) で止まる・重ね掛けは 1 本", m.log.draws === draws);
	const raw = fakeMap(), flagged = { [Symbol.for("ortho-earth.map.raw")]: raw }, s2 = createSpin(flagged, 10);
	s2(true); await sleep(30); s2(false);
	ok("旗つきの map は素の map を回す", raw.log.draws > 0);
}

// ── show・hover・click ──
{
	const m = fakeMap(), v = createGintView(m, { minZoom: 3 });
	ok("空の pbf は null", await v.show(null) === null && await v.show({ length: 0 }) === null);
	const pbf = pbfOf([139, 35, 140, 36]);
	const L = await v.show(pbf, { tipHtml: (fid, p) => fid === 7 ? `tip ${p.n}` : null, popHtml: (fid, p) => `pop ${fid} ${p.n}` });
	ok("show：addGint（minZoom・既定は塗る）・layer を返す", L === m.log.gints[0] && L.opts.minZoom === 3 && !("fillMaxEdges" in L.opts) && v.layer === L);
	ok("show：fit＝データへ飛ぶ", m.log.flights.length === 1 && near(m.log.flights[0][0], 139.5) && near(m.log.flights[0][1], 35.5));
	L.h.hover({ fid: 7, properties: { n: "a" } }); L.h.hover({ fid: 8, properties: {} }); L.h.hover(null);
	ok("hover：tipHtml の結果・null は消す", m.log.tips.slice(-3).join("|") === "tip a||", JSON.stringify(m.log.tips));
	L.h.click({ fid: 5, properties: { n: "b" }, lngLat: [10, 20] }); L.h.click({ fid: null, properties: {}, lngLat: [0, 0] });
	ok("click：pop をクリック点の画面座標へ・fid なしは出さない", m.log.pops.length === 1 && m.log.pops[0][0] === "pop 5 b" && m.log.pops[0][1].x === 20 && m.log.pops[0][1].y === 60 && m.log.pops[0][1].lng === 10);
	const L2 = await v.show(pbfOf([0, 0, 1, 1]), { fill: false, fit: false });
	ok("次の show：前の層を外す・fill:false は fillMaxEdges 0・fit:false は飛ばない", L.removed && L2.opts.fillMaxEdges === 0 && m.log.flights.length === 1);
	v.clear();
	ok("clear：層を外し tip と pop を消す", L2.removed && v.layer === null && m.log.tips.at(-1) === null && m.log.popClears >= 3);
	const err = console.error; let msg = ""; console.error = (...a) => { msg = a.join(" "); };
	ok("gint の無い pbf は描かない", await v.show({ length: 1, name: () => "x" }) === null && msg.includes("no gint"));
	console.error = err;
	let baked = 0;
	const lazy = { length: 1, bbox: [0, 0, 1, 1], gint: async () => { baked++; await sleep(10); lazy.unPackGint = {}; } };
	const p1 = v.show(lazy, { fit: false });
	const p2 = v.show(pbfOf([0, 0, 1, 1]), { fit: false });
	ok("焼いている間に次の show が来たら前は捨てる", await p1 === null && (await p2) !== null && baked === 1);
}

// ── fitTo ──
{
	const m = fakeMap(), v = createGintView(m, { overviewZoom: 1.5 });
	v.fitTo(pbfOf([139, 35, 139, 35]));
	ok("点 1 つ＝17 で頭打ち", m.log.flights[0][2] === 17);
	ok("bbox が非有限なら飛ばない", v.fitTo(pbfOf([NaN, 0, 1, 1])) === undefined && v.fitTo({ length: 1 }) === undefined);
	v.fitTo(pbfOf([-180, -10, 180, 10], [[170, 0, 172, 2], [-172, 0, -170, 2]]));
	const f = m.log.flights.at(-1);
	ok("全球級（±180 跨ぎ）＝3D 平均の重心（180° 付近・0° ではない）", Math.abs(Math.abs(f[0]) - 180) < 1e-6 && near(f[1], 1, 2e-2), `lon=${f[0]} lat=${f[1]}`);
	ok("全球級：重心まわりの広がり（中心どうし 18°）でズーム", near(f[2], Math.max(1.5, Math.log2(360 / 18)), 1e-6), `zoom=${f[2]}`);
	v.fitTo(pbfOf([-180, -90, 180, 90], [[-180, -90, 180, 90]]));
	ok("単一の全球＝概観ズーム", m.log.flights.at(-1)[2] === 1.5);
	ok("全球級で feature の bbox が全部無効なら飛ばない", v.fitTo(pbfOf([-180, -90, 180, 90], [null, [NaN, 0, 0, 0]])) === undefined);
}

// ── home ──
{
	const m = fakeMap(), v = createGintView(m, { overviewZoom: 2, spinDegPerSec: 3600 });
	await v.home(15);
	ok("home：今の経度・指定の緯度・概観ズーム・真俯瞰", same(m.log.flights[0], [179, 15, 2, 0, 0]));
	const d0 = m.log.draws; await sleep(40); v.spin(false);
	ok("home の後は自転する", m.log.draws > d0);
	const m2 = fakeMap(), v2 = createGintView(m2);
	const h = v2.home(); v2.clear(); await h;
	const d1 = m2.log.draws; await sleep(40);
	ok("飛行中に clear が来たら自転しない", m2.log.draws === d1);
}
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// ── showRasterMeshes ──
{
	globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
	globalThis.createImageBitmap = async img => img.data.buffer;   // 転送できる物（ArrayBuffer）で返す＝画素を読める
	const deflate = async u8 => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
	const W = 4, H = 4, codes = new Uint8Array(W * H).fill(1); codes.fill(2, 8);   // 上半分＝1・下半分＝2
	const palette = [{ code: 1, rgb: [255, 0, 0], label: "red" }, { code: 2, rgb: [0, 0, 255], label: "blue" }];
	const m = fakeMap();
	const meshes = new Map([["a", { bbox: [139, 35, 140, 36], classes: await deflate(codes), width: W, height: H }], ["bad", { bbox: [1, 1, 0, 0], classes: new Uint8Array(1), width: 1, height: 1 }]]);
	const off = await showRasterMeshes(m, meshes, { id: "lu", name: "LU", palette, opacity: 0.5 });
	const r = m.log.rasters[0];
	ok("raster.add：id・名前・opacity・port", r.id === "lu" && r.src.name === "LU" && r.opts.opacity === 0.5 && r.src.port instanceof MessagePort);
	const port = r.src.port, waiters = new Map(); let info = null;
	port.onmessage = ev => { const d = ev.data; if (d.type === "info") info = d.info; else waiters.get(d.id)?.(d); };
	const ask = (id, z, x, y) => new Promise(res => { waiters.set(id, res); port.postMessage({ id, z, x, y }); });
	const tileOf = (lon, lat, z) => { const n = 2 ** z, s = Math.sin(lat * Math.PI / 180); return [Math.floor((lon + 180) / 360 * n), Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)]; };
	const [x9, y9] = tileOf(139.5, 35.5, 9);
	const t9 = await ask(1, 9, x9, y9);
	await sleep(0);
	ok("info：tileSize 256・bbox は有効なメッシュだけ", info && info.tileSize === 256 && info.bbox.join() === "139,35,140,36");
	const px = new Uint32Array(t9.bitmap), cnt = { red: 0, blue: 0, none: 0 };
	for (const v of px) { if (v === (255 << 24 | 255) >>> 0) cnt.red++; else if (v === (255 << 24 | 255 << 16) >>> 0) cnt.blue++; else if (v === 0) cnt.none++; }
	ok("z9 のタイル：palette の赤と青だけ（他は透明）", px.length === 65536 && cnt.red > 0 && cnt.blue > 0 && cnt.red + cnt.blue + cnt.none === px.length, JSON.stringify(cnt));
	const [x6, y6] = tileOf(139.5, 35.5, 6), t6 = await ask(2, 6, x6, y6);
	ok("z6（縮約モザイク）でも色が出る", new Uint32Array(t6.bitmap).some(v => v >>> 24));
	const tOut = await ask(3, 9, 0, 0);
	ok("掛からないタイルは bitmap null", tOut.bitmap === null);
	ok("query：上半分は red・下半分は blue・外は null", (await off.query(139.5, 35.9))?.label === "red" && (await off.query(139.5, 35.1))?.label === "blue" && (await off.query(10, 10)) === null);
	off();
	ok("外す：raster.remove", m.log.removed.join() === "lu");
	const none = await showRasterMeshes(m, new Map([["x", { bbox: [0, 0, 0, 0] }]]));
	ok("有効なメッシュが無ければ何もしない関数", typeof none === "function" && m.log.rasters.length === 1);
	const m3 = fakeMap(), np = await showRasterMeshes(m3, new Map([["a", { bbox: [0, 0, 1, 1], classes: await deflate(codes), width: W, height: H }]]));
	ok("palette なし：query は null", (await np.query(0.5, 0.5)) === null);
	np();
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ t-gintView 全 PASS");
process.exit(fail ? 1 : 0);
