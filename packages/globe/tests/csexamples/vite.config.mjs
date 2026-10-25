// Cesium の公式例の門（段 0）の器＝globe の検定台（../../vite.config.js）に「配りの差し込み」を 1 つ足しただけ（tests/mlexamples/vite.config.mjs と同じ作り）。
// root は packages/globe のまま＝こちらの互換の口（src/cesium/）は verify:ui と同じ変換で配られる。
//   /cs/{ref,ortho}/gallery/<名>/            ＝例の頁（Sandcastle の bucket と同じ組み立て：index.html の本文＋main.js を module で・import map で "cesium" と "Sandcastle" を引く）
//   /cs/{ref,ortho}/gallery/<名>/main.js     ＝取り置きの**バイトをそのまま**（一文字も変えない）
//   /cs/{ref,ortho}/gallery/templates/*      ＝bucket.css（例が ../templates/bucket.css を @import する）
//   /cs/{ref,ortho}/SampleData/**            ＝素材（例は ../../SampleData/… で取る）
//   /cs/ref/Build/Cesium/**                  ＝本物 1.146 の Build を静的に（vite を通さない＝Workers・Assets もそのまま）
//   /cs/ref/cesium.js                        ＝本物を包む数行（Viewer を継いで作った viewer と事象を window.__csx に積む）
//   /cs/ortho/cesium.js                      ＝tests/csexamples/ortho-entry.js へ書き換え（vite が変換＝互換の口を包む）
//   /cs/{ref,ortho}/Sandcastle.js            ＝Sandcastle の助け手（取り置きの templates/Sandcastle.ts を vite で変換）
//   /cs/ref/** は COOP/COEP を外す（本番の Cesium と同じ条件）・/cs/ortho/** は検定台と同じく付けたまま（こちらの worker に要る）
import { defineConfig, mergeConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import base from "../../vite.config.js";
import { CACHE } from "./corpus.mjs";

const MIME = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm",
	".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".czml": "application/json",
	".geojson": "application/json", ".topojson": "application/json", ".kml": "application/vnd.google-earth.kml+xml", ".kmz": "application/vnd.google-earth.kmz", ".b3dm": "application/octet-stream",
	".pnts": "application/octet-stream", ".i3dm": "application/octet-stream", ".cmpt": "application/octet-stream", ".terrain": "application/vnd.quantized-mesh", ".ktx2": "image/ktx2" };

// 本物の包み：名前空間は本物のまま・Viewer だけ継ぐ（明示の export は export * より勝つ）
const REF_WRAPPER = `export * from "./Build/Cesium/index.js";
import * as real from "./Build/Cesium/index.js";
const X = (window.__csx ||= { side: "ref", viewers: [], errors: [] });
export class Viewer extends real.Viewer {
	constructor(c, o) {
		super(c, o); X.viewers.push(this);
		this.scene.renderError.addEventListener((s, e) => X.errors.push(String(e?.message || e)));
	}
}
`;

// 例の頁＝Sandcastle の bucket.html の要る所だけ（widgets.css・CESIUM_BASE_URL・import map）＋例の index.html の本文＋main.js
const page = (side, name) => {
	const body = fs.readFileSync(path.join(CACHE, "gallery", name, "index.html"), "utf8");
	const imports = { cesium: `/cs/${side}/cesium.js`, Sandcastle: `/cs/${side}/Sandcastle.js` };
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${name}</title>
<link rel="stylesheet" href="/cs/ref/Build/Cesium/Widgets/widgets.css">
<style>html,body{height:100%;margin:0;padding:0;overflow:hidden;font-family:sans-serif;font-size:9pt;background:#222}</style>
<script>window.CESIUM_BASE_URL = "/cs/ref/Build/Cesium/";</script>
<script type="importmap">${JSON.stringify({ imports })}</script>
</head><body class="sandcastle-loading">
${body}
<script type="module">
document.body.classList.remove("sandcastle-loading");
import("./main.js").then(async () => { (await import("Sandcastle")).default.finishedLoading(); (window.__csx ||= { errors: [] }).ran = true; })   // 助け手の既定の操作（最初の項目）＝Sandcastle の外枠と同じく例の後に
	.catch(e => { (window.__csx ||= { errors: [] }).errors.push("import: " + (e?.message || e)); console.error(e); });
</script>
</body></html>`;
};

const inside = (dir, rel) => { const f = path.resolve(dir, rel); return f.startsWith(dir + path.sep) ? f : null; };

const serve = {
	name: "csexamples-serve",
	configureServer(server) {
		server.middlewares.use((req, res, next) => {
			const u = new URL(req.url, "http://x");
			const m = /^\/cs\/(ref|ortho)\/(.*)$/.exec(u.pathname);
			if (!m) return next();
			const [, side, rest] = m;
			if (side === "ref") { res.removeHeader("Cross-Origin-Opener-Policy"); res.removeHeader("Cross-Origin-Embedder-Policy"); }
			let file = null, g;
			if ((g = /^gallery\/([a-z0-9-]+)\/$/.exec(rest)) && fs.existsSync(path.join(CACHE, "gallery", g[1], "main.js"))) {
				res.setHeader("Content-Type", MIME[".html"]); res.setHeader("Cache-Control", "no-store");
				return res.end(page(side, g[1]));
			}
			if (rest.startsWith("gallery/templates/")) file = inside(path.join(CACHE, "templates"), decodeURIComponent(rest.slice("gallery/templates/".length)));
			else if (rest.startsWith("gallery/")) file = inside(path.join(CACHE, "gallery"), decodeURIComponent(rest.slice("gallery/".length)));
			else if (rest.startsWith("SampleData/")) file = inside(path.join(CACHE, "SampleData"), decodeURIComponent(rest.slice("SampleData/".length)));
			else if (side === "ref" && rest.startsWith("Build/")) file = inside(path.join(CACHE, "Build"), decodeURIComponent(rest.slice("Build/".length)));
			else if (side === "ref" && rest === "cesium.js") { res.setHeader("Content-Type", MIME[".js"]); res.setHeader("Cache-Control", "no-store"); return res.end(REF_WRAPPER); }
			else if (side === "ortho" && rest === "cesium.js") { req.url = "/tests/csexamples/ortho-entry.js"; return next(); }
			else if (rest === "Sandcastle.js") { req.url = `/@fs${path.join(CACHE, "templates/Sandcastle.ts")}`; return next(); }
			if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
			res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
			res.setHeader("Cache-Control", "no-store");
			fs.createReadStream(file).pipe(res);
		});
	},
};

export default mergeConfig(base, defineConfig({
	root: path.resolve(import.meta.dirname, "../.."),
	server: { watch: { ignored: ["**/.cache/**"] }, fs: { allow: [path.resolve(import.meta.dirname, "../../../.."), CACHE] } },
	plugins: [serve],
}));
