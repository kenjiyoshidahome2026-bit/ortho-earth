// 画像タイル（メルカトル XYZ）のプロバイダ契約＝「z/x/y → ImageBitmap | null」に、出所の違いを畳む口。
// raster.js（選抜・在庫・描画）はこの契約しか見ない＝ソースを 1 種類増やしてもエンジンの他所は増えない。
//
//   source = { kind, tileSize, minZoom, maxZoom, bbox|null, attribution|null, name|null,
//              get(z, x, y, signal) → Promise<ImageBitmap | null>,   // null＝正当な「そこに無い」（404・索引外・圏外）
//              close() }
//
// spec（外から与える記述子。エンジンはカタログを持たない＝地域パック / URL パラメータ / 公開 API が渡す）：
//   { url: "https://…/{z}/{x}/{y}.png", subdomains?: "abc" | ["a","b"], tms?: bool（{-y} でも可）,
//     tileSize?: 256, minZoom?: 0, maxZoom?: 18, bbox?: [w,s,e,n], attribution?: string, name?: string,
//     headers?: {…}（自前契約のタイル鯖＝任意ヘッダ）, credentials?: "omit"（既定）|"include" }
//   { pmtiles: "https://…/x.pmtiles" }   … ヘッダの自己申告（bbox/zoom 域/tileType）を正とする＝手で bbox を書かない
//   { wms: { url, layers, styles?, format?, transparent?, version? } } … WMS（GetMap をタイルに割る・EPSG:3857）
//   { wmts: { capabilities: URL, layer?, style?, format? } } … WMTS（GetCapabilities を読む）／{ wmts: { url, layer, tileMatrixSet, … } }（KVP を手で）
//   url に {bbox-epsg-3857}（WMS）や {TileMatrix}/{TileRow}/{TileCol}（WMTS REST）を直に書いてもよい（MapLibre と同じ記法）
//   adjust?: { hueRotate, saturation, contrast, brightnessMin, brightnessMax } … 色調整（MapLibre の raster-* paint・#39）＝どの種類にも掛かる
//   { port: MessagePort, … }             … 外部プロバイダ（ローカル GeoPackage/MBTiles の worker・第三者の実装）。
//        プロトコル：port ← { type:"info", info:{ tileSize, minZoom, maxZoom, bbox, attribution, name } } を最初に 1 通。
//        要求 port → { id, z, x, y }／応答 port ← { id, bitmap: ImageBitmap|null, error?: string }（bitmap は transfer）。
//        中断 port → { id, abort: true }。close＝port.close()。
//
// 画像は premultiply しない（createImageBitmap premultiplyAlpha:"none"）＝FS が α を掛けて前乗算で出す（両バックエンド同じ）。
// worker でも main でも動く（DOM 不使用・fetch/createImageBitmap のみ）。
// pmtiles-src は PMTiles の源が来た時だけ読む（動的 import＝XYZ だけの起動で render worker に乗せない・2026-09-22）

// URL テンプレの展開。{z}/{x}/{y}・{-y}（TMS＝下から数える）・{s}（サブドメイン＝x+y で巡回）・{q}（quadkey）。
// ＋OGC（#45・2026-09-23）：{bbox-epsg-3857}（MapLibre と同じ＝WMS の GetMap の BBOX＝タイルの外接をメートルで）・
//   {TileMatrix}/{TileRow}/{TileCol}（WMTS の REST/KVP の型紙・matrixIds があれば z → その id）・{width}/{height}（＝tileSize）
const MERC_R = 6378137 * Math.PI;   // 球メルカトルの半幅[m]
export function expandTemplate(tpl, z, x, y, subdomains = null, tms = false, matrixIds = null, tileSize = 256) {
	const n = 1 << z;
	const yy = tms ? n - 1 - y : y;
	let s = tpl;
	if (s.includes("{bbox-epsg-3857}")) { const w = 2 * MERC_R / n, x0 = -MERC_R + x * w, y1 = MERC_R - y * w; s = s.split("{bbox-epsg-3857}").join(`${x0},${y1 - w},${x0 + w},${y1}`); }
	if (s.includes("{TileMatrix}")) s = s.split("{TileMatrix}").join(matrixIds?.[z] ?? String(z)).split("{TileRow}").join(String(yy)).split("{TileCol}").join(String(x));
	if (s.includes("{width}")) s = s.split("{width}").join(String(tileSize)).split("{height}").join(String(tileSize));
	if (s.includes("{q}") || s.includes("{quadkey}")) { let q = ""; for (let i = z - 1; i >= 0; i--) q += ((y >> i & 1) << 1 | (x >> i & 1)); s = s.split("{q}").join(q || "0").split("{quadkey}").join(q || "0"); }   // {quadkey}＝MapLibre の記法（2026-09-26）
	s = s.split("{z}").join(String(z)).split("{x}").join(String(x)).split("{y}").join(String(yy)).split("{-y}").join(String(n - 1 - y));
	if (s.includes("{s}")) { const subs = subdomains && subdomains.length ? subdomains : ["a", "b", "c"]; s = s.split("{s}").join(subs[(x + y) % subs.length]); }
	return s;
}

