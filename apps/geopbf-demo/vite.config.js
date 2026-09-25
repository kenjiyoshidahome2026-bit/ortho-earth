import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { resolve } from 'node:path';

// 地球儀＝@ortho-earth/globe（地域なしのホスト）＝dev も本番もソース直 import＝同梱（A 裁定 2026-09-23・external 無し）。
// 実行時アセット（koppen-clim.png 等）は globe の家（apps/ortho-globe/public）：本番＝/globe/（ortho-globe の Worker が配る）・dev＝/@fs で直読み。
const ROOT = resolve(import.meta.dirname, '../..');
const GLOBE_PUBLIC = resolve(import.meta.dirname, '../ortho-globe/public');
// rolldown（vite 8）のチャンク最適化を切る（2026-09-25・world／ortho-nl と同じ＝globe を束ねる vite 8 アプリの決まり）。
// 既定 on だと実行時ヘルパ __exportAll の共通チャンクが動的エントリ mesh-loaders に合流し、worker がヘルパ欲しさに
// mesh-loaders＋basis-loader（計 220KB）を静的 import する。worker は別ビルド＝build と worker の両方に要る。
// experimental の口＝rolldown を上げたら「mesh-loaders を静的 import するチャンクが無い」ことを確かめ直す。
const noChunkOptimization = { experimental: { chunkOptimization: false } };

export default defineConfig(({ command }) => ({
	base: '/geopbf/',
	plugins: [
		wasm(),
	],
	define: { __GLOBE_ASSETS__: JSON.stringify(command === 'serve' ? `/geopbf/@fs${GLOBE_PUBLIC}/` : '/globe/') },
	server: {
		fs: { allow: [ROOT] },
		// COEP は japan/census2020 と同じ credentialless（crossOriginIsolated＝SharedArrayBuffer の点火条件。無くてもコピー経路で動く）
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'credentialless'
		}
	},
	worker: { format: 'es', rolldownOptions: noChunkOptimization },
	// sourcemap: 'hidden' = .mapは出すがJS末尾に参照を書かない＝デプロイしても実質非公開（gishub-jpと同じ方針）
	// cssTarget＝vite 8 の既定（baseline-widely-available）の実体。無いと cssTarget も esnext になり、lightningcss が
	// -webkit-backdrop-filter を「不要な接頭辞」として消す＝iOS 17 以前の Safari でガラスのぼかしが消える（2026-09-25 実測・www と同じ）
	build: { target: 'esnext', cssTarget: ['chrome111', 'edge111', 'firefox114', 'safari16.4', 'ios16.4'], sourcemap: 'hidden', rolldownOptions: noChunkOptimization },
	css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } }
}));
