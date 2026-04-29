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
    worker: { format: 'es' },
    build: {
        target: 'esnext',
        sourcemap: true,
        chunkSizeWarningLimit: 1000,
        // 🌟 manualChunks は rollupOptions -> output の中に書くのが正解です
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