// 起動時の裁き（boot/tier.js）の検定＝navigator と location だけで決まる純関数を Node で回す。
// 台帳＝packages/ortho-core/fallback-ladder.md（ノブを変えたらこちらも）。実機の事故から採った例＝Windows i7/HD Graphics（2026-08-03）・
// 8GB Android（LOW_MEM 素通り）・Apple M1（既定のまま）・16 コア（HI）・swiftshader（headless の検定機）。
import { lowMem, classifyTier, deadMap } from "@ortho-earth/globe/boot/tier.js";
let n = 0, bad = 0;
const ok = (name, c, x = "") => { n++; if (!c) bad++; console.log(`${c ? "✓" : "✗"} ${name}${x ? ` (${x})` : ""}`); };
const nav = (o = {}) => ({ hardwareConcurrency: 8, maxTouchPoints: 0, ...o });
const tier = (o) => classifyTier({ LOW_MEM: false, search: "", coarse: () => false, nav: nav(), ...o });

// lowMem
ok("lowMem: deviceMemory 4 → 低メモリ", lowMem(nav({ deviceMemory: 4 })) === true);
ok("lowMem: deviceMemory 8 → 通常", lowMem(nav({ deviceMemory: 8 })) === false);
ok("lowMem: deviceMemory 無し（iOS）×タッチ → 低メモリ", lowMem(nav({ maxTouchPoints: 5 })) === true);
ok("lowMem: deviceMemory 無し×非タッチ → 通常", lowMem(nav({ maxTouchPoints: 0 })) === false);

// MID_TIER
let r = tier({ gpuRenderer: "ANGLE (Intel, Intel(R) HD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" });
ok("Windows i7 / HD Graphics → MID", r.MID_TIER === true && r.HI_TIER === false);
r = tier({ gpuRenderer: "ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)", nav: nav({ hardwareConcurrency: 16 }) });
ok("Intel Arc（独立GPU）→ MID でない・16 コアで HI", r.MID_TIER === false && r.HI_TIER === true);
r = tier({ gpuRenderer: "ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)" });
ok("AMD APU 内蔵 → MID", r.MID_TIER === true);
r = tier({ gpuRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)" });
ok("Apple M1 8 コア → 既定（MID でも HI でもない）", r.MID_TIER === false && r.HI_TIER === false);
r = tier({ gpuRenderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)" });
ok("swiftshader（headless）→ MID", r.MID_TIER === true);
r = tier({ nav: nav({ hardwareConcurrency: 4 }) });
ok("4 コア → MID", r.MID_TIER === true);
r = tier({ nav: nav({ hardwareConcurrency: 8, maxTouchPoints: 5, deviceMemory: 8 }), coarse: () => true });
ok("8GB Android（coarse×タッチ・LOW_MEM 素通り）→ MOBILE_UA → MID", r.MOBILE_UA === true && r.MID_TIER === true);
r = tier({ nav: nav({ userAgentData: { mobile: true } }), coarse: () => { throw new Error("must not be called"); } });
ok("userAgentData.mobile → MOBILE_UA（coarse は短絡で呼ばれない）", r.MOBILE_UA === true && r.MID_TIER === true);
r = tier({ nav: nav({ hardwareConcurrency: 8, maxTouchPoints: 10 }), coarse: () => false });
ok("タッチ対応ノート（fine ポインタ）→ MOBILE_UA でない", r.MOBILE_UA === false && r.MID_TIER === false);

// HI_TIER
r = tier({ nav: nav({ hardwareConcurrency: 12 }) });
ok("12 コア → HI", r.HI_TIER === true && r.MID_TIER === false);
r = tier({ nav: nav({ hardwareConcurrency: 16 }), gpuRenderer: "Intel(R) UHD Graphics 770" });
ok("16 コアでも内蔵 Intel → MID が勝ち HI でない", r.MID_TIER === true && r.HI_TIER === false);

// LOW_MEM は両ティアの外
r = tier({ LOW_MEM: true, nav: nav({ hardwareConcurrency: 16 }), gpuRenderer: "Intel(R) HD Graphics" });
ok("LOW_MEM → MID/HI とも偽", r.MID_TIER === false && r.HI_TIER === false);

// 上書きノブ
ok("?mid=0 → Intel でも MID 偽", tier({ search: "?mid=0", gpuRenderer: "Intel(R) HD Graphics" }).MID_TIER === false);
ok("?mid=1 → Apple でも MID 真", tier({ search: "?a=1&mid=1", gpuRenderer: "Apple M1" }).MID_TIER === true);
ok("?hi=0 → 16 コアでも HI 偽", tier({ search: "?hi=0", nav: nav({ hardwareConcurrency: 16 }) }).HI_TIER === false);
ok("?hi=1 → 4 コアでも HI 真（MID と両立）", (() => { const t = tier({ search: "?hi=1", nav: nav({ hardwareConcurrency: 4 }) }); return t.HI_TIER === true && t.MID_TIER === true; })());
ok("?mid=1 は MID を立て HI を折る（HI は !MID_TIER 条件）", (() => { const t = tier({ search: "?mid=1", nav: nav({ hardwareConcurrency: 16 }) }); return t.MID_TIER === true && t.HI_TIER === false; })());

// deadMap＝どんな連鎖も無害に空転
const d = deadMap();
ok("deadMap: 連鎖呼び出しが自分を返す", d.gadget.search({ a: 1 }).open() === d.gadget.search().open());
ok("deadMap: then は undefined（await が即解決）", d.then === undefined);
ok("deadMap: 文字列化は空", String(d) === "" && `${d}` === "");
ok("deadMap: 代入は無害", (() => { d.x = 1; return true; })());

console.log(bad ? `\nFAIL  ${bad}/${n}` : `\nPASS  ${n} 件すべて`);
process.exit(bad ? 1 : 0);
