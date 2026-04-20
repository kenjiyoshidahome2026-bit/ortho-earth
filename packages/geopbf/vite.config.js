import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
    resolve: {
        alias: {
            // 末尾の index.js を消して 'src' フォルダを指すようにします
            'common': resolve(__dirname, '../../packages/common/src'),
            'native-bucket': resolve(__dirname, '../native-bucket/src'),
            'ortho-map': resolve(__dirname, '../../packages/ortho-map/src'),
            'altpbf': resolve(__dirname, '../../packages/altpbf/src'),
        }
    },
    server: {
        fs: { allow: ['../..'] },
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