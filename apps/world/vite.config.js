// apps/world/vite.config.js ＝ 国別DB ビューア（旧 draw.js の移植先）。uploader と同じ配線（/api → api.ortho-earth.com）
import { defineConfig } from 'vite';
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
export default defineConfig({
	plugins: [coepHeaders()],
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
