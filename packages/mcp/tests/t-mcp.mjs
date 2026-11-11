// MCP サーバーの門（2026-11-11）：道具の中身（小さな写しで）・stdio の往復（bin を起こして）・Worker の HTTP の口。ネットに出ない
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sections, searchDocs, startRoute, appsOf, lookupApi, checkCompat, viewLink, TOOLS } from "../src/tools.js";
import { createServer } from "../src/server.js";
import { VERSION } from "../src/version.js";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// ---- 写し（www.ortho-earth.com が配る物の小さな形）----
const FILES = {
	"facts.json": JSON.stringify({ name: "Ortho Earth", release: { version: "9.9.9", date: "2026-11-11" } }),
	"llms.txt": "# Ortho Earth\n\n## Apps\n\n- [World quiz](https://www.ortho-earth.com/quiz/): A geography quiz.\n- [World clock](https://www.ortho-earth.com/globe/clock): Local time everywhere.\n\n## Source\n\n- x\n",
	"llms-full.txt": "# Ortho Earth\n\n# Full text\n\n## Coming from CesiumJS\n\nSource: https://www.ortho-earth.com/docs/from-cesium\n\nIntro.\n\n### 3D data and terrain\n\nUse `map.add3DTiles(url)` for 3D Tiles.\n\n```bash\n# not a heading\n```\n\n## Equal Earth\n\nSource: https://www.ortho-earth.com/docs/equal-earth\n\nThe projection in the shader.\n",
	"start.md": "# Build with Ortho Earth\n\nIntro.\n\n---\n\n## Route A — with Vite\n\nnpm install @ortho-earth/globe\n\n---\n\n## Route B — without a bundler\n\nnpm install @ortho-earth/japan\n\n---\n\n## Notes for AI coding agents\n\n- Check the console.\n",
	"compat.json": JSON.stringify({
		levels: { samePicture: "same picture", sameAnswers: "same answers", runsPartly: "partly", doesNotRun: "no" },
		styleStatus: { reads: "reads", partial: "partial" },
		maplibre: { how: "ml", examples: [{ id: "3d-terrain", title: "3D Terrain", level: "samePicture", picture: 83, note: "ok", url: "https://www.ortho-earth.com/maplibre/#3d-terrain", original: "o" }, { id: "add-a-popup", title: "Add a popup", level: "sameAnswers", picture: null, note: null, url: "u", original: "o" }] },
		cesium: { how: "cs", examples: [{ id: "billboards", title: "Billboards", level: "samePicture", picture: 99, note: null, imagery: ["Cesium ion"], url: "u", original: "o" }] },
		styleSpec: [{ layer: "fill", kind: "paint", property: "fill-pattern", status: "partial", note: "一部" }, { layer: "line", kind: "paint", property: "line-color", status: "reads" }],
	}),
	"ref/globe.d.ts": "export type LonLat = [number, number];\n/** 地球儀を起こす。await 必須 */\nexport function createGlobe(opts?: GlobeOptions): Promise<GlobeMap>;\nexport interface GlobeOptions {\n\t/** 視点 \"#z/lat/lon\" */\n\tview?: string;\n\ttarget?: string;\n}\n",
	"ref/globe-map.ts": "export interface CameraApi {\n\t/** 飛行（度） */\n\tflyTo(lon: number, lat: number, zoom: number): Promise<void>;\n}\n",
	"ref/maplibre.d.ts": "export class Map {\n\tflyTo(options: FlyToOptions): this;\n}\n",
};
const load = async (p) => { if (!Object.hasOwn(FILES, p)) throw new Error(`no ${p}`); return FILES[p]; };
const dir = mkdtempSync(join(tmpdir(), "ortho-mcp-"));
mkdirSync(join(dir, "ref"));
for (const [k, v] of Object.entries(FILES)) writeFileSync(join(dir, k), v);

test("版：src/version.js と package.json が同じ", () => {
	assert.equal(VERSION, JSON.parse(readFileSync(here("../package.json"), "utf8")).version);
});

