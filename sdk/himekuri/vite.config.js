import { defineConfig } from 'vite';

export default defineConfig({
	root: './',
	build: {
	target: 'esnext',
	outDir: 'dist',
	},
	server: {
	open: true
	}
});
