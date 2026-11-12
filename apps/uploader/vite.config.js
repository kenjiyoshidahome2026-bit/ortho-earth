// apps/uploader/vite.config.js
import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';
import { crossOriginIsolation } from '../../packages/globe/scripts/lib/vite-app.mjs';   // アプリ共通の決まり（2026-10-03）

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 書き込み鍵（.env.local の VITE_API_KEY）は import.meta.env 経由で束に文字列のまま焼き込まれる＝build の出力を
// どこかへ置くと鍵が漏れる（2026-05/06 に履歴から漏れたのと同じ鍵・2026-10-24 再監査）。uploader は手元の dev で使う道具なので、
// build では鍵を空にする。鍵入りの build が本当に要る時だけ UPLOADER_BUILD_WITH_KEY=1 を付ける（出力は公開しないこと）。
const stripKey = {
	name: 'uploader-strip-api-key', apply: 'build', enforce: 'pre',
	config: () => process.env.UPLOADER_BUILD_WITH_KEY === '1' ? {} : { define: { 'import.meta.env.VITE_API_KEY': '""' } },
};
export default defineConfig({
	plugins: [stripKey, crossOriginIsolation({ coep: 'require-corp' })],   // uploader だけ従来どおり require-corp（dev と preview の全リクエスト・旧 server.headers＝dev だけ）
	// 共有データの正本（packages/jp/shared-data）の絶対パス＝src/shared-data.ts が dev の /@fs で読む
	// 焼きスクリプトの出力（repo 直下の bake-out/）＝src/bake-out.ts が dev の /@fs で読む
	define: { __SHARED_DATA_DIR__: JSON.stringify(path.resolve(__dirname, '../../packages/jp/shared-data')), __BAKE_OUT_DIR__: JSON.stringify(path.resolve(__dirname, '../../bake-out')) },
	// 旧パスエイリアス（common・native-bucket・geopbf を packages/*/src へ直指し）は撤去済み
	// （geopbf は 2026-08-21、common・native-bucket は段 5-2）＝各 package の exports を通る workspace 解決に委ねる。
	optimizeDeps: {
		exclude: ['common', 'geopbf', 'altpbf', 'native-bucket']
	},
	server: {
		fs: { allow: ['../..'] },
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
