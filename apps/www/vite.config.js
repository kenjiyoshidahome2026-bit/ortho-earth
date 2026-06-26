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
    build: { target: 'esnext', sourcemap: true }
});
