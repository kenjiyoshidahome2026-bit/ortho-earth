import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { resolve } from 'node:path';

// 地球儀＝ortho-japan エンジン（gint v2）＝dev も本番も ../ortho-japan/app.js をソース直 import＝同梱（A 裁定 2026-09-23・external 無し）。
// 実行時アセット（plateau-sets.json 等）は ortho-japan の public が正本：本番＝/japan/（japan Worker が配る）・dev＝/@fs で直読み。
const ROOT = resolve(import.meta.dirname, '../..');
const JAPAN_PUBLIC = resolve(import.meta.dirname, '../ortho-japan/public');
// rolldown（vite 8）のチャンク最適化を切る（2026-09-25・world／ortho-nl と同じ＝globe を束ねる vite 8 アプリの決まり）。
// 既定 on だと実行時ヘルパ __exportAll の共通チャンクが動的エントリ mesh-loaders に合流し、gint・topology・pbf-base 等が
// ヘルパ欲しさに mesh-loaders＋basis-loader（計 220KB）を静的 import する（8.1 で 5 本を実測）。worker は別ビルド＝両方に要る。
// experimental の口＝rolldown を上げたら「mesh-loaders を静的 import するチャンクが無い」ことを確かめ直す。
const noChunkOptimization = { experimental: { chunkOptimization: false } };

export default defineConfig(({ command }) => ({
	base: '/gishub-jp/',
	plugins: [wasm()],
	define: { __JAPAN_ASSETS__: JSON.stringify(command === 'serve' ? `/gishub-jp/@fs${JAPAN_PUBLIC}/` : '/japan/') },
	worker: { format: 'es', rolldownOptions: noChunkOptimization },
	// sourcemap: 'hidden' = .map は生成するが JS 末尾に参照 URL を書かない（=デプロイしても実質非公開、
	// sealed 済みパッケージの生ソースが sourcesContent で丸見えになるのを防ぐ）。ローカルのデバッグは可能
	// cssTarget＝vite 8 の既定（baseline-widely-available）の実体。無いと cssTarget も esnext になり、lightningcss が
	// -webkit-backdrop-filter を「不要な接頭辞」として消す＝iOS 17 以前の Safari でガラスのぼかしが消える（8.1 で 24 規則を実測）
	build: { target: 'esnext', cssTarget: ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4'], sourcemap: 'hidden', rolldownOptions: noChunkOptimization },
	css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } },
	server: {
		port: 5173,
		open: true,
		fs: { allow: [ROOT] },
		// COEP は japan/census2020 と同じ credentialless（crossOriginIsolated＝SharedArrayBuffer の点火条件。無くてもコピー経路で動く）
		headers: {
			'Cross-Origin-Opener-Policy':   'same-origin',
			'Cross-Origin-Embedder-Policy': 'credentialless',
		},
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
