import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    open: true,
    proxy: {
      '/api/catalog': {
        target: 'https://nlftp.mlit.go.jp',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/catalog/, '/ksj/gml')
      },
      '/api': {
        target: 'https://api.ortho-earth.com',
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, '')
      }
    }
  }
})
