import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { resolve } from 'node:path';

// 地球儀＝ortho-japan エンジン（gint v2）＝dev も本番も ../ortho-japan/app.js をソース直 import＝同梱（A 裁定 2026-09-23・external 無し）。
// 実行時アセット（plateau-sets.json 等）は ortho-japan の public が正本：本番＝/japan/（japan Worker が配る）・dev＝/@fs で直読み。
const ROOT = resolve(import.meta.dirname, '../..');
const JAPAN_PUBLIC = resolve(import.meta.dirname, '../ortho-japan/public');

export default defineConfig(({ command }) => ({
	base: '/gishub-jp/',
	plugins: [wasm()],
	define: { __JAPAN_ASSETS__: JSON.stringify(command === 'serve' ? `/gishub-jp/@fs${JAPAN_PUBLIC}/` : '/japan/') },
	worker: { format: 'es' },
	// sourcemap: 'hidden' = .map は生成するが JS 末尾に参照 URL を書かない（=デプロイしても実質非公開、
	// sealed 済みパッケージの生ソースが sourcesContent で丸見えになるのを防ぐ）。ローカルのデバッグは可能
	build: { target: 'esnext', sourcemap: 'hidden' },
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
