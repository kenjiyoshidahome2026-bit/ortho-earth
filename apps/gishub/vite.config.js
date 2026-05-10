import { defineConfig } from 'vite';

export default defineConfig({
    worker: { format: 'es' },
    build: { target: 'esnext',
        sourcemap: true,
    }
});