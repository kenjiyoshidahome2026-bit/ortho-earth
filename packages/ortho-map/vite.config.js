// packages/ortho-map/vite.config.js
import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    resolve: {
        alias: {
            // これがないと Worker は他のパッケージを見つけられません
            'common': resolve(__dirname, '../common/src/index.js'),
            'native-bucket': resolve(__dirname, '../native-bucket/src/index.js'),
            'geopbf': resolve(__dirname, '../geopbf/src/geopbf.js'),
        }
    },
    worker: {
        format: 'es', // WorkerをESMとして扱う
    },
    build: {
        minify: false, // エラー内容を見えるようにする
        sourcemap: true,
        lib: {
            entry: './src/index.js',
            formats: ['es']
        }
    }
});