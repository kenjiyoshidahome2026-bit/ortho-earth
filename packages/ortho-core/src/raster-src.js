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
//   { port: MessagePort, … }             … 外部プロバイダ（ローカル GeoPackage/MBTiles の worker・第三者の実装）。
//        プロトコル：port ← { type:"info", info:{ tileSize, minZoom, maxZoom, bbox, attribution, name } } を最初に 1 通。
//        要求 port → { id, z, x, y }／応答 port ← { id, bitmap: ImageBitmap|null, error?: string }（bitmap は transfer）。
//        中断 port → { id, abort: true }。close＝port.close()。
//
// 画像は premultiply しない（createImageBitmap premultiplyAlpha:"none"）＝FS が α を掛けて前乗算で出す（両バックエンド同じ）。
// worker でも main でも動く（DOM 不使用・fetch/createImageBitmap のみ）。
// pmtiles-src は PMTiles の源が来た時だけ読む（動的 import＝XYZ だけの起動で render worker に乗せない・2026-09-22）

// URL テンプレの展開。{z}/{x}/{y}・{-y}（TMS＝下から数える）・{s}（サブドメイン＝x+y で巡回）・{q}（quadkey）。
export function expandTemplate(tpl, z, x, y, subdomains = null, tms = false) {
	const n = 1 << z;
	const yy = tms ? n - 1 - y : y;
	let s = tpl;
	if (s.includes("{q}")) { let q = ""; for (let i = z - 1; i >= 0; i--) q += ((y >> i & 1) << 1 | (x >> i & 1)); s = s.split("{q}").join(q || "0"); }
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
	if (typeof spec.url !== "string" || !spec.url) throw new Error("raster: spec needs url / pmtiles / port");
	if (!/\{z\}/.test(spec.url) && !/\{q\}/.test(spec.url)) throw new Error("raster: url template needs {z}/{x}/{y} (or {q})");
	const subs = typeof spec.subdomains === "string" ? spec.subdomains.split("") : Array.isArray(spec.subdomains) ? spec.subdomains : null;
	return {
		kind: "xyz", url: spec.url, subdomains: subs, tms: !!spec.tms,
		tileSize: spec.tileSize || 256, minZoom: spec.minZoom ?? 0, maxZoom: spec.maxZoom ?? 18,
		bbox: Array.isArray(spec.bbox) && spec.bbox.length === 4 ? spec.bbox.slice() : null,
		attribution: spec.attribution || null, name: spec.name || null,
		headers: spec.headers || null, credentials: spec.credentials || "omit",
	};
}

// AVIF など「ブラウザが復号できるか」は環境依存＝失敗した時に理由が分かる文面へ包む（黙って穴を空けない）
async function decode(blobOrBytes, mime) {
	const blob = blobOrBytes instanceof Blob ? blobOrBytes : new Blob([blobOrBytes], mime ? { type: mime } : {});
	try { return await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" }); }
	catch (e) { throw new Error(`raster: image decode failed (${mime || blob.type || "unknown type"}): ${e && e.message || e}`); }
}

export async function createRasterSource(spec) {
	const n = normalizeSpec(spec);
	if (n.kind === "xyz") {
		return {
			kind: "xyz", tileSize: n.tileSize, minZoom: n.minZoom, maxZoom: n.maxZoom, bbox: n.bbox, attribution: n.attribution, name: n.name,
			async get(z, x, y, signal) {
				const url = expandTemplate(n.url, z, x, y, n.subdomains, n.tms);
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
