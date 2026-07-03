import { defineConfig } from 'vite';

export default defineConfig({
	server: {
		port: 5174,
	},
	build: { target: 'esnext' },
	optimizeDeps: {
		exclude: ['@loaders.gl/draco'],
	},
});
