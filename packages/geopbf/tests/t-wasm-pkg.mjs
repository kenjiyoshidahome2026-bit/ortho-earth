#!/usr/bin/env node
// t-wasm-pkg: 同梱 wasm（wasm/pkg）の再現性の門（geopbf 改良点 11・2026-10-12・俯瞰 §2-D 15）。
//   ・台帳 wasm/pkg.sha256（build.sh が書く）と今の .rs／Cargo／pkg の sha256 が一致＝「.rs を変えたのに焼き直していない」「pkg を手で触った」を弾く
//   ・wasm の producers（rustc・wasm-bindgen の版）が rust-toolchain.toml と Cargo.lock の版と一致・台帳の wasm-opt（binaryen）の版が build.sh の固定値と一致＝別の toolchain で焼いた物を弾く
//   ・glue（pkg/gint_wasm.js）の export と .rs の #[wasm_bindgen] の名簿が一致＝.rs と pkg の同期（俯瞰 14「死蔵 Rust」の再発も止める：JS が import しない export は無い）
//   ・src/extension/gint.js と convert/node-gint.js が使う名前が全部 glue にある
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { current, ledger, compare } from "../scripts/wasm-pkg-hash.mjs";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const W = f => readFileSync(path.join(PKG, "wasm", f), "utf8");
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// 1) 台帳
const cur = current(), led = ledger();
const diff = compare(cur, led);
ok(diff.length === 0, `wasm/pkg.sha256 と .rs／Cargo／pkg が一致（rustc ${cur.producers.rustc}・wasm-bindgen ${cur.producers["wasm-bindgen"]}）${diff.length ? "\n   " + diff.join("\n   ") : ""}`);

// 2) toolchain の版
const channel = /channel\s*=\s*"([^"]+)"/.exec(W("rust-toolchain.toml"))?.[1];
const lockWbg = /name = "wasm-bindgen"\nversion = "([^"]+)"/.exec(W("Cargo.lock"))?.[1];
ok(channel && cur.producers.rustc?.startsWith(channel + " "), `producers の rustc（${cur.producers.rustc}）＝rust-toolchain.toml の ${channel}`);
ok(lockWbg && cur.producers["wasm-bindgen"] === lockWbg, `producers の wasm-bindgen（${cur.producers["wasm-bindgen"]}）＝Cargo.lock の ${lockWbg}`);
const pinnedOpt = /^WASM_OPT_VERSION=(\d+)/m.exec(W("build.sh"))?.[1];
ok(pinnedOpt && led?.wasmOpt === pinnedOpt, `台帳の wasm-opt（${led?.wasmOpt}）＝build.sh の WASM_OPT_VERSION=${pinnedOpt}（binaryen）`);

// 3) glue の export ＝ .rs の #[wasm_bindgen] の名簿
const glue = W("pkg/gint_wasm.js");
const exported = new Set([...glue.matchAll(/^export (?:function|class) ([A-Za-z_0-9]+)/gm)].map(m => m[1]));
const rsNames = new Set();
for (const f of readdirSync(path.join(PKG, "wasm/src")).filter(f => f.endsWith(".rs"))) {
	const src = W("src/" + f);
	for (const m of src.matchAll(/^#\[wasm_bindgen[^\]]*\]\n(?:#\[[^\]]*\]\n)*pub (?:fn|struct) ([A-Za-z_0-9]+)/gm)) rsNames.add(m[1]);
}
const onlyGlue = [...exported].filter(n => !rsNames.has(n)), onlyRs = [...rsNames].filter(n => !exported.has(n));
ok(onlyGlue.length === 0 && onlyRs.length === 0, `glue の export ${exported.size} 個＝.rs の #[wasm_bindgen] の名簿${onlyGlue.length ? "（glue だけ: " + onlyGlue.join(", ") + "）" : ""}${onlyRs.length ? "（.rs だけ: " + onlyRs.join(", ") + "）" : ""}`);

// 4) JS が使う名前が全部ある・glue の export は全部 JS が使う（死蔵の再発止め）
const used = new Set();
for (const f of ["src/extension/gint.js", "src/convert/node-gint.js"]) {
	const src = readFileSync(path.join(PKG, f), "utf8");
	const m = /import\s+(?:init\s*,\s*)?\{([^}]*)\}\s*from\s*"[^"]*wasm\/pkg\/gint_wasm\.js"/.exec(src);
	if (m) for (const n of m[1].split(",").map(s => s.trim()).filter(Boolean)) used.add(n);
}
const missing = [...used].filter(n => !exported.has(n));
ok(used.size >= 6 && missing.length === 0, `JS が import する ${used.size} 個が glue にある${missing.length ? "（無い: " + missing.join(", ") + "）" : ""}`);
const dead = [...exported].filter(n => !used.has(n) && /^[a-z]/.test(n));   // 小文字始まり＝関数。struct（GintBufOut）は戻り値の器
ok(dead.length === 0, `JS が使わない export 関数は無い（死蔵 Rust）${dead.length ? "（死蔵: " + dead.join(", ") + "）" : ""}`);

if (fails) { console.error(`t-wasm-pkg: ${fails} 件失敗`); process.exit(1); }
console.log("t-wasm-pkg: all passed");
