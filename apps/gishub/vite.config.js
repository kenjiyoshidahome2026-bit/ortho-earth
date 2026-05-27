import { defineConfig } from 'vite';

export default defineConfig({
  	server: {
		headers: { // sharedArrayBuffer を Worker で受け取るための CORS 関連ヘッダー
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp'
		}
  	},
   	worker: { format: 'es' },
    build: { target: 'esnext',
        sourcemap: true,
    }
});