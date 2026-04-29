import { defineConfig } from 'vite';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
	plugins: [
        visualizer({
            open: true,           // ビルド完了時に自動でブラウザを開く
            filename: 'stats.html', // 生成されるファイル名
            gzipSize: true,        // gzip後のサイズも表示
            brotliSize: true,      // brotli後のサイズも表示
        })
    ],    // WorkerのフォーマットをESモジュールに指定
    worker: { format: 'es' },
    build: {
        target: 'esnext',
        sourcemap: true,
		chunkSizeWarningLimit: 1000,
    }
});