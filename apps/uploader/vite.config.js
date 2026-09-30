// apps/uploader/vite.config.js
import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
	// 共有データの正本（apps/gishub-jp/shared-data）の絶対パス＝src/shared-data.js が dev の /@fs で読む
	define: { __SHARED_DATA_DIR__: JSON.stringify(path.resolve(__dirname, '../gishub-jp/shared-data')),
		__ENGINE_DIR__: JSON.stringify(path.resolve(__dirname, '../ortho-globe/dist/engine')) },   // 共有エンジンの出力（src/engine.js）
	resolve: {
		// 旧パスエイリアス（src直指し）。geopbf だけは撤去（2026-08-21）＝exports のサブパス
		// （geopbf/encodeZIP 等）を迂回して解決不能になるため、workspace 解決に委ねる。
		alias: {
			'common': path.resolve(__dirname, '../../packages/common/src'),
			'native-bucket': path.resolve(__dirname, '../../packages/native-bucket/src'),
		}
	},
	optimizeDeps: {
		exclude: ['common', 'geopbf', 'altpbf', 'native-bucket']
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
		target: 'esnext'
	}
});
