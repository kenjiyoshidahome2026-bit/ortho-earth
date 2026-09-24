import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { resolve } from 'node:path';

// 地球儀＝@ortho-earth/globe（地域なしのホスト）＝dev も本番もソース直 import＝同梱（A 裁定 2026-09-23・external 無し）。
// 実行時アセット（koppen-clim.png 等）は globe の家（apps/ortho-globe/public）：本番＝/globe/（ortho-globe の Worker が配る）・dev＝/@fs で直読み。
const ROOT = resolve(import.meta.dirname, '../..');
const GLOBE_PUBLIC = resolve(import.meta.dirname, '../ortho-globe/public');

export default defineConfig(({ command }) => ({
	base: '/geopbf/',
	plugins: [
		wasm(),
	],
	define: { __GLOBE_ASSETS__: JSON.stringify(command === 'serve' ? `/geopbf/@fs${GLOBE_PUBLIC}/` : '/globe/') },
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
	build: { target: 'esnext', sourcemap: 'hidden' },
	css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } }
}));
