// apps/world/vite.config.js ＝ 国別DB ビューア（旧 draw.js の移植先）。uploader と同じ配線（/api → api.ortho-earth.com）
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { sharedEngine } from '../../packages/globe/scripts/lib/shared-engine.mjs';   // build の時だけ地球儀は共有エンジン（/globe/engine/<版>/）を URL で読む（縮小計画 項目 9・2026-09-30）
import { crossOriginIsolation, coepHeadersFile, noChunkOptimization, CSS_TARGET } from '../../packages/globe/scripts/lib/vite-app.mjs';   // アプリ共通の決まり（2026-10-03）
// 本番の COOP/COEP＝coepHeadersFile が dist/site/_headers を書く（www のデモ一覧の iframe に載る頁＝www と同じ COEP credentialless が要る・2026-09-22・理由は vite-app.mjs）。
// 地図パネル（src/mappane.js）＝地球儀のホスト（@ortho-earth/globe）を遅延 import する。dev はソース直・build は共有エンジン
// （sharedEngine＝/globe/engine/<版>/・2026-09-30 に A 裁定 2026-09-23「自分の束に焼く」を改めた。__GLOBE_ASSETS__ は従来どおり）。
const GLOBE_PUBLIC = path.resolve(__dirname, '../ortho-globe/public');   // 地球儀の実行時アセット（koppen-clim.png 等）＝globe の家（本番 /globe/）
// noChunkOptimization＝rolldown（vite 8）の決まり（2026-09-25・理由は vite-app.mjs）。worker は別ビルド＝build と worker の両方に要る。

export default defineConfig(({ command }) => ({
	plugins: [crossOriginIsolation(), wasm(), coepHeadersFile(path.resolve(__dirname, 'dist/site')), sharedEngine()],   // dev/preview＝middleware（エンジンは worker と越境取得を使う＝japan/census2020 と同じ credentialless・旧 server.headers＝dev だけ）
	define: { __GLOBE_ASSETS__: JSON.stringify(command === 'serve' ? `/world/@fs${GLOBE_PUBLIC}/` : '/globe/') },
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
	worker: { format: 'es', rolldownOptions: noChunkOptimization },
	// CSS_TARGET＝vite 8 の既定の実体（target esnext で -webkit-backdrop-filter が消えるのを防ぐ・2026-09-25 実測・理由は vite-app.mjs）
	build: { sourcemap: true, target: 'esnext', cssTarget: CSS_TARGET, outDir: 'dist/site/world', emptyOutDir: true, rolldownOptions: noChunkOptimization }   // 配信＝[assets] dist/site（route /world* が URL パスのまま引く）。エンジンは同梱（external 無し）
}));
