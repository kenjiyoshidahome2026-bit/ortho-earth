// 3D Tiles のスタイル（color・show）の純関数の検定（node・網なし）。MapLibre の式の評価と、束の頂点色の塗り直し（地物ごと・NaN＝元のまま）。
import { compileStyle, paintBatch } from "../src/tiles3d-style.ts";
import { NO_FEATURE } from "../src/mesh-features.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const x = (props, id = null, state = null) => ({ props, id, state });

ok("無し＝null", compileStyle(null) === null && compileStyle({}) === null);
const s = compileStyle({ color: ["case", [">", ["get", "height"], 50], "#ff0000", ["rgba", 0, 0, 255, 0.5]], show: ["!=", ["get", "kind"], "tree"] });
ok("color＝CSS 色", JSON.stringify(s.color(x({ height: 60 }))) === "[255,0,0,255]");
ok("color＝rgba（α 0.5）", JSON.stringify(s.color(x({ height: 10 }))) === "[0,0,255,128]");
ok("show", s.show(x({ kind: "tree" })) === false && s.show(x({ kind: "house" })) === true);
const sid = compileStyle({ color: ["case", ["==", ["id"], 2], "#00ff00", ["boolean", ["feature-state", "hot"], false], "#ffffff", null] });
ok("id・feature-state・null＝元のまま", JSON.stringify(sid.color(x({}, 2))) === "[0,255,0,255]" && JSON.stringify(sid.color(x({}, 1, { hot: true }))) === "[255,255,255,255]" && sid.color(x({}, 1)) === null);
const bad = compileStyle({ color: ["+", ["get", "a"], 1], show: ["get", "missing"] });
ok("色に読めない・値が無い＝元のまま・見せる", bad.color(x({ a: "s" })) === null && bad.show(x({})) === true);
const nat = compileStyle({ color: ["case", ["get", "flag"], "#ff0000", "#000000"], origin: "native" });
ok("native＝寛容（数を真偽に）", JSON.stringify(nat.color(x({ flag: 1 }))) === "[255,0,0,255]");

const col0 = new Uint8Array([10, 10, 10, 200, 20, 20, 20, 200, 30, 30, 30, 200, 40, 40, 40, 200]);
const ids = new Uint32Array([0, 0, 1, NO_FEATURE]), seen = [];
const out = paintBatch(col0, ids, () => 0, (id, t) => { seen.push(`${id}:${t}`); return id === 0 ? [255, 0, 0, NaN] : id === 1 ? [NaN, NaN, NaN, 0] : null; });
ok("paintBatch＝地物ごと・NaN＝元のまま・null＝そのまま", out.join() === "255,0,0,200,255,0,0,200,30,30,30,0,40,40,40,200" && col0[0] === 10, out.join());
ok("paintBatch＝同じ地物が続けば 1 回・NO_FEATURE は (null,null)", seen.join(" ") === "0:0 1:0 null:null", seen.join(" "));
ok("paintBatch＝地物が無い束は 1 回で全部", paintBatch(col0, null, () => null, () => [1, 2, 3, 4]).join() === "1,2,3,4,1,2,3,4,1,2,3,4,1,2,3,4");

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ tiles3d-style 全 PASS");
process.exit(fail ? 1 : 0);
