import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM環境で__dirnameを定義
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            // ここが命です：パッケージ名を実際のソースパスに紐付けます
            'ortho-map': path.resolve(__dirname, '../../packages/ortho-map/src/index.js'),
            'common': path.resolve(__dirname, '../../packages/common/src/index.js'),
            'geopbf': path.resolve(__dirname, '../../packages/geopbf/src/geopbf.js'),
            'altpbf': path.resolve(__dirname, '../../packages/altpbf/src/altpbf.js'),
            'native-bucket': path.resolve(__dirname, '../../packages/native-bucket/src/index.js'),
        }
    },
    optimizeDeps: {
        // エイリアスを貼ったので、事前バンドルのキャッシュ対象から完全に外します
        exclude: ['ortho-map', 'common', 'geopbf', 'altpbf', 'native-bucket']
    },
    server: {
        fs: {
            allow: ['../..'] // ワークスペース全体へのアクセスを許可
        }
    },
    worker: {
        format: 'es' // WorkerをESモジュールとして扱う
    },
    build: {
        sourcemap: true
    }
});