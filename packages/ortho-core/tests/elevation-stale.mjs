// 失効判定（createGetHeight.js staleDSM）の門：申告域（dtm）の中で、R01 は brand 銘で始まる物だけ・R10 は brand 銘を含む物だけ信用する（2026-10-02）。
// 動機＝GEBCO だけの R10 は 10° タイルの境（東北 140°E）に段差＝DEM10B を転写した焼き直し（"GEBCO 2026 + GSI DEM10B(JP)"）へ IDB を自己修復させる。
// node tests/elevation-stale.mjs
import { staleDSM } from "../src/elevation/createGetHeight.js";
let fails = 0;
const ok = (c, msg) => { if (!c) fails++; console.log(`${c ? "✓" : "✗"} ${msg}`); };
const dtm = { bbox: [122, 20, 154, 46], range: 1, brand: "GSI" };
ok(staleDSM("R01N038E139", { source: "ALOS AW3D30" }, dtm) === true, "R01 域内・旧 DSM＝失効");
ok(staleDSM("R01N038E139", { source: "GSI DEM10B" }, dtm) === false, "R01 域内・焼き直し済み＝信用");
ok(staleDSM("R01N038E139", {}, dtm) === true, "R01 域内・無記名＝失効");
ok(staleDSM("R01N050E000", { source: "ALOS AW3D30" }, dtm) === false, "R01 域外＝触らない");
ok(staleDSM("R10N030E130", { source: "GEBCO 2026" }, dtm) === true, "R10 域内・GEBCO だけ＝失効（10° 境の段差）");
ok(staleDSM("R10N030E130", { source: "GEBCO 2026 + GSI DEM10B(JP)" }, dtm) === false, "R10 域内・転写済み（銘を含む）＝信用");
ok(staleDSM("R10N030E150", { source: "GEBCO 2026 + GSI DEM10B(JP)" }, dtm) === false, "R10 域内・海だけのセルも同じ銘＝信用（毎セッション取り直さない）");
ok(staleDSM("R10N040E000", { source: "GEBCO 2026" }, dtm) === false, "R10 域外＝触らない");
ok(staleDSM("R90N000E090", { source: "GEBCO 2026" }, dtm) === false, "R90＝触らない");
ok(staleDSM("R10N030E130", { source: "GEBCO 2026" }, null) === false, "申告なし＝触らない");
console.log(fails ? `FAIL ${fails}` : "PASS");
process.exit(fails ? 1 : 0);
