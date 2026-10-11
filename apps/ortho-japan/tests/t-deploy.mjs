#!/usr/bin/env node
// deploy 台本の純関数の常設検定＝globe の門の出力から落ちた頁を拾う（単独の回し直しに渡す列）。
import { failedPages } from "../scripts/deploy-lib.mjs";

let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const out = [
	"（4 本ずつ並べる・並べない頁なし）",
	"PASS  t-shadow           [webgpu] PASS 12/12  〔31.2s〕",
	"FAIL  t-mlcompat?g=layers [webgpu] FAIL fill-no-outline:139,37.5-2:... circle-opacity:Δ41  〔118.0s〕",
	"PASS  t-mlcompat?g=relief [webgpu] PASS  〔60.1s〕",
	"FAIL  t-ellparity?g=scan&ell=1 FAIL no-title(realtime 300s):   〔300.4s〕",
	"FAIL  t-mlcompat?g=layers [webgpu] FAIL again  〔100.0s〕",
	"",
	"壁時計 9.8 分（4 本ずつ）・遅い頁：t-ellparity?g=scan&ell=1 300s",
	"✗ 3/64 ページ失敗",
];
t("落ちた頁を query 込みで・順に・重複なく拾う", eq(failedPages(out), ["t-mlcompat?g=layers", "t-ellparity?g=scan&ell=1"]), JSON.stringify(failedPages(out)));
t("deploy.mjs の pipe の頭（[globe 123s]）が付いていても拾う", eq(failedPages(out.map(l => `[globe 123s] ${l}`)), ["t-mlcompat?g=layers", "t-ellparity?g=scan&ell=1"]));
t("全部 PASS＝空", eq(failedPages(["PASS  t-a  x  〔1.0s〕", "✓ 全64ページ PASS"]), []));
t("まとめの行（✗ 3/64 ページ失敗）や頁の表題の中の FAIL は頁として拾わない", eq(failedPages(["✗ 3/64 ページ失敗", "PASS  t-b  FAIL と書いてある表題  〔1.0s〕", "FAIL chrome: spawn ENOENT"]), []));
t("空・非文字列に耐える", eq(failedPages([]), []) && eq(failedPages([null, undefined, 42]), []));

console.log(`\n${ng ? "✗" : "✓"} t-deploy ${ok} ok / ${ng} ng`);
process.exit(ng ? 1 : 0);
