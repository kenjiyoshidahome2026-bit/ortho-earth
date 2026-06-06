import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({

    server: {
        fs: { allow: ['../..'/*, '../wasm'*/] },
        proxy: {
            '/api': {
                target: 'https://api.ortho-earth.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api/, ''),
            }
        }
    },
    worker: { format: 'es' },
    optimizeDeps: {
        exclude: ['ortho-map', 'common', 'geopbf', 'altpbf', 'native-bucket']
    },
    build: {
        target: 'esnext',
        sourcemap: true,
        minify: false,
        lib: {
            entry: resolve(__dirname, 'src/geopbf.js'),
            name: 'geopbf',
            fileName: 'geopbf',
            formats: ['es']
        },
        rollupOptions: {
            external: ['encoding-japanese']
        }
    }
})