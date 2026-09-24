#!/usr/bin/env node
// quiet-mono の tokens.scss → components.scss → src/style.scss（この順）を焼いて src/globe.css を作る（2026-09-25）。
// 出荷物は素の CSS＝利用者に sass も quiet-mono も要らない（1.1.0 までは scss を直に import ＝ sass が @parcel/watcher を連れてきた）。
// scss を変えたら npm run build:css（prepack でも走る）。--check＝焼き直しが要るなら落ちる（verify の関門）。geoedit の css-build.mjs と同じ流儀。
import { compile } from "sass";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const qm = path.dirname(createRequire(import.meta.url).resolve("quiet-mono/tokens.scss"));
const parts = [path.join(qm, "tokens.scss"), path.join(qm, "components.scss"), path.join(PKG, "src/style.scss")];
const css = "/* 生成物＝npm run build:css（正本は quiet-mono の tokens/components.scss と src/style.scss）。手で編集しない。 */\n"
	+ parts.map(f => compile(f, { style: "expanded", quietDeps: true }).css).join("\n") + "\n";
const OUT = path.join(PKG, "src/globe.css");
if (process.argv.includes("--check")) {
	if (!fs.existsSync(OUT) || fs.readFileSync(OUT, "utf8") !== css) { console.error("✗ src/globe.css が scss と合っていない＝npm run build:css -w @ortho-earth/globe"); process.exit(1); }
	console.log("✓ globe.css は scss と一致"); process.exit(0);
}
fs.writeFileSync(OUT, css);
console.log(`globe.css ${(css.length / 1024).toFixed(1)} KB`);
