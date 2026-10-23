// apps/sokutei/vite.config.js ＝ 体長・体重の測定 PWA。地図エンジンに依らない素の vite（公開パス /sokutei/・Workers の route）。
// pwa プラグイン：ビルドの最後に dist/site/sokutei/ の全ファイルを一覧にして sw.js（サービスワーカー）を書く＝全部を前もって溜め、以後は網が無くても開く。
// 版＝一覧の内容のハッシュ（中身が変わると版が変わり、古い溜め置きは activate で捨てる）。dev では sw を登録しない（app.js 側で import.meta.env.PROD を見る）。
import { defineConfig } from "vite";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const __dirname = import.meta.dirname;
const BASE = "/sokutei/";
const OUT = path.resolve(__dirname, "dist/site/sokutei");

const walk = (dir, rel = "") => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
	e.isDirectory() ? walk(path.join(dir, e.name), rel + e.name + "/") : [rel + e.name]);

const pwa = () => ({
	name: "sokutei-pwa",
	closeBundle() {
		const files = walk(OUT).filter(f => f !== "sw.js" && !f.endsWith(".map"));
		const urls = files.map(f => BASE + (f === "index.html" ? "" : f));
		const ver = createHash("sha1").update(files.map(f => f + ":" + fs.statSync(path.join(OUT, f)).size).join("\n")).digest("hex").slice(0, 10);
		const sw = fs.readFileSync(path.resolve(__dirname, "src/sw.js"), "utf8")
			.replace("__VER__", JSON.stringify(ver)).replace("__ASSETS__", JSON.stringify(urls)).replace("__BASE__", JSON.stringify(BASE));
		fs.writeFileSync(path.join(OUT, "sw.js"), sw);
	},
});

export default defineConfig({
	base: BASE,
	plugins: [pwa()],
	server: { port: 5197 },
	build: { target: "esnext", outDir: OUT, emptyOutDir: true },
});
