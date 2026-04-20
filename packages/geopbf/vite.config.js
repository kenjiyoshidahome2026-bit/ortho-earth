import { defineConfig } from 'vite'
import { resolve } from 'path'

const banner = `/*!
* geopbf.js v1.0.0
* (c) 2026 Kenji Yoshida
* Released under the MIT License.
*/`;

export default defineConfig({
    resolve: {
        alias: {
            // path.resolve ではなく、import した resolve を使います
            'ortho-map': resolve(__dirname, '../../packages/ortho-map/src/index.js'),
            'common': resolve(__dirname, '../../packages/common/src/index.js'),
            'geopbf': resolve(__dirname, './src/geopbf.js'),
            'altpbf': resolve(__dirname, '../../packages/altpbf/src/altpbf.js'),
            'native-bucket': resolve(__dirname, '../native-bucket/src/index.js'),
        }
    },
    server: {
        fs: {
            allow: ['../..']
        },
        proxy: {
            '/api': {
                target: 'https://api.ortho-earth.com',
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/api/, ''),
            }
        }
    },
    worker: {
        format: 'es',
    },
    optimizeDeps: {
        // ここで除外しているのは正解です
        exclude: ['ortho-map', 'common', 'geopbf', 'altpbf', 'native-bucket']
    },
    build: {
        target: 'esnext',
        sourcemap: true,
        minify: false, // 🛑 デバッガを効かせるため、一旦 false に！
        lib: {
            entry: resolve(__dirname, 'src/geopbf.js'),
            name: 'geopbf',
            fileName: 'geopbf',
            formats: ['es'] // 'esm' ではなく 'es' が Vite の標準です
        },
        rollupOptions: {
            external: ['encoding-japanese']
        }
    }
})