import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    target: 'esnext',
    minify: false,
    sourcemap: true,
    outDir: 'dist/client',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      name: 'nativeBucket',
      formats: ['es']
    }
  }
})
