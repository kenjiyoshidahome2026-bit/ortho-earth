// native-bucket の利用者側（nativeBucket・Fetch・Bucket）を、この package の Worker（workers/index.ts＝/proxy と /bucket）と突き合わせる検定。
// グローバル fetch を「api 宛は Worker を直に呼ぶ・それ以外は偽の配信元」へ差し替える＝デプロイ不要・外部へ出ない。
//   ・nativeBucket：apiUrl 必須・apiKey（文字列でも）・proxy／bucket の URL を結ぶ
//   ・Fetch：proxy の check → 本体（type＝text・json・csv・arraybuffer・blob・file・encoding sjis）・gzip を伸ばす・無い＝null・
//            proxy が使えない（許可表の外）＝直に取る・鍵があれば proxy を通る・転送先へ鍵を漏らさない・zip の 1 本／目録（Range）・イベント
//   ・Bucket：put（gzip で縮める／縮めない拡張子）・get（伸ばす・json/text/arrayBuffer）・meta・exist・etag・list・del・
//             puts／gets（zip）・50MB 以上は multipart・鍵なしは put できない・オフライン
import { nativeBucket } from "../src/index.ts";
import { Fetch } from "../src/Fetch.ts";
import { encodeZIP } from "geopbf/encodeZIP";
import worker from "../workers/index.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; quiet.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const API = "https://api.test", KEY = "secret-key";
const quiet = { log: console.log, info: console.info, warn: console.warn, error: console.error };
console.log = console.info = console.warn = () => {};

// ── 偽の R2（本体はバイト列・httpMetadata・list の prefix/delimiter・multipart）と Cache API ──
const objs = new Map();
const R2 = {
	async get(k) { const o = objs.get(k); return o ? { key: k, body: new Blob([o.bytes]).stream(), size: o.bytes.length, uploaded: "2026-10-17", httpEtag: `"${o.etag}"`, httpMetadata: o.meta } : null; },
	async head(k) { const o = objs.get(k); return o ? { key: k, size: o.bytes.length, uploaded: "2026-10-17", httpEtag: `"${o.etag}"`, httpMetadata: o.meta } : null; },
	async put(k, body, opt) { const bytes = new Uint8Array(await new Response(body).arrayBuffer()); objs.set(k, { bytes, meta: opt?.httpMetadata || {}, etag: "e" + bytes.length }); },
	async delete(k) { objs.delete(k); },
	async list({ prefix = "" }) { return { objects: [...objs.keys()].filter(k => k.startsWith(prefix) && !k.slice(prefix.length).includes("/")).map(k => ({ key: k, size: objs.get(k).bytes.length, uploaded: "2026-10-17", httpEtag: `"${objs.get(k).etag}"` })), truncated: false }; },
	parts: new Map(),
	async createMultipartUpload(k, opt) { R2.parts.set("u1", { k, opt, parts: [] }); return { uploadId: "u1" }; },
	resumeMultipartUpload: (k, id) => ({
		uploadPart: async (n, body) => { const b = new Uint8Array(await new Response(body).arrayBuffer()); R2.parts.get(id).parts.push([n, b]); return { partNumber: n, etag: "p" + n }; },
		complete: async parts => { const u = R2.parts.get(id), all = new Blob(u.parts.sort((a, b) => a[0] - b[0]).map(p => p[1])); await R2.put(k, all, u.opt); u.done = parts; },
	}),
};
// window も self も無い Node では Fetch が null.dispatchEvent で落ちる（Fetch.ts の TODO・振る舞いは変えない）＝ブラウザの self を置く。
globalThis.self = new EventTarget();
const store = new Map();
globalThis.caches = { default: { match: async r => store.get(r.url)?.clone(), put: async (r, res) => { store.set(r.url, res); }, delete: async r => store.delete(new URL(r.url).href) } };
let pending = []; const ctx = { waitUntil: p => pending.push(p) };
const ENV = { MY_BUCKET: R2, API_KEY: KEY, PROXY_ALLOWED_HOSTS: "data.test", ALLOWED_DOMAINS: "" };

