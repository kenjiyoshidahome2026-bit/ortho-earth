export default {
  build: {
    rollupOptions: { external: ['canvas'], },
  },
  optimizeDeps: { exclude: ['canvas'] }
}