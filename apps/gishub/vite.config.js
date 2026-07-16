import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
	base: '/gishub/',
	plugins: [
		wasm(),
	],
		server: {
		headers: { // sharedArrayBuffer を Worker で受け取るための CORS 関連ヘッダー
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp'
		}
		},
	 	worker: { format: 'es' },
	// sourcemap: 'hidden' = .mapは出すがJS末尾に参照を書かない＝デプロイしても実質非公開（gishub-jpと同じ方針）
	build: { target: 'esnext', sourcemap: 'hidden' },
	css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } }
});