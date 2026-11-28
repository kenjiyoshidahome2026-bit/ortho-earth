// /bucket の検証（デプロイ不要・caches.default と R2 を差し替えて bucket() を直に叩く）。
//   node packages/native-bucket/tests/t-bucket.mjs
// 守るもの：GET はエッジキャッシュに載る／put・mp-complete・del の後はその道のキャッシュを捨てる（B18・2026-09-25）
//          ＝書いた直後の GET が古い本体を返さない（同じ拠点の中で）／鍵が無ければ書けない
import { bucket } from "../workers/bucket.ts";

const ENV = { API_KEY: "secret-key" };
const BASE = "https://api.ortho-earth.com/bucket/";

// Cache API の差し替え（鍵＝URL・GET のみ）
const store = new Map();
globalThis.caches = { default: {
	match: async req => store.get(new URL(req.url).href)?.clone(),
	put: async (req, res) => { store.set(new URL(req.url).href, res); },
	delete: async req => store.delete(new URL(req.url).href),
} };
// R2 の差し替え（put/get/delete/multipart）
const objs = new Map(); let ranged = 0;
const R2 = {
	get: async (k, o) => objs.has(k) ? { key: k, body: o?.range ? (ranged++, objs.get(k).slice(o.range.offset, o.range.offset + o.range.length)) : objs.get(k), size: objs.get(k).length, httpEtag: `"${objs.get(k).length}"`, httpMetadata: {} } : null,
	head: async k => objs.has(k) ? { key: k, size: objs.get(k).length, httpMetadata: {} } : null,
	put: async (k, body) => { objs.set(k, typeof body === "string" ? body : await new Response(body).text()); },
	delete: async k => { objs.delete(k); },
	list: async () => ({ objects: [], truncated: false }),
	createMultipartUpload: async () => ({ uploadId: "u1" }),
	resumeMultipartUpload: k => ({ uploadPart: async (n, body) => ({ partNumber: n, etag: "e" + n, body: await new Response(body).text() }), complete: async () => { objs.set(k, "multipart"); } }),
};
// ctx.waitUntil は待てるように集める
let pending = [];
const ctx = { waitUntil: p => pending.push(p) };
const settle = async () => { await Promise.all(pending); pending = []; };

const get = async path => { const r = await bucket(new Request(BASE + path), R2, ctx, ENV); await settle(); return r.status === 200 ? r.text() : r.status; };
const post = async (path, action, body, key = ENV.API_KEY) => {
	const h = new Headers({ "X-Action": action }); if (key) h.set("X-API-Key", key);
	const r = await bucket(new Request(BASE + path, { method: "POST", headers: h, body }), R2, ctx, ENV); await settle(); return r.status;
};

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log(`  ok   ${name}`); } catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };
const eq = (got, want, what) => { if (got !== want) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); };

await t("GET はキャッシュに載る", async () => {
	objs.set("a/x.txt", "v1");
	eq(await get("a/x.txt"), "v1", "1 回目");
	objs.set("a/x.txt", "v2-behind-cache");   // R2 を裏で書き換え＝キャッシュが効いていれば v1 のまま
	eq(await get("a/x.txt"), "v1", "2 回目（キャッシュ）");
});
await t("put の後は新しい本体", async () => {
	eq(await post("a/x.txt", "put", "v3"), 200, "put");
	eq(await get("a/x.txt"), "v3", "put 直後の GET");
});
await t("mp-complete の後は新しい本体", async () => {
	eq(await get("a/x.txt"), "v3", "載せ直し");
	eq(await post("a/x.txt", "mp-complete", JSON.stringify({ uploadId: "u1", parts: [{ partNumber: 1, etag: "e1" }] })), 200, "complete");
	eq(await get("a/x.txt"), "multipart", "complete 直後の GET");
});
await t("del の後は 404", async () => {
	eq(await post("a/x.txt", "del", null), 200, "del");
	eq(await get("a/x.txt"), 404, "del 直後の GET");
});
await t("鍵が無ければ書けず、キャッシュも残る", async () => {
	objs.set("b/y.txt", "keep"); eq(await get("b/y.txt"), "keep", "載せる");
	eq(await post("b/y.txt", "put", "evil", null), 401, "鍵なし put");
	eq(await get("b/y.txt"), "keep", "中身");
});

