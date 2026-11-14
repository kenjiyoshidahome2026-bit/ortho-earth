#!/usr/bin/env node
// 共有の芯（src/core.ts）の常設検定（Node だけ・外部網なし）＝市の設定を受け取る関数が、横浜でも京都でも同じに働くか。
// 細かい関数（歩ける道・タイル・地点調べ等）の検定は apps/yokohama/tests/t-yokohama.mjs（横浜の台帳で確かめる）、京都の設定は apps/kyoto/tests/t-kyoto.mjs。
// 両市の設定ファイルも読み、共有モジュールの約束（CityConfig）を満たしているかを並べて確かめる。
import { readFileSync } from "node:fs";
import { wardOfAddress, sheltersIn, facilityIndex, parseState, writeState, subwayCodes, HAZARDS, TABS, FACILITY_CATS } from "../src/core.ts";
import { CITY as YK } from "../../../apps/yokohama/data.ts";
import { CITY as KT } from "../../../apps/kyoto/data.ts";
let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };

t("住所 → 区：市ごとの頭（横浜市／京都市）で引き、別の市の住所は当てない",
	wardOfAddress(YK, "神奈川県横浜市中区本町1")?.code === "14104" && wardOfAddress(KT, "京都府京都市中京区x")?.code === "26104" && wardOfAddress(YK, "京都市中京区x") === null && wardOfAddress(KT, "横浜市南区x") === null);
t("住所 → 区：ヶ／ケの揺れ（保土ヶ谷区）", wardOfAddress(YK, "横浜市保土ヶ谷区天王町1")?.code === "14106");
const rows = [[139.6, 35.4, "a", "横浜市中区1", 1], [135.7, 35.0, "b", "京都市北区1", 1], [135.7, 35.0, "c", "京都府宇治市", 1], ["x", 1, "d", "京都市", 1]];
t("避難場所：市の名を含む行だけ・座標の壊れた行は捨てる", sheltersIn(rows, "京都市").map(r => r[2]).join() === "b" && sheltersIn(rows, "横浜市").map(r => r[2]).join() === "a");
const fac = [[0, 0, "区役所", 0, "京都市北区x", "区役所"], [0, 0, "図書館", 3, "京都市中京区y", "図書館"], [0, 0, "y", 3, "横浜市中区", "図書館"]];
const all = new Set(Array.from({ length: 64 }, (_, i) => i));
t("施設の検索：区で絞る（区なし＝全部）", facilityIndex(KT, fac, "26104", all).join() === "1" && facilityIndex(KT, fac, "", all).length === 3);
const s1 = parseState(KT, "?hz=flood,hightide,tsunami,dosha"), s2 = parseState(YK, "?hz=flood,hightide,tsunami,dosha");
t("URL の状態：市の想定に無いハザードは捨てる（京都＝高潮・津波なし）", s1.hz.join() === "flood,dosha" && s2.hz.join() === "flood,hightide,tsunami,dosha");
t("URL の状態：別の市の区・名所は捨てる", parseState(KT, "?ward=14104&spot=mm21").ward === "" && parseState(YK, "?ward=14104&spot=mm21").spot === "mm21");
t("URL の状態：既定の面（暮らし）は書かない", !/tab=/.test(writeState(KT, "", { ...parseState(KT, ""), tab: TABS[0] })));
t("地下鉄の駅番号：市の路線表で引く", subwayCodes(YK.subway, "センター南").length === 2 && subwayCodes(KT.subway, "烏丸御池").length === 2 && subwayCodes(KT.subway, "関内").length === 0);
t("ハザードの型紙：全国の 4 つ", HAZARDS.map(h => h.id).join() === "flood,hightide,tsunami,dosha");
for (const C of [YK, KT]) {
	const req = ["id", "key", "title", "cityName", "allWards", "outside", "addrPrefix", "bbox", "view", "maskBox", "wards", "spots", "tour", "tourIntro", "subway", "subwayName", "subwayNote", "busName", "transit", "railLinesEn", "hazards", "riskNote", "hinanUrl", "lod2Prefetch", "bldSets", "majorHospitals", "offlineMB"];
	t(`${C.id}：CityConfig の欄が揃う`, req.every(k => C[k] != null), req.filter(k => C[k] == null).join());
	t(`${C.id}：ツアーは名所の id・名所は区に属す`, C.tour.every(id => C.spots.some(s => s.id === id)) && C.spots.every(s => C.wards.some(w => w.code === s.ward)));
	t(`${C.id}：id と保存の鍵の頭が市ごとに違う`, C.id !== (C === YK ? KT : YK).id && C.key !== (C === YK ? KT : YK).key);
}
const pages = JSON.parse(readFileSync(new URL("../i18n/pages/citytwin.json", import.meta.url), "utf8")).ui;
t("共通の辞書：施設の区分の名が全部ある", FACILITY_CATS.every(c => pages[c.name]?.ja || c.name in JSON.parse(readFileSync(new URL("../../globe/src/i18n/ui.json", import.meta.url), "utf8")).ui));
console.log(`\n${ng ? "✗" : "✓"} citytwin: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
