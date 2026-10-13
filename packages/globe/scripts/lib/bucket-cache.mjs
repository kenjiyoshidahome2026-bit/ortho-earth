// bucket（api.ortho-earth.com）の手元の中継（2026-10-13）＝検定の Chrome が bucket から取る物を、器（node）が取って disk に持ち、次からは手元から返す。
//   なぜ：検定の頁は毎回新しいプロファイルで立つ＝標高データ（1 本 3〜4 MB・頁あたり 7 本ほど）を毎回 bucket から取り直す。回線が細い・途切れる所では
//   idle 待ちの頁（t-columnar?g=depth の 30 秒など）が回線の都合で落ち、deploy の門が止まった（Kenji の旅先・実測 250 KB/s〜途切れ・ERR_QUIC_PROTOCOL_ERROR）。
//   Chrome 任せの HTTP キャッシュ（--disk-cache-dir）は試して捨てた＝頁が時間切れで閉じると取得途中の大きいファイルが載らず、いつまでも温まらない。
//   ここは取得を node がやり切る（頁が閉じても続ける・失敗は 3 回までやり直す）＝一度取れた物は次の頁・次の走り・並行の走りで共有する。
// 判定は変えない＝頁ごとの別プロファイル（IDB/localStorage/GPU は空）はそのまま。変わるのは「bucket の応答が手元から返る」ことだけ。
// 仕組み：Chrome に `--host-resolver-rules=MAP api.ortho-earth.com 127.0.0.1:<port>` を渡し、この https サーバ（自己署名）へ向ける（証明書の検めは検定の Chrome だけ外す）。
//   ・持つのは GET・200 の応答（Range なし）。サーバが cache-control: max-age を付けた物（bucket の中身＝4 時間・etag つき）はその期限まで。
//     期限の無い物（bucket の meta＝?meta=1&v=<時刻>・一覧・/proxy/ 経由の外の一覧）は「移ろう物」＝毎回まず上流へ聞く（VOLATILE_TRY_MS で見切る）・届かない時だけ手元の古い物で返す。
//     （10 分だけ手元から即答する形は試して捨てた＝t-qmesh の renderedLand が必ず落ちる。応答が全部一瞬で返ると頁の側の順序が変わる＝検定の条件を変えてしまう）
//     鍵からは時刻だけの cache-buster（v・_t・nocache が数字だけ）を外す＝同じ問いは同じ鍵。Range つき・POST・preflight は素通し（読むだけの物は 3 回までやり直す）。
//   ・期限内＝手元から。期限切れ＝If-None-Match で確かめ直す（304＝期限を延ばす）。上流に届かない時は古い物を返す（検定を回線で止めない）。
//   ・置き場は 1 つ（URL の hash が鍵）＝頁・走り・process をまたいで共有。書き込みは tmp → rename（並行の process が同じ物を取っても壊れない）。
// OE_BUCKET_CACHE=0 で切る・OE_BUCKET_CACHE=<dir> で置き場を替える（消せば空に戻る）。
import https from "node:https";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, statSync, utimesSync } from "node:fs";

export const BUCKET_HOST = "api.ortho-earth.com";
const DIR = process.env.OE_BUCKET_CACHE === "0" ? null : (process.env.OE_BUCKET_CACHE || "/tmp/oe-bucket-cache");
const VOLATILE_TRY_MS = 8000;   // 期限の無い応答を上流へ聞き直す時の見切り（過ぎたら手元の古い物で返す）
const keyUrl = url => url.replace(/([?&])(v|_t|nocache)=\d{10,}(?=&|$)/g, "$1").replace(/[?&]+$/, "").replace(/\?&+/, "?").replace(/&&+/g, "&");
const HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "alt-svc", "host", "content-length"]);
const upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

