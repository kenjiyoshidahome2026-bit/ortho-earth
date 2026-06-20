import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';

export default defineConfig({
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
    build: { target: 'esnext', sourcemap: true, },
	css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } }
});