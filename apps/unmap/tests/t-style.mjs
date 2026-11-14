// OSM（Protomaps v4）の style がエンジンの読み替え（core の mlstyle）で 1 層も落ちず・spec の警告も出ないこと
import { splitMapLibreStyle, validateMLStyle } from "../../../packages/ortho-core/src/mlstyle.ts";
import { osmStyle, nameExpr, NAME_LANGS, LABEL_LAYERS, isNameLang } from "../style.ts";

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

// 地名の言語（UN の 6 公用語＋現地語）
ok("地名の層＝LABEL_LAYERS（style の symbol と一致）", st.layers.filter(L => L.type === "symbol").map(L => L.id).join() === LABEL_LAYERS.join());
ok("既定＝現地語の name", st.layers.filter(L => L.type === "symbol").every(L => JSON.stringify(L.layout["text-field"]) === '["get","name"]'));
for (const l of NAME_LANGS) {
	const s2 = osmStyle("https://a/v4.pmtiles", l), iss = validateMLStyle(s2), sp = splitMapLibreStyle(s2);
	ok(`${l}：spec の警告なし・落ちる層なし`, iss.length === 0 && sp.skipped.length === 0, iss.map(i => i.message).join("; "));
}
ok("fr＝name:fr → name", JSON.stringify(nameExpr("fr")) === '["coalesce",["get","name:fr"],["get","name"]]');
ok("zh＝簡体字 → zh → name", JSON.stringify(nameExpr("zh")) === '["coalesce",["get","name:zh-Hans"],["get","name:zh"],["get","name"]]');
ok("isNameLang の門", isNameLang("ar") && isNameLang("local") && !isNameLang("ja") && !isNameLang(null));

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ t-style 全 PASS");
process.exit(fail ? 1 : 0);
