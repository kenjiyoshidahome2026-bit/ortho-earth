// 現代の温泉番付を public/onsen-banzuke.svg に焼く（中身＝../onsen-banzuke.ts の 温泉番付()・既定の番付＝現代番付）
//   node apps/onsen/scripts/onsen-banzuke.mjs
// 江戸の番付 public/onsen-banzuke-edo.svg は手で詰めた一枚もの＝焼き直さない。
import { writeFileSync } from "node:fs";
import { 温泉番付 } from "../onsen-banzuke.ts";   // Node 23.6+ は型を剥がして直に読む

const svg = 温泉番付();
writeFileSync(new URL("../public/onsen-banzuke.svg", import.meta.url), svg);
console.log(`public/onsen-banzuke.svg (${svg.length} 字)`);
