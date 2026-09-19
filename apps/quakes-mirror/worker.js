// 世界の地震（USGS ANSS ComCat・M2+）の配信と月 1 回の直近分取り込み＝専用 Worker（2026-09-19 本人裁定：月 1 回・直近 1 年程度・Worker は別・
// Workers Free で回し切る＝案 A「cron は取って置くだけ・変換はブラウザ」）。
// なぜこの形か：Free は CPU 10 ms／回。CSV の解析と GeoPBF の組み立て（直近 1 年で約 1 秒）は載らない。通信待ちは CPU に数えない＝
//   USGS の月別 CSV をバイト列のまま R2 に置くだけなら数 ms。解析は読み手（apps/ortho-japan/quakes-worker.js）が usgs.js で行う。
// 形：R2（binding QUAKES）
//   archive.geopbf / archive.json … 確定した過去分。手元で焼いて置く（下の手順）。json の end＝排他終端＝recent の起点
//   recent/<from>_<to>.csv       … USGS の CSV そのまま（月 1 本。20,000 件上限に当たった月は二分して複数本）
//   recent.json                  … 目次 { start, end, minmag, windows:[{ key, from, to, rows, bytes, fetchedAt }], updatedAt }
// 取り込み（cron 毎時 17 分）：対象＝起点（archive.json の end、無ければ 12 か月前の月初）〜当月初（排他＝先月末まで・当月は入れない）。
//   ・未取得の月、または未確定（月末から 30 日たつ前に取った）で今月まだ取り直していない月を、1 回に PER_RUN か月まで取る
//     ＝初回の全取得は数時間に分割、以後は月初に先月分と未確定分だけ。月末＋30 日以降に取った月は確定＝二度と取らない。
//   ・仕事が無い回は recent.json を読むだけ。失敗（429/5xx 等）は待たずにやめる＝次の時間にやり直す。
//   ・archive を差し替えて起点が進んだら、archive に入った月の CSV は目次と R2 から消す。
// 配信（CORS 開放・ETag で 304）：
//   GET /quakes/archive.geopbf  GET /quakes/recent.json  GET /quakes/recent/<from>_<to>.csv（?v=fetchedAt で版を刻む＝長期キャッシュ）
//   GET /quakes/status          { archive, recent: { start, end, months, rows, bytes, updatedAt } }（見張り用）
// archive の焼き直し（年 1 回程度＝recent が 2 年に近づいたら。境目は月初にそろえる）：
//   node scripts/usgs-quakes-build.mjs --end 2025-08-31 --manifest --out usgs-quakes-archive.geopbf
//   npx wrangler r2 object put ortho-quakes/archive.geopbf --file usgs-quakes-archive.geopbf --remote
//   npx wrangler r2 object put ortho-quakes/archive.json --file usgs-quakes-archive.geopbf.json --remote
import { API, LIMIT, DAY, iso, months } from "./usgs.js";

