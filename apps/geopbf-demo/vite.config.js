import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import { resolve } from 'node:path';
import { sharedEngine } from '../../packages/globe/scripts/lib/shared-engine.mjs';   // build の時だけ地球儀・geopbf・core・i18n は共有エンジン（/globe/engine/<版>/）を URL で読む（縮小計画 項目 9・2026-09-30）
import { crossOriginIsolation, noChunkOptimization, CSS_TARGET } from '../../packages/globe/scripts/lib/vite-app.mjs';   // アプリ共通の決まり（2026-10-03）

// 地球儀＝@ortho-earth/globe（地域なしのホスト）＝dev はソース直・build は共有エンジン（/globe/engine/<版>/・2026-09-30 に A 裁定を改めた）。
// 実行時アセット（koppen-clim.png 等）は globe の家（apps/ortho-globe/public）：本番＝/globe/（ortho-globe の Worker が配る）・dev＝/@fs で直読み。
const ROOT = resolve(import.meta.dirname, '../..');
const GLOBE_PUBLIC = resolve(import.meta.dirname, '../ortho-globe/public');
// noChunkOptimization＝rolldown（vite 8）の決まり（2026-09-25・理由は vite-app.mjs）。worker は別ビルド＝build と worker の両方に要る。

export default defineConfig(({ command }) => ({
	base: '/geopbf/',
	plugins: [
		crossOriginIsolation(),   // COEP は japan/census2020 と同じ credentialless（crossOriginIsolated＝SharedArrayBuffer の点火条件。無くてもコピー経路で動く）＝dev と preview の全リクエスト（旧 server.headers＝dev だけ）
		wasm(),
		sharedEngine(),
	],
	define: { __GLOBE_ASSETS__: JSON.stringify(command === 'serve' ? `/geopbf/@fs${GLOBE_PUBLIC}/` : '/globe/') },
	server: {
		fs: { allow: [ROOT] },
	},
	worker: { format: 'es', rolldownOptions: noChunkOptimization },
	// sourcemap: 'hidden' = .mapは出すがJS末尾に参照を書かない＝デプロイしても実質非公開（gishub-jpと同じ方針）
	// CSS_TARGET＝vite 8 の既定の実体（target esnext で -webkit-backdrop-filter が消えるのを防ぐ・2026-09-25 実測・理由は vite-app.mjs）
	build: { target: 'esnext', cssTarget: CSS_TARGET, sourcemap: 'hidden', rolldownOptions: noChunkOptimization },
	css: { preprocessorOptions: { scss: { api: 'modern-compiler' } } }
}));
