#!/usr/bin/env node
// COI 無し（COOP/COEP を刻まない）世界のスモーク＝**SDK 化の前提確認**（2026-09-24 に japan の殻から globe へ）。
// 埋め込み先のページに COEP を要求することは実質できない（COEP はホスト側の他の埋め込みを軒並み壊す）ので、
// 「crossOriginIsolated が立たなくても全機能が動く」ことを実測で押さえる。逃げ道は geopbf setGintBUF の
// SAB フォールバック（SAB 不在なら通常 ArrayBuffer＝コピー1回）＝Safari は元からこの世界で動いている。
// エンジンを配る側の約束なので、宿は地球儀ホスト（japan の t-opts/t-gadgets は日本の殻の関心＝ここでは見ない）。
// 実時間で回す：worker 連鎖（geopbf encoder→gint decoder）は仮想時計が先に燃え尽きて偽陽性になる。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite, runPages, SWIFTSHADER } from "./lib/ui-runner.mjs";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VGN_PORT || 5247;

// t-nocoi＝COI非成立と SAB 不在を自分で検定する的（ここが緑でないと以下は無意味）。以降は SAB 経路に触る層。
const ALL_PAGES = ["t-nocoi?nocoi=1", "t-gintembed", "t-gintlod", "t-gintswap", "t-gintdepth"];
const ARGS = process.argv.slice(2).filter(a => !a.startsWith("--"));
const PAGES = ARGS.length ? ARGS : ALL_PAGES;
const stop = await startVite({ cwd: PKG, port: PORT, readyUrl: `http://localhost:${PORT}/tests/`, env: { NOCOI: "1" } });
// 門前の確認＝COI ヘッダが本当に消えているか（NOCOI の効きが壊れたら以下は全部偽の緑になる）
const h = (await fetch(`http://localhost:${PORT}/tests/t-nocoi.html`)).headers;
if (h.get("cross-origin-embedder-policy") || h.get("cross-origin-opener-policy")) {
	console.error("FAIL  NOCOI=1 なのに COOP/COEP が刻まれている＝この検定は意味を成さない"); stop(); process.exit(1);
}
const fail = await runPages({
	pages: PAGES, realtime: new Set(PAGES.map(p => p.split("?")[0])), long: Object.fromEntries(PAGES.map(p => [p.split("?")[0], 90])),
	flags: SWIFTSHADER, profilePrefix: "og-nocoi", cdpBase: 9736, pad: 16,
	urlOf: (page, q) => `http://localhost:${PORT}/tests/${page}.html?${q}`,
});
stop();
process.exit(fail ? 1 : 0);
