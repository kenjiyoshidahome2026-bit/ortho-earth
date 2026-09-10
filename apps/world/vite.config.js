// apps/world/vite.config.js ＝ 国別DB ビューア（旧 draw.js の移植先）。uploader と同じ配線（/api → api.ortho-earth.com）
import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
	base: '/world/',   // 公開パス＝ortho-earth.com/world/（gishub と同じ配置）
	resolve: {
		alias: {
			'common': path.resolve(__dirname, '../../packages/common/src'),
			'native-bucket': path.resolve(__dirname, '../../packages/native-bucket/src'),
		}
	},
	optimizeDeps: { exclude: ['common', 'geopbf', 'native-bucket'] },
	server: {
		fs: { allow: ['../..'] },
		proxy: { '/api': { target: 'https://api.ortho-earth.com', changeOrigin: true, rewrite: p => p.replace(/^\/api/, '') } }
	},
	build: { sourcemap: true, target: 'esnext', outDir: 'dist/site/world', emptyOutDir: true }   // 配信＝[assets] dist/site（route /world* が URL パスのまま引く）
});
