// common/geoExec.ts（GIS データの読み込み→プレビュー→プロファイルの共通の流れ）と trimCanvas の検定。
// geopbf・logger・canvas・IDB の控えは偽物で受ける（呼ばれた事を記録する）＝外部データ不要。
//   ・成功：geopbf へ渡す選択肢（既定値・crs は有る時だけ）・preview と profile・onSuccess・控えへ書く
//   ・控えあり：preview を呼ばず控えの画像と profile を使う・nocache は控えを読まない・File の鍵
//   ・空のデータ・例外：logger.error と onError
//   ・trimCanvas：上下の透明な行を切る（dpr を保つ）・全部透明／切る所が無ければそのまま
import { geoExec, trimCanvas } from "../src/geoExec.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };

// ── 偽の canvas（RGBA の配列を持つ）──
class FakeCanvas {
	constructor(w = 0, h = 0) { this._w = w; this._h = h; this.px = new Uint8ClampedArray(w * h * 4); this.style = {}; }
	get width() { return this._w; } set width(v) { this._w = v; this.px = new Uint8ClampedArray(this._w * this._h * 4); }
	get height() { return this._h; } set height(v) { this._h = v; this.px = new Uint8ClampedArray(this._w * this._h * 4); }
	getContext() { const c = this; return {
		getImageData: (x, y, w, h) => ({ data: c.px.slice((y * c._w + x) * 4, ((y + h) * c._w) * 4), width: w, height: h }),
		putImageData: (img, x, y) => c.px.set(img.data.subarray(0, c.px.length - (y * c._w + x) * 4), (y * c._w + x) * 4),
		drawImage: () => {},
	}; }
}
const canvasWithRows = (w, h, rows) => { const c = new FakeCanvas(w, h); c.style.width = `${w / 2}px`; for (const y of rows) for (let x = 0; x < w; x++) c.px[(y * w + x) * 4 + 3] = 255; return c; };
const made = [];
globalThis.document = { createElement: t => { const c = new FakeCanvas(); made.push([t, c]); return c; } };
globalThis.ImageBitmap = class { constructor(w, h) { this.width = w; this.height = h; } };
globalThis.createImageBitmap = async blob => new ImageBitmap(40, 20);
const blobs = [];
globalThis.OffscreenCanvas = class { constructor(w, h) { this.w = w; this.h = h; } getContext() { return { drawImage: () => {} }; } async convertToBlob(o) { const b = new Blob(["png"], { type: o.type }); blobs.push(b); return b; } };

// ── 偽の logger（どの口も自分を返して呼ばれた事を記録する）──
function fakeLogger() {
	const calls = [], appended = [];
	const self = new Proxy({}, { get: (_, k) => k === "calls" ? calls : k === "appended" ? appended : k === "node" ? () => ({ appendChild: c => appended.push(c) }) : (...a) => { calls.push([k, ...a]); return self; } });
	return self;
}
const fakePbf = (n = 3) => { const p = { length: n, size: "1KB", previews: 0, profiles: 0,
	async preview(canvas, opts) { p.previews++; p.previewOpts = opts; canvas.width = 8; canvas.height = 6; canvas.style.width = "4px"; for (let x = 0; x < 8; x++) canvas.px[(2 * 8 + x) * 4 + 3] = 255; return new ImageBitmap(8, 6); },
	async profile(o) { p.profiles++; p.profileOpts = o; return "<table/>"; } }; return p; };

