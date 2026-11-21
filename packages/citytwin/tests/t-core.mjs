#!/usr/bin/env node
// 共有の芯（src/core.ts）の常設検定（Node だけ・外部網なし）＝市の設定を受け取る関数が、横浜でも京都でも同じに働くか。
// 細かい関数（歩ける道・タイル・地点調べ等）の検定は apps/yokohama/tests/t-yokohama.mjs（横浜の台帳で確かめる）、京都・福岡の設定は apps/kyoto/tests/t-kyoto.mjs・apps/fukuoka/tests/t-fukuoka.mjs。
// 3 市（横浜・京都・福岡）の設定ファイルも読み、
// 共有モジュールの約束（CityConfig）を満たしているかを並べて確かめる。
import { readFileSync, existsSync } from "node:fs";
import { wardOfAddress, sheltersIn, facilityIndex, parseState, writeState, subwayCodes, HAZARDS, TABS, FACILITY_CATS, parseExtras, extraText } from "../src/core.ts";
import { CITY as YK } from "../../../apps/yokohama/data.ts";
import { CITY as KT } from "../../../apps/kyoto/data.ts";
import { CITY as FK } from "../../../apps/fukuoka/data.ts";
import { CITY as AK } from "../../../apps/asahikawa/data.ts";
import { CITY as AS } from "../../../apps/asakura/data.ts";
import { CITY as KW } from "../../../apps/kawaba/data.ts";
import { CITY as KS } from "../../../apps/kusatsu/data.ts";
let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };

t("住所 → 区：市ごとの頭（横浜市／京都市）で引き、別の市の住所は当てない",
	wardOfAddress(YK, "神奈川県横浜市中区本町1")?.code === "14104" && wardOfAddress(KT, "京都府京都市中京区x")?.code === "26104" && wardOfAddress(YK, "京都市中京区x") === null && wardOfAddress(KT, "横浜市南区x") === null);
