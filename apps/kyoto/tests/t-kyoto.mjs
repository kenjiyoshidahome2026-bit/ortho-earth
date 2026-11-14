#!/usr/bin/env node
// data.ts の常設検定（Node だけ・外部網なし）＝京都の市の設定（区・名所・ツアー・地下鉄の駅番号・物語・救急・URL の状態）が共有モジュールの約束に合っているか。
// 共有の芯（packages/citytwin/src/core.ts）の関数の検定は横浜の tests/t-yokohama.mjs と packages/citytwin/tests/t-core.mjs が持つ。
import { readFileSync } from "node:fs";
import { CITY, WARDS, SPOTS, TOUR, HAZARDS, CITY_BBOX, SUBWAY, TRANSIT, KYOTO_STORY, HILL_VIEWS, NIGHT_CENTERS, MAJOR_HOSPITALS, BLD_SETS, LOD2_PREFETCH, RAIL_LINES_EN,
	subwayCodes, wardOfAddress, parseState, writeState, parsePlaces, kyotoShelters, majorHospital, railLinesEn, TABS } from "../data.ts";
let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const inCity = (lon, lat) => lon >= CITY_BBOX[0] && lon <= CITY_BBOX[2] && lat >= CITY_BBOX[1] && lat <= CITY_BBOX[3];

t("区：11 区・コードは 26101〜26111 の連番", WARDS.length === 11 && WARDS.every((w, i) => w.code === String(26101 + i)), WARDS.map(w => w.code).join());
t("区：名前は「区」で終わり重複しない", WARDS.every(w => w.name.endsWith("区")) && new Set(WARDS.map(w => w.name)).size === 11);
t("区・名所・物語：座標は京都市の外接矩形の中", [...WARDS, ...SPOTS, ...KYOTO_STORY, ...NIGHT_CENTERS].every(p => inCity(p.lon, p.lat)));
t("名所：id は重複しない・区は 11 区のどれか", new Set(SPOTS.map(s => s.id)).size === SPOTS.length && SPOTS.every(s => WARDS.some(w => w.code === s.ward)));
t("名所：note は文で終わる・名前は英語（ASCII）", SPOTS.every(s => /[.)]$/.test(s.note) && /^[\x20-\x7e]+$/.test(s.name)));
t("ツアー：全部が名所の id・重複なし", TOUR.every(id => SPOTS.some(s => s.id === id)) && new Set(TOUR).size === TOUR.length);
t("物語：年の順・写真の id は名所にある", KYOTO_STORY.every((c, i) => i === 0 || +c.year > +KYOTO_STORY[i - 1].year) && KYOTO_STORY.every(c => !c.photo || SPOTS.some(s => s.id === c.photo)));
t("物語：眺めは 3 つ・傾きは 70° 以上", HILL_VIEWS.length === 3 && HILL_VIEWS.every(v => v.tilt >= 70 && inCity(v.lon, v.lat)));
t("地下鉄：烏丸線 15 駅（K01 国際会館〜K15 竹田）・東西線 17 駅（T01 六地蔵〜T17 太秦天神川）",
	SUBWAY[0].stations.length === 15 && SUBWAY[1].stations.length === 17 && SUBWAY.every(l => l.romaji.length === l.stations.length));
