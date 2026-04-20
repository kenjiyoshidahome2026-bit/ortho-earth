import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
    resolve: {
        alias: {
            // パス解決を整理
            'common': resolve(__dirname, '../../packages/common/src/index.js'),
            'native-bucket': resolve(__dirname, '../native-bucket/src/index.js'),
        }
    },
    worker: { format: 'es' },
    optimizeDeps: {
        exclude: ['common', 'native-bucket']
    },
    build: {
        sourcemap: true,
        minify: false, // デバッガを殺さない
        lib: {
            entry: resolve(__dirname, 'src/geopbf.js'),
            formats: ['es']
        }
    }
})