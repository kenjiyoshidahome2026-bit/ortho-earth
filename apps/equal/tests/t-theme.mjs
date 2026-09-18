// 配色テーマ台帳の検定（2026-09-18）。守るもの＝「テーマを足しても、どのテーマでも地図面の色が全部決まる」。
//
// 轍：themes.js で label を二度使った（表示名と文字色）＝後勝ちで label が色オブジェクトになり、
// t(T.label) が `key.indexOf is not a function` で全ページ死んだ。キーの網羅と重複はここで機械的に止める。
//
// 使い方: node tests/t-theme.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { THEMES, THEME_NAMES, normTheme, hex } from "../src/themes.js";
import { PALETTE } from "../src/layers.js";
import { WORLD_PAL_THEMES, resolveWorldPal, WORLD_PAL_DEFAULT } from "ortho-core/worldpal";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let n = 0, fails = 0;
const ok = (cond, msg) => { n++; if (!cond) { console.error("✗", msg); fails++; } };

// ① どのテーマも PALETTE の全キーを持つ（＝テーマ切替で色が変わらない層が生まれない）
for (const name of THEME_NAMES) {
	const T = THEMES[name];
	const missing = Object.keys(PALETTE).filter(k => T[k] === undefined);
	ok(missing.length === 0, `${name}: PALETTE のキーが欠けている → ${missing.join(",")}`);
	ok(typeof T.label === "string" && T.label.length > 0, `${name}: label は表示名の文字列（i18n キー）`);
	ok(/^#[0-9a-f]{6}$/i.test(T.swatch), `${name}: swatch は 6 桁 hex（テーマ選択の紙色見本）`);
	ok(T.labelColor && typeof T.labelColor.country === "string" && typeof T.labelColor.city === "string" && typeof T.labelColor.halo === "string",
		`${name}: labelColor は country/city/halo の CSS 色`);
	ok(T.world === null || typeof T.world === "object", `${name}: world は共有パレット（null＝既定）`);
}

// ② 同じオブジェクト literal に同じキーを二度書いていない（JS は黙って後勝ち＝上の轍の根）
{
	const src = fs.readFileSync(path.join(APP, "src/themes.js"), "utf8");
	let cur = null; const seen = {}; const dup = [];
	for (const line of src.split("\n")) {
		const t = line.match(/^\t(\w+): \{/); if (t) { cur = t[1]; seen[cur] = new Set(); continue; }
		if (!cur) continue;
		for (const m of line.matchAll(/(?:^|\s)(\w+):/g)) { const k = m[1]; if (seen[cur].has(k)) dup.push(`${cur}.${k}`); seen[cur].add(k); }
	}
	ok(dup.length === 0, `themes.js に重複キー → ${dup.join(", ")}`);
}

// ③ 色は GL が読める形へ変換できる（hex→[r,g,b,a]・0..1）
for (const name of THEME_NAMES) {
	const T = THEMES[name];
	for (const k of Object.keys(PALETTE)) {
		const v = T[k], c = Array.isArray(v) ? hex(v[0], v[1]) : hex(v);
		ok(c.length === 4 && c.every(x => Number.isFinite(x) && x >= 0 && x <= 1), `${name}.${k}: 色が 0..1 の 4 成分にならない（${JSON.stringify(v)}）`);
	}
}

// ④ 全球パレット＝ortho-core の共有正本を引いている（japan の palettes.js と同じ物）
ok(THEMES.mono.world === WORLD_PAL_THEMES.mono, "mono.world は共有正本（既定＝null）");
for (const name of ["dark", "gsi", "sepia"]) ok(THEMES[name].world === WORLD_PAL_THEMES[name], `${name}.world は ortho-core の共有正本そのもの（写しを作らない）`);
{
	const p = resolveWorldPal(THEMES.gsi.world);
	ok(p.sea !== WORLD_PAL_DEFAULT.sea && p.lowHumid === WORLD_PAL_DEFAULT.lowHumid, "gsi＝海だけ差し替え（per-key マージ）が成立");
	const m = resolveWorldPal(THEMES.mono.world);
	ok(Object.keys(WORLD_PAL_DEFAULT).every(k => m[k] === WORLD_PAL_DEFAULT[k]), "mono＝既定そのもの（従来出力と一致）");
}

// ⑤ 名前の正規化（japan と同じ綴りが正・口語の別名だけ受ける・未知は null＝呼び手が既定へ倒す）
ok(normTheme("dark") === "dark" && normTheme("DARK") === "dark", "大小は無視");
ok(normTheme("night") === "dark", "night は dark の別名（japan の綴りが正）");
ok(normTheme("") === null && normTheme(null) === null && normTheme("nope") === null, "未知・空は null");
ok(THEME_NAMES.includes("mono") && THEME_NAMES[0] === "mono", "mono が既定（先頭）");

// ⑥ テーマの表示名は辞書にある（equal 固有 or japan 共有）＝選択 UI が英語のまま残らない
{
	const own = JSON.parse(fs.readFileSync(path.join(APP, "i18n/ui.json"), "utf8")).ui;
	const jp = JSON.parse(fs.readFileSync(path.join(APP, "../ortho-japan/i18n/ui.json"), "utf8")).ui;
	for (const name of THEME_NAMES) {
		const label = THEMES[name].label;
		ok(!!(own[label] || jp[label]), `${name}: 表示名 "${label}" がどちらの辞書にも無い`);
	}
}

console.log(fails ? `t-theme: ${n - fails}/${n} ok（${fails} 件 NG）` : `t-theme: ${n} ok`);
process.exit(fails ? 1 : 0);