await t("一覧はエッジに載り、書いた後は親の一覧も捨てる（2026-10-24）", async () => {
	let listed = 0;
	R2.list = async () => { listed++; return { objects: [{ key: "GIS/pbf/poi.json", size: 2, uploaded: new Date(0), httpEtag: '"e"' }], truncated: false }; };
	const r1 = await bucket(new Request(BASE + "GIS/pbf/"), R2, ctx, ENV); await settle();
	eq(r1.headers.get("Cache-Control"), "public, max-age=0, s-maxage=60", "一覧の Cache-Control");
	eq(JSON.parse(await r1.text()).data.IsTruncated, false, "打ち切っていない");
	await get("GIS/pbf/"); eq(listed, 1, "2 回目はキャッシュ");
	eq(await post("GIS/pbf/poi.json", "put", "{}"), 200, "put");
	await get("GIS/pbf/"); eq(listed, 2, "put の後は R2 を読み直す");
	R2.list = async () => ({ objects: [], truncated: true, cursor: "c" });   // 終わらない一覧＝頁数の上限で打ち切る
	const r2 = await bucket(new Request(BASE + "endless/"), R2, ctx, ENV); await settle();
	eq(JSON.parse(await r2.text()).data.IsTruncated, true, "上限で打ち切り");
	R2.list = async () => ({ objects: [], truncated: false });
});