// ── 偽の配信元（Range も答える）──
const files = new Map();
const urlOf = u => new URL(u instanceof Request ? u.url : String(u));
const isApi = u => urlOf(u).origin === API;   // 宛先は origin で見る（前方一致は "https://api.test.evil" も通す）
const upstream = [];
globalThis.fetch = async (url, init = {}) => {
	const req = url instanceof Request ? url : new Request(String(url), init);
	if (isApi(req)) { const r = await worker.fetch(req, ENV, ctx); await Promise.all(pending); pending = []; return r; }
	upstream.push({ url: req.url, key: req.headers.get("X-API-Key"), range: req.headers.get("range"), method: req.method });
	const path = new URL(req.url).pathname, f = files.get(path);
	if (!f) return new Response("no", { status: 404 });
	const range = req.headers.get("range");
	if (req.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(f.length), "accept-ranges": "bytes" } });
	if (range) { const [, a, b] = /bytes=(\d+)-(\d*)/.exec(range); const e = b === "" ? f.length - 1 : Math.min(+b, f.length - 1); return new Response(f.slice(+a, e + 1), { status: 206, headers: { "content-range": `bytes ${a}-${e}/${f.length}`, "content-length": String(e - +a + 1), "accept-ranges": "bytes" } }); }
	return new Response(f, { status: 200, headers: { "content-length": String(f.length), "accept-ranges": "bytes" } });
};
const enc = s => new TextEncoder().encode(s);
const gz = async u8 => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());

// ── nativeBucket ──
{
	let threw = false; try { nativeBucket(""); } catch { threw = true; }
	ok("nativeBucket：apiUrl が無ければ投げる", threw);
	const nb = nativeBucket(API, KEY);
	ok("nativeBucket：Fetch・Bucket・Cache の口", typeof nb.Fetch === "function" && typeof nb.Bucket === "function" && typeof nb.Cache === "function");
	let t2 = false; try { await Fetch("https://data.test/a"); } catch { t2 = true; }
	ok("Fetch：proxy の指定が無ければ投げる", t2);
}

