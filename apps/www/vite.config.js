import { defineConfig } from 'vite';

export default defineConfig({
	optimizeDeps: {
		exclude: ['ortho-map', 'common', 'geopbf', 'altpbf', 'native-bucket', 'calender', 'pbf'],
	},
	server: {
		fs: { allow: ['../..'] },
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		}
	},
	worker: { format: 'es' },
	// sourcemap: 'hidden' = .mapは出すがJS末尾に参照を書かない＝実質非公開（gishub-jpと同じ方針）
	build: { target: 'esnext', sourcemap: 'hidden' }
});
