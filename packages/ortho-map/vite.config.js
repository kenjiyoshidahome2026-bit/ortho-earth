import { defineConfig } from 'vite';
export default defineConfig({
    worker: {
        format: 'iife',
    },
    build: {
        minify: true,
        sourcemap: true,
    }
});