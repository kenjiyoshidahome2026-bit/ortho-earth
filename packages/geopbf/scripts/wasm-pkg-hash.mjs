#!/usr/bin/env node
// wasm の台帳（wasm/pkg.sha256）＝「この .rs・Cargo から、この toolchain で、この pkg が出来た」の記録（改良点 11・2026-10-12）。
//   --write --wasm-opt <版> : 今の sources と pkg の sha256・wasm の producers（rustc／wasm-bindgen の版）・wasm-opt の版（binaryen は producers に書かないので build.sh が渡す）を台帳へ書く
//   --check  : 台帳と今の sources／pkg を照合する（tests/t-wasm-pkg.mjs・npm test）。
//              sources が違う＝.rs を変えたのに焼き直していない／pkg が違う＝pkg を手で触った・別の toolchain で焼いた → `npm run build:wasm`
//   引数なし : 読んだ物を表示
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WASM = path.join(PKG, "wasm");
const LEDGER = path.join(WASM, "pkg.sha256");
export const SOURCES = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/lib.rs", "src/topology.rs"];
export const OUTPUTS = ["pkg/gint_wasm_bg.wasm", "pkg/gint_wasm.js", "pkg/gint_wasm.d.ts", "pkg/package.json"];
const sha = f => createHash("sha256").update(readFileSync(path.join(WASM, f))).digest("hex");

// wasm の custom section "producers"（rustc・wasm-bindgen・wasm-opt の版）
export function producers(bytes) {
	const b = new Uint8Array(bytes); let p = 8; const out = {};
	const u = () => { let r = 0, s = 0; for (;;) { const x = b[p++]; r |= (x & 127) << s; if (!(x & 128)) return r >>> 0; s += 7; } };
	const str = () => { const n = u(); const s = new TextDecoder().decode(b.subarray(p, p + n)); p += n; return s; };
	while (p < b.length) {
		const id = b[p++]; const size = u(); const end = p + size;
		if (id === 0 && str() === "producers") {
			const m = u();
			for (let i = 0; i < m; i++) { const field = str(); const vc = u(); for (let j = 0; j < vc; j++) { const name = str(), ver = str(); out[name] = ver || field; } }
		}
		p = end;
	}
	return out;   // 例 { Rust: "language", rustc: "1.96.0 (…)", walrus: "0.26.4", "wasm-bindgen": "0.2.122" }
}

export function current() {
	const sources = Object.fromEntries(SOURCES.map(f => [f, sha(f)]));
	const outputs = Object.fromEntries(OUTPUTS.map(f => [f, sha(f)]));
	const prod = producers(readFileSync(path.join(WASM, "pkg/gint_wasm_bg.wasm")));
	return { sources, outputs, producers: { rustc: prod.rustc || null, "wasm-bindgen": prod["wasm-bindgen"] || null } };
}
export function ledger() { return existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, "utf8")) : null; }
export function compare(cur = current(), led = ledger()) {
	const diff = [];
	if (!led) return ["台帳 wasm/pkg.sha256 が無い（npm run build:wasm）"];
	for (const [k, v] of Object.entries(cur.sources)) if (led.sources?.[k] !== v) diff.push(`sources: ${k} が台帳と違う（.rs／Cargo を変えたら npm run build:wasm）`);
	for (const k of Object.keys(led.sources || {})) if (!(k in cur.sources)) diff.push(`sources: ${k} が台帳にあるのに無い`);
	for (const [k, v] of Object.entries(cur.outputs)) if (led.outputs?.[k] !== v) diff.push(`pkg: ${k} が台帳と違う（手で触った／別の toolchain で焼いた＝npm run build:wasm で焼き直して台帳も更新）`);
	for (const k of ["rustc", "wasm-bindgen"]) if ((led.producers?.[k] ?? null) !== (cur.producers[k] ?? null)) diff.push(`producers: ${k} が台帳と違う（${led.producers?.[k]} ≠ ${cur.producers[k]}）`);
	const pinned = /^WASM_OPT_VERSION=(\d+)/m.exec(readFileSync(path.join(WASM, "build.sh"), "utf8"))?.[1] ?? null;
	if ((led.wasmOpt ?? null) !== pinned) diff.push(`wasm-opt: 台帳の ${led.wasmOpt} ≠ build.sh の WASM_OPT_VERSION=${pinned}`);
	return diff;
}

const mode = process.argv[2];
if (import.meta.url === `file://${process.argv[1]}`) {
	const cur = current();
	if (mode === "--write") {
		const wasmOpt = process.argv[process.argv.indexOf("--wasm-opt") + 1] || null;
		if (!wasmOpt || process.argv.indexOf("--wasm-opt") < 0) { console.error("✗ --write には --wasm-opt <binaryen の版> が要る（build.sh が渡す）"); process.exit(1); }
		writeFileSync(LEDGER, JSON.stringify({ note: "wasm/build.sh が書く台帳。手で編集しない（tests/t-wasm-pkg.mjs が照合）", ...cur, wasmOpt, builtAt: new Date().toISOString() }, null, "\t") + "\n");
		console.log(`✓ ${path.relative(PKG, LEDGER)} を書いた（rustc ${cur.producers.rustc}・wasm-bindgen ${cur.producers["wasm-bindgen"]}・wasm-opt ${wasmOpt}）`);
	} else if (mode === "--check") {
		const diff = compare(cur);
		if (diff.length) { for (const d of diff) console.error("✗", d); process.exit(1); }
		console.log(`✓ wasm/pkg は台帳どおり（rustc ${cur.producers.rustc}・wasm-bindgen ${cur.producers["wasm-bindgen"]}・wasm-opt ${ledger()?.wasmOpt}）`);
	} else console.log(JSON.stringify(cur, null, 2));
}
