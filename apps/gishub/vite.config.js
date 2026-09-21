import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { resolve } from 'node:path';

// 地球儀＝ortho-japan エンジン（gint v2）。dev＝../ortho-japan/app.js をソース直 import／本番＝/japan/lib/ の SDK（external）。
// 実行時アセット（plateau-sets.json 等）は ortho-japan の public が正本：本番＝/japan/（japan Worker が配る）・dev＝/@fs で直読み。
const ROOT = resolve(import.meta.dirname, '../..');
const JAPAN_PUBLIC = resolve(import.meta.dirname, '../ortho-japan/public');

export default defineConfig(({ command }) => ({
	base: '/gishub/',
	plugins: [
		wasm(),
	],
	define: { __JAPAN_ASSETS__: JSON.stringify(command === 'serve' ? `/gishub/@fs${JAPAN_PUBLIC}/` : '/japan/') },
	server: {
		fs: { allow: [ROOT] },
		// COEP は japan/census2020 と同じ credentialless（crossOriginIsolated＝SharedArrayBuffer の点火条件。無くてもコピー経路で動く）
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'credentialless'
		}
	},
	worker: { format: 'es' },
	// sourcemap: 'hidden' = .mapは出すがJS末尾に参照を書かない＝デプロイしても実質非公開（gishub-jpと同じ方針）
	build: { target: 'esnext', sourcemap: 'hidden', rollupOptions: { external: ['/japan/lib/ortho-japan.js'] } },
	css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } }
}));
