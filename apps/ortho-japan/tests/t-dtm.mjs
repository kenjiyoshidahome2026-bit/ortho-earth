// 裸地標高(DTM)の申告が、今と同じ判断を出すことを写し取る検定（2026-09-17）。
//
// なぜ要るか：この二つの判断は、これまでコードの中に日本として直書きされていて、常設の門が無かった。
//   ① 失効判定 staleDSM … どのキャッシュを捨てて bucket を見直すか。間違うと全国のキャッシュが飛ぶか、
//      逆に古い表層標高が永久に生き残る（東新橋の屋上斜面の型）。
//   ② 接地リフト clipToDTM … 建物を地面に載せてよい域。間違うと屋根が斜面に裂けるか、建物が浮く。
// 申告を外に出した後も、日本の申告を渡せば**以前と同じ答え**になることを固定する。
//
// 使い方: node tests/t-dtm.mjs
import { staleDSM } from "altpbf/loader";
import { clipToDTM } from "@ortho-earth/core/terrain";
import { JP_DTM } from "../jp/dtm.js";

let ok = 0, ng = 0;
const eq = (name, got, want) => {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g === w) { ok++; return; }
	ng++; console.error(`NG  ${name}\n    got  ${g}\n    want ${w}`);
};

// ── ① 失効判定 ──────────────────────────────────────────────────────────
// 名前は altpbf の規約（R{段}{N/S}緯度{E/W}経度）。東京 R01 = R01N035E139。
const TOKYO = "R01N035E139", SEOUL = "R01N037E126", DELFT = "R01N051E004", TOKYO90 = "R90N000E120";

eq("焼き直し済み（GSI 銘）は信用する", staleDSM(TOKYO, { source: "GSI DEM10B" }, JP_DTM), false);
eq("域内の無記名は失効させる", staleDSM(TOKYO, { source: undefined }, JP_DTM), true);
eq("域内の旧 ALOS 明記も失効させる", staleDSM(TOKYO, { source: "ALOS AW3D30" }, JP_DTM), true);
eq("域内の noBake 付きも失効させる", staleDSM(TOKYO, { source: "ALOS AW3D30", noBake: 1 }, JP_DTM), true);
eq("箱の中の外国（ソウル）も同じ扱い", staleDSM(SEOUL, { source: "ALOS AW3D30" }, JP_DTM), true);
eq("箱の外（デルフト）は触らない", staleDSM(DELFT, { source: "ALOS AW3D30" }, JP_DTM), false);
eq("段が違えば触らない（R90）", staleDSM(TOKYO90, { source: "GEBCO" }, JP_DTM), false);
eq("中身が無ければ false", staleDSM(TOKYO, null, JP_DTM), false);
eq("申告が無ければ何も失効しない", staleDSM(TOKYO, { source: "ALOS AW3D30" }, null), false);

// ── ② 接地リフトの域 ────────────────────────────────────────────────────
const JP = JP_DTM.bbox;
eq("日本のど真ん中の窓はそのまま通る", clipToDTM([138, 34, 4, 4], JP), [138, 34, 4, 4]);
eq("西へはみ出す窓は箱の縁で切る", clipToDTM([120, 34, 4, 4], JP), [122, 34, 2, 4]);
eq("東へはみ出す窓も切る", clipToDTM([152, 34, 4, 4], JP), [152, 34, 2, 4]);
eq("北へはみ出す窓も切る", clipToDTM([138, 44, 4, 4], JP), [138, 44, 4, 2]);
eq("箱の外（オランダ）は null＝リフトしない", clipToDTM([3, 51, 3, 3], JP), null);
eq("窓が無ければ null（R10/R90 窓）", clipToDTM(null, JP), null);
eq("申告が無ければ null＝保証が無いのでリフトしない", clipToDTM([138, 34, 4, 4], null), null);
eq("接するだけ（面積ゼロ）は null", clipToDTM([118, 34, 4, 4], JP), null);

// ── ③ 申告そのもの ─────────────────────────────────────────────────────
eq("申告の箱は焼き対象と同じ数字", JP_DTM.bbox, [122, 20, 154, 46]);
eq("申告の段は R01", JP_DTM.range, 1);
eq("申告の銘は GSI", JP_DTM.brand, "GSI");

console.log(ng ? `\nFAIL  ${ng} / ${ok + ng}` : `\nPASS  ${ok} 件すべて`);
process.exit(ng ? 1 : 0);