t("住所 → 区：福岡市（福岡県の頭つき）・別の市は当てない", wardOfAddress(FK, "福岡県福岡市早良区百道浜1")?.code === "40137" && wardOfAddress(FK, "北九州市小倉北区x") === null);
t("住所 → 区：区の無い市（旭川＝市そのもの 1 つ）は市の名で始まる住所を市に・別の市は当てない", wardOfAddress(AK, "北海道旭川市6条通9丁目46")?.code === "01204" && wardOfAddress(AK, "旭川市神楽3条6丁目")?.code === "01204" && wardOfAddress(AK, "北海道上川郡鷹栖町x") === null && wardOfAddress(AK, "札幌市中央区x") === null);
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
t("URL の状態：名所だけの URL は観光の面で開く・往復で同じ", (() => { const a = parseState(YK, "?spot=mm21"), w = writeState(YK, "", a), b = parseState(YK, "?tab=life&spot=mm21"); return a.tab === "sight" && w === "?spot=mm21" && b.tab === "life" && /tab=life/.test(writeState(YK, "", b)); })());
t("地下鉄の駅番号：市の路線表で引く", subwayCodes(YK.subway, "センター南").length === 2 && subwayCodes(KT.subway, "烏丸御池").length === 2 && subwayCodes(KT.subway, "関内").length === 0);
t("ハザードの型紙：全国の 4 つ", HAZARDS.map(h => h.id).join() === "flood,hightide,tsunami,dosha");
t("住所 → 市町村：町村は郡の名が挟まる（群馬県利根郡川場村…・吾妻郡草津町…）・隣の市町村は当てない", wardOfAddress(KW, "群馬県利根郡川場村大字谷地2390-2")?.code === "10444" && wardOfAddress(KW, "川場村谷地2402")?.code === "10444" && wardOfAddress(KS, "吾妻郡草津町大字草津28")?.code === "10426" && wardOfAddress(KW, "群馬県沼田市上原町1738-1") === null && wardOfAddress(KS, "群馬県吾妻郡長野原町大字長野原1520-4") === null && wardOfAddress(AS, "福岡県朝倉市菩提寺412-2")?.code === "40228" && wardOfAddress(AS, "福岡県朝倉郡筑前町x") === null);
const ALL = [YK, KT, FK, AK, AS, KW, KS];
for (const C of ALL) {
	const req = ["id", "key", "title", "cityName", "allWards", "outside", "addrPrefix", "bbox", "view", "maskBox", "wards", "spots", "tour", "tourIntro", "subway", "subwayName", "subwayNote", "busName", "transit", "railLinesEn", "hazards", "riskNote", "hinanUrl", "lod2Prefetch", "bldSets", "majorHospitals", "offlineMB"];
	t(`${C.id}：CityConfig の欄が揃う`, req.every(k => C[k] != null), req.filter(k => C[k] == null).join());
	t(`${C.id}：ツアーは名所の id・名所は区に属す`, C.tour.every(id => C.spots.some(s => s.id === id)) && C.spots.every(s => C.wards.some(w => w.code === s.ward)));
	t(`${C.id}：id と保存の鍵の頭が市ごとに違う`, ALL.every(o => o === C || (o.id !== C.id && o.key !== C.key)));
}
// 後から足す物（extras.json）
{
	const x = parseExtras({ spots: [
		{ id: "x-ok", name: { en: "New place", ja: "新しい名所", fr: "Nouveau lieu" }, note: { en: "Note" }, lon: 139.11, lat: 36.70, tour: true, photo: { src: "https://example.org/a.jpg", artist: "A", license: "CC BY 4.0" } },
		{ id: "denen-plaza", name: "dup", lon: 139.11, lat: 36.70 }, { id: "Bad Id", name: "x", lon: 139.11, lat: 36.70 }, { id: "far", name: "x", lon: 36.70, lat: 139.11 }, { id: "noname", lon: 139.11, lat: 36.70 },
	], layers: [
		{ id: "aed", name: { en: "AEDs", ja: "AED" }, color: "#d81b60", rows: [[139.105, 36.694, "役場", "谷地2390", "", "Village Office"], [0, 0, "壊れた行"]] },
		{ id: "trail", name: "Trails", file: "extra/trail.geojson" }, { id: "evil", name: "x", file: "../x.json" }, { id: "empty", name: "x" }, { id: "aed", name: "dup", rows: [[139.105, 36.694, "a"]] },
	] }, KW, "ja");
	t("extras：正しい名所だけ足す（id の重なり・悪い id・範囲の外・名前なしは飛ばす）", x.spots.map(s => s.id).join() === "x-ok" && x.spots[0].name === "新しい名所" && x.spots[0].ward === KW.wards[0].code && x.tour.join() === "x-ok" && x.photos["x-ok"]?.license === "CC BY 4.0", JSON.stringify(x.errors));
	t("extras：層は点の表か台帳の名・壊れた行と外へ出る名は飛ばす", x.layers.map(l => l.id).join() === "aed,trail" && x.layers[0].rows.length === 1 && x.layers[0].label === "AED" && x.layers[1].color === "#00897b" && x.errors.length === 8, `${x.errors.length} ${x.errors.join(" / ")}`);
	t("extras：言語は その言語 → 英語 → 日本語", extraText({ en: "E", ja: "J", fr: "F" }, "fr") === "F" && extraText({ en: "E", ja: "J" }, "de") === "E" && extraText({ en: "E" }, "ja") === "E" && extraText("S", "ko") === "S");
	t("extras：無い・壊れた＝何も足さない", parseExtras(null, KW, "ja").spots.length === 0 && parseExtras({ spots: "x", layers: 3 }, KW, "en").layers.length === 0);
	for (const C of ALL) {
		const f = new URL(`../../../ortho-data/japan/${C.id}/extras.json`, import.meta.url);
		const raw = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null, r = parseExtras(raw, C, "en");
		t(`${C.id}：extras.json が有り、誤りが無い（層の台帳も有る）`, !!raw && r.errors.length === 0 && r.layers.every(l => !l.file || existsSync(new URL(`../../../ortho-data/japan/${C.id}/${l.file}`, import.meta.url))), r.errors.join(" / "));
	}
}
const pages = JSON.parse(readFileSync(new URL("../i18n/pages/citytwin.json", import.meta.url), "utf8")).ui;
t("共通の辞書：施設の区分の名が全部ある", FACILITY_CATS.every(c => pages[c.name]?.ja || c.name in JSON.parse(readFileSync(new URL("../../globe/src/i18n/ui.json", import.meta.url), "utf8")).ui));
console.log(`\n${ng ? "✗" : "✓"} citytwin: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
