import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// 背景の地球＝ortho-japan エンジン（gint v2）。dev＝../ortho-japan/app.js をソース直 import／本番＝/japan/lib/ の SDK（external）。
// 実行時アセットは ortho-japan の public が正本：本番＝/japan/（japan Worker が配る）・dev＝/@fs で直読み。
const JAPAN_PUBLIC = resolve(import.meta.dirname, '../ortho-japan/public');

export default defineConfig(({ command }) => ({
	define: { __JAPAN_ASSETS__: JSON.stringify(command === 'serve' ? `/@fs${JAPAN_PUBLIC}/` : '/japan/') },
	optimizeDeps: {
		exclude: ['common', 'geopbf', 'altpbf', 'native-bucket', 'himekuri', 'pbf'],
	},
	server: {
		fs: { allow: ['../..'] },
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'credentialless',
		}
	},
	worker: { format: 'es' },
	// sourcemap: 'hidden' = .mapは出すがJS末尾に参照を書かない＝実質非公開（gishub-jpと同じ方針）
	build: { target: 'esnext', sourcemap: 'hidden', rollupOptions: { external: ['/japan/lib/ortho-japan.js'] } }
}));