// spec の種別判定と既定値（純関数＝Node で検定）。url が .pmtiles で終わる／pmtiles:// なら pmtiles 扱い。
export function normalizeSpec(spec) {
	if (!spec || typeof spec !== "object") throw new Error("raster: spec must be an object");
	if (spec.port) return { kind: "port", port: spec.port, name: spec.name || null, attribution: spec.attribution || null };
	let pm = spec.pmtiles || null;
	if (!pm && typeof spec.url === "string" && (/\.pmtiles(\?|#|$)/i.test(spec.url) || spec.url.startsWith("pmtiles://"))) pm = spec.url;
	if (pm) return { kind: "pmtiles", url: pm.startsWith("pmtiles://") ? pm : "pmtiles://" + pm, name: spec.name || null, attribution: spec.attribution || null };
	if (spec.wms) spec = { ...spec, url: wmsTemplate(spec.wms) };
	if (spec.wmts && !spec.url) spec = { ...spec, url: wmtsTemplate(spec.wmts), matrixIds: spec.wmts.matrixIds || spec.matrixIds };
	if (typeof spec.url !== "string" || !spec.url) throw new Error("raster: spec needs url / pmtiles / port / wms / wmts");
	if (!/\{z\}|\{q\}|\{quadkey\}|\{bbox-epsg-3857\}|\{TileMatrix\}/.test(spec.url)) throw new Error("raster: url template needs {z}/{x}/{y} (or {q} / {bbox-epsg-3857} / {TileMatrix})");
	const subs = typeof spec.subdomains === "string" ? spec.subdomains.split("") : Array.isArray(spec.subdomains) ? spec.subdomains : null;
	return {
		kind: "xyz", url: spec.url, subdomains: subs, tms: !!spec.tms,
		tileSize: spec.tileSize || 256, minZoom: spec.minZoom ?? 0, maxZoom: spec.maxZoom ?? 18,
		bbox: Array.isArray(spec.bbox) && spec.bbox.length === 4 ? spec.bbox.slice() : null,
		attribution: spec.attribution || null, name: spec.name || null,
		headers: spec.headers || null, credentials: spec.credentials || "omit",
		matrixIds: Array.isArray(spec.matrixIds) ? spec.matrixIds.slice() : null,
	};
}

// WMS（GetMap を画面のタイルに割る）＝{ url（サービスの入口）, layers, styles?, format?:"image/png", transparent?:true, version?:"1.3.0", params?:{…} }
// 1.3.0 は CRS・1.1.1 は SRS（どちらも EPSG:3857・軸順はメートルの x,y のまま）
export function wmsTemplate(w) {
	const u = new URL(w.url);
	const v = w.version || "1.3.0";
	const q = { SERVICE: "WMS", REQUEST: "GetMap", VERSION: v, LAYERS: w.layers, STYLES: w.styles ?? "", FORMAT: w.format || "image/png", TRANSPARENT: String(w.transparent ?? true).toUpperCase(), [v >= "1.3" ? "CRS" : "SRS"]: "EPSG:3857", WIDTH: "{width}", HEIGHT: "{height}", BBOX: "{bbox-epsg-3857}", ...(w.params || {}) };
	for (const [k, val] of Object.entries(q)) u.searchParams.set(k, val);
	return decodeURI(u.href).replace(/%7B/gi, "{").replace(/%7D/gi, "}").replace(/%2C/gi, ",");
}
// WMTS（KVP）＝{ url, layer, style?:"default", tileMatrixSet, format?:"image/png", matrixIds? } → 型紙。REST の型紙は url に {TileMatrix} を書いて直に渡せばよい
export function wmtsTemplate(w) {
	if (/\{TileMatrix\}/.test(w.url)) return w.url;
	const u = new URL(w.url);
	const q = { SERVICE: "WMTS", REQUEST: "GetTile", VERSION: "1.0.0", LAYER: w.layer, STYLE: w.style || "default", TILEMATRIXSET: w.tileMatrixSet, FORMAT: w.format || "image/png", TILEMATRIX: "{TileMatrix}", TILEROW: "{TileRow}", TILECOL: "{TileCol}" };
	for (const [k, val] of Object.entries(q)) u.searchParams.set(k, val);
	return decodeURI(u.href).replace(/%7B/gi, "{").replace(/%7D/gi, "}");
}
// WMTS の GetCapabilities を読んで spec を作る（DOMParser 不要の最小の読み：Layer・TileMatrixSet・ResourceURL）。
// 描けるのはウェブメルカトル（EPSG:3857 / 900913・GoogleMapsCompatible 相当）の行列だけ＝行列の id を z 順に並べて matrixIds へ
export function wmtsFromCapabilities(xml, { layer, style, format, capabilitiesUrl } = {}) {
	const tag = (s, t) => [...s.matchAll(new RegExp(`<(?:[\\w-]+:)?${t}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${t}>`, "g"))].map(m => m[1]);
	const text = (s, t) => (tag(s, t)[0] ?? "").replace(/<[^>]+>/g, "").trim();
	const layers = tag(xml, "Layer");
	const L = layers.find(l => !layer || text(l, "Identifier") === layer) || layers[0];
	if (!L) throw new Error("wmts: no layer");
	const lid = text(L, "Identifier");
	const sets = tag(xml, "TileMatrixSet").filter(s => /<(?:[\w-]+:)?TileMatrix\b/.test(s));
	const linked = tag(L, "TileMatrixSetLink").map(k => text(k, "TileMatrixSet"));
	const merc = sets.find(s => linked.includes(text(s, "Identifier")) && /3857|900913|GoogleMapsCompatible/i.test(text(s, "SupportedCRS") + text(s, "Identifier") + text(s, "WellKnownScaleSet")));
	if (!merc) throw new Error("wmts: no web-mercator TileMatrixSet for this layer");
	const ids = tag(merc, "TileMatrix").map(m => ({ id: text(m, "Identifier"), s: +text(m, "ScaleDenominator") })).sort((a, b) => b.s - a.s).map(m => m.id);
	const z0 = Math.round(Math.log2(559082264.0287178 / (tag(merc, "TileMatrix").map(m => +text(m, "ScaleDenominator")).sort((a, b) => b - a)[0] || 559082264.0287178)));   // 最初の行列の z（z0 の縮尺分母＝559082264）
	const matrixIds = []; ids.forEach((id, i) => { matrixIds[z0 + i] = id; });
	const fmt = format || text(L, "Format") || "image/png";
	const attr = (a, k) => new RegExp(`${k}=["']([^"']+)["']`).exec(a)?.[1];   // 属性は '…' も "…" もある（GIBS は一重）
	const rests = [...L.matchAll(/<(?:[\w-]+:)?ResourceURL\b([^>]*)\/?>/g)].map(m => m[1]).filter(a => attr(a, "resourceType") === "tile" && (!format || attr(a, "format") === format));
	const tmpl0 = rests.map(a => attr(a, "template")).sort((a, b) => (a.match(/\{/g) || []).length - (b.match(/\{/g) || []).length)[0];   // 差し込みの少ない型紙（{Time} 無し）を優先
	const sty = style || text(tag(L, "Style")[0] || "", "Identifier") || "default";
	// 次元（{Time} 等）＝Dimension の Default で埋める
	const dims = Object.fromEntries(tag(L, "Dimension").map(d => [text(d, "Identifier"), text(d, "Default")]));
	const fill = u => u.replace(/&amp;/g, "&").replace("{Style}", sty).replace("{TileMatrixSet}", text(merc, "Identifier")).replace(/\{(\w+)\}/g, (m, k) => dims[k] ?? m);
	const kvp = (/<(?:[\w-]+:)?Operation\s+name=["']GetTile["'][\s\S]*?<\/(?:[\w-]+:)?Operation>/.exec(xml)?.[0] || "").match(/href=["']([^"']+)["']/g)?.map(h => h.slice(6, -1)).find(h => /\?/.test(h) || /cgi|wmts/i.test(h));
	const url = tmpl0 ? fill(tmpl0)
		: wmtsTemplate({ url: (kvp || capabilitiesUrl).replace(/&amp;/g, "&").replace(/\?.*$/, ""), layer: lid, style: sty, tileMatrixSet: text(merc, "Identifier"), format: fmt });
	return { url, matrixIds, minZoom: z0, maxZoom: z0 + ids.length - 1, name: text(L, "Title") || lid };
}

// AVIF など「ブラウザが復号できるか」は環境依存＝失敗した時に理由が分かる文面へ包む（黙って穴を空けない）
async function decode(blobOrBytes, mime) {
	const blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes], mime ? { type: mime } : {});
	try { return await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" }); }
	catch (e) { throw new Error(`raster: image decode failed (${mime || blob.type || "unknown type"}): ${e && e.message || e}`); }
}

// ラスタの色調整（MapLibre の raster-hue-rotate / raster-saturation / raster-contrast / raster-brightness-min・max・#39）。
// 順番も MapLibre と同じ＝色相 → 彩度 → コントラスト → 明るさの幅。復号した画像に画素でかける（シェーダは触らない＝両バックエンド同じ）。
// adj＝{ hueRotate:度, saturation:-1..1, contrast:-1..1, brightnessMin:0..1, brightnessMax:0..1 }（既定＝何もしない）
export function adjustRGBA(px, adj) {
	const hr = (adj.hueRotate || 0) * Math.PI / 180, cs = Math.cos(hr), sn = Math.sin(hr);
	// 色相の回転（CSS の hue-rotate と同じ行列）
	const M = [0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928,
		0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.140, 0.072 - cs * 0.072 - sn * 0.283,
		0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072];
	const sat = adj.saturation || 0, satF = sat > 0 ? 1 - 1 / (1.001 - sat) : -sat;   // MapLibre の式
	const con = adj.contrast || 0, conF = con > 0 ? 1 / (1 - con) : 1 + con;
	const bmin = adj.brightnessMin ?? 0, bmax = adj.brightnessMax ?? 1;
	for (let i = 0; i < px.length; i += 4) {
		let r = px[i] / 255, g = px[i + 1] / 255, b = px[i + 2] / 255;
		if (hr) { const r2 = M[0] * r + M[1] * g + M[2] * b, g2 = M[3] * r + M[4] * g + M[5] * b, b2 = M[6] * r + M[7] * g + M[8] * b; r = r2; g = g2; b = b2; }
		if (sat) { const avg = (r + g + b) / 3; r += (avg - r) * satF; g += (avg - g) * satF; b += (avg - b) * satF; }
		if (con) { r = (r - 0.5) * conF + 0.5; g = (g - 0.5) * conF + 0.5; b = (b - 0.5) * conF + 0.5; }
		r = bmin + r * (bmax - bmin); g = bmin + g * (bmax - bmin); b = bmin + b * (bmax - bmin);
		px[i] = Math.max(0, Math.min(255, r * 255 + 0.5)); px[i + 1] = Math.max(0, Math.min(255, g * 255 + 0.5)); px[i + 2] = Math.max(0, Math.min(255, b * 255 + 0.5));
	}
	return px;
}
const needsAdjust = a => a && (a.hueRotate || a.saturation || a.contrast || (a.brightnessMin ?? 0) !== 0 || (a.brightnessMax ?? 1) !== 1);
async function adjustBitmap(bm, adj) {
	const cv = new OffscreenCanvas(bm.width, bm.height), g = cv.getContext("2d", { willReadFrequently: true });
	g.drawImage(bm, 0, 0); bm.close?.();
	const im = g.getImageData(0, 0, cv.width, cv.height);
	adjustRGBA(im.data, adj);
	g.putImageData(im, 0, 0);
	return createImageBitmap(cv, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
}

export async function createRasterSource(spec) {
	const src = await createRasterSource0(spec);
	if (!needsAdjust(spec?.adjust)) return src;
	const get = src.get.bind(src);
	src.get = async (z, x, y, signal) => { const bm = await get(z, x, y, signal); return bm ? adjustBitmap(bm, spec.adjust) : bm; };   // 色調整（#39）は復号の直後に
	return src;
}
async function createRasterSource0(spec) {
	if (spec?.wmts?.capabilities) {   // WMTS の GetCapabilities を読んで型紙・行列 id・ズーム域・名前を作る（#45）
		const cu = spec.wmts.capabilities, r = await fetch(cu, { credentials: spec.credentials || "omit" });
		if (!r.ok) throw new Error(`raster: WMTS capabilities HTTP ${r.status}`);
		const w = wmtsFromCapabilities(await r.text(), { ...spec.wmts, capabilitiesUrl: cu });
		spec = { ...spec, wmts: undefined, url: w.url, matrixIds: w.matrixIds, minZoom: spec.minZoom ?? w.minZoom, maxZoom: spec.maxZoom ?? w.maxZoom, name: spec.name || w.name };
	}
	const n = normalizeSpec(spec);
	if (n.kind === "xyz") {
		return {
			kind: "xyz", tileSize: n.tileSize, minZoom: n.minZoom, maxZoom: n.maxZoom, bbox: n.bbox, attribution: n.attribution, name: n.name,
			async get(z, x, y, signal) {
				const url = expandTemplate(n.url, z, x, y, n.subdomains, n.tms, n.matrixIds, n.tileSize);
				// force-cache＝HTTP キャッシュを最優先（v1 base.js と同じ）。タイルは不変が前提＝再訪はネット無し。
				const res = await fetch(url, { signal, cache: "force-cache", credentials: n.credentials, headers: n.headers || undefined });
				if (res.status === 404 || res.status === 204 || res.status === 410) return null;   // 無い＝正当
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const blob = await res.blob();
				if (!blob.size) return null;
				return decode(blob);
			},
			close() {},
		};
	}
	if (n.kind === "pmtiles") {
		const { pmtilesInfo, fetchPMTilesRaw, isRasterTileType, RASTER_MIME } = await import("./pmtiles-src.js");
		const info = await pmtilesInfo(n.url);
		if (!isRasterTileType(info.tileType)) throw new Error(`raster: PMTiles tileType is "${info.tileType}" (not a raster archive)`);
		const mime = RASTER_MIME[info.tileType];
		return {
			kind: "pmtiles", tileSize: 256, minZoom: info.minZoom, maxZoom: info.maxZoom, bbox: info.bbox, tileType: info.tileType,
			attribution: n.attribution || info.attribution || null, name: n.name || info.name || null,
			async get(z, x, y, signal) {
				const bytes = await fetchPMTilesRaw(n.url, z, x, y, signal);
				return bytes ? decode(bytes, mime) : null;
			},
			close() {},
		};
	}
	// port＝外部プロバイダ。info を 1 通待ってから契約を返す（タイムアウト＝相手が黙っていれば失敗を言う）
	const port = n.port;
	const pending = new Map();
	let seq = 0;
	const info = await new Promise((resolve, reject) => {
		const to = setTimeout(() => reject(new Error("raster: provider port sent no info within 20s")), 20000);
		port.onmessage = ev => {
			const m = ev.data || {};
			if (m.type === "info") { clearTimeout(to); resolve(m.info || {}); return; }
			const p = pending.get(m.id); if (!p) { if (m.bitmap && m.bitmap.close) m.bitmap.close(); return; }   // 中断済みの遅着＝閉じて捨てる
			pending.delete(m.id);
			if (m.error) p.reject(new Error(m.error)); else p.resolve(m.bitmap || null);
		};
		port.start?.();
	});
	return {
		kind: "port", tileSize: info.tileSize || 256, minZoom: info.minZoom ?? 0, maxZoom: info.maxZoom ?? 18, bbox: info.bbox || null,
		attribution: n.attribution || info.attribution || null, name: n.name || info.name || null,
		get(z, x, y, signal) {
			const id = ++seq;
			return new Promise((resolve, reject) => {
				pending.set(id, { resolve, reject });
				port.postMessage({ id, z, x, y });
				signal?.addEventListener("abort", () => { if (pending.delete(id)) { port.postMessage({ id, abort: true }); reject(new Error("aborted")); } }, { once: true });
			});
		},
		close() { for (const p of pending.values()) p.reject(new Error("closed")); pending.clear(); try { port.close(); } catch { /* 既に閉じている */ } },
	};
}
