import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    minify: false, // デバッガを効かせるため
    sourcemap: true,
    rollupOptions: { external: ['canvas'], },
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      name: 'nativeBucket',
      formats: ['es'] // ESMのみに絞る
    }
  },
  optimizeDeps: { exclude: ['canvas'] }
})