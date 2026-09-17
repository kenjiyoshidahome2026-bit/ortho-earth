import { defineConfig } from "vite";

// base './'＝どのパスにマウントしても動く相対参照（solar と同じ型）。
export default defineConfig({
	base: "./",
	build: { outDir: "dist/site/equal", emptyOutDir: true, target: "es2022" },   // target＝トップレベル await を許す（起動時に UI の訳を揃える）
	worker: { format: "es" },   // geopbf は module worker 連鎖＝既定 iife だとビルドが落ちる（ortho-japan と同じ轍）
	server: { port: 5198 },
});
