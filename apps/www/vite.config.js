import { defineConfig } from 'vite';

// 背景の地球は globe-lite.js（webp 1 枚＋WebGL）＝エンジンは載せない。prefetch.js が geopbf/altpbf で /japan/ の世界データを IDB へ先読みする。
export default defineConfig({
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
	build: { target: 'esnext', sourcemap: 'hidden' }
});
