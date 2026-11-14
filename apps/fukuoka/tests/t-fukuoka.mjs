#!/usr/bin/env node
// data.ts の常設検定（Node だけ・外部網なし）＝福岡の市の設定（区・名所・ツアー・地下鉄の駅番号・物語・救急・URL の状態）が共有モジュールの約束に合っているか。
// 共有の芯（packages/citytwin/src/core.ts）の関数の検定は横浜の tests/t-yokohama.mjs と packages/citytwin/tests/t-core.mjs が持つ。
import { readFileSync } from "node:fs";
import { CITY, WARDS, SPOTS, TOUR, HAZARDS, CITY_BBOX, SUBWAY, TRANSIT, FUKUOKA_STORY, BAY_VIEWS, NIGHT_CENTERS, MAJOR_HOSPITALS, BLD_SETS, LOD2_PREFETCH, RAIL_LINES_EN,
	FIT_BOX, subwayCodes, wardOfAddress, parseState, writeState, parsePlaces, fukuokaShelters, majorHospital, railLinesEn, TABS } from "../data.ts";
let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const inCity = (lon, lat) => lon >= CITY_BBOX[0] && lon <= CITY_BBOX[2] && lat >= CITY_BBOX[1] && lat <= CITY_BBOX[3];

t("区：7 区・コードは 40131〜40137 の連番", WARDS.length === 7 && WARDS.every((w, i) => w.code === String(40131 + i)), WARDS.map(w => w.code).join());
t("区：名前は「区」で終わり重複しない", WARDS.every(w => w.name.endsWith("区")) && new Set(WARDS.map(w => w.name)).size === 7);
t("区・名所・物語：座標は福岡市の外接矩形の中", [...WARDS, ...SPOTS, ...FUKUOKA_STORY, ...NIGHT_CENTERS].every(p => inCity(p.lon, p.lat)));
t("名所：id は重複しない・区は 7 区のどれか", new Set(SPOTS.map(s => s.id)).size === SPOTS.length && SPOTS.every(s => WARDS.some(w => w.code === s.ward)));
t("名所：note は文で終わる・名前は英語（ASCII）", SPOTS.every(s => /[.)]$/.test(s.note) && /^[\x20-\x7e]+$/.test(s.name)));
t("ツアー：全部が名所の id・重複なし", TOUR.every(id => SPOTS.some(s => s.id === id)) && new Set(TOUR).size === TOUR.length);
t("物語：年の順・写真の id は名所にある", FUKUOKA_STORY.every((c, i) => i === 0 || +c.year > +FUKUOKA_STORY[i - 1].year) && FUKUOKA_STORY.every(c => !c.photo || SPOTS.some(s => s.id === c.photo)));
t("物語：眺めは 3 つ・傾きは 70° 以上", BAY_VIEWS.length === 3 && BAY_VIEWS.every(v => v.tilt >= 70 && inCity(v.lon, v.lat)));
t("地下鉄：空港線 13 駅（K01 姪浜〜K13 福岡空港）・箱崎線 7 駅（H01 中洲川端〜H07 貝塚）・七隈線 18 駅（N01 橋本〜N18 博多）",
	SUBWAY[0].stations.length === 13 && SUBWAY[1].stations.length === 7 && SUBWAY[2].stations.length === 18 && SUBWAY.every(l => l.romaji.length === l.stations.length));