const MINMAG = 2;
const PER_RUN = 3;             // 1 回の起動で取る月の上限（Free＝サブリクエスト 50・CPU 10 ms の枠内）
const FINAL_MS = 30 * DAY;     // 月末からこれ以上たって取った月は確定（速報→確定の更新が落ち着く）
const INTERVAL = 1000;         // リクエスト開始の最小間隔 ms＝USGS の 429 対策
const UA = "ortho-earth quakes-mirror/2.0 (+https://www.ortho-earth.com/)";
const K = { archive: "archive.geopbf", archiveMeta: "archive.json", manifest: "recent.json" };
const CSV_PATH = /^\/recent\/\d{8}T\d{6}_\d{8}T\d{6}\.csv$/;
const monthIdx = ms => { const d = new Date(ms); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
const stamp = ms => iso(ms).replace(/[-:]/g, "");   // 20260801T000000
const readJson = async (b, k) => { const o = await b.get(k); return o ? o.json() : null; };

// 改行の数（上限 cap で打ち切り）＝文字列に起こさずバイト列のまま数える（CPU を食わない）
function lineCount(u8, cap) {
	let n = 0;
	for (let p = u8.indexOf(10); p >= 0 && n <= cap; p = u8.indexOf(10, p + 1)) n++;
	return n;
}

// 期間 [a, z) の CSV を取る。20,000 件上限に当たったら二分して取り直す。out に { from, to, buf, rows } を積む
async function fetchWindow(get, a, z, out) {
	const q = new URLSearchParams({
		starttime: iso(a), endtime: iso(z - 1000), minmagnitude: String(MINMAG), eventtype: "earthquake",
		format: "csv", orderby: "time-asc", limit: String(LIMIT),
	});
	const buf = new Uint8Array(await get(`${API}/query?${q}`));
	const rows = buf.length ? Math.max(0, lineCount(buf, LIMIT + 1) - 1) : 0;   // ヘッダ 1 行ぶん引く
	if (rows >= LIMIT && z - a > 2000) {
		const m = a + Math.floor((z - a) / 2 / 1000) * 1000;
		await fetchWindow(get, a, m, out);
		await fetchWindow(get, m, z, out);
		return;
	}
	out.push({ from: a, to: z, buf, rows });
}

// 目次から「連続して埋まっている終端」を出す（status と読み手の表示用）
function coveredEnd(s, windows) {
	let end = s;
	for (const w of [...windows].sort((x, y) => x.from - y.from)) { if (w.from > end) break; end = Math.max(end, w.to); }
	return end;
}

// 戻り値＝何をしたか（ログとテスト用）："fresh" | "partial" | "stored" | "error"
export async function build(env, now = Date.now(), { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)), perRun = PER_RUN } = {}) {
	const b = env.QUAKES;
	const [archive, man] = await Promise.all([readJson(b, K.archiveMeta), readJson(b, K.manifest)]);
	const d = new Date(now);
	const s = archive?.end ? Date.parse(archive.end + "T00:00:00Z") : Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), 1);
	const e = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);   // 当月初＝先月末まで
	let windows = man?.windows ?? [];
	const dropped = windows.filter(w => w.from < s);   // archive に入った月
	windows = windows.filter(w => w.from >= s);
	const nowM = monthIdx(now);
	const todo = months(s, e).filter(([a, z]) => {
		const have = windows.filter(w => w.from >= a && w.to <= z);
		if (!have.length) return true;
		if (have.every(w => w.fetchedAt >= z + FINAL_MS)) return false;   // 確定
		return have.some(w => monthIdx(w.fetchedAt) < nowM);            // 未確定は月 1 回だけ取り直す
	});
	const save = async () => {
		windows.sort((x, y) => x.from - y.from);
		const m = { start: iso(s).slice(0, 10), end: iso(coveredEnd(s, windows)).slice(0, 10), minmag: MINMAG, windows, updatedAt: new Date(now).toISOString() };
		await b.put(K.manifest, JSON.stringify(m), { httpMetadata: { contentType: "application/json" } });
	};
	if (dropped.length) {
		await save();   // 目次から先に外す＝消した CSV を指す目次を残さない
		await Promise.all(dropped.map(w => b.delete(w.key)));
		console.log("[quakes-mirror] dropped", dropped.length, "windows now covered by archive");
	}
	if (!todo.length) return "fresh";

	let nextSlot = 0;
	const get = async url => {
		const at = Math.max(Date.now(), nextSlot);
		nextSlot = at + INTERVAL;
		if (at > Date.now()) await sleep(at - Date.now());
		const r = await fetchImpl(url, { headers: { "User-Agent": UA } });
		if (r.status === 204) return new ArrayBuffer(0);   // 該当なし
		if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
		return r.arrayBuffer();
	};
	for (const [a, z] of todo.slice(0, perRun)) {
		const got = [];
		try { await fetchWindow(get, a, z, got); }
		catch (err) { console.error("[quakes-mirror] fetch failed — retry next hour:", err.message); return "error"; }
		const fetchedAt = now;
		const fresh = got.map(g => ({ key: `recent/${stamp(g.from)}_${stamp(g.to)}.csv`, from: g.from, to: g.to, rows: g.rows, bytes: g.buf.byteLength, fetchedAt }));
		await Promise.all(got.map((g, i) => b.put(fresh[i].key, g.buf, { httpMetadata: { contentType: "text/csv; charset=utf-8" } })));
		const old = windows.filter(w => w.from >= a && w.to <= z);
		windows = windows.filter(w => !(w.from >= a && w.to <= z)).concat(fresh);
		await save();   // 本体の後に目次＝目次が指す CSV は必ずある
		const stale = old.filter(w => !fresh.some(f => f.key === w.key));   // 二分の切り方が変わった古い本
		if (stale.length) await Promise.all(stale.map(w => b.delete(w.key)));
		console.log("[quakes-mirror] stored", iso(a).slice(0, 7), fresh.reduce((n, f) => n + f.rows, 0), "rows in", fresh.length, "file(s)");
	}
	return todo.length > perRun ? "partial" : "stored";
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Cross-Origin-Resource-Policy": "cross-origin" };
const json = (obj, status = 200, cache = "no-store") => new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": cache } });

export async function serve(req, env) {
	if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
	if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
	const path = new URL(req.url).pathname.replace(/^\/quakes/, "");
	if (path === "/status") {
		const [archive, man] = await Promise.all([readJson(env.QUAKES, K.archiveMeta), readJson(env.QUAKES, K.manifest)]);
		const recent = man && { start: man.start, end: man.end, months: new Set(man.windows.map(w => monthIdx(w.from))).size,
			rows: man.windows.reduce((n, w) => n + w.rows, 0), bytes: man.windows.reduce((n, w) => n + w.bytes, 0), updatedAt: man.updatedAt };
		return json({ archive, recent });
	}
	let key, type, cache;
	if (path === "/archive.geopbf") [key, type, cache] = [K.archive, "application/octet-stream", "public, max-age=86400"];
	else if (path === "/recent.json") [key, type, cache] = [K.manifest, "application/json", "public, max-age=600"];
	// CSV は text/plain で返す＝Cloudflare のエッジ自動圧縮の対象は text/plain 等で text/csv は外れる（実測 2026-09-19：csv は素の 0.56 MB・json は br）。
	// 読み手は ?v=fetchedAt を付ける＝取り直せば URL が変わる＝長期キャッシュ
	else if (CSV_PATH.test(path)) [key, type, cache] = [path.slice(1), "text/plain; charset=utf-8", "public, max-age=2592000"];
	else return json({ error: "not found" }, 404);
	const obj = await env.QUAKES.get(key, { onlyIf: req.headers });
	if (!obj) return json({ error: `${key} not built yet` }, key === K.archive || key === K.manifest ? 503 : 404);
	const headers = { ...CORS, "Content-Type": type, ETag: obj.httpEtag, "Last-Modified": obj.uploaded.toUTCString(), "Cache-Control": cache };
	if (!("body" in obj)) return new Response(null, { status: 304, headers });   // If-None-Match 一致
	return new Response(req.method === "HEAD" ? null : obj.body, { headers: { ...headers, "Content-Length": String(obj.size) } });
}

export default {
	fetch: (req, env) => serve(req, env),
	scheduled(event, env, ctx) { ctx.waitUntil(build(env, event.scheduledTime).catch(e => console.error("[quakes-mirror]", e))); },
};
