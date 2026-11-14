// OSM（Protomaps v4）の style がエンジンの読み替え（core の mlstyle）で 1 層も落ちず・spec の警告も出ないこと
import { splitMapLibreStyle, validateMLStyle } from "../../../packages/ortho-core/src/mlstyle.ts";
import { osmStyle } from "../style.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };

const st = osmStyle("https://a/v4.pmtiles");
ok("source＝pmtiles:// のベクタ 1 つ", Object.keys(st.sources).length === 1 && st.sources.osm.type === "vector" && st.sources.osm.url === "pmtiles://https://a/v4.pmtiles");
const issues = validateMLStyle(st);
ok("MapLibre の style spec の警告なし", issues.length === 0, issues.map(i => `${i.layer}: ${i.message}`).join("; "));
const split = splitMapLibreStyle(st);
ok("基図の source＝osm", split.vectorSource === "osm");
ok("描かない層なし", split.skipped.length === 0, split.skipped.map(k => `${k.id} (${k.why})`).join(", "));
ok("破線を使わない（地図の掟）", !st.layers.some(L => L.paint?.["line-dasharray"]));
const ids = st.layers.map(L => L.id);
ok("層の id は一意", new Set(ids).size === ids.length);
for (const v of ["earth", "water", "roads", "boundaries", "places", "buildings", "landcover", "landuse"]) ok(`v4 の層 ${v} を読む`, st.layers.some(L => L["source-layer"] === v));

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ t-style 全 PASS");
process.exit(fail ? 1 : 0);
