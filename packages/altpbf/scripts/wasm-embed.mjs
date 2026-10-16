#!/usr/bin/env node
// altpbf の wasm を src/svarint-wasm.ts へ埋め、台帳（wasm/wasm.sha256）を書く／照合する（高速化 段 3・2026-10-16）。
//   --write <scalar.wasm> <simd.wasm> --wasm-opt <版> : wasm/build.sh から。.ts を書き、sources と .ts の sha256・toolchain の版を台帳へ
//   --check : 台帳と今の sources／.ts を照合する（tests/svarint.mjs・npm test）。
//             sources が違う＝.rs を変えたのに焼き直していない／.ts が違う＝埋めた wasm を手で触った → `npm run build:wasm`
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WASM = path.join(PKG, "wasm"), LEDGER = path.join(WASM, "wasm.sha256"), OUT = path.join(PKG, "src/svarint-wasm.ts");
export const SOURCES = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "src/lib.rs"];
const sha = b => createHash("sha256").update(b).digest("hex");
const current = () => ({ ...Object.fromEntries(SOURCES.map(f => [f, sha(readFileSync(path.join(WASM, f)))])), "../src/svarint-wasm.ts": sha(readFileSync(OUT)) });
const readLedger = () => Object.fromEntries(readFileSync(LEDGER, "utf8").split("\n").filter(l => /^[0-9a-f]{64}  /.test(l)).map(l => [l.slice(66), l.slice(0, 64)]));

export function check() {
	const want = readLedger(), have = current(), bad = Object.keys(have).filter(f => want[f] !== have[f]);
	return { ok: bad.length === 0, bad };
}

const args = process.argv.slice(2);
if (args[0] === "--write") {
	const [scalarPath, simdPath] = args.slice(1, 3), optv = args[args.indexOf("--wasm-opt") + 1];
	const scalar = readFileSync(scalarPath), simd = readFileSync(simdPath);
	if (!WebAssembly.validate(scalar) || !WebAssembly.validate(simd)) throw new Error("✗ 焼いた wasm が validate を通らない");
	const rustc = (readFileSync(path.join(WASM, "rust-toolchain.toml"), "utf8").match(/channel = "([^"]+)"/) || [])[1];
	writeFileSync(OUT, `// 生成物（wasm/build.sh → scripts/wasm-embed.mjs）。手で直さない＝台帳 wasm/wasm.sha256 が検める。
// 中身＝wasm/src/lib.rs を rustc ${rustc}・wasm-opt ${optv} で焼いた 2 本（SIMD128 なし ${scalar.length} B／あり ${simd.length} B）の base64。
export const SCALAR_WASM = "${scalar.toString("base64")}";
export const SIMD_WASM = "${simd.toString("base64")}";
`);
	const have = current();
	writeFileSync(LEDGER, `# altpbf の wasm の台帳（scripts/wasm-embed.mjs が書く・tests/svarint.mjs が照合）。rustc ${rustc}・wasm-opt ${optv}\n` + Object.entries(have).map(([f, h]) => `${h}  ${f}`).join("\n") + "\n");
	console.log(`✓ src/svarint-wasm.ts（scalar ${scalar.length} B・simd ${simd.length} B）と wasm/wasm.sha256 を書いた`);
} else if (args[0] === "--check") {
	const { ok, bad } = check();
	if (!ok) { console.error(`✗ wasm の台帳と合わない: ${bad.join(", ")} → npm run build:wasm（wasm/build.sh）`); process.exit(1); }
	console.log("✓ wasm の台帳と一致");
}
