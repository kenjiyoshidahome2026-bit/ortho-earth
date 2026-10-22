#!/usr/bin/env node
// MapLibre style-spec の性質の網羅表（互換の計画 P0-2・2026-10-22）＝spec の写し（core src/mlspec.ts）の全性質に「今どう扱うか」を付けて maplibre-coverage.md に書き出す。
// 状態の決め方：①下の NOTES（台帳 §3・§4 の「未」「近似」「一部」の写し・人が書く）が勝つ ②無ければ、性質の名前がエンジンの src（globe・core）の文字列に現れるか（"読む"／"無い"）。
//   ②は「名前を読む所がある」だけを言う＝絵が MapLibre と同じかは公式例の門と互換の爪車が見る。警告の一覧（*_UNSUPPORTED・not supported）と transition.ts（paint の名前の総覧）は数えない。
// 使い方：node scripts/ml-coverage.mjs（書き出す）／--check（表が古ければ落ちる＝globe の npm test）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ML_LAYER_PROPS, ML_SPEC_VERSION } from "../../ortho-core/src/mlspec.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url)), PKG = path.resolve(HERE, ".."), CORE = path.resolve(PKG, "../ortho-core");
const OUT = path.join(PKG, "maplibre-coverage.md");
const SKIP = new Set(["mlspec.ts", "transition.ts"]);

// 台帳の写し＝{ 性質: [状態, 中身] }。段で直したらここを直す（--check が表の古さを見張る）
const NOTES = {
	"line-cap": ["一部", "基図と vector の層は GL2・WebGPU とも MapLibre と同じ（S-P1-1・2026-10-22）・geojson の層は丸"],
	"line-join": ["一部", "基図と vector の層は GL2・WebGPU とも MapLibre と同じ（属性の式は層で一度）・geojson の層は丸"],
	"line-miter-limit": ["一部", "GL2 だけ（zoom の式も読む）"],
	"line-round-limit": ["近似", "読まない＝丸い継ぎのまま（浅い角の見分けは付かない）"],
	"line-dasharray": ["一部", "基図と vector の層は GL2・WebGPU とも MapLibre と同じ（S-P1-3・2026-10-22）・ずらす層・9 個以上はタイルの z の尺で刻む・geojson の層は先頭の対だけ"],
	"line-width": ["読む", "上限なし（基図と vector の層は f32・geojson の層は 2026-10-22 から u16＝8191px まで）・基図はタイルの z で焼く（ズームの段は §4）"],
	"line-gap-width": ["読む", "基図・vector・geojson（2026-10-03）"],
	"fill-pattern": ["一部", "基図と vector の層（GL2・WebGPU・S-P1-4/5・2026-10-22・名前は層で一度・模様の大きさは cos φ 倍・3D（地形あり）の塗りは描かない）・geojson の層は canvas2D の模様"],
	"line-pattern": ["一部", "geojson の層だけ（canvas2D の模様）。基図・vector の層は未"],
	"background-pattern": ["未", "§3 B5"],
	"fill-extrusion-pattern": ["未", "警告して描く（§4）"],
	"fill-translate": ["一部", "基図と vector の層（GL2・WebGPU・S-P1-4/5・2026-10-22・層で一度＝zoom の式はタイルの z）・3D（地形あり）の塗り・geojson の層は読まない"],
	"line-translate": ["一部", "基図と vector の層（GL2・WebGPU・S-P1-4/5・2026-10-22）・geojson の層は読まない"],
	"circle-translate": ["一部", "vector の層（GL2・WebGPU・S-P1-4/5・2026-10-22）・geojson の層は読まない"],
	"fill-extrusion-translate": ["未", "警告して描く（§4）"],
	"fill-translate-anchor": ["一部", "translate と同じ（viewport＝方位だけ回す）"],
	"line-translate-anchor": ["一部", "translate と同じ（viewport＝方位だけ回す）"],
	"circle-translate-anchor": ["一部", "translate と同じ（viewport＝方位だけ回す）"],
	"fill-extrusion-translate-anchor": ["未", "translate が未"],
	"line-gradient": ["一部", "geojson の層だけ（canvas2D の線の飾り）。vector の層は未"],
	"line-blur": ["一部", "基図と vector の層（GL2・WebGPU・S-P1-4/5・2026-10-22・属性の式は層で一度）・geojson の層は読まない"],
	"circle-blur": ["一部", "vector の層（GL2・WebGPU・S-P1-4/5・2026-10-22・層で一度・透ける円の縁の輪はぼかさない）・geojson の層は読まない"],
	"circle-pitch-alignment": ["一部", "\"map\" は警告して画面に向いた円で描く"],
	"circle-pitch-scale": ["未", "遠近の縮みは無い（§4）"],
	"fill-layer-opacity": ["近似", "vector の層だけ・地物の opacity に掛け合わせる（§4）"],
	"line-layer-opacity": ["近似", "vector の層だけ・地物の opacity に掛け合わせる（§4）"],
	"text-font": ["近似", "端末のフォントで描く（glyphs は記録だけ）＝波 5 の T-P4 で PBF"],
	"symbol-avoid-edges": ["未", ""],
	"icon-keep-upright": ["未", ""],
	"hillshade-illumination-anchor": ["未", ""],
	"symbol-z-order": ["一部", "基図・vector の注記だけ（geojson の点置きの symbol は読まない・§4）"],
	"symbol-sort-key": ["読む", "衝突判定の順"],
};