test("節：``` の中の # は見出しでない・Source を小見出しが継ぐ・Full text は道に入れない", () => {
	const s = sections(FILES["llms-full.txt"]);
	const t = s.find(x => x.heading === "3D data and terrain");
	assert.equal(t.title, "Coming from CesiumJS › 3D data and terrain");
	assert.equal(t.source, "https://www.ortho-earth.com/docs/from-cesium");
	assert.match(t.body, /# not a heading/);
	assert.ok(!s.some(x => x.heading === "not a heading"));
});

test("search_docs：語の多く当たる節が先", () => {
	const r = searchDocs(FILES["llms-full.txt"], "3D Tiles terrain");
	assert.equal(r[0].heading, "3D data and terrain");
	assert.throws(() => searchDocs(FILES["llms-full.txt"], "  "), /empty/);
});

test("get_started：道筋ごとに前書き・本文・エージェントへの注意", () => {
	const a = startRoute(FILES["start.md"], "vite"), b = startRoute(FILES["start.md"], "html");
	assert.match(a, /Route A/); assert.doesNotMatch(a, /Route B/); assert.match(a, /Notes for AI coding agents/);
	assert.match(b, /@ortho-earth\/japan/); assert.match(b, /^# Build with Ortho Earth/);
});

test("list_apps：llms.txt の Apps 節", () => {
	assert.deepEqual(appsOf(FILES["llms.txt"]).map(a => a.name), ["World quiz", "World clock"]);
});

test("lookup_api：宣言を JSDoc と本体ごと・宣言そのものが先・無ければ似た名前", () => {
	const files = { "globe.d.ts": FILES["ref/globe.d.ts"], "globe-map.ts": FILES["ref/globe-map.ts"], "maplibre.d.ts": FILES["ref/maplibre.d.ts"] };
	const c = lookupApi(files, "createGlobe");
	assert.equal(c.hits[0].exact, true);
	assert.match(c.hits[0].code, /^\/\*\* 地球儀を起こす/);
	const o = lookupApi(files, "GlobeOptions");
	assert.match(o.hits[0].code, /view\?: string;[\s\S]*\}$/);
	const f = lookupApi(files, "Map.flyTo");
	assert.deepEqual(f.hits.map(h => h.file).sort(), ["globe-map.ts", "maplibre.d.ts"]);
	assert.match(f.hits.find(h => h.file === "globe-map.ts").code, /飛行/);
	const n = lookupApi(files, "Globe");
	assert.ok(n.found === false && n.similar.includes("createGlobe"));
	assert.throws(() => lookupApi(files, "a b"), /identifier/);
});

test("check_compat：例と style の性質・ライブラリで絞る・無ければ案内", () => {
	const c = JSON.parse(FILES["compat.json"]);
	const t = checkCompat(c, "terrain");
	assert.equal(t.maplibre.examples[0].id, "3d-terrain");
	assert.equal(t.maplibre.examples[0].picturePercent, 83);
	assert.equal(t.cesium.examples.length, 0);
	assert.equal(checkCompat(c, "fill-pattern").styleSpec[0].status, "partial");
	const b = checkCompat(c, "billboards", "cesium");
	assert.equal(b.maplibre, undefined);
	assert.deepEqual(b.cesium.examples[0].imagery, ["Cesium ion"]);
	assert.match(checkCompat(c, "nothing-like-this").summary, /map\.supports/);
});

test("view_link：URL と view の文字列・範囲の外は断る", () => {
	const v = viewLink({ lat: 35.681, lon: 139.767, zoom: 15, pitch: 60, bearing: -20, app: "japan" });
	assert.equal(v.view, "#15.00/35.68100/139.76700/60t/-20r");
	assert.equal(v.url, "https://www.ortho-earth.com/japan/#15.00/35.68100/139.76700/60t/-20r");
	assert.equal(viewLink({ lat: 0, lon: 0 }).url, "https://www.ortho-earth.com/globe/#3.00/0.00000/0.00000");
	assert.throws(() => viewLink({ lat: 91, lon: 0 }), /lat/);
	assert.throws(() => viewLink({ lat: 0, lon: 0, app: "toString" }), /app/);
});

test("道具の台帳：7 本・名前が重ならない・読むだけの印", () => {
	assert.equal(TOOLS.length, 7);
	assert.equal(new Set(TOOLS.map(t => t.name)).size, 7);
	for (const t of TOOLS) { assert.equal(t.inputSchema.type, "object"); assert.equal(t.annotations.readOnlyHint, true); assert.ok(t.description.length > 40, t.name); }
});

test("JSON-RPC：initialize・通知・tools/list・誤り", async () => {
	const { handle } = createServer({ load });
	const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
	assert.equal(init.result.protocolVersion, "2025-06-18");
	assert.equal(init.result.serverInfo.version, VERSION);
	assert.equal((await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } })).result.protocolVersion, "2025-11-25");
	assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
	const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	assert.equal(list.result.tools.length, 7);
	assert.ok(list.result.tools.every(t => !("run" in t)));
	assert.equal((await handle({ jsonrpc: "2.0", id: 3, method: "nope" })).error.code, -32601);
	assert.equal((await handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "nope" } })).error.code, -32602);
	const bad = await handle({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "view_link", arguments: { lat: 100, lon: 0 } } });
	assert.equal(bad.result.isError, true);
	assert.equal((await handle({ id: 6, method: "ping" })).error.code, -32600);
});

