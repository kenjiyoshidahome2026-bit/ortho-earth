import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { resolve } from 'node:path';
import { sharedEngine } from '../../packages/globe/scripts/lib/shared-engine.mjs';   // 共有エンジン（LAYERS.md 掟 3）
import { crossOriginIsolation, noChunkOptimization, CSS_TARGET, orthoData, bootScreen } from '../../packages/globe/scripts/lib/vite-app.mjs';   // アプリ共通の決まり（2026-10-03）

// 地球儀＝@ortho-earth/regions/app（orthoJapan＝globe＋jp パック）。build はエンジンと orthoJapan を共有エンジンの版つき URL から読む（regions/app.js・2026-10-14）
// （2026-09-30・LAYERS.md 掟 3）＝束に残るのは jp パックと gishub の殻。dev はソース直のまま。
// 実行時アセット（plateau-sets.json 等）は packages/jp/assets が正本＝orthoJapan の既定（本番＝共有エンジンの assets/・dev＝/@fs で直読み・2026-10-14）。
// 観測点の GeoPBF（jishin/seismic・jishin/fault・jma/amedas）は ortho-data/japan/：本番＝GitHub Pages・dev＝手元の正本（vite-app.mjs の orthoData・DATA.md）。
const ROOT = resolve(import.meta.dirname, '../..');
// noChunkOptimization＝rolldown（vite 8）の決まり（2026-09-25・gint・topology・pbf-base 等 5 本が mesh-loaders を静的 import するのを 8.1 で実測・理由は vite-app.mjs）。

export default defineConfig(({ command }) => ({
	base: '/gishub-jp/',
	// COOP/COEP は japan/census2020 と同じ credentialless（crossOriginIsolated＝SharedArrayBuffer の点火条件。無くてもコピー経路で動く）＝middleware で dev と preview の全リクエストに刻む（旧 server.headers＝dev だけ）
	plugins: [crossOriginIsolation(), sharedEngine(), wasm(), bootScreen],
	define: { __DATA_JAPAN__: orthoData(command, '/gishub-jp/', ROOT, 'japan') },
	worker: { format: 'es', rolldownOptions: noChunkOptimization },
	// sourcemap: 'hidden' = .map は生成するが JS 末尾に参照 URL を書かない（=デプロイしても実質非公開、
	// sealed 済みパッケージの生ソースが sourcesContent で丸見えになるのを防ぐ）。ローカルのデバッグは可能
	// CSS_TARGET＝vite 8 の既定の実体（target esnext で -webkit-backdrop-filter が消えるのを防ぐ・8.1 で 24 規則を実測・理由は vite-app.mjs）
	build: { target: 'esnext', cssTarget: CSS_TARGET, sourcemap: 'hidden', rolldownOptions: noChunkOptimization },
	css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } },
	server: {
		port: 5173,
		open: true,
		fs: { allow: [ROOT] },
		proxy: {
			'/api/catalog': {
				target: 'https://nlftp.mlit.go.jp',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api\/catalog/, '/ksj/gml')
			},
			'/api': {
				target: 'https://api.ortho-earth.com',
				changeOrigin: true,
				rewrite: path => path.replace(/^\/api/, '')
			}
		}
	}
}))