t("地下鉄：京都＝K11・二条＝T15", subwayCodes("京都")[0]?.code === "K11" && subwayCodes("二条")[0]?.code === "T15");
t("地下鉄：烏丸御池は乗換（K08・T13）", subwayCodes("烏丸御池").map(c => c.code).join() === "K08,T13");
t("地下鉄：松ケ崎（台帳の字）も松ヶ崎に当たる", subwayCodes("松ケ崎")[0]?.code === "K02");
t("地下鉄の色：N02 の路線名で分ける", CITY.subwayColor("東西線") === SUBWAY[1].color && CITY.subwayColor("烏丸線") === SUBWAY[0].color);
t("地下鉄の路線：rail.json の「京都市 烏丸線」に当たる", CITY.subwayRail.test("京都市 烏丸線") && CITY.subwayRail.test("京都市 東西線") && !CITY.subwayRail.test("京阪電気鉄道 京阪本線"));
t("路線の英語：烏丸線＝Karasuma Line・知らない線はそのまま", railLinesEn("京都市 烏丸線") === "Karasuma Line" && Object.keys(RAIL_LINES_EN).length >= 15);
t("交通の層：地下鉄・鉄道・バス", TRANSIT.map(x => x.id).join() === "subway,rail,bus");
t("災害：海の無い京都＝洪水と土砂だけ", HAZARDS.map(h => h.id).join() === "flood,dosha");
t("住所 → 区：京都市中京区… → 中京区", wardOfAddress("京都市中京区寺町通御池上る上本能寺前町488")?.code === "26104" && wardOfAddress("横浜市中区本町1")?.code === undefined);
t("避難場所：京都市の行だけ", kyotoShelters([[135.76, 35.0, "A", "京都市左京区x", 1], [135.8, 34.9, "B", "宇治市y", 1]]).length === 1);
t("大きな病院：台帳の名に含まれる語で引く", majorHospital("京都市立病院") === "京都市立病院" && majorHospital("洛和会音羽病院") === "洛和会音羽病院" && majorHospital("某医院") === null && MAJOR_HOSPITALS.length === 8);
t("急病：市の診療所 1 か所・夜間の見出しと時間・#7119", NIGHT_CENTERS.length === 1 && !!CITY.emergency?.night?.label && /Call ahead/.test(CITY.emergency.night.hours) && CITY.emergency.advice?.tel === "#7119" && !CITY.emergency.holiday);
t("建物：11 区＋橋梁・先読みは登録簿の名前", BLD_SETS.length === 12 && LOD2_PREFETCH.every(n => BLD_SETS.includes(n)));
const sets = JSON.parse(readFileSync(new URL("../../../packages/jp/assets/plateau-sets.json", import.meta.url), "utf8")).map(s => s.name);
t("建物：登録簿（plateau-sets.json）に全部ある", BLD_SETS.every(n => sets.includes(n)), BLD_SETS.filter(n => !sets.includes(n)).join());
t("建物：区の名 → 中京・東山は橋梁も", CITY.bldNames("26104").includes("京都市（橋梁）") && CITY.bldNames("26101").join() === "京都北区");
const st = parseState("?tab=risk&hz=flood,tsunami&ward=26104&spot=kiyomizu&tr=subway");
t("URL の状態：京都に無い津波は捨てる・区と名所は読む", st.tab === "risk" && st.hz.join() === "flood" && st.ward === "26104" && st.spot === "kiyomizu" && st.tr.join() === "subway");
t("URL の状態：往復", parseState(writeState("", st)).ward === "26104" && TABS.includes(parseState("?tab=nope").tab));
t("保存した地点：市の外は捨てる", parsePlaces(JSON.stringify([{ n: "家", at: [135.76, 35.0] }, { n: "横浜", at: [139.6, 35.4] }])).length === 1);
const dict = JSON.parse(readFileSync(new URL("../i18n/pages/kyoto.json", import.meta.url), "utf8")).ui;
const keys = [CITY.title, CITY.allWards, CITY.outside, CITY.tourIntro, ...WARDS.map(w => w.en), ...SPOTS.flatMap(s => [s.name, s.note]), ...KYOTO_STORY.flatMap(c => [c.name, c.note]), CITY.story.button, ...CITY.story.viewsCaption, CITY.subwayNote, CITY.riskNote, CITY.emergency.night.hours, CITY.emergency.night.label];
t("26 言語：画面に出る京都の文は全部辞書にある（ja も）", keys.every(k => dict[k]?.ja), keys.filter(k => !dict[k]?.ja).join(" | "));
console.log(`\n${ng ? "✗" : "✓"} kyoto: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
