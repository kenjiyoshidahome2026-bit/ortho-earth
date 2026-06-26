import { defineConfig } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
	plugins: [
		visualizer({
			open: true,
			filename: 'stats.html',
			gzipSize: true,
			brotliSize: true,
		})
	],
	optimizeDeps: {
		exclude: ['ortho-map', 'common', 'geopbf', 'altpbf', 'native-bucket', 'calender'],
		include: ['polygon-clipping']
	},
	server: {
		fs: { allow: ['../..'] },
		headers: {
			'Cross-Origin-Opener-Policy': 'same-origin',
			'Cross-Origin-Embedder-Policy': 'require-corp',
		}
	},
	worker: { format: 'es' },
	build: {
		target: 'esnext',
		sourcemap: true,
		chunkSizeWarningLimit: 1000,
		rollupOptions: {
			output: {
				manualChunks: {
					'vendor-dom': ['linkedom', 'entities', 'cssom', 'htmlparser2'],
					'vendor-d3': ['d3-geo', 'd3-zoom', 'd3-selection', 'd3-dispatch',
						'd3-array', 'd3-scale', 'd3-interpolate', 'd3-transition', 'd3-ease']
				}
			}
		}
	}
});
