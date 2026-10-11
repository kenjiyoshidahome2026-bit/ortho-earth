import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { renderDemos } from './cards.js';
import { crossOriginIsolation, CSS_TARGET } from '../../packages/globe/scripts/lib/vite-app.mjs';   // アプリ共通の決まり（2026-10-03）

// デモカード＝demos.json から静的 HTML に焼く（<!--DEMOS-->）。dev でも毎回読む＝demos.json を足せば即反映
const readDemos = () => JSON.parse(readFileSync(new URL('./demos.json', import.meta.url), 'utf8'));
const demosHtml = () => ({
	name: 'www-demos',
	transformIndexHtml(html) {
		const langs = JSON.parse(readFileSync(new URL('../../packages/world/i18n/langs.json', import.meta.url), 'utf8'));
		return html.replace('<!--DEMOS-->', renderDemos(readDemos()))
			.replace('__LANG_CODES__', langs.map(l => l.code).join(' ')).replace('__RTL_CODES__', langs.filter(l => l.rtl).map(l => l.code).join(' '));
	},
	// llms.txt の Apps 節も demos.json から（サンプルが増えても目次が古びない）
	generateBundle() {
		const apps = readDemos().demos.map(d => `- [${d.title}](https://www.ortho-earth.com${d.href}): ${d.desc}`).join('\n');
		this.emitFile({ type: 'asset', fileName: 'llms.txt', source: readFileSync(new URL('./llms.template.txt', import.meta.url), 'utf8').replace('<!--APPS-->', apps) });
	},
});

// 背景の地球は globe-lite.js（webp 1 枚＋WebGL）＝エンジンは載せない。prefetch.js が geopbf/altpbf で /japan/ の世界データを IDB へ先読みする。
export default defineConfig({
	plugins: [crossOriginIsolation(), demosHtml()],   // COOP/COEP credentialless＝dev と preview の全リクエスト（旧 server.headers＝dev だけ）。本番は deploy-worker.js が刻む
	optimizeDeps: {
		exclude: ['common', 'geopbf', 'altpbf', 'native-bucket', 'himekuri', 'pbf', '@ortho-earth/core'],
	},
	server: {
		fs: { allow: ['../..'] },
		// 開発だけ：デモ一覧の iframe（同じオリジンのパス）を開けるよう、デモのパスを中継する＝既定は本番・JAPAN_DEV で /japan/ だけ手元へ
		// （例：JAPAN_DEV=http://localhost:5322 npx vite ＝ apps/ortho-japan の開発サーバー）。本番は同じドメインの別 Worker が返す
		// 鍵は正規表現＝パスの区切りで止める（素の '/globe' は前方一致で /globe-lite.js まで本番へ送り、手元のトップが素の HTML で壊れた・2026-09-25）
		proxy: Object.fromEntries(['/japan', '/globe', '/equal', '/world', '/solar', '/geopbf', '/gishub-jp', '/nl', '/maps', '/docs'].map(p => [`^${p}(/|\\?|$)`, {
			target: (p === '/japan' && process.env.JAPAN_DEV) || 'https://www.ortho-earth.com', changeOrigin: true, secure: true,
		}])),
	},
	worker: { format: 'es' },
	// sourcemap: 'hidden' = .mapは出すがJS末尾に参照を書かない＝実質非公開（gishub-jpと同じ方針）
	// CSS_TARGET＝vite 8 の既定の実体（target esnext で -webkit-backdrop-filter が消えるのを防ぐ・2026-09-25 実測・理由は vite-app.mjs）
	build: { target: 'esnext', cssTarget: CSS_TARGET, sourcemap: 'hidden' }
});