// ── Fetch ──
{
	const nb = nativeBucket(API), F = nb.Fetch;
	files.set("/a.txt", enc("hello"));
	files.set("/a.json", enc('{"x":[1,2]}'));
	files.set("/a.csv", enc('﻿name,n,ok,z,q,e\r\n"A, ""B""",12,true,null,,1e5\r\nC,-3.5,false,x y ,"",007\r\n'));
	files.set("/b.txt.gz", await gz(enc("zipped text")));
	files.set("/sjis.txt", new Uint8Array([0x93, 0xfa, 0x96, 0x7b]));   // 「日本」（Shift_JIS）
	ok("text", await F("https://data.test/a.txt", "text") === "hello");
	ok("json", same(await F("https://data.test/a.json", "json"), { x: [1, 2] }));
	const csv = await F("https://data.test/a.csv", { type: "csv" });
	ok("csv：引用符・数・真偽・null・空・指数は文字のまま・BOM を落とす", same(csv[0], ["name", "n", "ok", "z", "q", "e"]) && same(csv[1], ['A, "B"', 12, true, null, "", "1e5"]) && same(csv[2], ["C", -3.5, false, "x y", "", 7]), JSON.stringify(csv));
	const ab = await F("https://data.test/a.txt", "arraybuffer");
	ok("arraybuffer", ab instanceof ArrayBuffer && ab.byteLength === 5);
	const bl = await F("https://data.test/a.json", "blob");
	ok("blob（型は名前から）", bl instanceof Blob && !(bl instanceof File) && bl.type.includes("json"));
	const fl = await F("https://data.test/a.txt");
	ok("既定は File（名前は URL の末尾）", fl instanceof File && fl.name === "a.txt");
	ok("gzip は伸ばし、名前の .gz を外す", (await F("https://data.test/b.txt.gz")).name === "b.txt" && await F("https://data.test/b.txt.gz", "text") === "zipped text");
	ok("encoding：shift_jis", await F("https://data.test/sjis.txt", { type: "text", encoding: "Shift_JIS" }) === "日本");
	ok("name の指定", (await F("https://data.test/a.txt", { name: "x.dat" })).name === "x.dat");
	// 実際の proxy の check は exists:false でも url を返す＝Fetch の null 分岐（url が無い時だけ）に入らず、本体の 404 で投げる（今の振る舞い）
	let e404 = null; try { await F("https://data.test/none.txt", "text"); } catch (e) { e404 = e; }
	ok("無い：今の振る舞いは 404 で投げる", e404?.message === "404");
	const real0 = globalThis.fetch;
	globalThis.fetch = async (u, i) => String(u).includes("mode=check") ? Response.json({ exists: false }) : real0(u, i);
	ok("check が url なしの exists:false＝null", await F("https://data.test/none.txt", "text") === null);
	globalThis.fetch = real0;
	upstream.length = 0;
	ok("許可表の外・鍵なし＝proxy は 403 → 直に取る", await F("https://other.test/a.txt", "text") === "hello");
	ok("直に取る時は proxy を通らない（転送先へ直）", upstream.some(u => urlOf(u.url).origin === "https://other.test" && urlOf(u.url).pathname === "/a.txt" && urlOf(u.url).searchParams.has("_t")));
	upstream.length = 0;
	const nk = nativeBucket(API, { apiKey: KEY });
	ok("鍵あり＝許可表の外も proxy を通る", await nk.Fetch("https://other.test/a.txt", "text") === "hello");
	ok("鍵は転送先へ送らない", upstream.length > 0 && upstream.every(u => u.key === null));
	const ev = new EventTarget(), seen = [];
	for (const k of ["FetchStart", "FetchEnd", "FetchError"]) ev.addEventListener(k, e => seen.push([k, e.detail.name]));
	await F("https://data.test/a.txt", { type: "text", eventTarget: ev });
	ok("イベント：FetchStart・FetchEnd（名前）", same(seen, [["FetchStart", "a.txt"], ["FetchEnd", "a.txt"]]));
	files.set("/gone.txt", enc("x"));
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (u, i) => (urlOf(u).origin === "https://data.test" && urlOf(u).pathname === "/gone.txt") || (isApi(u) && urlOf(u).searchParams.get("url") === "https://data.test/gone.txt" && urlOf(u).searchParams.get("mode") !== "check") ? new Response("err", { status: 500 }) : realFetch(u, i);
	seen.length = 0; let err = null;
	try { await F("https://data.test/gone.txt", { type: "text", eventTarget: ev }); } catch (e) { err = e; }
	ok("本体が 500＝投げる・FetchError", err?.message === "500" && seen.some(s => s[0] === "FetchError"));
	globalThis.fetch = realFetch;

	// zip（Range）
	const zip = new Uint8Array(await (await encodeZIP([new File(["inner text"], "in.txt"), new File(["{\"k\":1}"], "d.json")])).arrayBuffer());
	files.set("/pack.zip", zip);
	ok("zip の 1 本（target）を Range で取る", await F("https://data.test/pack.zip", { type: "text", target: "in.txt" }) === "inner text");
	const list = await F("https://data.test/pack.zip", { target: false });
	ok("zip の目録（target:false）", Array.isArray(list) && list.map(e => e.name ?? e.filename ?? e).join().includes("in.txt"), JSON.stringify(list).slice(0, 120));
	ok("zip に無い名前＝null", await F("https://data.test/pack.zip", { type: "text", target: "no.txt" }) === null);
}