await t("Range は要る分だけ 206 で返す（PMTiles の部分読み）", async () => {
	objs.set("GIS/hpx/osm/face1.pmtiles", "0123456789");
	const rg = async (h, path = "GIS/hpx/osm/face1.pmtiles") => { const r = await bucket(new Request(BASE + path, { headers: { Range: h } }), R2, ctx, ENV); await settle(); return [r.status, r.headers.get("Content-Range"), r.headers.get("Content-Length"), r.status === 416 ? "" : await r.text()].join("|"); };
	eq(await rg("bytes=2-5"), "206|bytes 2-5/10|4|2345", "a-b");
	eq(await rg("bytes=7-"), "206|bytes 7-9/10|3|789", "a-");
	eq(await rg("bytes=-3"), "206|bytes 7-9/10|3|789", "-n");
	eq(await rg("bytes=0-16383"), "206|bytes 0-9/10|10|0123456789", "末尾を越える b は切り詰める（pmtiles の最初の 16 KB）");
	eq(await rg("bytes=10-12"), "416|bytes */10||", "範囲の外");
	eq(ranged, 4, "R2 へは範囲で取りに行く");
	eq(store.has(BASE + "GIS/hpx/osm/face1.pmtiles"), false, "部分はエッジに載せない");
	eq(await rg("bytes=0-1,4-5"), "200||10|0123456789", "複数区間は全体で返す");
	eq(await rg("bytes=1-2", "GIS/none.pmtiles"), "404|||{\"data\":null}", "無い物");
	const realGet = R2.get; R2.get = async (k, o) => ({ ...(await realGet(k, o)), httpMetadata: { contentEncoding: "gzip" } }); const realHead = R2.head; R2.head = async k => ({ ...(await realHead(k)), httpMetadata: { contentEncoding: "gzip" } });
	objs.set("GIS/z.json", "abcdef");
	eq(await rg("bytes=1-2", "GIS/z.json"), "200||6|abcdef", "gzip で置いた物は Range を見ずに全体");
	R2.get = async (k, o) => ({ ...(await realGet(k, o)), httpMetadata: { contentEncoding: "null" } }); R2.head = async k => ({ ...(await realHead(k)), httpMetadata: { contentEncoding: "null" } });
	objs.set("GIS/n.zip", "abcdef");
	eq(await rg("bytes=1-2", "GIS/n.zip"), "206|bytes 1-2/6|2|bc", "昔の put が残した文字列 \"null\" は「縮めていない」＝Range が効く");
	{ const r = await bucket(new Request(BASE + "GIS/n.zip"), R2, ctx, ENV); await settle(); eq(r.headers.get("Content-Encoding") || "", "", "全体の応答に content-encoding: null を出さない"); }
	R2.get = realGet; R2.head = realHead;
});
await t("版つきの URL（?v=）の Range は区間ごとにエッジに載る（2 回目は R2 へ行かない）", async () => {
	objs.set("GIS/hpx/osm/face9.pmtiles", "abcdefghij");
	const rg = async (h, q = "?v=1") => { const r = await bucket(new Request(BASE + "GIS/hpx/osm/face9.pmtiles" + q, { headers: { Range: h } }), R2, ctx, ENV); await settle(); return [r.status, r.headers.get("Content-Range"), r.headers.get("Content-Length"), r.headers.get("X-Range-Cache"), await r.text()].join("|"); };
	const r0 = ranged;
	eq(await rg("bytes=2-5"), "206|bytes 2-5/10|4|MISS|cdef", "1 回目＝R2 から");
	eq(ranged, r0 + 1, "R2 へ 1 回");
	eq(await rg("bytes=2-5"), "206|bytes 2-5/10|4|HIT|cdef", "2 回目＝エッジから・同じ中身と同じ Content-Range");
	eq(ranged, r0 + 1, "R2 へは行っていない");
	eq(await rg("bytes=0-16383"), "206|bytes 0-9/10|10|MISS|abcdefghij", "末尾を越える b は切り詰めて置く");
	eq(await rg("bytes=0-16383"), "206|bytes 0-9/10|10|HIT|abcdefghij", "切り詰めた Content-Range のまま返る");
	// 版が変われば別の鍵（差し替えの後に古い区間を返さない）
	objs.set("GIS/hpx/osm/face9.pmtiles", "ABCDEFGHIJ");
	eq(await rg("bytes=2-5", "?v=2"), "206|bytes 2-5/10|4|MISS|CDEF", "版が変われば取り直す");
	eq(await rg("bytes=2-5"), "206|bytes 2-5/10|4|HIT|cdef", "古い版の URL は古い区間のまま（版ごとに閉じている）");
	// 版なしの URL・a-b でない形・大きすぎる区間は載せない
	const r1 = ranged;
	eq((await rg("bytes=2-5", "")).split("|")[3], "", "版なしは今までどおり（載せない）");
	await rg("bytes=2-5", ""); eq(ranged, r1 + 2, "版なしは毎回 R2 へ");
	eq((await rg("bytes=7-")).split("|")[3], "", "a- の形は載せない");
	eq((await rg("bytes=0-9999999")).split("|")[3], "", "4 MB を越える区間は載せない");
	eq((await rg("bytes=10-12")).split("|")[0], "416", "範囲の外は 416 のまま");
});


const cc = async path => (await bucket(new Request(BASE + path), R2, ctx, ENV)).headers.get("Cache-Control");
await t("中身のハッシュ入りの共有データは immutable、他は従来どおり（2026-09-30）", async () => {
	objs.set("GIS/shared/census/2020-small.8d2ee2ae.csv", "a,b"); objs.set("GIS/shared/census/2020-small.csv", "a,b");
	eq(await cc("GIS/shared/census/2020-small.8d2ee2ae.csv"), "public, max-age=31536000, immutable", "ハッシュ入り");
	eq(await cc("GIS/shared/census/2020-small.csv"), "public, s-maxage=3600, max-age=60", "ハッシュ無し");
	eq(await cc("b/y.txt"), "public, s-maxage=3600, max-age=60", "他の道");
	await settle();
});

console.log(`\nt-bucket: ${pass} ok, ${fail} fail`);
if (fail) process.exit(1);
