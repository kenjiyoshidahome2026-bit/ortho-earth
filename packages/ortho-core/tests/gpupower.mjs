// GPU の選び方（gpupower.ts・2026-11-03）＝既定は high-performance。low-power／default に戻せる。呼び手が明示した値が勝つ。
import { setPowerPreference, powerPreference, glAttrs, gpuAdapterOptions } from "../src/gpupower.ts";

let fail = 0;
const ok = (name, cond) => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

ok("既定＝high-performance", powerPreference() === "high-performance");
ok("WebGL の属性に足す", glAttrs({ antialias: true }).powerPreference === "high-performance" && glAttrs({ antialias: true }).antialias === true);
ok("引数なしでも足す", glAttrs().powerPreference === "high-performance");
ok("WebGPU のアダプタ要求", gpuAdapterOptions()?.powerPreference === "high-performance");
setPowerPreference("low-power");
ok("low-power に戻せる", powerPreference() === "low-power" && glAttrs().powerPreference === "low-power" && gpuAdapterOptions()?.powerPreference === "low-power");
ok("呼び手の明示が勝つ", glAttrs({ powerPreference: "high-performance" }).powerPreference === "high-performance");
setPowerPreference("default");
ok("default＝WebGPU には何も言わない", gpuAdapterOptions() === undefined && glAttrs().powerPreference === "default");
setPowerPreference(undefined);
ok("未指定・未知の値は既定へ", powerPreference() === "high-performance");
setPowerPreference("turbo");
ok("未知の値は既定へ", powerPreference() === "high-performance");

if (fail) { console.log(`\n${fail} failed`); process.exit(1); }
console.log("\nall passed");
