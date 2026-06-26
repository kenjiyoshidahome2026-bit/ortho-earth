import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
	plugins: [wasm()],
	worker: { format: 'es' },
	build: { target: 'esnext', sourcemap: true },
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
