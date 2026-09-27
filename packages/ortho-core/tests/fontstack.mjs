#!/usr/bin/env node
// text-font（MapLibre のフォントスタック名）→ CSS の書体（fontstack.js・段 2）の検定（Node）
import { parseFontStack, fontCss } from "../src/fontstack.js";
let fails = 0;
const ok = (cond, label) => { if (cond) return; fails++; console.error(`  ✗ ${label}`); };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
eq(parseFontStack(["Noto Sans Bold"]), { fam: ["Noto Sans"], w: 700, st: "normal" }, "Bold");
eq(parseFontStack(["Noto Sans Italic"]), { fam: ["Noto Sans"], w: 400, st: "italic" }, "Italic");
eq(parseFontStack(["Noto Sans Bold Italic"]), { fam: ["Noto Sans"], w: 700, st: "italic" }, "Bold Italic");
eq(parseFontStack(["Open Sans Semibold", "Arial Unicode MS Bold"]), { fam: ["Open Sans", "Arial Unicode MS"], w: 600, st: "normal" }, "二つの名前＝family の列・weight は先頭");
eq(parseFontStack(["Metropolis Regular"]), { fam: ["Metropolis"], w: 400, st: "normal" }, "Regular");
eq(parseFontStack(["Roboto Condensed Light"]), { fam: ["Roboto"], w: 300, st: "normal" }, "Condensed は捨てる");
eq(parseFontStack("Noto Sans Medium"), { fam: ["Noto Sans"], w: 500, st: "normal" }, "文字列 1 つ");
eq(parseFontStack(["Sans"]), { fam: ["Sans"], w: 400, st: "normal" }, "語が 1 つ＝family のまま（Sans を weight と取らない）");
eq(parseFontStack([]), null, "空＝null"); eq(parseFontStack(null), null, "null");
eq(fontCss(parseFontStack(["Noto Sans Bold"]), 14, "sans-serif"), '700 14px "Noto Sans",sans-serif', "css bold");
eq(fontCss(parseFontStack(["Noto Sans Italic"]), 12, "X"), 'italic 12px "Noto Sans",X', "css italic");
eq(fontCss(null, 10, "X"), "10px X", "css 無し＝既定の束だけ");
eq(fontCss(parseFontStack(['Bad"Name Bold']), 10, "X"), '700 10px "BadName",X', "引用符は剥ぐ");
if (fails) { console.error(`✗ fontstack: ${fails} failure(s)`); process.exit(1); }
console.log("✓ fontstack: all checks passed");
