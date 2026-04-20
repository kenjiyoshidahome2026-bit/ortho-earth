import { defineConfig } from 'vite';

export default defineConfig({
    // Workerの設定を明示
    worker: {
        format: 'es',
    },
    // ライブラリとしてビルドする場合の設定（任意）
    build: {
        lib: {
            entry: './src/index.js',
            formats: ['es']
        },
        sourcemap: true // デバッグを有効にするために必須
    }
});