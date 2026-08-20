// apps/uploader/vite.config.js
import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
//import wasm from 'vite-plugin-wasm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
//    plugins: [wasm()],
	resolve: {
		// 旧パスエイリアス（src直指し）。geopbf だけは撤去（2026-08-21）＝exports のサブパス
		// （geopbf/encodeZIP 等）を迂回して解決不能になるため、workspace 解決に委ねる。
		alias: {
			'common': path.resolve(__dirname, '../../packages/common/src'),
			'native-bucket': path.resolve(__dirname, '../../packages/native-bucket/src'),
			'altpbf': path.resolve(__dirname, '../../packages/altpbf/src'),
			'ortho-map': path.resolve(__dirname, '../../packages/ortho-map/src'),
		   'calender': path.resolve(__dirname, '../../packages/calender/src')
		}
	},
	optimizeDeps: {
		exclude: ['ortho-map', 'common', 'geopbf', 'altpbf', 'native-bucket', 'calender']
	},
	server: {
		fs: { allow: ['../..'] },
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		},
		proxy: {
			'/api': {
				target: 'https://api.ortho-earth.com',
				changeOrigin: true,
				rewrite: path => path.replace(/^\/api/, '')
			}
		}
	},
	worker: {
		format: 'es'
	},
	build: {
		sourcemap: true,
		target: 'esnext' // または 'es2022'
	}
});
