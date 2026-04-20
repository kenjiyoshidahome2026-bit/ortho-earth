import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
    resolve: {
        alias: {
            'common': resolve(__dirname, '../common/src'),
            'native-bucket': resolve(__dirname, '../native-bucket/src'),
            'geopbf': resolve(__dirname, '../geopbf/src'),
            'altpbf': resolve(__dirname, '../altpbf/src'),
        }
    },
    worker: { format: 'es' },
    build: {
        minify: false,
        sourcemap: true,
        lib: {
            entry: './src/index.js',
            formats: ['es']
        }
    }
});