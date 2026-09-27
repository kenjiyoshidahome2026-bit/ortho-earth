// 網の録り置き（台帳 §8・本人裁定 2）＝頁の session の Fetch.requestPaused を受けて、取り置きから返すか実際に取って録る。
// 2026-09-27 の試し：頁の session の Fetch.enable（https://*）で 頁・専用 worker・入れ子の worker・module worker・blob worker・
// CORS の preflight（OPTIONS）まで全部捕まる（worker の session では Fetch 自体が無い）＝proxy は要らない。
//   ・鍵＝method＋URL（native-bucket の _t= を除く）＋Range。本物とこちらは同じ鍵なら同じバイトを読む
//   ・replay（既定）＝取り置きに無ければ失敗させて net-miss に数える／record＝毎回取って上書き／record-missing＝無い物だけ取る
//   ・preflight は録らない＝その場で許可を返す。maplibre.org/…/docs/assets/ は取り置きの素材（corpus）へ振り替える
//   ・返す時は Access-Control-Allow-Origin を要求の Origin（無ければ *）に書き換え・CORP も付ける（こちらの頁は COEP credentialless）
//   ・取るのは Chrome 自身（要求の段で continueRequest(interceptResponse)→応答の段で getResponseBody）＝頁が本当に受け取るバイト。
//     旧＝Node の fetch は ows.terrestris.de に接続できなかった（curl と Chrome は通る・2026-09-27）。UA は走らせ台が --user-agent で普通の Chrome に。
//     本体は展開済み＝content-encoding は落とす
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ASSET_PREFIX = "https://maplibre.org/maplibre-gl-js/docs/assets/";
export const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const DROP_RESP = /^(content-encoding|content-length|transfer-encoding|connection|keep-alive|set-cookie|access-control-.*|cross-origin-resource-policy|timing-allow-origin)$/i;
const MIME = { ".json": "application/json", ".geojson": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".tif": "image/tiff", ".gltf": "model/gltf+json", ".bin": "application/octet-stream" };

// 録る応答＝成功（2xx）・転送（3xx）・決まった断り（401/403＝鍵が要る・404＝タイルが無い）。429・5xx は一時の都合＝録らない
export const KEEP = status => (status >= 200 && status < 400) || status === 401 || status === 403 || status === 404;
export const normUrl = url => { try { const u = new URL(url); u.searchParams.delete("_t"); return u.toString(); } catch { return url; } };
export const keyOf = (method, url, range) => crypto.createHash("sha1").update(`${method} ${normUrl(url)} ${range || ""}`).digest("hex");

const header = (h, name) => { for (const [k, v] of Object.entries(h || {})) if (k.toLowerCase() === name) return v; return undefined; };
const cors = reqHeaders => [
	{ name: "Access-Control-Allow-Origin", value: header(reqHeaders, "origin") || "*" },
	{ name: "Access-Control-Allow-Credentials", value: "true" },
	{ name: "Access-Control-Expose-Headers", value: "*" },
	{ name: "Cross-Origin-Resource-Policy", value: "cross-origin" },
];

