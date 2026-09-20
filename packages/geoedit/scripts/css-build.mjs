#!/usr/bin/env node
// src/editor.scss → src/editor.css.js（export default "…"）。scss は開発時の書き方（quiet-mono の tokens を @use）。
// 出荷物は焼き込んだ CSS 文字列＝消費側に sass も quiet-mono（private）も ?inline（Vite 専用）も要らない。変えたら npm run build:css（prepack でも走る）。
import { compile } from "sass";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const roots = [path.join(PKG, "node_modules"), path.join(PKG, "../../node_modules"), path.join(PKG, "..")];   // quiet-mono＝monorepo の packages/quiet-mono（workspace リンク）
const r = compile(path.join(PKG, "src/editor.scss"), { style: "compressed", loadPaths: roots, quietDeps: true });
fs.writeFileSync(path.join(PKG, "src/editor.css.js"), "// 生成物＝npm run build:css（正本は editor.scss）。手で編集しない。\nexport default " + JSON.stringify(r.css) + ";\n");
console.log(`editor.css.js ${r.css.length} chars`);
