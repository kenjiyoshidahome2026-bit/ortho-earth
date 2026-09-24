// apps/world/vite.config.js ＝ 国別DB ビューア（旧 draw.js の移植先）。uploader と同じ配線（/api → api.ortho-earth.com）
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import fs from 'fs';
// www のデモ一覧は各デモをナビの下の iframe で開く（2026-09-22）＝www は COEP credentialless の頁＝中に入る頁も COEP が要る
// （無いと iframe の中で拒まれる）。Workers の静的アセットは配信ディレクトリ直下の _headers を読む＝ビルドの最後に dist/site/_headers を書く。
// credentialless＝越境の no-cors 取得は資格情報なしで通る（japan・equal と同じ・SAB は使わない）。
const coepHeaders = () => ({
	name: "coep-headers",
	closeBundle() { fs.writeFileSync(path.resolve(__dirname, "dist/site/_headers"), "/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: credentialless\n"); },
});
// 地図パネル（src/mappane.js）＝地球儀のホスト（@ortho-earth/globe）を遅延 import する。dev も本番もソース直
// （A 裁定 2026-09-23＝自分の束に焼く。wasm プラグインと __GLOBE_ASSETS__ が要る＝geopbf-demo と同じ配線）。
const GLOBE_PUBLIC = path.resolve(__dirname, '../ortho-globe/public');   // 地球儀の実行時アセット（koppen-clim.png 等）＝globe の家（本番 /globe/）

export default defineConfig(({ command }) => ({
	plugins: [wasm(), coepHeaders()],
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
		// エンジンは worker と越境取得を使う＝japan/census2020 と同じ credentialless（dev でも本番の頁と同じ条件で見る）
		headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' },
		proxy: { '/api': { target: 'https://api.ortho-earth.com', changeOrigin: true, rewrite: p => p.replace(/^\/api/, '') } }
	},
	worker: { format: 'es' },
	build: { sourcemap: true, target: 'esnext', outDir: 'dist/site/world', emptyOutDir: true }   // 配信＝[assets] dist/site（route /world* が URL パスのまま引く）。エンジンは同梱（external 無し）
}));
