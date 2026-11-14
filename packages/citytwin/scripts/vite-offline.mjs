// 市のデジタルツインの vite の部品（横浜・京都が共有）。
// offlineManifest＝通信なしで使う束の目録（offline.json・2026-11-12）＝このビルドのファイル・エンジンの版とファイル・台帳のファイル。
// src/offline.ts がこれを見て端末に詰める。build＝ファイル名（content-hash 入り）とエンジンの版の要約＝デプロイで中身が変われば変わる
import { resolve } from "node:path";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ENGINE_DIR } from "../../globe/scripts/lib/shared-engine.mjs";

/** id＝市の頁の名（"yokohama"）・out＝ビルドの出口（dist/site/<id>）・data＝台帳の正本（ortho-data/japan/<id>） */
export function offlineManifest({ id, out, data }) {
	const walk = (dir, pre = "") => readdirSync(dir).flatMap(n => statSync(resolve(dir, n)).isDirectory() ? walk(resolve(dir, n), pre + n + "/") : [pre + n]);
	return {
		name: `${id}-offline-manifest`, apply: "build",
		closeBundle() {
			const files = walk(out).filter(f => !/(\.map|\.DS_Store)$/.test(f) && !["offline.json", "sw.js", "index.html"].includes(f)).sort();
			const engine = JSON.parse(readFileSync(resolve(ENGINE_DIR, "current.json"), "utf8"));
			const ledgers = walk(data).filter(f => !/\.DS_Store$/.test(f)).sort();
			const build = createHash("sha256").update(files.join("\n")).update(engine.version).digest("hex").slice(0, 12);
			writeFileSync(resolve(out, "offline.json"), JSON.stringify({ build, base: `/${id}/`, files, engine: { version: engine.version, files: engine.files }, data: ledgers }));
		},
	};
}
