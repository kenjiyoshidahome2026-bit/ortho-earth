// 軽い標高（?elevcheap・LOW_MEM）のシェーダ特化（wgsl.ts elevCheapWgsl・2026-11-07）：`if (F.ellP.z > 0.5) { A } else { B }` を A だけに。
// Galaxy/Mali のコールドコンパイル（線の VS 2〜4 s）を短くする＝両枝を持たない。F.ellP.z は uniform＝絵は変わらない。
import { elevCheapWgsl, elevCheapWgslN, LINE_WGSL, BUILDING_WGSL, MESH_WGSL, FILL_WGSL, GLOBE_WGSL, TERRAIN_WGSL, LINE_SH_WGSL, LINE_CLIP_WGSL, lineXWgsl } from "../src/gpu/wgsl.ts";

let fail = 0;
const ok = (name, cond) => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}`); };

const src = "a;\n\tif (F.ellP.z > 0.5) { x = elev1(p); } else { x = elevQ(p); }\n\tb;";
ok("A だけ残る（ブロックのまま）", elevCheapWgsl(src) === "a;\n\t{ x = elev1(p); }\n\tb;");
ok("入れ子の if（建物メッシュ）も内側だけ置き換わる", elevCheapWgsl("if (B.alpha.z < 0.5) { if (F.ellP.z > 0.5) { hE = elev1(q); } else { hE = elev(q); } }") === "if (B.alpha.z < 0.5) { { hE = elev1(q); } }");
ok("2 回掛けても同じ（冪等）", elevCheapWgsl(elevCheapWgsl(src)) === elevCheapWgsl(src));
ok("印の無いコードは無変更", elevCheapWgsl(FILL_WGSL) === FILL_WGSL && elevCheapWgsl(GLOBE_WGSL) === GLOBE_WGSL && elevCheapWgsl(TERRAIN_WGSL) === TERRAIN_WGSL);

// 本物のシェーダ：ellP.z の if が全部置き換わり（残り 0）、elevQ 側の呼び出しが減る
for (const [name, code] of [["LINE_WGSL", LINE_WGSL], ["LINE_X", lineXWgsl(LINE_WGSL, "LINE_X")], ["LINE_SH_WGSL", LINE_SH_WGSL], ["LINE_CLIP_WGSL", LINE_CLIP_WGSL], ["BUILDING_WGSL", BUILDING_WGSL], ["MESH_WGSL", MESH_WGSL]]) {
	const n = elevCheapWgslN(code), out = elevCheapWgsl(code);
	ok(`${name}: 印 ${n} 個 → 残り 0・F.ellP.z の分岐が消える`, n >= 1 && elevCheapWgslN(out) === 0 && !out.includes("F.ellP.z > 0.5") && out.length < code.length);
}
const lineOut = elevCheapWgsl(LINE_WGSL);
ok("線：elevQ は ha/hb の 2 回だけ残る（余白の 3 回は elev1）", (lineOut.match(/elevQ\(/g) || []).length === (LINE_WGSL.match(/elevQ\(/g) || []).length - 3 && (lineOut.match(/elev1\(/g) || []).length === (LINE_WGSL.match(/elev1\(/g) || []).length);
ok("建物：elevQ の呼び出しが消える", !/elevQ\(F\.origin/.test(elevCheapWgsl(BUILDING_WGSL)));
// 書式の見張り：原本の if は必ず「1 行・入れ子無し」で書く（この正規表現が拾える形）＝ellP.z を見る if は全部拾える
for (const [name, code] of [["LINE_WGSL", LINE_WGSL], ["BUILDING_WGSL", BUILDING_WGSL], ["MESH_WGSL", MESH_WGSL]]) ok(`${name}: ellP.z を見る if の数 ＝ 置き換えた数`, (code.match(/if \(F\.ellP\.z/g) || []).length === elevCheapWgslN(code));

if (fail) { console.error(`${fail} FAIL`); process.exit(1); }
console.log("wgsl-elevcheap OK");
