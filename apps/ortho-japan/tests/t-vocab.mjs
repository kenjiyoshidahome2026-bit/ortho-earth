// ソースの語彙（style.schema）が、今と同じ判断を出すことを写し取る検定（2026-09-17）。
//
// なぜ要るか：建物の層名・種別コード→高さ・注記の分類属性は、エンジンの中に地理院の語彙として
// 直書きされていた。style の申告へ移した後も、①日本の style では以前と同じ値が使われ、
// ②申告を持たないソース（?pm= の任意アーカイブ）では従来どおり建物も分類も出ない、を固定する。
//
// ⚠ 訂正（2026-09-17）：この変更のコミット a0f968d の本文に「東京 z16 の実描画が変更前後で 1 画素も
// 違わない」と書いたが、**あれは誤り**。撮れていたのは起動待ち/WebGL2 起動失敗のカードで、地図は写って
// いなかった（虚時間＋--screenshot では worker の rAF が回らない・CDP 実時間でも /japan/ 本体は
// swiftshader で WebGL2 が立たず fatal カードになる）。よってこの変更を支えるのは下の 18 件と、
// verify:ui 22 頁・verify:prod の緑であって、画素比較ではない。z≥14 の建物が実際に立つ絵での確認は未了。
//
// 使い方: node tests/t-vocab.mjs
import { neededSourceLayers } from "ortho-core/decode";
import { buildBuildings } from "ortho-core";
import mono from "../style-mono.js";
import dark from "../style-dark.js";
import gsi from "../style-gsi.js";

let ok = 0, ng = 0;
const eq = (name, got, want) => {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { ok++; return; }
	ng++; console.error(`NG  ${name}\n    got  ${g}\n    want ${w}`);
};
const yes = (name, cond) => eq(name, !!cond, true);

// ── ① 申告の中身＝エンジンに書いてあった値と同一 ──────────────────────────
const B = mono.schema.buildings;
eq("建物の層名", B.layer, "BldA");
eq("種別→高さ（普通/堅ろう/高層/無壁舎）", [B.heightByCode[3101], B.heightByCode[3102], B.heightByCode[3103], B.heightByCode[3111]], [9, 16, 34, 5]);
eq("表に無い種別の既定高さ", B.defaultHeight, 10);
eq("地上レベルの属性", B.levelKey, "vt_lvorder");
eq("注記の分類コードの属性", mono.schema.labelCode, "vt_code");
eq("合成水域の名乗り", mono.schema.seaProps, { vt_code: 5101 });

// テーマ変換（色だけ入れ替える機械変換）を越えて申告が生き残る
eq("dark も同じ申告を持つ", dark.schema.buildings.heightByCode[3103], 34);
eq("gsi も同じ申告を持つ", gsi.schema.buildings.layer, "BldA");

// ── ② 復号の対象に建物層が入る ───────────────────────────────────────────
yes("申告された建物層が復号対象に入る", neededSourceLayers(mono).has("BldA"));
yes("申告が無ければ建物層は足されない", !neededSourceLayers({ layers: [], schema: undefined }).has("BldA"));
yes("style が参照する層はこれまで通り入る", neededSourceLayers(mono).has("Anno"));

// ── ③ 建物の押し出し ────────────────────────────────────────────────────
// タイル座標系の正方形 1 枚（extent 4096）。z=14 以上でだけ立つ。
const square = { coords: new Int32Array([100, 100, 900, 100, 900, 900, 100, 900, 100, 100]), ends: [10] };
const tile = code => ({ BldA: { extent: 4096, features: [{ type: "Polygon", id: 1, props: { vt_code: code, vt_lvorder: 0 }, geom: square }] } });
const call = (layers, schema, z = 15) => buildBuildings({ layers, z, x: 14552, y: 6451 }, [139, 36], schema);

yes("申告ありで建物が立つ", call(tile(3103), mono.schema));
eq("申告なしでは立たない（?pm= の道）", call(tile(3103), null), null);
eq("申告があっても z<14 では立たない", call(tile(3103), mono.schema, 13), null);
eq("申告された層が無いタイルでは立たない", call({ other: { extent: 4096, features: [] } }, mono.schema), null);

// 地上レベル以外は採らない（vt_lvorder が 0 でない＝地下・空中）
const under = { BldA: { extent: 4096, features: [{ type: "Polygon", id: 2, props: { vt_code: 3101, vt_lvorder: -1 }, geom: square }] } };
eq("地上レベル以外は採らない", call(under, mono.schema), null);

// 種別で高さが変わる＝高層(34m)は普通(9m)より頂点が高い（押し出し高は位置に焼かれる）
// pos は [経度差, 緯度差, 高さ] の三つ組＝高さは 3 番目の成分（単位球スケール）
const topY = b => { let m = -Infinity; for (let i = 2; i < b.pos.length; i += 3) m = Math.max(m, b.pos[i]); return m; };
const tall = call(tile(3103), mono.schema), low = call(tile(3101), mono.schema);
yes("高層は普通より高く押し出される", topY(tall) > topY(low));
const unknown = call(tile(9999), mono.schema);
yes("表に無い種別は既定高さ（普通 9m より高く 高層 34m より低い）", topY(unknown) > topY(low) && topY(unknown) < topY(tall));

console.log(ng ? `\nFAIL  ${ng} / ${ok + ng}` : `\nPASS  ${ok} 件すべて`);
process.exit(ng ? 1 : 0);
