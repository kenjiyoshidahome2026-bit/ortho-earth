import { defineConfig } from "vite";
import { resolve } from "node:path";

// 共有エンジンの 5 本目の入口 maplibre.js（MapLibre GL JS 互換の口・www の /maplibre/ が import map で指す）を**別に**焼く（2026-10-01）。
// 本体の lib ビルド（vite.engine.config.js）の入口に足すと、本体が globe.js から共有チャンク assets/globe-*.js へ移り、
// japan の本番組立で撮影（shot）が「OffscreenCanvas の大きさ 0」で落ちた（verify:prod の実クリック・#201 の直後）。
// ＝本体の束は一切変えず、互換の口だけを焼いて、エンジン本体は隣の ./globe.js（既存の入口＝CSS も貼る）を実行時に読む。
// 互換の口は ../globe.js（公開の顔）しか import しない（mlshim の掟）＝そこを外部 ./globe.js に差し替えるだけで済む。
const ROOT = resolve(import.meta.dirname, "../..");
const FACE = resolve(ROOT, "packages/globe/src/globe.js");
const toEngineEntry = {
	name: "engine-entry-external",
	enforce: "pre",
	async resolveId(id, importer) {
		if (id === "./globe.js" && importer?.endsWith("/engine/maplibre.js")) return { id: "./globe.js", external: true };
		const r = await this.resolve(id, importer, { skipSelf: true });
		return r?.id === FACE ? { id: "./globe.js", external: true } : null;
	},
};
export default defineConfig({
	root: import.meta.dirname,
	plugins: [toEngineEntry],
	publicDir: false,
	build: {
		outDir: "dist/engine/_build",
		emptyOutDir: false,   // 本体のビルドの出力に足す（build-engine.mjs が本体の後に呼ぶ）
		sourcemap: true,
		lib: { entry: { maplibre: resolve(import.meta.dirname, "engine/maplibre.js") }, formats: ["es"] },
		rollupOptions: { output: { minify: true, entryFileNames: "[name].js", chunkFileNames: "assets/ml-[name]-[hash].js" } },
	},
});
