// 公式例の門（台帳 §8）の器＝globe の検定台（../../vite.config.js）に「配りの差し込み」を 1 つ足しただけ。
// root は packages/globe のまま＝こちらの通訳（src/maplibre/）は verify:ui と同じ変換（worker・?url・CSS・#tile-formats・BASE_URL）で配られる。
//   /{ref,ortho}/test/examples/<名>.html ＝取り置きの**バイトをそのまま**（vite の HTML 変換を通さない＝import map の例も壊れない・一文字も変えない）
//   /{ref,ortho}/dist/maplibre-gl.css   ＝本物の CSS（双方同じ）
//   /ref/dist/maplibre-gl-dev.mjs       ＝本物を包む 5 行（Map を継いで作った地図と事象を window.__mlx に積む）
//   /ref/dist/_real/**                  ＝本物 6.11.2 の dist を静的に（vite を通さない＝worker の chunk・blob もそのまま）
//   /ortho/dist/maplibre-gl-dev.mjs     ＝tests/mlexamples/ortho-entry.js へ書き換え（vite が変換＝通訳を包む）
//   /ref/** は COOP/COEP を外す（本番の MapLibre と同じ条件）・/ortho/** は検定台と同じく付けたまま（こちらの worker に要る）
// 例は素材を maplibre.org の絶対 URL で取る＝ここでは配らない（走らせ台の網の横取りが取り置きの素材へ振り替える）。
import { defineConfig, mergeConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import base from "../../vite.config.js";
import { CACHE } from "./corpus.mjs";

const MIME = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".css": "text/css", ".map": "application/json", ".json": "application/json" };

// 本物の包み：名前空間は本物のまま・Map だけ継ぐ（明示の export は export * より勝つ）
const REF_WRAPPER = `export * from "./_real/maplibre-gl-dev.mjs";
import * as real from "./_real/maplibre-gl-dev.mjs";
const X = (window.__mlx ||= { side: "ref", maps: [], ev: [], errors: [] });
export class Map extends real.Map {
	constructor(o) {
		super(o); const i = X.maps.push(this) - 1;
		for (const k of ["load", "style.load", "idle"]) this.on(k, () => X.ev.push([i, k, Math.round(performance.now())]));
		this.on("error", e => X.errors.push([i, String(e?.error?.message || e?.error || e?.message || e)]));
	}
}
`;

const inside = (dir, rel) => { const f = path.resolve(dir, rel); return f.startsWith(dir + path.sep) ? f : null; };

const serve = {
	name: "mlexamples-serve",
	configureServer(server) {
		server.middlewares.use((req, res, next) => {
			const u = new URL(req.url, "http://x");
			const m = /^\/(ref|ortho)\/(.*)$/.exec(u.pathname);
			if (!m) return next();
			const [, side, rest] = m;
			if (side === "ref") { res.removeHeader("Cross-Origin-Opener-Policy"); res.removeHeader("Cross-Origin-Embedder-Policy"); }
			let file = null;
			if (rest.startsWith("test/examples/")) file = inside(path.join(CACHE, "examples"), decodeURIComponent(rest.slice("test/examples/".length)));
			else if (rest === "dist/maplibre-gl.css") file = path.join(CACHE, "dist/maplibre-gl.css");
			else if (side === "ref" && rest === "dist/maplibre-gl-dev.mjs") {
				res.setHeader("Content-Type", MIME[".mjs"]); res.setHeader("Cache-Control", "no-store");
				return res.end(REF_WRAPPER);
			} else if (side === "ref" && rest.startsWith("dist/_real/")) file = inside(path.join(CACHE, "dist"), rest.slice("dist/_real/".length));
			else if (side === "ortho" && rest === "dist/maplibre-gl-dev.mjs") { req.url = "/tests/mlexamples/ortho-entry.js"; return next(); }
			if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end(); }
			res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
			res.setHeader("Cache-Control", "no-store");
			fs.createReadStream(file).pipe(res);
		});
	},
};

export default mergeConfig(base, defineConfig({
	root: path.resolve(import.meta.dirname, "../.."),
	server: { watch: { ignored: ["**/.cache/**"] } },
	plugins: [serve],
}));
