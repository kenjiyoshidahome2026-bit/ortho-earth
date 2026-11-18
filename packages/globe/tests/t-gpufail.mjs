// メモリ不足・GPU 喪失の裁き（src/boot/gpufail.ts）の検定＝DOM なしの純関数を Node で回す（2026-11-18）。
// 実例：タブを 100 枚超開いた Windows 機で「最初の 3 回は開けず、後で開けた」「地震の頁で落ちた」。
import { isOomMessage, lossStep, crashMarker, clearMarker, safeMemBoot, oomBurst, ALIVE_KEY, SAFE_KEY } from "../src/boot/gpufail.ts";
let n = 0, bad = 0;
const ok = (name, c) => { n++; if (!c) bad++; console.log(`${c ? "✓" : "✗"} ${name}`); };
const store = () => { const m = new Map(); return { m, getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

// isOomMessage：各エンジンの言い回し
ok("V8：Array buffer allocation failed", isOomMessage(new RangeError("Array buffer allocation failed")));
ok("V8：Invalid typed array length", isOomMessage("RangeError: Invalid typed array length: 4294967296"));
ok("SpiderMonkey：out of memory", isOomMessage("uncaught exception: out of memory"));
ok("WebGPU：GPUOutOfMemoryError（名前）", isOomMessage({ name: "GPUOutOfMemoryError", message: "" }));
ok("WebGPU：GPUOutOfMemoryError（constructor）", isOomMessage(new (class GPUOutOfMemoryError { message = "x" })()));
ok("WebGL：GL_OUT_OF_MEMORY", isOomMessage("WebGL: OUT_OF_MEMORY: texImage2D"));
ok("Chrome：Failed to allocate", isOomMessage("Failed to allocate buffer"));
ok("ズームの文言は別物（zoom）", !isOomMessage("zoom out of range"));
ok("RangeError の別物（Maximum call stack）", !isOomMessage(new RangeError("Maximum call stack size exceeded")));
ok("検証エラーは別物", !isOomMessage("Validation error: binding size too small"));
ok("null／undefined", !isOomMessage(null) && !isOomMessage(undefined));

// lossStep：梯子
ok("1 回目＝読み直す", lossStep(0, false) === "reload");
ok("2 回目＝省メモリで読み直す", lossStep(1, false) === "reload-safe");
ok("2 回目・既に省メモリ＝案内", lossStep(1, true) === "fatal");
ok("3 回目＝案内", lossStep(2, false) === "fatal");
ok("1 回目は省メモリでも読み直す", lossStep(0, true) === "reload");

// crashMarker：前の起動が畳まれずに消えたか
{
	const s = store();
	ok("初めての起動＝落ちていない", crashMarker(s, 100).crashed === false && s.m.get(ALIVE_KEY) === "100");
	ok("同じ頁の 2 枚目の地図＝落ちていない", crashMarker(s, 100).crashed === false);
	ok("印が残ったまま別の起動＝落ちた", crashMarker(s, 200).crashed === true && s.m.get(ALIVE_KEY) === "200");
	clearMarker(s, 200);
	ok("普通の離脱で印を下ろす", !s.m.has(ALIVE_KEY));
	ok("離脱の後の起動＝落ちていない", crashMarker(s, 300).crashed === false);
	clearMarker(s, 999);
	ok("他の起動の印は下ろさない", s.m.get(ALIVE_KEY) === "300");
	ok("store 無し（private）＝落ちていない", crashMarker(null, 1).crashed === false);
	const thrower = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() {} };
	ok("store が例外＝落ちていない", crashMarker(thrower, 1).crashed === false);
}

// safeMemBoot
{
	const s = store();
	ok("落ちていない・印無し＝通常", safeMemBoot({ search: "", crashed: false, store: s }) === false);
	ok("落ちた＝省メモリ・印を立てる", safeMemBoot({ search: "", crashed: true, store: s }) === true && s.m.get(SAFE_KEY) === "1");
	ok("印があれば次も省メモリ（タブの間）", safeMemBoot({ search: "", crashed: false, store: s }) === true);
	ok("?lowmem=0 は従わない", safeMemBoot({ search: "?x=1&lowmem=0", crashed: true, store: s }) === false);
}

// oomBurst
{
	const t = [];
	ok("1 回目＝様子見", oomBurst(t, 0) === false);
	ok("2 回目＝様子見", oomBurst(t, 1000) === false);
	ok("30 秒内の 3 回目＝描けていない", oomBurst(t, 2000) === true);
	const u = [];
	oomBurst(u, 0); oomBurst(u, 1000);
	ok("間が空けば数え直す", oomBurst(u, 40000) === false && u.length === 1);
}

console.log(`\n${n - bad}/${n} passed`);
if (bad) process.exit(1);
