import { defineConfig } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// ライブラリ（iife）ビルド：src/global.ts → dist/native-bucket.iife.js（README の CDN リンク先＝window.nativeBucket）。
// デモページは vite.demo.config.js（dist/demo/）＝`npm run build` は demo → lib の順に 2 回組む（この側は dist を空にしない）。
// ミラー repo（github/native-bucket）単独でも同じ手順で組める（deploy.yml が ./dist を GitHub Pages へ配る）。
const __dirname = dirname(fileURLToPath(import.meta.url))
const banner = `/*!
 * nativeBucket.js v1.0.0
 * (c) 2026 Kenji Yoshida
 * Released under the MIT License.
 */`

export default defineConfig({
	build: {
		sourcemap: true,
		minify: 'terser',
		terserOptions: { format: { comments: /^\!/, preamble: banner } },
		lib: {
			entry: resolve(__dirname, 'src/global.ts'),
			name: 'nativeBucket',
			fileName: () => 'native-bucket.iife.js',
			formats: ['iife'],
		},
		outDir: 'dist',
		emptyOutDir: false,
	},
})