function ensureCert() {
	const key = `${DIR}/relay-key.pem`, crt = `${DIR}/relay-cert.pem`;
	if (!existsSync(key) || !existsSync(crt)) {
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-subj", `/CN=${BUCKET_HOST}`,
			"-addext", `subjectAltName=DNS:${BUCKET_HOST}`, "-keyout", key + ".tmp" + process.pid, "-out", crt + ".tmp" + process.pid], { stdio: "ignore" });
		renameSync(key + ".tmp" + process.pid, key); renameSync(crt + ".tmp" + process.pid, crt);
	}
	return { key: readFileSync(key), cert: readFileSync(crt) };
}

// 上流へ 1 回。戻り＝{ status, headers, body }（body は全部読んでから）
const upstream = (method, path, headers, body = null, timeoutMs = 90000) => new Promise((res, rej) => {
	const rq = https.request({ host: BUCKET_HOST, servername: BUCKET_HOST, path, method, headers: { ...headers, host: BUCKET_HOST }, agent: upstreamAgent }, r => {
		const chunks = []; r.on("data", c => chunks.push(c)); r.on("end", () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) })); r.on("error", rej);
	});
	rq.setTimeout(timeoutMs, () => rq.destroy(new Error("upstream timeout")));
	rq.on("error", rej);
	if (body && body.length) rq.write(body);
	rq.end();
});
const withRetry = async (fn, n = 3) => { let err; for (let i = 0; i < n; i++) { try { return await fn(); } catch (e) { err = e; await new Promise(r => setTimeout(r, 400 * (i + 1))); } } throw err; };

const maxAgeOf = h => { const m = /(?:^|[,\s])max-age=(\d+)/i.exec(String(h["cache-control"] || "")); return m && !/no-store|private/i.test(h["cache-control"]) ? +m[1] : 0; };
const cleanHeaders = h => Object.fromEntries(Object.entries(h).filter(([k]) => !HOP.has(k.toLowerCase())));

