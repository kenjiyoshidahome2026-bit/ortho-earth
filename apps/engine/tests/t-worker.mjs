// エンジンの配信口（deploy-worker.js）の検定：旧版の入口は今の版へ 302・チャンクは今の版に同じ名前がある時だけ 302・入口は no-cache・チャンクは immutable。
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../deploy-worker.js";

const CUR = "abcdef0123", OLD = "0123456789";
const HAVE = new Set([`/globe/engine/current.json`, `/globe/engine/${CUR}/globe.js`, `/globe/engine/${CUR}/regions/app.js`, `/globe/engine/${CUR}/assets/cog-A1.js`]);
const env = { ASSETS: { fetch: async req => {
	const p = new URL(req.url).pathname;
	if (!HAVE.has(p)) return new Response("nf", { status: 404 });
	return new Response(p.endsWith("current.json") ? JSON.stringify({ version: CUR }) : "x", { status: 200 });
} } };
const get = p => worker.fetch(new Request("https://www.ortho-earth.com" + p), env);

test("旧版の入口は今の版の同じ名前へ 302（regions/app.js の 1 階下も）", async () => {
	for (const name of ["globe.js", "regions/app.js", "equal.js"]) {
		const r = await get(`/globe/engine/${OLD}/${name}`);
		assert.equal(r.status, 302, name);
		assert.equal(r.headers.get("Location"), `/globe/engine/${CUR}/${name}`);
	}
});
test("旧版のチャンクは今の版に同じ名前がある時だけ 302", async () => {
	assert.equal((await get(`/globe/engine/${OLD}/assets/cog-A1.js`)).status, 302);
	assert.equal((await get(`/globe/engine/${OLD}/assets/cog-ZZ.js`)).status, 404);
});
test("入口は no-cache・チャンクは immutable・札は no-cache・COOP/COEP を刻む", async () => {
	const e = await get(`/globe/engine/${CUR}/globe.js`), c = await get(`/globe/engine/${CUR}/assets/cog-A1.js`), j = await get("/globe/engine/current.json");
	assert.equal(e.headers.get("Cache-Control"), "no-cache");
	assert.match(c.headers.get("Cache-Control"), /immutable/);
	assert.equal(j.headers.get("Cache-Control"), "no-cache");
	assert.equal(e.headers.get("Cross-Origin-Embedder-Policy"), "credentialless");
});
