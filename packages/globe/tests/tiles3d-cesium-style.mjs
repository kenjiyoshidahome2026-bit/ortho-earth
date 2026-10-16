// Cesium の 3D Tiles Styling → MapLibre の式の訳の検定（node・網なし）。訳した式を tiles3d-style の compileStyle で評価して、Cesium の意味どおりの色・真偽になるか。
import { isCesiumStyle, cesiumToSpec, parseExpr } from "../src/tiles3d-cesium-style.ts";
import { compileStyle } from "../src/tiles3d-style.ts";
import { evalExpr } from "@ortho-earth/core";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const throws = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };
const ev = (src, props = {}) => evalExpr(parseExpr(src), { props, origin: "native" });
const col = (style, props = {}) => compileStyle(cesiumToSpec(style)).color({ props, id: null, state: null });
const show = (style, props = {}) => compileStyle(cesiumToSpec(style)).show({ props, id: null, state: null });

ok("isCesiumStyle", isCesiumStyle({ color: "color('red')" }) && isCesiumStyle({ show: { conditions: [] } }) && isCesiumStyle({ defines: {} })
	&& !isCesiumStyle({ color: ["get", "c"] }) && !isCesiumStyle({ show: true }) && !isCesiumStyle(null));
// 式
ok("算術と優先順位", ev("1 + 2 * 3 - 4 / 2") === 5 && ev("(1 + 2) * 3") === 9 && ev("7 % 4") === 3 && ev("-2 * -3") === 6 && ev("2 * -${a}", { a: 4 }) === -8);
ok("比較・論理", ev("${a} > 1 && ${a} <= 3", { a: 2 }) === true && ev("${a} === 'x' || ${b}", { a: "y", b: false }) === false && ev("!(${a} != 2)", { a: 2 }) === true);
ok("三項（右結合）", ev("${a} > 10 ? 'big' : ${a} > 5 ? 'mid' : 'small'", { a: 7 }) === "mid");
ok("文字列の連結", ev("'id-' + ${n}", { n: 3 }) === "id-3" && ev("\"a\\\"b\"") === 'a"b');
ok("${feature['名']}", ev("${feature['the name']}", { "the name": "x" }) === "x" && ev("${feature.h}", { h: 5 }) === 5);
ok("Math 系", ev("abs(-2) + sqrt(16) + floor(1.7) + ceil(1.2) + round(1.5)") === 2 + 4 + 1 + 2 + 2 && Math.abs(ev("pow(2, 10) + exp2(3) + log2(8) + log(exp(2))") - (1024 + 8 + 3 + 2)) < 1e-9);
ok("clamp・mix・sign・fract", ev("clamp(${a}, 0, 10)", { a: 15 }) === 10 && ev("mix(0, 10, 0.25)") === 2.5 && ev("sign(-3)") === -1 && Math.abs(ev("fract(2.75)") - 0.75) < 1e-12);
ok("radians・degrees・atan2・Math.PI", Math.abs(ev("degrees(radians(90))") - 90) < 1e-9 && Math.abs(ev("atan2(1, -1)") - Math.atan2(1, -1)) < 1e-12 && Math.abs(ev("atan2(-1, 0)") + Math.PI / 2) < 1e-12 && Math.abs(ev("Math.PI") - Math.PI) < 1e-12);
ok("Boolean・Number・String・isNaN・isFinite", ev("Boolean(0)") === false && ev("Number('3') + 1") === 4 && ev("String(3) + 'a'") === "3a" && ev("isNaN(${a})", { a: "x" }) === true && ev("isFinite(1 / 0)") === false && ev("isFinite(2)") === true);
ok("null・undefined・true／false", ev("${a} === null", { a: null }) === true && ev("undefined") === null && ev("true && false") === false);
ok("訳せない物＝例外", throws(() => parseExpr("regExp('a').test(${x})"), /regExp/) && throws(() => parseExpr("${a} +"), /途中/) && throws(() => parseExpr("vec3(1)"), /vec3/) && throws(() => parseExpr("1 2"), /余計/) && throws(() => parseExpr("'abc"), /閉じて/));
// 色
ok("color(名)", JSON.stringify(col({ color: "color('red')" })) === "[255,0,0,255]" && JSON.stringify(col({ color: "color()" })) === "[255,255,255,255]");
ok("color(名, α)", JSON.stringify(col({ color: "color('#0000ff', 0.5)" })) === "[0,0,255,128]");
ok("color(式, α)", JSON.stringify(col({ color: "color(${c}, 0.5)" }, { c: "lime" })) === "[0,255,0,128]", JSON.stringify(col({ color: "color(${c}, 0.5)" }, { c: "lime" })));
ok("rgb・rgba・hsl", JSON.stringify(col({ color: "rgb(255, ${g}, 0)" }, { g: 128 })) === "[255,128,0,255]" && JSON.stringify(col({ color: "rgba(0, 0, 0, 0.25)" })) === "[0,0,0,64]"
	&& JSON.stringify(col({ color: "hsl(0.0, 1.0, 0.5)" })) === "[255,0,0,255]", JSON.stringify(col({ color: "hsl(0.0, 1.0, 0.5)" })));
// conditions・defines・show
const cond = { color: { conditions: [["${height} >= 100", "color('purple')"], ["${height} >= 50", "color('red')"], ["true", "color('white')"]] } };
ok("conditions", JSON.stringify(col(cond, { height: 120 })) === "[128,0,128,255]" && JSON.stringify(col(cond, { height: 60 })) === "[255,0,0,255]" && JSON.stringify(col(cond, { height: 1 })) === "[255,255,255,255]");
ok("conditions＝どれにも当たらない＝元のまま", col({ color: { conditions: [["${h} > 1", "color('red')"]] } }, { h: 0 }) === null);
const def = { defines: { tall: "${height} * 2", veryTall: "${tall} > 100" }, color: "${veryTall} ? color('red') : color('blue')", show: "${tall} > 10" };
ok("defines（defines から defines）", JSON.stringify(col(def, { height: 60 })) === "[255,0,0,255]" && JSON.stringify(col(def, { height: 30 })) === "[0,0,255,255]" && show(def, { height: 2 }) === false && show(def, { height: 6 }) === true);
ok("defines の循環＝例外", throws(() => cesiumToSpec({ defines: { a: "${b}", b: "${a}" }, show: "${a}" }), /循環/));
ok("show＝真偽そのまま", cesiumToSpec({ show: false }).show === false && show({ show: "${kind} !== 'tree'" }, { kind: "tree" }) === false);

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ tiles3d-cesium-style 全 PASS");
process.exit(fail ? 1 : 0);
