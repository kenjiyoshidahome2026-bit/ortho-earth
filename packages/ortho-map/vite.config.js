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
    worker: {
        format: 'es',
        // Worker内で使われるライブラリをすべて一つのファイルにまとめる設定
        rollupOptions: {
            output: {
                inlineDynamicImports: true
            }
        }
    },
    build: {
        minify: false,
        sourcemap: true,
        lib: {
            entry: './src/index.js',
            fileName: 'index',
            formats: ['es']
        },
        rollupOptions: {
            // ライブラリモードで外部依存関係を正しく処理するため
            external: ['canvas', 'd3'], 
            output: {
                globals: {
                    canvas: 'Canvas',
                    d3: 'd3'
                }
            }
        }
    },
	optimizeDeps: {
		exclude: ['canvas']// 依存関係の事前ビルドからも除外
	}
});