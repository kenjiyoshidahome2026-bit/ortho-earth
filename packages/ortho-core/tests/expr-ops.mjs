// 式の残り（C2・2026-10-12）＝within・distance・config・semiliteral・number-format の unit/currency・collator・interpolate-hcl/lab・pitch・distance-from-center。
// 期待値は MapLibre の意味（文書・color_spaces.ts）から。semiliteral は推定の意味（compat.md §4）
import { evalExpr, unknownOps, setGlobalState, KNOWN_OPS } from "../src/expr.ts";
import { featureGeomLL } from "../src/expr-geo.ts";

let fails = 0;
const ok = (name, cond, note = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); if (!cond) fails++; };
const ML = { zoom: 10, props: {}, vars: {}, origin: "ml" }, NA = { zoom: 10, props: {}, vars: {} };
const E = (e, c = ML) => evalExpr(e, c);
const G = g => ({ ...ML, geojson: g });
const rgb = s => s.match(/\d+(\.\d+)?/g).map(Number);

// ── within ──
const poly = { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] };
const holed = { type: "Feature", geometry: { type: "Polygon", coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]] } };
ok("within point inside", E(["within", poly], G({ type: "Point", coordinates: [5, 5] })) === true);
ok("within point on boundary = false", E(["within", poly], G({ type: "Point", coordinates: [10, 5] })) === false);
ok("within point outside", E(["within", poly], G({ type: "Point", coordinates: [15, 5] })) === false);
ok("within point in hole = false", E(["within", holed], G({ type: "Point", coordinates: [5, 5] })) === false);
ok("within line inside", E(["within", poly], G({ type: "LineString", coordinates: [[1, 1], [9, 9]] })) === true);
ok("within line crossing = false", E(["within", poly], G({ type: "LineString", coordinates: [[1, 1], [12, 9]] })) === false);
ok("within line touching boundary = false", E(["within", poly], G({ type: "LineString", coordinates: [[1, 1], [10, 5]] })) === false);
ok("within polygon feature = false", E(["within", poly], G({ type: "Polygon", coordinates: [[[1, 1], [2, 1], [2, 2], [1, 1]]] })) === false);
ok("within FeatureCollection of 2 polygons", E(["within", { type: "FeatureCollection", features: [{ type: "Feature", geometry: poly }, { type: "Feature", geometry: { type: "Polygon", coordinates: [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]] } }] }], G({ type: "Point", coordinates: [25, 25] })) === true);
ok("within without geometry = false", E(["within", poly], ML) === false);
// タイルの地物（フラット geom）→ 経緯度
const tile = { z: 14, x: 14553, y: 6450, E: 4096 }, pt = { type: "Point", geom: { coords: new Int32Array([2048, 2048]), ends: [2] } };
const ll = featureGeomLL({ feat: pt, tile });
ok("featureGeomLL tile point → lon/lat", ll.type === "Point" && Math.abs(ll.coordinates[0] - 139.76) < 0.05 && Math.abs(ll.coordinates[1] - 35.68) < 0.05, JSON.stringify(ll));
ok("within on tile feature", E(["within", { type: "Polygon", coordinates: [[[139, 35], [140, 35], [140, 36], [139, 36], [139, 35]]] }], { ...ML, feat: pt, tile }) === true);
const line = { type: "LineString", geom: { coords: new Int32Array([0, 0, 4096, 4096]), ends: [4] } };
ok("featureGeomLL tile line", featureGeomLL({ feat: line, tile }).type === "LineString" && featureGeomLL({ feat: line, tile }).coordinates.length === 2);

// ── distance（m）──
const d1 = E(["distance", { type: "Point", coordinates: [139.76, 35.68] }], G({ type: "Point", coordinates: [139.77, 35.68] }));
ok("distance point-point ≈ 903 m", Math.abs(d1 - 903) < 3, d1.toFixed(1));
ok("distance point in polygon = 0", E(["distance", poly], G({ type: "Point", coordinates: [5, 5] })) === 0);
const d2 = E(["distance", poly], G({ type: "Point", coordinates: [11, 5] }));
ok("distance point to polygon edge ≈ 1° ≈ 110.8 km", Math.abs(d2 - 110771) < 300, d2.toFixed(0));
const d3 = E(["distance", { type: "LineString", coordinates: [[0, 0], [0, 1]] }], G({ type: "Point", coordinates: [0.001, 0.5] }));
ok("distance point to line segment ≈ 111 m", Math.abs(d3 - 111.2) < 1, d3.toFixed(2));
const d4 = E(["distance", { type: "Point", coordinates: [0.001, 0.5] }], G({ type: "LineString", coordinates: [[0, 0], [0, 1]] }));
ok("distance line feature to point (symmetric)", Math.abs(d4 - d3) < 1e-6, d4.toFixed(2));
ok("distance polygon feature containing input point = 0", E(["distance", { type: "Point", coordinates: [5, 5] }], G(poly)) === 0);
ok("distance without geometry (ml) = evaluation error", E(["distance", poly], ML) === undefined);
ok("distance in filter via case", E(["case", ["<", ["distance", { type: "Point", coordinates: [0, 0] }], 1000], "near", "far"], G({ type: "Point", coordinates: [0, 0.005] })) === "near");

