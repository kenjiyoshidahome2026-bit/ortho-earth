import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  base: './',
  build: {
    // 1. デバッグのために圧縮を完全に止める
    minify: false,
    sourcemap: true,
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      name: 'nativeBucket',
      // 2. フォーマットは 'es' (ESM) だけにする
      formats: ['es']
    },
    rollupOptions: {
      // 3. Worker から直接 import できるように外部依存を排除
      output: {
        preserveModules: true
      }
    }
  }
})