// ── 成功の流れ ──
{
	const log = fakeLogger(), pbf = fakePbf(), store = new Map();
	const cache = async (k, v) => { if (v === undefined) return store.get(k); store.set(k, v); };
	let gotOpts = null, succ = null;
	await geoExec({ target: "https://x/%E5%8D%83.geojson", name: "千", link: "https://l" }, {
		geopbf: async (t, o) => { gotOpts = [t, o]; return pbf; }, logger: log, cache, onSuccess: (p, ctx) => { succ = [p, ctx]; } });
	ok("geopbf へ：target と既定値（precision 6・crs は無い）", gotOpts[0] === "https://x/%E5%8D%83.geojson" && gotOpts[1].precision === 6 && gotOpts[1].name === "千" && !("crs" in gotOpts[1]) && gotOpts[1].nocache === false);
	ok("preview（256px・dpr 2）と profile（nohead）を呼ぶ", pbf.previews === 1 && pbf.previewOpts.size === 256 && pbf.previewOpts.dpr === 2 && pbf.profileOpts.nohead === true);
	ok("onSuccess：pbf・切り詰めた canvas・profile", succ[0] === pbf && succ[1].profileHtml === "<table/>" && succ[1].previewCanvas.height === 1 && succ[1].logger === log);
	ok("logger：title・success・canvas を足す・profile を出す", log.calls.some(c => c[0] === "title" && c[1] === "千") && log.calls.some(c => c[0] === "success") && log.appended[0] === succ[1].previewCanvas && log.calls.some(c => c[0] === "log" && c[1] === "<table/>"));
	ok("Requesting の行は読める字（%E5… を戻す）", log.calls.some(c => c[0] === "log" && String(c[1]).includes("Requesting: https://x/千.geojson")));
	await new Promise(r => setTimeout(r, 0));
	ok("控えへ書く（PREVIEW の画像と PROFILE）", store.get("https://x/%E5%8D%83.geojson")?.PROFILE === "<table/>" && store.get("https://x/%E5%8D%83.geojson").PREVIEW instanceof Blob);

	// 控えあり＝preview を呼ばない
	const pbf2 = fakePbf(); let succ2 = null;
	await geoExec({ target: "https://x/%E5%8D%83.geojson", name: "千" }, { geopbf: async () => pbf2, cache, onSuccess: (p, c) => { succ2 = c; } });
	ok("控えあり：preview・profile を呼ばず控えを使う", pbf2.previews === 0 && pbf2.profiles === 0 && succ2.profileHtml === "<table/>" && succ2.previewCanvas.width === 40 && succ2.previewCanvas.style.width === "20px");
	const pbf3 = fakePbf();
	await geoExec({ target: "https://x/%E5%8D%83.geojson", nocache: true }, { geopbf: async () => pbf3, cache });
	ok("nocache：控えを読まない", pbf3.previews === 1);
	const keys = []; const spy = async (k, v) => { keys.push(k); };
	const file = new File(["a"], "a.zip", { lastModified: 5 });
	let o4 = null;
	await geoExec({ target: file, crs: 6677, format: "shp" }, { geopbf: async (t, o) => { o4 = o; return fakePbf(); }, cache: spy });
	ok("File の鍵＝名前・大きさ・更新時刻", keys[0] === "FILE::a.zip::1::5");
	ok("crs と format は geopbf へ素通し", o4.crs === 6677 && o4.format === "shp");
	const k2 = []; await geoExec({ target: new Blob(["b"]) }, { geopbf: async () => fakePbf(), cache: async k => { k2.push(k); } });
	ok("名前の無い Blob は控えない", k2.length === 0);
}

// ── 失敗の流れ ──
{
	const log = fakeLogger(); let e1 = null;
	await geoExec({ target: "u", name: "n" }, { geopbf: async () => ({ length: 0 }), logger: log, onError: (e, c) => { e1 = [e, c]; } });
	ok("空のデータ：logger.error と onError（Empty data）", e1[0].message === "Empty data" && e1[1].info.target === "u" && log.calls.some(c => c[0] === "error"));
	let e2 = null;
	await geoExec({ target: "u2" }, { geopbf: async () => { throw new Error("boom"); }, logger: log, onError: e => { e2 = e; } });
	ok("例外：onError に元の例外・logger に名前と理由", e2.message === "boom" && log.calls.some(c => c[0] === "error" && String(c[1]).includes("u2") && String(c[1]).includes("boom")));
	let e3 = null;
	await geoExec({ target: "u3" }, { geopbf: async () => null, onError: e => { e3 = e; } });
	ok("logger 無し・null の pbf でも落ちない", e3?.message === "Empty data");
	await geoExec({ target: "u4" }, { geopbf: async () => ({ length: 0 }) });
	ok("onError 無しでも落ちない", true);
}

// ── trimCanvas ──
{
	const c = canvasWithRows(4, 10, [3, 5]);
	trimCanvas(c);
	ok("上下の透明な行を切る（3..5 行の 3 行）", c.height === 3 && c.px[3] === 255 && c.px[(2 * 4) * 4 + 3] === 255 && c.px[(1 * 4) * 4 + 3] === 0);
	ok("CSS の高さは dpr を保つ（幅 4px→2px＝dpr 2）", c.style.height === "1.5px");
	const full = canvasWithRows(4, 4, [0, 3]); trimCanvas(full);
	ok("上下の端に絵がある＝そのまま", full.height === 4 && full.style.height === undefined);
	const empty = canvasWithRows(4, 4, []); trimCanvas(empty);
	ok("全部透明＝そのまま", empty.height === 4);
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ t-geoExec 全 PASS");
process.exit(fail ? 1 : 0);