// 中継を立てる。戻り＝{ port, chromeArgs, stats, close }｜null（切ってある・立てられない＝従来どおり直に取る）
export async function startBucketCache() {
	if (!DIR) return null;
	let tls;
	try { mkdirSync(DIR, { recursive: true }); tls = ensureCert(); } catch (e) { console.warn(`（bucket の中継は立てない：${e.message}）`); return null; }
	const stats = { hit: 0, miss: 0, revalidated: 0, stale: 0, pass: 0, error: 0, passBy: {}, errors: [] };
	const passed = (req, why) => { stats.pass++; const k = `${req.method} ${req.url.split("?")[0].split("/").slice(0, 4).join("/")} (${why})`; stats.passBy[k] = (stats.passBy[k] || 0) + 1; };
	const flights = new Map();   // 鍵 → 取得中の Promise（同じ物を同時に 2 回取らない・頁が閉じても続く）
	const paths = key => ({ meta: `${DIR}/${key}.json`, body: `${DIR}/${key}.bin` });
	const readEntry = key => { try { const p = paths(key), meta = JSON.parse(readFileSync(p.meta, "utf8")); return { meta, mtime: statSync(p.meta).mtimeMs, bodyPath: p.body }; } catch { return null; } };
	const writeEntry = (key, meta, body) => {
		const p = paths(key), t = `.tmp${process.pid}-${Math.random().toString(36).slice(2)}`;
		writeFileSync(p.body + t, body); renameSync(p.body + t, p.body);
		writeFileSync(p.meta + t, JSON.stringify(meta)); renameSync(p.meta + t, p.meta);   // meta が後＝meta があれば body は揃っている
	};
	const fetchAndStore = (key, path, reqHeaders, prev) => {
		let f = flights.get(key);
		if (f) return f;
		f = (async () => {
			const h = { ...reqHeaders }; delete h["if-none-match"]; delete h["if-modified-since"];
			if (prev?.meta.headers.etag) h["if-none-match"] = prev.meta.headers.etag;
			const r = await (prev?.meta.volatile ? upstream("GET", path, h, null, VOLATILE_TRY_MS) : withRetry(() => upstream("GET", path, h)));   // 移ろう物は 1 回だけ・短く（駄目なら呼び手が古い物で返す）
			if (r.status === 304 && prev) { const now = new Date(); utimesSync(paths(key).meta, now, now); stats.revalidated++; return readEntry(key); }
			if (r.status === 200) { const ma = maxAgeOf(r.headers); writeEntry(key, { path, status: 200, headers: cleanHeaders(r.headers), maxAge: ma > 0 ? ma : 0, volatile: !(ma > 0) }, r.body); return readEntry(key); }
			return { direct: r };   // 持てない応答＝そのまま返す
		})().finally(() => flights.delete(key));
		f.catch(() => { /* 待つ人が居なくても落とさない（頁が先に閉じた） */ });
		flights.set(key, f);
		return f;
	};
	const sendEntry = (res, e) => { const body = readFileSync(e.bodyPath); res.writeHead(e.meta.status, { ...e.meta.headers, "content-length": body.length }); res.end(body); };
	const sendDirect = (res, r) => { res.writeHead(r.status, { ...cleanHeaders(r.headers), "content-length": r.body.length }); res.end(r.body); };
	const server = https.createServer(tls, async (req, res) => {
		try {
			const headers = cleanHeaders(req.headers);
			const cacheable = req.method === "GET" && !req.headers.range;
			if (!cacheable) {   // 素通し（POST・preflight・Range）
				const chunks = []; for await (const c of req) chunks.push(c);
				passed(req, "not-plain-get");
				const body = Buffer.concat(chunks), call = () => upstream(req.method, req.url, headers, body);
				return sendDirect(res, await (req.method === "GET" || req.method === "OPTIONS" || req.method === "HEAD" ? withRetry(call) : call()));   // 読むだけの物はやり直す
			}
			const key = createHash("sha1").update(keyUrl(req.url) + "\n" + (req.headers["accept-encoding"] || "")).digest("hex");
			const e = readEntry(key);
			if (process.env.OE_BUCKET_CACHE_LOG === "2") console.error(`[relay] ${e ? (e.meta.volatile ? "volatile" : Date.now() - e.mtime < e.meta.maxAge * 1000 ? "HIT" : "expired") : "new"} ${req.url.slice(0, 200)}`);
			if (e && !e.meta.volatile && Date.now() - e.mtime < e.meta.maxAge * 1000) { stats.hit++; return sendEntry(res, e); }
			try {
				const got = await fetchAndStore(key, req.url, headers, e);
				if (got?.direct) { passed(req, `${got.direct.status} ${got.direct.headers["cache-control"] || "no cache-control"}`); return sendDirect(res, got.direct); }
				if (!e) stats.miss++;
				return sendEntry(res, got);
			} catch (err) {
				if (e) { stats.stale++; return sendEntry(res, e); }   // 上流に届かない＝古い物で返す
				throw err;
			}
		} catch (err) {
			stats.error++; stats.errors.push(`${req.method} ${req.url.slice(0, 90)}: ${err.message}`);
			if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain", "access-control-allow-origin": "*" });
			res.end(`bucket relay: ${err.message}`);
		}
	});
	await new Promise((ok, ng) => { server.once("error", ng); server.listen(0, "127.0.0.1", ok); }).catch(e => { console.warn(`（bucket の中継は立てない：${e.message}）`); });
	if (!server.listening) return null;
	const port = server.address().port;
	return {
		port, stats,
		chromeArgs: [`--host-resolver-rules=MAP ${BUCKET_HOST} 127.0.0.1:${port}`, "--ignore-certificate-errors"],
		close: async () => {   // 取得中の物は 3 秒だけ待つ（回線が詰まっていても走りの終わりを止めない）
			await Promise.race([Promise.allSettled([...flights.values()]), new Promise(r => setTimeout(r, 3000))]);
			upstreamAgent.destroy(); server.closeAllConnections?.(); await new Promise(r => server.close(r));
		},
	};
}
