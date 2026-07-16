import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
	base: '/gishub-jp/',
	plugins: [wasm()],
	worker: { format: 'es' },
	// sourcemap: 'hidden' = .map は生成するが JS 末尾に参照 URL を書かない（=デプロイしても実質非公開、
	// sealed 済みパッケージの生ソースが sourcesContent で丸見えになるのを防ぐ）。ローカルのデバッグは可能
	build: { target: 'esnext', sourcemap: 'hidden' },
	css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } },
	server: {
		port: 5173,
		open: true,
		headers: {
			'Cross-Origin-Opener-Policy':   'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
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
})
