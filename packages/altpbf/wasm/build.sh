#!/usr/bin/env bash
# altpbf の wasm（標高の varint 読み）を再現ビルドする（高速化 段 3・2026-10-16）。npm run build:wasm と同じ。
#   toolchain＝rust-toolchain.toml（rustc 1.96.0・wasm32-unknown-unknown）・依存なし・wasm-bindgen なし。
#   SIMD128 なし／ありの 2 本を cargo build → wasm-opt -O で焼き、src/svarint-wasm.ts へ base64 で埋める（npm の dist も同じ .ts から作る＝別ファイルを配らない）。
#   wasm-opt（binaryen）は WASM_OPT_VERSION に固定（`npm i -g binaryen@<版>` か `WASM_OPT=/path/to/wasm-opt`）。
#   .rs/Cargo と埋めた wasm の sha256 を wasm.sha256（台帳）へ書く＝tests/svarint.mjs が「.rs を変えたのに焼き直していない」「.ts を手で触った」を検める。
# 使い方: bash wasm/build.sh            （altpbf の root から・npm run build:wasm）
#         bash wasm/build.sh --check    （ビルドせず台帳の照合だけ）
set -euo pipefail
WASM_OPT_VERSION=132   # binaryen（npm の binaryen@132.0.0）＝geopbf/wasm/build.sh と同じ
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(dirname "$HERE")"
if [[ "${1:-}" == "--check" ]]; then exec node "$PKG/scripts/wasm-embed.mjs" --check; fi
command -v cargo >/dev/null || { echo "✗ cargo が無い（https://rustup.rs）"; exit 1; }
WASM_OPT="${WASM_OPT:-wasm-opt}"
command -v "$WASM_OPT" >/dev/null || { echo "✗ wasm-opt が無い: npm i -g binaryen@$WASM_OPT_VERSION（または WASM_OPT=…/node_modules/.bin/wasm-opt）"; exit 1; }
OPTV="$("$WASM_OPT" --version | sed -n 's/^wasm-opt version \([0-9]*\).*/\1/p')"
[[ "$OPTV" == "$WASM_OPT_VERSION" ]] || { echo "✗ wasm-opt version $OPTV ≠ $WASM_OPT_VERSION（build.sh の WASM_OPT_VERSION）: npm i -g binaryen@$WASM_OPT_VERSION"; exit 1; }

cd "$HERE"
echo "… cargo build ×2（$(rustc --version)）"
CARGO_TARGET_DIR=target/scalar cargo build --release --target wasm32-unknown-unknown --locked
CARGO_TARGET_DIR=target/simd RUSTFLAGS="-C target-feature=+simd128" cargo build --release --target wasm32-unknown-unknown --locked
echo "… wasm-opt -O（binaryen ${OPTV}）"
mkdir -p target/out
"$WASM_OPT" -O target/scalar/wasm32-unknown-unknown/release/altpbf_svarint.wasm -o target/out/scalar.wasm
"$WASM_OPT" -O --enable-simd target/simd/wasm32-unknown-unknown/release/altpbf_svarint.wasm -o target/out/simd.wasm
node "$PKG/scripts/wasm-embed.mjs" --write target/out/scalar.wasm target/out/simd.wasm --wasm-opt "$OPTV"
