// apps/viewer/vite.config.js
import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
    resolve: {
        // オブジェクトの配列にすることで、「単体で呼ばれた時」と「サブファイルが呼ばれた時」を完璧に振り分けます
        alias: {
            'common': path.resolve(__dirname, '../../packages/common/src'),
            'native-bucket': path.resolve(__dirname, '../../packages/native-bucket/src'),
            'altpbf': path.resolve(__dirname, '../../packages/altpbf/src'),
            'geopbf': path.resolve(__dirname, '../../packages/geopbf/src'),
            'ortho-map': path.resolve(__dirname, '../../packages/ortho-map/src')        
        }
    },
    optimizeDeps: {
        exclude: ['ortho-map', 'common', 'geopbf', 'altpbf', 'native-bucket']
    },
    server: {
        fs: { allow: ['../..'] }
    },
    worker: {
        format: 'es'
    },
    build: {
        sourcemap: true,
       target: 'esnext' // または 'es2022'
     }
});