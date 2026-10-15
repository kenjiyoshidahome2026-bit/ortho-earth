// バンドラ（vite）の ?url import の型＝ファイルの URL（laz-web.ts が laz-perf の .wasm をファイルのまま出すのに使う）
declare module "*.wasm?url" { const url: string; export default url; }
