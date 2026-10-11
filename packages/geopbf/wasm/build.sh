#!/usr/bin/env bash
# geopbf の wasm（Gint の焼き込み・交差検出）を再現ビルドする（改良点 11・2026-10-12）。npm run build:wasm と同じ。
#   toolchain＝rust-toolchain.toml（rustc 1.96.0・wasm32-unknown-unknown）、wasm-bindgen CLI＝Cargo.lock の wasm-bindgen と同じ版（違えば止まる）。
#   wasm-pack は使わない（binaryen の版と flag が wasm-pack の版で変わる）＝cargo build → wasm-bindgen --target web → wasm-opt -O の 3 段を自分で回す。
#   wasm-opt（binaryen）は WASM_OPT_VERSION に固定（npm の binaryen パッケージ: `npm i -g binaryen@<版>` か `WASM_OPT=/path/to/wasm-opt`）。
#   同梱の 1.19 の wasm は wasm-pack 産（binaryen の版が不明・-O で 142,896 bytes）。この手順の出力はそれと数百 bytes 違う＝binaryen の版差。以後はこの手順＋台帳が正。
#   出来た pkg の sha256 と .rs/Cargo の sha256 を pkg.sha256（台帳）へ書く＝tests/t-wasm-pkg.mjs が「.rs を変えたのに pkg を焼き直していない」「pkg を手で触った」を検める。
# 使い方: bash wasm/build.sh            （geopbf の root から・npm run build:wasm）
#         bash wasm/build.sh --check    （ビルドせず台帳の照合だけ＝t-wasm-pkg と同じ）
#         wasm-bindgen CLI が無い時:  cargo install wasm-bindgen-cli --version <Cargo.lock の版> --locked
#         wasm-opt が無い時:          npm i -g binaryen@<WASM_OPT_VERSION>（または WASM_OPT=…/node_modules/.bin/wasm-opt）
set -euo pipefail
WASM_OPT_VERSION=132   # binaryen（npm の binaryen@132.0.0）。変えたら pkg を焼き直して台帳も更新する
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(dirname "$HERE")"
if [[ "${1:-}" == "--check" ]]; then exec node "$PKG/scripts/wasm-pkg-hash.mjs" --check; fi

WANT="$(grep -A1 '^name = "wasm-bindgen"$' "$HERE/Cargo.lock" | sed -n 's/^version = "\(.*\)"/\1/p')"
[[ -n "$WANT" ]] || { echo "✗ Cargo.lock に wasm-bindgen が無い"; exit 1; }
command -v cargo >/dev/null || { echo "✗ cargo が無い（https://rustup.rs）"; exit 1; }
command -v wasm-bindgen >/dev/null || { echo "✗ wasm-bindgen CLI が無い: cargo install wasm-bindgen-cli --version $WANT --locked"; exit 1; }
HAVE="$(wasm-bindgen --version | awk '{print $2}')"
[[ "$HAVE" == "$WANT" ]] || { echo "✗ wasm-bindgen CLI $HAVE ≠ Cargo.lock の $WANT: cargo install wasm-bindgen-cli --version $WANT --locked --force"; exit 1; }
WASM_OPT="${WASM_OPT:-wasm-opt}"
command -v "$WASM_OPT" >/dev/null || { echo "✗ wasm-opt が無い: npm i -g binaryen@$WASM_OPT_VERSION（または WASM_OPT=…/node_modules/.bin/wasm-opt）"; exit 1; }
OPTV="$("$WASM_OPT" --version | sed -n 's/^wasm-opt version \([0-9]*\).*/\1/p')"
[[ "$OPTV" == "$WASM_OPT_VERSION" ]] || { echo "✗ wasm-opt version $OPTV ≠ $WASM_OPT_VERSION（build.sh の WASM_OPT_VERSION）: npm i -g binaryen@$WASM_OPT_VERSION"; exit 1; }

cd "$HERE"
echo "… cargo build（$(rustc --version)・wasm-bindgen $HAVE）"
cargo build --release --target wasm32-unknown-unknown --locked
echo "… wasm-bindgen --target web → pkg/"
wasm-bindgen --target web --out-dir pkg --out-name gint_wasm target/wasm32-unknown-unknown/release/gint_wasm.wasm
echo "… wasm-opt -O（binaryen $OPTV）"
"$WASM_OPT" -O pkg/gint_wasm_bg.wasm -o pkg/gint_wasm_bg.wasm
# wasm-pack が書いていた物を同じ内容で（package.json・LICENSE）。.gitignore は書かない（npm pack に載せる物＝prepack が消していた）
cat > pkg/package.json <<'JSON'
{
  "name": "gint-wasm",
  "type": "module",
  "version": "0.1.0",
  "license": "MIT",
  "files": [
    "gint_wasm_bg.wasm",
    "gint_wasm.js",
    "gint_wasm.d.ts"
  ],
  "main": "gint_wasm.js",
  "types": "gint_wasm.d.ts",
  "sideEffects": [
    "./snippets/*"
  ]
}
JSON
cp LICENSE pkg/LICENSE
rm -f pkg/.gitignore
node "$PKG/scripts/wasm-pkg-hash.mjs" --write --wasm-opt "$OPTV"
ls -l pkg/gint_wasm_bg.wasm | awk '{print "✓ pkg/gint_wasm_bg.wasm " $5 " bytes"}'
