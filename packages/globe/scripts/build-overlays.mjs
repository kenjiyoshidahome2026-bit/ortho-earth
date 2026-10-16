#!/usr/bin/env node
// URL で読まれる同一フレームのオーバーレイ（map.overlay(url)）の正本 src/**/*.ts から、配る .js を作る（TS 化・2026-10-16）。
// vite は `import u from "./x.js?url"` のファイルを変換せずにそのまま置く（.ts を ?url にすると型の付いた生の TS が配られる）＝
// 配る物は型を剥いだ .js のまま置き、正本だけを .ts にする。中身は型を剥ぐだけ（挙動は変えない）。
// .ts を変えたら npm run build:overlays -w @ortho-earth/globe。--check＝焼き直しが要るなら落ちる（tests/overlays-gen.mjs が npm test で回す）。
import fs from "node:fs";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// URL で読まれるオーバーレイ（tests/url-modules.mjs が「依存ゼロ」を見る物と同じ顔ぶれ）
export const OVERLAYS = [
	"src/cluster-2d.ts", "src/heatmap-gl.ts", "src/pattern-2d.ts", "src/symbols-2d.ts", "src/columnar/draw-gl.ts",
	"src/gadgets/arcs-gl.ts", "src/gadgets/copc-gl.ts", "src/gadgets/customgl-draw.ts", "src/gadgets/points-gl.ts",
	"src/gadgets/screengrid-draw.ts", "src/gadgets/trips-gl.ts",
];
// 型を剥ぐ＝node の stripTypeScriptTypes（strip：型の所を同じ長さの空白にする＝位置が変わらない・ASI が要る所には ; を足す）。
// 空白にされた所（元は空白でない字）は詰める＝行の形・字下げ・注釈は正本のまま。型だけだった行（import type・interface）は行ごと落とす。
const strip = src => {
	const warn = process.emitWarning; process.emitWarning = () => {};   // ExperimentalWarning を黙らせる（node 22）
	let out; try { out = stripTypeScriptTypes(src, { mode: "strip" }); } finally { process.emitWarning = warn; }
	if (out.length !== src.length) throw new Error("build-overlays: strip の出力の長さが変わった（node の版？）");
	const n = src.length, gone = k => out[k] !== src[k] && /\s/.test(out[k]);   // 剥がれた字（元は字・今は空白）
	let r = "";
	for (let i = 0; i < n;) {
		if (!gone(i)) { r += out[i++]; continue; }
		// 剥がれた区間＝空白だけを挟んで続く剥がれた字の並び。中の改行は残す（行の対応を保つ）・他は落とす
		let j = i;
		for (;;) { while (j < n && gone(j)) j++; let k = j; while (k < n && /\s/.test(src[k]) && out[k] === src[k]) k++; if (k < n && gone(k)) j = k; else break; }
		r += src.slice(i, j).replace(/[^\n]/g, "");
		if (/[ \t]$/.test(r) && /^[)\],;:}>.]/.test(src.slice(j, j + 1))) r = r.replace(/[ \t]+$/, "");   // 「x as T)」→「x)」
		i = j;
	}
	// 型だけだった行（元は字があり、今は空白だけ）を落とす
	const before = src.split("\n"), after = r.split("\n");
	if (before.length !== after.length) throw new Error("build-overlays: 行の数が変わった");
	const drop = after.map((l, k) => l.trim() === "" && before[k].trim() !== "");
	// 落とした型の行の直前の JSDoc（/** … */）も落とす＝型の説明が宙に浮かない
	for (let k = 0; k < drop.length; k++) {
		if (!drop[k] || (k > 0 && drop[k - 1])) continue;
		let j = k - 1;
		if (j >= 0 && /^\s*\/\*\*.*\*\/\s*$/.test(after[j])) { drop[j] = true; continue; }
		if (j >= 0 && /\*\/\s*$/.test(after[j]) && !/\/\*/.test(after[j].replace(/^\s*\/\*\*/, ""))) {
			let i = j; while (i >= 0 && !/^\s*\/\*\*/.test(after[i])) i--;
			if (i >= 0) for (let t = i; t <= j; t++) drop[t] = true;
		}
	}
	return after.filter((_, k) => !drop[k]).join("\n");
};
const build = rel => `// 生成物＝npm run build:overlays（正本は ${path.basename(rel)}）。手で編集しない。\n` + strip(fs.readFileSync(path.join(PKG, rel), "utf8"));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const check = process.argv.includes("--check");
	let bad = 0;
	for (const rel of OVERLAYS) {
		const out = path.join(PKG, rel.replace(/\.ts$/, ".js")), js = build(rel);
		if (check) { if (!fs.existsSync(out) || fs.readFileSync(out, "utf8") !== js) { bad++; console.error(`✗ ${path.relative(PKG, out)} が ${path.basename(rel)} と合っていない`); } }
		else fs.writeFileSync(out, js);
	}
	if (check) {
		if (bad) { console.error("  → npm run build:overlays -w @ortho-earth/globe"); process.exit(1); }
		console.log(`✓ overlays-gen PASS（${OVERLAYS.length} 本の .js が .ts と一致）`);
	} else console.log(`build-overlays: ${OVERLAYS.length} 本`);
}
