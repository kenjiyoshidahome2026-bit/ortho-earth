// Ortho Earth の MCP サーバーの道具（2026-11-11）。どれも読むだけ＝鍵も書き込みも無い。
// 答えの材料は www.ortho-earth.com が配る機械可読の資料（apps/www が正本から組む＝版を出すたびに新しくなる）：
//   /facts.json・/llms.txt・/llms-full.txt・/start.md・/compat.json・/ref/globe.d.ts・/ref/globe-map.ts・/ref/maplibre.d.ts
// 取り方（load）は呼び手が渡す＝node の stdio 版も Cloudflare Worker 版も同じ道具を使う。

/** @typedef {(path: string) => Promise<string>} Load */

const SITE = "https://www.ortho-earth.com";
const CLIP = 4000;   // 1 節の返す文字の上限（長い節で文脈を潰さない）

const clip = (s, n = CLIP) => s.length <= n ? s : s.slice(0, n) + `\n…(${s.length - n} more characters; see the source page)`;
const termsOf = (q) => String(q ?? "").toLowerCase().split(/[\s,、。]+/).map(t => t.trim()).filter(t => t.length >= 2 || /[^\x00-\x7f]/.test(t));
const countIn = (hay, t) => { let n = 0, i = 0; while ((i = hay.indexOf(t, i)) !== -1) { n++; i += t.length; } return n; };

