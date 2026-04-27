import { defineConfig } from 'vite';

export default defineConfig({
    // WorkerのフォーマットをESモジュールに指定
    worker: {
        format: 'es'
    },
    build: {
        // ESモジュールのWorkerをフルサポートさせるため、ターゲットをモダンブラウザに設定
        target: 'esnext',
        sourcemap: true
    }
});