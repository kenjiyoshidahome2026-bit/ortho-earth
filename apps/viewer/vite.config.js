import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
    optimizeDeps: {
        // 自作パッケージを事前バンドルの対象から外す
        exclude: ['ortho-map', 'common', 'geopbf', 'altpbf', 'native-bucket']
    },
    server: {
        fs: {
            // ワークスペース全体（packagesフォルダ）のファイル参照を許可
            allow: ['..']
        }
    },
    build: {
        sourcemap: true // ソースマップを明示的に有効化
    }
});