/** Markdown を見出し（## 〜 ####）で節に分ける。``` の中の # は見出しでない。"Source: <url>" を節の出所として引き継ぐ */
export function sections(md) {
	const out = [], path = [];
	let cur = null, fence = false, source = null;
	for (const line of md.split("\n")) {
		if (/^\s*```/.test(line)) fence = !fence;
		const h = !fence && /^(#{1,4}) (.+)$/.exec(line);
		if (h) {
			const level = h[1].length;
			path.length = level - 1;
			path[level - 1] = h[2].trim();
			if (level <= 2) source = null;
			cur = { title: path.filter(Boolean).filter(t => t !== "Full text").join(" › "), heading: h[2].trim(), level, source, lines: [] };
			out.push(cur);
			continue;
		}
		const s = !fence && /^Source: (https?:\/\/\S+)$/.exec(line);
		if (s) { source = s[1]; if (cur) cur.source = source; continue; }   // 節の頭の出所＝後ろの小見出しも継ぐ
		if (cur) cur.lines.push(line);
	}
	return out.map(({ lines, ...s }) => ({ ...s, body: lines.join("\n").trim() }));
}

export function searchDocs(md, query, limit = 3) {
	const terms = termsOf(query);
	if (!terms.length) throw new Error("query is empty");
	const hits = [];
	for (const s of sections(md)) {
		if (!s.body) continue;
		const title = s.title.toLowerCase(), body = s.body.toLowerCase();
		let matched = 0, score = 0;
		for (const t of terms) {
			const nt = countIn(title, t), nb = countIn(body, t);
			if (nt || nb) matched++;
			score += nt * 5 + Math.min(nb, 10);
		}
		if (matched) hits.push({ s, matched, score });
	}
	hits.sort((a, b) => b.matched - a.matched || b.score - a.score);
	return hits.slice(0, Math.max(1, Math.min(8, limit | 0 || 3))).map(h => h.s);
}

/** start.md から道筋（vite／html）の節と、AI エージェントへの注意を切り出す */
export function startRoute(md, route) {
	const parts = md.split(/^---$/m).map(p => p.trim());
	const intro = parts[0];
	const want = route === "html" ? /^## Route B/m : /^## Route A/m;
	const body = parts.find(p => want.test(p));
	const notes = parts.find(p => /^## Notes for AI coding agents/m.test(p));
	if (!body) throw new Error(`start.md: no section for route ${route}`);
	return [intro, body, notes].filter(Boolean).join("\n\n---\n\n");
}

/** llms.txt の「## Apps」の節 →［{ name, url, description }］ */
export function appsOf(llms) {
	const s = sections(llms).find(x => x.heading === "Apps");
	if (!s) throw new Error("llms.txt: no Apps section");
	return s.body.split("\n").map(l => /^- \[([^\]]+)\]\((https?:\/\/[^)]+)\): (.*)$/.exec(l)).filter(Boolean).map(m => ({ name: m[1], url: m[2], description: m[3] }));
}

/** .d.ts から名前の宣言を、直前の JSDoc つきで引く。型・関数・interface の本体は閉じ括弧まで（長い物は切る） */
export function lookupApi(files, name, limit = 6) {
	const want = String(name ?? "").trim().split(".").pop();
	if (!/^[A-Za-z_$][\w$]*$/.test(want || "")) throw new Error("name must be an identifier such as createGlobe, Map or flyTo");
	const re = new RegExp(`(^|[\\s(,{;])(?:export\\s+)?(?:declare\\s+)?(?:(?:function|interface|type|class|const|let|enum|namespace)\\s+${want}\\b|(?:readonly\\s+)?${want}\\??\\s*[:(<])`);
	const top = new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:function|interface|type|class|const|let|enum|namespace)\\s+${want}\\b`);
	const hits = [];
	for (const [file, text] of Object.entries(files)) {
		const lines = text.split("\n");
		lines.forEach((line, i) => {
			if (!re.test(line) || /^\s*(\/\/|\*|\/\*)/.test(line)) return;
			let a = i;   // 直前の JSDoc（/** … */）を足す
			if (/\*\/\s*$/.test(lines[i - 1] ?? "")) { a = i - 1; while (a > 0 && !/\/\*\*/.test(lines[a])) a--; }
			else if (/^\s*\/\*\*.*\*\/\s*$/.test(lines[i - 1] ?? "")) a = i - 1;
			let b = i, depth = 0;   // 本体を閉じ括弧まで（{ の数で数える・60 行で切る）
			for (let k = i; k < lines.length && k < i + 60; k++) {
				for (const ch of lines[k].replace(/\/\/.*$/, "")) { if (ch === "{") depth++; else if (ch === "}") depth--; }
				b = k;
				if (depth <= 0 && (k > i || !/[{(,]\s*$/.test(lines[k]))) break;
			}
			hits.push({ file, line: i + 1, exact: top.test(line), code: lines.slice(a, b + 1).join("\n") });
		});
	}
	hits.sort((x, y) => Number(y.exact) - Number(x.exact));
	if (hits.length) return { found: true, hits: hits.slice(0, limit), more: Math.max(0, hits.length - limit) };
	const ids = new Set();
	for (const text of Object.values(files)) for (const m of text.matchAll(/\b[A-Za-z_$][\w$]{2,}\b/g)) if (m[0].toLowerCase().includes(want.toLowerCase())) ids.add(m[0]);
	return { found: false, similar: [...ids].slice(0, 15) };
}

export function checkCompat(compat, query, library = "all") {
	const terms = termsOf(query);
	if (!terms.length) throw new Error("query is empty");
	const has = (s) => { const h = s.toLowerCase(); return terms.every(t => h.includes(t)); };
	const pick = (lib) => compat[lib].examples.filter(e => has(`${e.id} ${e.title}`)).slice(0, 12)
		.map(({ id, title, level, picture, note, imagery, url, original }) => ({ id, title, level: level ?? "notScored", ...(picture != null ? { picturePercent: picture } : {}), ...(note ? { note } : {}), ...(imagery ? { imagery } : {}), url, original }));
	const out = { levels: compat.levels };
	if (library !== "cesium") { out.maplibre = { how: compat.maplibre.how, examples: pick("maplibre") }; out.styleSpec = compat.styleSpec.filter(p => has(`${p.layer} ${p.property}`)).slice(0, 20); if (out.styleSpec.length) out.styleStatus = compat.styleStatus; }
	if (library !== "maplibre") out.cesium = { how: compat.cesium.how, examples: pick("cesium") };
	const n = (out.maplibre?.examples.length ?? 0) + (out.cesium?.examples.length ?? 0) + (out.styleSpec?.length ?? 0);
	out.summary = n ? `${n} matching entries. Each example is the library's own official example, run unchanged on Ortho Earth and graded against the original.`
		: "No official example or style property matches. That does not mean it is unsupported: try search_docs or lookup_api, and at runtime ask map.supports(key) / map.capabilities().";
	return out;
}

/** 視点の URL。zoom・lat・lon は createGlobe({ view: "#zoom/lat/lon" }) と同じ（start.md） */
export function viewLink({ lat, lon, zoom = 3, pitch = 0, bearing = 0, app = "globe" }) {
	const num = (v, lo, hi, k) => { const x = Number(v); if (!Number.isFinite(x) || x < lo || x > hi) throw new Error(`${k} must be a number from ${lo} to ${hi}`); return x; };
	lat = num(lat, -90, 90, "lat"); lon = num(lon, -180, 180, "lon"); zoom = num(zoom, 0, 22, "zoom"); pitch = num(pitch, 0, 85, "pitch"); bearing = num(bearing, -360, 360, "bearing");
	const APPS = { globe: `${SITE}/globe/`, japan: `${SITE}/japan/` };
	if (!Object.hasOwn(APPS, app)) throw new Error(`app must be one of ${Object.keys(APPS).join(", ")}`);
	const parts = [zoom.toFixed(2), lat.toFixed(5), lon.toFixed(5)];
	if (pitch > 0.001) parts.push(Math.round(pitch) + "t");
	if (Math.abs(bearing) > 0.001) parts.push(Math.round(bearing) + "r");
	const view = "#" + parts.join("/");
	return { url: APPS[app] + view, view, code: `const map = await createGlobe({ target: "#map", view: "${view}" });` };
}

const json = (v) => JSON.stringify(v, null, 2);

/** 道具の台帳：MCP の tools/list にそのまま出す形＋実行（run） */
export const TOOLS = [
	{
		name: "get_facts",
		title: "Current facts about Ortho Earth",
		description: "Latest version and release date, npm packages, licenses, and how many official MapLibre GL JS and CesiumJS examples run unchanged on Ortho Earth. Rebuilt on every deploy of www.ortho-earth.com. Call this before stating a version number or a compatibility figure.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async (_a, load) => await load("facts.json"),
	},
	{
		name: "search_docs",
		title: "Search the Ortho Earth documentation",
		description: "Full-text search over the Ortho Earth documentation (the recipe, the changelog, migration guides from MapLibre GL JS, CesiumJS, Leaflet and Google Maps, the engine overview, GeoPBF, Gint, comparison articles). Returns the best matching sections with their source page.",
		inputSchema: { type: "object", properties: { query: { type: "string", description: "Words to look for, e.g. \"3D Tiles\", \"terrain exaggeration\", \"popup\"" }, limit: { type: "integer", minimum: 1, maximum: 8, default: 3 } }, required: ["query"], additionalProperties: false },
		run: async (a, load) => {
			const hits = searchDocs(await load("llms-full.txt"), a.query, a.limit);
			if (!hits.length) return `Nothing matched "${a.query}". Try other words, or lookup_api for an API name.`;
			return hits.map(s => `## ${s.title}\nSource: ${s.source ?? `${SITE}/llms-full.txt`}\n\n${clip(s.body)}`).join("\n\n---\n\n");
		},
	},
	{
		name: "get_started",
		title: "Tested recipe for a page with the globe",
		description: "The step-by-step recipe for putting the Ortho Earth globe in a web page, with the exact file contents. Every step is run by an automated test against the published npm packages. route \"vite\" = npm + Vite project with @ortho-earth/globe (recommended); route \"html\" = a plain HTML page without a bundler.",
		inputSchema: { type: "object", properties: { route: { type: "string", enum: ["vite", "html"], default: "vite" } }, additionalProperties: false },
		run: async (a, load) => startRoute(await load("start.md"), a.route ?? "vite"),
	},
	{
		name: "check_compat",
		title: "Does this MapLibre / CesiumJS feature work on Ortho Earth?",
		description: "Looks up how the official MapLibre GL JS examples and CesiumJS Sandcastle examples matching the query run on Ortho Earth (same picture / same answers / runs partly / does not run), with notes and links to side-by-side comparisons, and how MapLibre style properties are read (e.g. \"fill-extrusion\", \"line-dasharray\").",
		inputSchema: { type: "object", properties: { query: { type: "string", description: "Feature or example name, e.g. \"terrain\", \"popup\", \"3d tiles\", \"fill-pattern\"" }, library: { type: "string", enum: ["all", "maplibre", "cesium"], default: "all" } }, required: ["query"], additionalProperties: false },
		run: async (a, load) => json(checkCompat(JSON.parse(await load("compat.json")), a.query, a.library ?? "all")),
	},
	{
		name: "lookup_api",
		title: "Look up an Ortho Earth API",
		description: "Returns the TypeScript declaration (with its doc comment) of an Ortho Earth API from the published types: createGlobe and its options (globe.d.ts), the map object it returns (globe-map.ts), and the MapLibre-compatible facade (maplibre.d.ts). Doc comments are partly in Japanese.",
		inputSchema: { type: "object", properties: { name: { type: "string", description: "An identifier, e.g. \"createGlobe\", \"flyTo\", \"Map.addLayer\", \"GlobeOptions\"" } }, required: ["name"], additionalProperties: false },
		run: async (a, load) => {
			const files = { "globe.d.ts": await load("ref/globe.d.ts"), "globe-map.ts": await load("ref/globe-map.ts"), "maplibre.d.ts": await load("ref/maplibre.d.ts") };
			const r = lookupApi(files, a.name);
			if (!r.found) return `No declaration named "${a.name}".` + (r.similar.length ? ` Similar names: ${r.similar.join(", ")}` : " Try search_docs.");
			return r.hits.map(h => `// ${h.file}:${h.line}\n${clip(h.code, 2500)}`).join("\n\n") + (r.more ? `\n\n(${r.more} more matches; ask for a more specific name)` : "");
		},
	},
	{
		name: "view_link",
		title: "Link to a place on the globe",
		description: "Makes a www.ortho-earth.com link that opens the 3D globe at a place, and the matching view string for createGlobe({ view }). zoom uses the same scale as the view string (about 0–2 for the whole Earth, 12 for a city). app \"japan\" adds Japan's detailed basemap and PLATEAU 3D buildings.",
		inputSchema: { type: "object", properties: { lat: { type: "number", minimum: -90, maximum: 90 }, lon: { type: "number", minimum: -180, maximum: 180 }, zoom: { type: "number", minimum: 0, maximum: 22, default: 3 }, pitch: { type: "number", minimum: 0, maximum: 85, default: 0, description: "Tilt in degrees" }, bearing: { type: "number", default: 0, description: "Rotation in degrees, clockwise from north" }, app: { type: "string", enum: ["globe", "japan"], default: "globe" } }, required: ["lat", "lon"], additionalProperties: false },
		run: async (a) => json(viewLink(a)),
	},
	{
		name: "list_apps",
		title: "Apps and demos built with Ortho Earth",
		description: "The apps and demos on www.ortho-earth.com, each with its link and a one-line description. Useful for showing what the engine can do.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async (_a, load) => json(appsOf(await load("llms.txt"))),
	},
];
for (const t of TOOLS) t.annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
