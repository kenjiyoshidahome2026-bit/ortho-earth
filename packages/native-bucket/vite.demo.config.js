import { defineConfig } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

// デモページ（demo/index.html → dist/demo/）＝GitHub Pages のデモ。`vite`（dev）もこの設定で demo/ を配る。
const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	base: './',
	build: {
		sourcemap: true,
		rollupOptions: { input: { demo: resolve(__dirname, 'demo/index.html') } },
		outDir: 'dist',
		emptyOutDir: true,
	},
})