const stdio = (lines) => new Promise((resolve, reject) => {
	const p = spawn(process.execPath, [here("../bin/ortho-earth-mcp.js")], { env: { ...process.env, ORTHO_EARTH_BASE: dir } });
	let out = "", err = "";
	p.stdout.on("data", d => out += d); p.stderr.on("data", d => err += d);
	p.on("error", reject);
	p.on("close", code => code === 0 ? resolve(out.trim().split("\n").filter(Boolean).map(l => JSON.parse(l))) : reject(new Error(`exit ${code}: ${err}`)));
	for (const l of lines) p.stdin.write((typeof l === "string" ? l : JSON.stringify(l)) + "\n");
	p.stdin.end();
});

test("stdio：bin を起こして全部の道具を 1 回ずつ（資料は手元の写し）", async () => {
	const args = { get_facts: {}, search_docs: { query: "3D Tiles" }, get_started: { route: "html" }, check_compat: { query: "popup" }, lookup_api: { name: "createGlobe" }, view_link: { lat: 35, lon: 139 }, list_apps: {} };
	const msgs = [
		{ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		"{not json",
		...TOOLS.map((t, i) => ({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: t.name, arguments: args[t.name] } })),
	];
	const res = await stdio(msgs);
	assert.equal(res.length, 1 + 1 + TOOLS.length);   // 通知には答えない・壊れた行は Parse error
	assert.ok(res.some(r => r.error?.code === -32700));
	const by = Object.fromEntries(res.filter(r => r.id > 0).map(r => [TOOLS[r.id - 1].name, r.result]));
	for (const [k, r] of Object.entries(by)) assert.ok(!r.isError, `${k}: ${r.content[0].text}`);
	assert.match(by.get_facts.content[0].text, /9\.9\.9/);
	assert.match(by.search_docs.content[0].text, /^## Coming from CesiumJS › 3D data and terrain\nSource: https:\/\/www\.ortho-earth\.com\/docs\/from-cesium/);
	assert.match(by.get_started.content[0].text, /@ortho-earth\/japan/);
	assert.equal(JSON.parse(by.check_compat.content[0].text).maplibre.examples[0].id, "add-a-popup");
	assert.match(by.lookup_api.content[0].text, /globe\.d\.ts:3/);
	assert.equal(JSON.parse(by.view_link.content[0].text).view, "#3.00/35.00000/139.00000");
	assert.equal(JSON.parse(by.list_apps.content[0].text).length, 2);
});

test("Worker：POST で答え・通知は 202・GET は 405・preflight・道の外は 404・壊れた JSON は 400", async () => {
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => { const p = String(url).replace("https://www.ortho-earth.com/", ""); return Object.hasOwn(FILES, p) ? new Response(FILES[p]) : new Response("no", { status: 404 }); };
	try {
		const { default: worker } = await import("../worker.js");
		const post = (body) => worker.fetch(new Request("https://www.ortho-earth.com/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: typeof body === "string" ? body : JSON.stringify(body) }));
		const r = await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_facts", arguments: {} } });
		assert.equal(r.status, 200);
		assert.equal(r.headers.get("Access-Control-Allow-Origin"), "*");
		assert.match((await r.json()).result.content[0].text, /9\.9\.9/);
		assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
		assert.equal((await post("{oops")).status, 400);
		assert.equal((await worker.fetch(new Request("https://www.ortho-earth.com/mcp"))).status, 405);
		assert.equal((await worker.fetch(new Request("https://www.ortho-earth.com/mcp", { method: "OPTIONS" }))).status, 204);
		assert.equal((await worker.fetch(new Request("https://www.ortho-earth.com/mcpx", { method: "POST", body: "{}" }))).status, 404);
	} finally { globalThis.fetch = realFetch; }
});