// ── Bucket ──
{
	const nb = nativeBucket(API, { apiKey: KEY });
	const B = await nb.Bucket("dir", { silent: true });
	ok("Bucket：URL＝baseUrl＋dir/", B.url === `${API}/bucket/dir/`);
	const n = await B.put("a.json", new Blob(['{"v":1}'], { type: "application/json" }));
	ok("put：圧縮できる物は gzip で置く", objs.get("dir/a.json")?.meta.contentEncoding === "gzip" && n === objs.get("dir/a.json").bytes.length && n > 0);
	ok("get：伸ばして返す（json・text・arrayBuffer・blob）", same(await B.get("a.json", "json"), { v: 1 }) && await B.get("a.json", "text") === '{"v":1}' && (await B.get("a.json", "arrayBuffer")).byteLength === 7 && (await B.get("a.json")).size === 7);
	await B.put(new File([new Uint8Array([137, 80, 78, 71])], "p.png"));
	ok("put(File)：名前は File から・png は縮めない", objs.get("dir/p.png")?.meta.contentEncoding === null && objs.get("dir/p.png").bytes.length === 4);
	const m = await B.meta("a.json");
	ok("meta：Key は名前だけ・ETag は引用符なし", m.Key === "a.json" && m.ETag === objs.get("dir/a.json").etag && m.Size === objs.get("dir/a.json").bytes.length);
	ok("meta：無い＝null・exist・etag", await B.meta("none") === null && await B.exist("a.json") && !(await B.exist("none")) && await B.etag("none") === null && await B.etag("a.json") === m.ETag);
	const ls = await B.list();
	ok("list：dir の直下だけ", same(ls.map(o => o.Key).sort(), ["a.json", "p.png"]));
	await B.puts("bundle.zip", [new File(["one"], "1.txt"), new File(["two"], "2.txt")]);
	const got = await B.gets("bundle");
	ok("puts／gets：zip で置いて中身を出す", Array.isArray(got) && got.length === 2 && await got.find(f => f.name === "2.txt").text() === "two");
	ok("gets：無い zip＝[]", same(await B.gets("nothing"), []));
	ok("get：無い＝null（LoadError）", await B.get("nothing.txt") === null);
	ok("del", await B.del("p.png") && !objs.has("dir/p.png"));
	const big = new Uint8Array(51 * 1024 * 1024); for (let i = 0; i < big.length; i += 4096) big[i] = i & 255;
	const sent = await B.put("big.png", new Blob([big]));
	ok("50MB 以上は multipart（5MB ずつ・順に組む）", sent === big.length && objs.get("dir/big.png")?.bytes.length === big.length && R2.parts.get("u1").parts.length === 11 && R2.parts.get("u1").done.length === 11);
	ok("multipart の本体は元と同じ", objs.get("dir/big.png").bytes[4096 * 7] === big[4096 * 7] && objs.get("dir/big.png").bytes[big.length - 4096] === big[big.length - 4096]);
	objs.delete("dir/big.png");
	const anon = await nativeBucket(API).Bucket("dir");
	let e401 = null; try { await anon.put("x.txt", new Blob(["x"])); } catch (e) { e401 = e; }
	ok("鍵なしの put は 401 で投げる", /put failed: 401/.test(e401?.message || ""));
	ok("鍵なしの del は false", (await anon.del("a.json")) === false && objs.has("dir/a.json"));
	const lazy = await nb.Bucket("lazy", { lazy: true });
	ok("lazy：到達確認なしで返す", lazy && lazy.directory === "lazy/");
	Object.defineProperty(globalThis.navigator, "onLine", { value: false, configurable: true });
	const off = await nb.Bucket("dir");
	ok("オフライン：meta は false・list は []・etag は false", await off.meta("a.json") === false && same(await off.list(), []) && await off.etag("a.json") === false);
	Object.defineProperty(globalThis.navigator, "onLine", { value: true, configurable: true });
	let threw = false; try { await (await import("../src/Bucket.ts")).Bucket("x", {}); } catch { threw = true; }
	ok("baseUrl が無ければ投げる", threw);
}

console.log = quiet.log; console.info = quiet.info; console.warn = quiet.warn; console.error = quiet.error;
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ t-client 全 PASS");
process.exit(fail ? 1 : 0);
