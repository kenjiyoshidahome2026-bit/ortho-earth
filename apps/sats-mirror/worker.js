// 人工衛星の軌道要素（CelesTrak GP・active）の素通しミラー＝専用 Worker（2026-09-19 本人裁定：native-bucket に混ぜない・置き場は KV）。
// なぜ：CelesTrak は同じグループを同一 IP から 2 時間に 1 回しか返さない（間は HTTP 200 の断り文）＝学校・会社のように IP を
//   共有する教室では、ブラウザ直読みだと 2 人目以降が初回から読めない。ここが 2 時間に 1 回だけ取って KV に置き、皆はここを読む。
//   CelesTrak 利用ポリシー（celestrak.org/usage-policy.php）の「更新（2 時間）ごとに 1 回だけ取る」にもこの方が沿う。
// 形：加工しない（CSV のまま gzip で置くだけ＝鯖焼きではない）。読み手は apps/ortho-japan/gadgets/sats.js。
//   GET /sats/active.csv   CSV（gzip 配信・CORS 開放）。まだ一度も取れていなければ 503
//   GET /sats/status       { fetchedAt, rows, bytes, halted }（見張り用）
// 掟（同ポリシー）：
//   ・cron は毎時。成功は 110 分に 1 回まで（毎時なのは、断られた回の取り直しの余地のため）
//   ・「まだ更新されていない」の断り（実測＝HTTP 403＋本文 "GP data has not updated since your last successful download…"）
//     ＝今回は見送り・古いミラーはそのまま（毎時 1 回＝2 時間で最大 2 回の 403＝遮断線 50 回のはるか下）
//   ・それ以外の 200 以外（301/404/5xx・遮断の 403）＝即停止し KV に停止札 "halt" を置く。札がある間は一切取りに行かない
//     ＝「M2M は 200 以外を受けたら止めて人に報告せよ」。原因を確かめて `wrangler kv key delete halt` で再開
//     （エラーを積むと IP ごとファイアウォール送り＝2 時間で 50 回）。
const SRC = "https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=csv";
const UA = "ortho-earth sats-mirror/1.0 (+https://www.ortho-earth.com/)";
const MIN_INTERVAL_MS = 110 * 60e3;
const K = { data: "active.csv.gz", meta: "meta", halt: "halt" };
const NOT_UPDATED = /has not updated since your last successful/i;   // CelesTrak の「2 時間に 1 回」の断り文（403 で返る）

// 戻り値＝何をしたか（ログとテスト用）："halted" | "fresh" | "refused" | "error" | "stored"
export async function mirror(env, now = Date.now(), fetchImpl = fetch) {
	const kv = env.SATS;
	if (await kv.get(K.halt)) { console.warn("[sats-mirror] halted — delete KV key 'halt' after checking the cause"); return "halted"; }
	const meta = await kv.get(K.meta, "json");
	if (meta && now - meta.fetchedAt < MIN_INTERVAL_MS) return "fresh";
	const res = await fetchImpl(SRC, { headers: { "User-Agent": UA } });
	if (res.status !== 200) {
		const body = (await res.text().catch(() => "")).slice(0, 500);
		if (res.status === 403 && NOT_UPDATED.test(body)) { console.warn("[sats-mirror] not updated yet:", body.slice(0, 160)); return "refused"; }
		await kv.put(K.halt, JSON.stringify({ status: res.status, at: new Date(now).toISOString(), body }));
		console.error("[sats-mirror] HTTP", res.status, "— halted until a human deletes KV key 'halt'");
		return "error";
	}
	const text = await res.text();
	if (!text.startsWith("OBJECT_NAME,")) { console.warn("[sats-mirror] refused:", text.slice(0, 160)); return "refused"; }
	const gz = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
	await kv.put(K.data, gz);
	await kv.put(K.meta, JSON.stringify({ fetchedAt: now, rows: text.split("\n").filter(Boolean).length - 1, bytes: gz.byteLength }));   // 本体の後に書く＝meta が指す本体は必ずある
	console.log("[sats-mirror] stored", gz.byteLength, "bytes gz");
	return "stored";
}

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS" };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function serve(req, env) {
	if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
	if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405);
	const path = new URL(req.url).pathname.replace(/^\/sats/, "");
	if (path === "/status") {
		const [meta, halt] = await Promise.all([env.SATS.get(K.meta, "json"), env.SATS.get(K.halt, "json")]);
		return json({ ...(meta || {}), halted: halt || false });
	}
	if (path === "/active.csv") {
		const [gz, meta] = await Promise.all([env.SATS.get(K.data, "arrayBuffer"), env.SATS.get(K.meta, "json")]);
		if (!gz) return json({ error: "mirror not filled yet" }, 503);
		return new Response(req.method === "HEAD" ? null : gz, {
			encodeBody: "manual",   // 既に gzip＝ランタイムに圧縮し直させない（Content-Encoding どおりブラウザが解く）
			headers: {
				...CORS, "Content-Type": "text/csv; charset=utf-8", "Content-Encoding": "gzip",
				"Cache-Control": "public, max-age=600",   // 10 分＝要素の更新は 2 時間毎なので十分・KV 読みも減る
				...(meta ? { "Last-Modified": new Date(meta.fetchedAt).toUTCString() } : {}),
			},
		});
	}
	return json({ error: "not found" }, 404);
}

export default {
	fetch: (req, env) => serve(req, env),
	scheduled(event, env, ctx) { ctx.waitUntil(mirror(env).catch(e => console.error("[sats-mirror]", e))); },
};
