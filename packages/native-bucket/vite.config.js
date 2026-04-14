import { defineConfig } from 'vite'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

// ESM環境（package.jsonのtype:module）でパスを正しく扱うための設定
const __dirname = dirname(fileURLToPath(import.meta.url))

const banner = `/*!
 * nativeBucket.js v1.0.0
 * (c) 2026 Kenji Yoshida
 * Released under the MIT License.
 */`;

export default defineConfig({
  // エラーの原因となっていた plugins: [cloudflare()] を削除しました
  base: './',
  build: {
    sourcemap: true,
    minify: 'terser',
    rollupOptions: {
      input: {
        // demo フォルダ内の index.html をメインの入力にする設定
        main: resolve(__dirname, 'demo/index.html'),
      },
    },
    terserOptions: {
      format: {
        comments: /^\!/, // 「!」で始まるコメント（ライセンス等）を残す設定
        preamble: banner  // ファイルの最先端に必ずこれを置く設定
      }
    },
    lib: {
      // ライブラリの入り口となるファイルを指定
      entry: resolve(__dirname, 'src/index.js'), 
      name: 'nativeBucket',
      fileName: 'native-bucket',
      formats: ['iife']
    },
    outDir: 'dist',
  }
})