t("地下鉄：天神＝K08・天神南＝N16・福岡空港＝K13", subwayCodes("天神")[0]?.code === "K08" && subwayCodes("天神南")[0]?.code === "N16" && subwayCodes("福岡空港")[0]?.code === "K13");
t("地下鉄：乗換＝中洲川端（K09・H01）・博多（K11・N18）", subwayCodes("中洲川端").map(c => c.code).join() === "K09,H01" && subwayCodes("博多").map(c => c.code).join() === "K11,N18");
t("地下鉄の色：N02 の路線名で分ける", CITY.subwayColor("2号線(箱崎線)") === SUBWAY[1].color && CITY.subwayColor("3号線(七隈線)") === SUBWAY[2].color && CITY.subwayColor("1号線(空港線)") === SUBWAY[0].color);
t("地下鉄の路線：rail.json の「福岡市 …」に当たる", CITY.subwayRail.test("福岡市 1号線(空港線)") && !CITY.subwayRail.test("西日本鉄道 天神大牟田線"));
t("路線の英語：知らない線はそのまま", railLinesEn("西日本鉄道 天神大牟田線") === "Nishitetsu Tenjin Omuta Line" && Object.keys(RAIL_LINES_EN).length >= 10);
t("交通の層：地下鉄・鉄道・バス", TRANSIT.map(x => x.id).join() === "subway,rail,bus");
t("災害：海に面した福岡＝4 つとも", HAZARDS.map(h => h.id).join() === "flood,hightide,tsunami,dosha");
t("住所 → 区：福岡市博多区… → 博多区", wardOfAddress("福岡市博多区博多駅中央街1-1")?.code === "40132" && wardOfAddress("京都市中京区寺町")?.code === undefined);
t("避難場所：福岡市の行だけ", fukuokaShelters([[130.4, 33.6, "A", "福岡市東区x", 1], [130.5, 33.5, "B", "春日市y", 1]]).length === 1);
t("大きな病院：台帳の名に含まれる語で引く", majorHospital("九州大学病院") === "九州大学病院" && majorHospital("独立行政法人国立病院機構九州医療センター") === "国立病院機構九州医療センター" && majorHospital("某医院") === null && MAJOR_HOSPITALS.length === 8);
t("急病：市の急患診療センター・夜間の見出しと時間・#7119", NIGHT_CENTERS.length === 1 && !!CITY.emergency?.night?.label && /Call ahead/.test(CITY.emergency.night.hours) && CITY.emergency.advice?.tel === "#7119" && !CITY.emergency.holiday);
t("建物：7 区・先読みは登録簿の名前", BLD_SETS.length === 7 && LOD2_PREFETCH.every(n => BLD_SETS.includes(n)));
const sets = JSON.parse(readFileSync(new URL("../../../packages/jp/assets/plateau-sets.json", import.meta.url), "utf8")).map(s => s.name);
t("建物：登録簿（plateau-sets.json）に全部ある", BLD_SETS.every(n => sets.includes(n)), BLD_SETS.filter(n => !sets.includes(n)).join());
t("建物：区の名 → 登録簿の名", CITY.bldNames("40132").join() === "福岡博多区" && CITY.bldNames("99999").length === 0);
t("収める枠：沖の小呂島を外す・市の矩形の内側", FIT_BOX[0] > CITY_BBOX[0] && FIT_BOX[3] < CITY_BBOX[3] && !(130.04 >= FIT_BOX[0]));
const st = parseState("?tab=risk&hz=flood,tsunami&ward=40132&spot=kushida&tr=subway");
t("URL の状態：津波も読む・区と名所は読む", st.tab === "risk" && st.hz.join() === "flood,tsunami" && st.ward === "40132" && st.spot === "kushida" && st.tr.join() === "subway");
t("URL の状態：往復", parseState(writeState("", st)).ward === "40132" && TABS.includes(parseState("?tab=nope").tab));
t("保存した地点：市の外は捨てる", parsePlaces(JSON.stringify([{ n: "家", at: [130.4, 33.59] }, { n: "京都", at: [135.76, 35.0] }])).length === 1);
const dict = JSON.parse(readFileSync(new URL("../i18n/pages/fukuoka.json", import.meta.url), "utf8")).ui;
const keys = [CITY.title, CITY.allWards, CITY.outside, CITY.tourIntro, ...WARDS.map(w => w.en), ...SPOTS.flatMap(s => [s.name, s.note]), ...FUKUOKA_STORY.flatMap(c => [c.name, c.note]), CITY.story.button, ...CITY.story.viewsCaption, CITY.subwayNote, CITY.riskNote, CITY.emergency.night.hours, CITY.emergency.night.label];
t("26 言語：画面に出る福岡の文は全部辞書にある（ja も）", keys.every(k => dict[k]?.ja), keys.filter(k => !dict[k]?.ja).join(" | "));
console.log(`\n${ng ? "✗" : "✓"} fukuoka: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