// ── config（global-state の別名）・semiliteral ──
setGlobalState({ k: 3, s: "x" });
ok("config reads global-state", E(["config", "k"]) === 3 && E(["config", "nope"]) === null);
ok("config prefers ctx.gs", E(["config", "k"], { ...ML, gs: { k: 7 } }) === 7);
ok("semiliteral evaluates nested expressions", JSON.stringify(E(["semiliteral", [1, ["+", 1, 2], { a: ["zoom"], b: ["x", "y"] }]])) === '[1,3,{"a":10,"b":["x","y"]}]');
ok("semiliteral plain object", JSON.stringify(E(["semiliteral", { n: ["get", "v"] }], { ...ML, props: { v: 5 } })) === '{"n":5}');

// ── number-format ──
ok("number-format unit", E(["number-format", 1234.5, { unit: "kilometer", "max-fraction-digits": 1, locale: "en-US" }]) === "1,234.5 km");
ok("number-format currency", /1,235/.test(E(["number-format", 1234.5, { currency: "JPY", locale: "ja-JP" }])));
ok("number-format fraction digits", E(["number-format", 3.14159, { "max-fraction-digits": 2, locale: "en-US" }]) === "3.14");
ok("number-format option as expression", E(["number-format", 2, { unit: ["get", "u"], locale: "en-US" }], { ...ML, props: { u: "meter" } }) === "2 m");
ok("number-format unknown unit does not throw", typeof E(["number-format", 2, { unit: "furlong-fortnight", locale: "en-US" }]) === "string");

// ── collator ──
ok("collator case-insensitive ==", E(["==", "a", "A", ["collator", { "case-sensitive": false }]]) === true);
ok("collator case-sensitive == false", E(["==", "a", "A", ["collator", { "case-sensitive": true }]]) === false);
ok("collator diacritic-insensitive", E(["==", "é", "e", ["collator", { "diacritic-sensitive": false }]]) === true && E(["==", "é", "e", ["collator", { "diacritic-sensitive": true }]]) === false);
ok("collator <, >=, !=", E(["<", "a", "b", ["collator", {}]]) === true && E([">=", "b", "a", ["collator", {}]]) === true && E(["!=", "a", "A", ["collator", { "case-sensitive": false }]]) === false);
ok("resolved-locale of collator", E(["resolved-locale", ["collator", { locale: "ja" }]]) === "ja");
ok("comparison without collator unchanged", E(["==", "a", "A"]) === false && E(["<", 1, 2]) === true && E(["<", 1, "2"]) === undefined);

// ── interpolate-lab / -hcl ──
const red2blue = sp => ["interpolate-" + sp, ["linear"], ["zoom"], 0, "#ff0000", 20, "#0000ff"];
ok("interpolate-lab endpoints exact", E(red2blue("lab"), { ...ML, zoom: 0 }) === "#ff0000" && E(red2blue("lab"), { ...ML, zoom: 20 }) === "#0000ff");
const lab = rgb(E(red2blue("lab"))), hcl = rgb(E(red2blue("hcl"))), lin = rgb(E(["interpolate", ["linear"], ["zoom"], 0, "#ff0000", 20, "#0000ff"]));
ok("interpolate-lab midpoint = MapLibre lab (202,0,136)", Math.abs(lab[0] - 202) <= 2 && lab[1] === 0 && Math.abs(lab[2] - 136) <= 2, lab.join());
ok("interpolate-hcl midpoint = MapLibre hcl (250,0,128)", Math.abs(hcl[0] - 250) <= 3 && hcl[1] === 0 && Math.abs(hcl[2] - 128) <= 3, hcl.join());
ok("rgb linear midpoint unchanged (128,0,128)", lin[0] === 128 && lin[2] === 128, lin.join());
const grey = rgb(E(["interpolate-hcl", ["linear"], ["zoom"], 0, "#808080", 20, "#ff0000"]));
ok("interpolate-hcl from grey takes partner hue", grey[0] > grey[1] && grey[0] > grey[2], grey.join());
ok("interpolate-lab alpha", rgb(E(["interpolate-lab", ["linear"], ["zoom"], 0, "rgba(255,0,0,0)", 20, "rgba(255,0,0,1)"]))[3] === 0.5);
ok("interpolate-lab numbers still linear", E(["interpolate-lab", ["linear"], ["zoom"], 0, 0, 20, 10]) === 5);
ok("native origin also uses lab", rgb(E(red2blue("lab"), NA))[0] === lab[0]);

// ── pitch・distance-from-center ──
ok("pitch from ctx", E(["pitch"], { ...ML, pitch: 45 }) === 45 && E(["pitch"]) === 0);
ok("distance-from-center from ctx", E(["distance-from-center"], { ...ML, dfc: -0.5 }) === -0.5 && E(["distance-from-center"]) === 0);

// ── unknownOps：GeoJSON・semiliteral の中身は式でない ──
ok("unknownOps skips within/distance/semiliteral payload", unknownOps(["all", ["within", { type: "Polygon", coordinates: [[["frob", 1]]] }], ["<", ["distance", { type: "Point", coordinates: [0, 0] }], 5], ["semiliteral", [["frob", 1]]]]).size === 0);
ok("KNOWN_OPS has the C2 ops", ["within", "distance", "config", "semiliteral", "pitch", "distance-from-center"].every(o => KNOWN_OPS.has(o)));

if (fails) { console.error(`✗ expr-ops ${fails} 件 FAIL`); process.exit(1); }
console.log("✓ expr-ops 全 PASS");
