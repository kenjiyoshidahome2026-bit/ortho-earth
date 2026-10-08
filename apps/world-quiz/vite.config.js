// apps/world-quiz/vite.config.js ＝ 世界クイズ。配線は World（apps/world）と同じ：データは bucket（/api → api.ortho-earth.com）、
// 地球儀は dev がソース直・build は共有エンジン（/globe/engine/<版>/）＝shared-engine.mjs。公開パス /quiz/（Workers の route）。
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import path from 'path';
import fs from 'fs';
import { sharedEngine } from '../../packages/globe/scripts/lib/shared-engine.mjs';
const __dirname = import.meta.dirname;
// www のデモ一覧は各デモをナビの下の iframe で開く＝www は COEP credentialless の頁＝中に入る頁も COEP が要る（world と同じ）
const coepHeaders = () => ({
	name: "coep-headers",
	closeBundle() { fs.writeFileSync(path.resolve(__dirname, "dist/site/_headers"), "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: credentialless\n"); },
});
const GLOBE_PUBLIC = path.resolve(__dirname, '../ortho-globe/public');   // 地球儀の実行時アセット（koppen-clim.png 等）＝globe の家（本番 /globe/）
const noChunkOptimization = { experimental: { chunkOptimization: false } };   // world と同じ理由（mesh-loaders の合流を避ける）

export default defineConfig(({ command }) => ({
	plugins: [wasm(), coepHeaders(), sharedEngine()],
	define: { __GLOBE_ASSETS__: JSON.stringify(command === 'serve' ? `/quiz/@fs${GLOBE_PUBLIC}/` : '/globe/') },
	base: '/quiz/',
	resolve: {
		alias: {
			'common': path.resolve(__dirname, '../../packages/common/src'),
			'native-bucket': path.resolve(__dirname, '../../packages/native-bucket/src'),
		}
	},
	optimizeDeps: { exclude: ['common', 'geopbf', 'native-bucket'] },
	server: {
		port: 5198,
		fs: { allow: ['../..'] },
		headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' },
		proxy: { '/api': { target: 'https://api.ortho-earth.com', changeOrigin: true, rewrite: p => p.replace(/^\/api/, '') } }
	},
	worker: { format: 'es', rolldownOptions: noChunkOptimization },
	build: { sourcemap: true, target: 'esnext', cssTarget: ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4'], outDir: 'dist/site/quiz', emptyOutDir: true, rolldownOptions: noChunkOptimization }
}));