function engineText() {
	const files = [];
	const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name) && !SKIP.has(e.name)) files.push(p); } };
	walk(path.join(PKG, "src")); walk(path.join(CORE, "src"));
	return files.map(f => fs.readFileSync(f, "utf8").split("\n").filter(l => !/UNSUPPORTED|not supported/.test(l)).map(l => l.replace(/(^|[^:"'])\/\/.*$/, "$1")).join("\n")).join("\n");
}
export function buildCoverage() {
	const src = engineText(), count = {};
	let md = `# MapLibre style-spec の性質の網羅表（生成物）\n\n`
		+ `\`scripts/ml-coverage.mjs\` が style-spec ${ML_SPEC_VERSION} の写し（core \`src/mlspec.ts\`）から作る。手で書き換えない＝状態を変えるときはスクリプトの \`NOTES\`（台帳 \`maplibre-compat.md\` の §3・§4 の写し）を直して書き出し直す。\n`
		+ `「読む」は性質の名前を読む所がエンジンにあることだけを言う。絵が MapLibre と同じかは公式例の門（台帳 §8）と互換の爪車（§6）が見る。\n\n`;
	const rows = [];
	for (const [type, parts] of Object.entries(ML_LAYER_PROPS)) for (const part of ["layout", "paint"]) for (const p of parts[part]) {
		if (p === "visibility") continue;
		const [st, note] = NOTES[p] ?? [src.includes(`"${p}"`) || src.includes(`'${p}'`) ? "読む" : "無い", ""];
		count[st] = (count[st] || 0) + 1;
		rows.push(`| ${type} | ${part} | \`${p}\` | ${st} | ${note} |`);
	}
	md += `計 ${rows.length}：${Object.entries(count).map(([k, v]) => `${k} ${v}`).join("・")}\n\n| 層 | 置き場 | 性質 | 状態 | 中身 |\n|---|---|---|---|---|\n${rows.join("\n")}\n`;
	return { md, count };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { md, count } = buildCoverage();
	if (process.argv.includes("--check")) {
		const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : "";
		if (cur !== md) { console.error("✗ maplibre-coverage.md is out of date — run: node packages/globe/scripts/ml-coverage.mjs"); process.exit(1); }
		console.log(`✓ ml-coverage: maplibre-coverage.md is current（${Object.entries(count).map(([k, v]) => `${k} ${v}`).join("・")}）`);
	} else { fs.writeFileSync(OUT, md); console.log(`wrote ${path.relative(process.cwd(), OUT)}（${Object.entries(count).map(([k, v]) => `${k} ${v}`).join("・")}）`); }
}