export function createNetStore({ dir, assetsDir, mode = "replay" }) {
	fs.mkdirSync(dir, { recursive: true });
	const stats = { hits: 0, recorded: 0, assets: 0, preflight: 0, misses: [], errors: [], inflight: 0, last: Date.now() };

	function save(key, rec, body) {
		const tmp = path.join(dir, `${key}.${process.pid}.${Math.random().toString(36).slice(2)}`);
		fs.writeFileSync(tmp + ".bin", body); fs.renameSync(tmp + ".bin", path.join(dir, key + ".bin"));
		fs.writeFileSync(tmp + ".json", JSON.stringify(rec)); fs.renameSync(tmp + ".json", path.join(dir, key + ".json"));
		stats.recorded++;
	}

	function stored(key) {
		const j = path.join(dir, key + ".json");
		if (!fs.existsSync(j)) return null;
		return { rec: JSON.parse(fs.readFileSync(j, "utf8")), body: fs.readFileSync(path.join(dir, key + ".bin")) };
	}

	// cdp＝connect() の戻り・session＝頁の sessionId・p＝Fetch.requestPaused の params
	async function handle(cdp, session, p) {
		if (p.responseStatusCode != null || p.responseErrorReason) return onResponse(cdp, session, p);   // 録りの応答の段
		stats.inflight++; stats.last = Date.now();
		const reqH = p.request.headers;
		const fulfill = (responseCode, headers, body) => cdp.call("Fetch.fulfillRequest", { requestId: p.requestId, responseCode,
			responseHeaders: [...headers, ...cors(reqH)], body: body.toString("base64") }, { session, timeoutMs: 30000 });
		try {
			const url = p.request.url, method = p.request.method;
			if (method === "OPTIONS") {   // preflight＝録らない
				stats.preflight++;
				return await fulfill(204, [{ name: "Access-Control-Allow-Methods", value: "GET, HEAD, POST, OPTIONS" },
					{ name: "Access-Control-Allow-Headers", value: header(reqH, "access-control-request-headers") || "*" }], Buffer.alloc(0));
			}
			if (url.startsWith(ASSET_PREFIX)) {   // 例の素材＝取り置き（corpus）から
				const rel = decodeURIComponent(new URL(url).pathname.slice(new URL(ASSET_PREFIX).pathname.length));
				const f = path.resolve(assetsDir, rel);
				if (f.startsWith(assetsDir + path.sep) && fs.existsSync(f)) {
					stats.assets++;
					return await fulfill(200, [{ name: "Content-Type", value: MIME[path.extname(f).toLowerCase()] || "application/octet-stream" }], fs.readFileSync(f));
				}
			}
			const key = keyOf(method, url, header(reqH, "range"));
			let got = mode === "record" ? null : stored(key);
			if (got) stats.hits++;
			else if (mode === "replay") {
				stats.misses.push(`${method} ${normUrl(url)}${header(reqH, "range") ? ` [${header(reqH, "range")}]` : ""}`);
				return await cdp.call("Fetch.failRequest", { requestId: p.requestId, errorReason: "InternetDisconnected" }, { session });
			} else {   // 録る＝Chrome に取らせ、応答の段（onResponse）で写して返す
				pendingRec.set(p.requestId, { key, range: header(reqH, "range") || "" });
				stats.inflight++;   // 応答の段で減らす（取得中も「静か」と見なさない）
				return await cdp.call("Fetch.continueRequest", { requestId: p.requestId, interceptResponse: true }, { session });
			}
			return await fulfill(got.rec.status, got.rec.headers, got.body);
		} catch (e) {
			stats.errors.push(`${p.request.method} ${p.request.url}: ${e.message}`);
			if (pendingRec.delete(p.requestId)) stats.inflight--;   // 録ると決めた後に continueRequest が投げた＝応答の段は来ない
			await cdp.call("Fetch.failRequest", { requestId: p.requestId, errorReason: "Failed" }, { session }).catch(() => { /* 頁が去った */ });
		} finally {
			stats.inflight--; stats.last = Date.now();
		}
	}
	const pendingRec = new Map();   // requestId → { key, range }（要求の段で録ると決めた物）
	async function onResponse(cdp, session, p) {
		const pend = pendingRec.get(p.requestId); pendingRec.delete(p.requestId);
		try {
			if (!pend || p.responseErrorReason) {
				if (pend) stats.errors.push(`${p.request.method} ${p.request.url}: ${p.responseErrorReason}`);
				return await cdp.call("Fetch.continueResponse", { requestId: p.requestId }, { session }).catch(() => cdp.call("Fetch.continueRequest", { requestId: p.requestId }, { session }));
			}
			const status = p.responseStatusCode, headers = (p.responseHeaders || []).filter(h => !DROP_RESP.test(h.name));
			if (!KEEP(status)) {   // 429・5xx は録らない（相手の都合＝録ると再生でも「多すぎる」が返り続け、MapLibre の load が来ない・2026-09-27 に踏んだ）
				stats.errors.push(`${p.request.method} ${p.request.url}: HTTP ${status} (not recorded)`);
				return await cdp.call("Fetch.continueResponse", { requestId: p.requestId }, { session });
			}
			let body = Buffer.alloc(0);
			if (!(status >= 300 && status < 400)) {
				const r = await cdp.call("Fetch.getResponseBody", { requestId: p.requestId }, { session, timeoutMs: 60000 });
				body = Buffer.from(r.body, r.base64Encoded ? "base64" : "utf8");
			}
			save(pend.key, { method: p.request.method, url: normUrl(p.request.url), range: pend.range, status, headers }, body);
			await cdp.call("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: status, responseHeaders: [...headers, ...cors(p.request.headers)], body: body.toString("base64") }, { session, timeoutMs: 30000 });
		} catch (e) {
			stats.errors.push(`${p.request.method} ${p.request.url}: record ${e.message}`);
			await cdp.call("Fetch.continueResponse", { requestId: p.requestId }, { session }).catch(() => { /* 頁が去った */ });
		} finally {
			if (pend) { stats.inflight--; stats.last = Date.now(); }
		}
	}
	return { handle, stats, quietMs: () => (stats.inflight ? 0 : Date.now() - stats.last) };
}
