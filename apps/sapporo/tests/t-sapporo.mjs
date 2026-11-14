#!/usr/bin/env node
// data.ts の常設検定（Node だけ・外部網なし）＝札幌の市の設定（区・名所・ツアー・地下鉄の駅番号・物語・救急・URL の状態）が共有モジュールの約束に合っているか。
// 共有の芯（packages/citytwin/src/core.ts）の関数の検定は横浜の tests/t-yokohama.mjs と packages/citytwin/tests/t-core.mjs が持つ。
import { readFileSync } from "node:fs";
import { CITY, WARDS, SPOTS, TOUR, HAZARDS, CITY_BBOX, SUBWAY, TRANSIT, SAPPORO_STORY, HILL_VIEWS, NIGHT_CENTERS, MAJOR_HOSPITALS, BLD_SETS, LOD2_PREFETCH, RAIL_LINES_EN,
	subwayCodes, wardOfAddress, parseState, writeState, parsePlaces, sapporoShelters, majorHospital, railLinesEn, TABS } from "../data.ts";
import { makeEn } from "../../../packages/citytwin/scripts/en-names.mjs";
import { BAKE } from "../scripts/bake-sapporo.mjs";
let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const inCity = (lon, lat) => lon >= CITY_BBOX[0] && lon <= CITY_BBOX[2] && lat >= CITY_BBOX[1] && lat <= CITY_BBOX[3];

t("区：10 区・コードは 01101〜01110 の連番", WARDS.length === 10 && WARDS.every((w, i) => w.code === String(1101 + i).padStart(5, "0")), WARDS.map(w => w.code).join());
t("区：名前は「区」で終わり重複しない", WARDS.every(w => w.name.endsWith("区")) && new Set(WARDS.map(w => w.name)).size === 10);
t("区・名所・物語：座標は札幌市の外接矩形の中", [...WARDS, ...SPOTS, ...SAPPORO_STORY, ...NIGHT_CENTERS].every(p => inCity(p.lon, p.lat)));
t("名所：id は重複しない・区は 10 区のどれか", new Set(SPOTS.map(s => s.id)).size === SPOTS.length && SPOTS.every(s => WARDS.some(w => w.code === s.ward)));
t("名所：note は文で終わる・名前は英語（ASCII）", SPOTS.every(s => /[.)]$/.test(s.note) && /^[\x20-\x7e]+$/.test(s.name)));
t("ツアー：全部が名所の id・重複なし", TOUR.every(id => SPOTS.some(s => s.id === id)) && new Set(TOUR).size === TOUR.length);
t("物語：年の順・写真の id は名所にある", SAPPORO_STORY.every((c, i) => i === 0 || +c.year > +SAPPORO_STORY[i - 1].year) && SAPPORO_STORY.every(c => !c.photo || SPOTS.some(s => s.id === c.photo)));
t("物語：眺めは 3 つ・傾きは 70° 以上", HILL_VIEWS.length === 3 && HILL_VIEWS.every(v => v.tilt >= 70 && inCity(v.lon, v.lat)));
t("地下鉄：南北線 16 駅（N01 麻生〜N16 真駒内）・東西線 19 駅（T01 宮の沢〜T19 新さっぽろ）・東豊線 14 駅（H01 栄町〜H14 福住）",
	SUBWAY.map(l => l.stations.length).join() === "16,19,14" && SUBWAY.every(l => l.romaji.length === l.stations.length));
t("地下鉄：すすきの＝N08・福住＝H14・宮の沢＝T01", subwayCodes("すすきの")[0]?.code === "N08" && subwayCodes("福住")[0]?.code === "H14" && subwayCodes("宮の沢")[0]?.code === "T01");
t("地下鉄：大通は 3 線の乗換（N07・T09・H08）・さっぽろは 2 線（N06・H07）", subwayCodes("大通").map(c => c.code).join() === "N07,T09,H08" && subwayCodes("さっぽろ").map(c => c.code).join() === "N06,H07");
t("地下鉄：全角の数字（台帳の字）も当たる", subwayCodes("南郷１３丁目")[0]?.code === "T15" && subwayCodes("北３４条")[0]?.code === "N02");
t("地下鉄の色：N02 の路線名で分ける", CITY.subwayColor("東西線") === SUBWAY[1].color && CITY.subwayColor("東豊線") === SUBWAY[2].color && CITY.subwayColor("南北線") === SUBWAY[0].color);
t("地下鉄の路線：rail.json の「札幌市 南北線」に当たる・市電と JR は当たらない", CITY.subwayRail.test("札幌市 南北線") && CITY.subwayRail.test("札幌市 東豊線") && !CITY.subwayRail.test("一般社団法人札幌市交通事業振興公社 都心線") && !CITY.subwayRail.test("北海道旅客鉄道 函館線"));
t("路線の英語：東豊線＝Toho Line・市電＝Sapporo Streetcar", railLinesEn("札幌市 東豊線") === "Toho Line" && railLinesEn("一般社団法人札幌市交通事業振興公社 山鼻線") === "Sapporo Streetcar" && Object.keys(RAIL_LINES_EN).length >= 10);
t("交通の層：地下鉄・鉄道・バス", TRANSIT.map(x => x.id).join() === "subway,rail,bus");
t("災害：海に面さない札幌＝洪水と土砂だけ", HAZARDS.map(h => h.id).join() === "flood,dosha");
t("住所 → 区：札幌市中央区… → 中央区・北海道の付いた住所も", wardOfAddress("札幌市中央区北1条西2丁目")?.code === "01101" && wardOfAddress("北海道札幌市厚別区中央1条5丁目")?.code === "01108" && wardOfAddress("京都市中京区x")?.code === undefined);
t("避難場所：札幌市の行だけ（台帳の住所は「北海道札幌市…」）", sapporoShelters([[141.35, 43.06, "A", "北海道札幌市中央区x", 1], [141.5, 43.1, "B", "北海道江別市y", 1]]).length === 1);
t("大きな病院：台帳の名に含まれる語で引く・東徳洲会と徳洲会を取り違えない", majorHospital("市立札幌病院") === "市立札幌病院" && majorHospital("札幌東徳洲会病院") === "札幌東徳洲会病院" && majorHospital("某医院") === null && MAJOR_HOSPITALS.length === 8);
t("急病：市のセンター 1 か所・夜間の見出しと時間・#7119", NIGHT_CENTERS.length === 1 && !!CITY.emergency?.night?.label && /Call ahead/.test(CITY.emergency.night.hours) && CITY.emergency.advice?.tel === "#7119" && !CITY.emergency.holiday);
t("学区：札幌に台帳が無い＝出さない・焼かない", CITY.noAreas?.join() === "school-e,school-j" && BAKE.skip.join() === "eschool,jschool");
t("建物：10 区・先読みは登録簿の名前", BLD_SETS.length === 10 && LOD2_PREFETCH.every(n => BLD_SETS.includes(n)));
const sets = JSON.parse(readFileSync(new URL("../../../packages/jp/assets/plateau-sets.json", import.meta.url), "utf8"));
t("建物：登録簿（plateau-sets.json）に全部ある", BLD_SETS.every(n => sets.some(s => s.name === n)), BLD_SETS.filter(n => !sets.some(s => s.name === n)).join());
t("建物：LOD2 の区＝登録簿で lod の無い組（中央・北・東・西）", WARDS.filter(w => !sets.find(s => s.name === "札幌" + w.name)?.lod).map(w => w.name).join() === "中央区,北区,東区,西区");
t("建物：区の名 → 登録簿の名", CITY.bldNames("01101").join() === "札幌中央区" && CITY.bldNames("99999").length === 0);
const st = parseState("?tab=risk&hz=flood,tsunami&ward=01101&spot=odori&tr=subway");
t("URL の状態：札幌に無い津波は捨てる・区と名所は読む", st.tab === "risk" && st.hz.join() === "flood" && st.ward === "01101" && st.spot === "odori" && st.tr.join() === "subway");
t("URL の状態：往復", parseState(writeState("", st)).ward === "01101" && TABS.includes(parseState("?tab=nope").tab));
t("保存した地点：市の外は捨てる", parsePlaces(JSON.stringify([{ n: "家", at: [141.35, 43.06] }, { n: "京都", at: [135.76, 35.0] }])).length === 1);
// 英語化（焼きの設定 BAKE.en）＝北海道の住所と条丁目
const E = makeEn({ towns: [["発寒", "ハッサム"], ["宮の森", "ミヤノモリ"]], wards: WARDS.map(w => [w.name.replace(/区$/, ""), w.en.replace(/-ku$/, "")]), tokenize: null, city: BAKE.en });
t("英語の住所：北海道を落とし、条丁目＝Kita 1-jo Nishi 2-chome", E.addr("北海道札幌市中央区北1条西2丁目1-1", "Chuo-ku") === "1-1 Kita 1-jo Nishi 2-chome, Chuo-ku", E.addr("北海道札幌市中央区北1条西2丁目1-1", "Chuo-ku"));
t("英語の住所：漢数字・番号・条だけの町", E.addr("札幌市西区発寒五条六丁目3番4号", "Nishi-ku") === "3-4 Hassamu 5-jo 6-chome, Nishi-ku" && E.addr("札幌市中央区宮の森2丁目3-5", "Chuo-ku") === "3-5 Miyanomori 2-chome, Chuo-ku", E.addr("札幌市西区発寒五条六丁目3番4号", "Nishi-ku"));
t("英語化の既定（横浜・京都）は条丁目を読まない", makeEn({ towns: [], wards: [], tokenize: null }).joAddr("北1条西2丁目") !== undefined && makeEn({ towns: [], wards: [], tokenize: null }).addr("横浜市港北区菊名7-8-27", "Kohoku-ku") === "7-8-27 菊名, Kohoku-ku");
const dict = JSON.parse(readFileSync(new URL("../i18n/pages/sapporo.json", import.meta.url), "utf8")).ui;
const keys = [CITY.title, CITY.cityName, CITY.allWards, CITY.outside, CITY.tourIntro, CITY.wholeCityTitle, CITY.flatNote, CITY.zonesTitle, ...WARDS.map(w => w.en), ...SPOTS.flatMap(s => [s.name, s.note]), ...SAPPORO_STORY.flatMap(c => [c.name, c.note]), CITY.story.button, CITY.story.viewsButton, ...CITY.story.viewsCaption,
	...SUBWAY.map(l => l.name), CITY.subwayName, CITY.subwayNote, ...TRANSIT.filter(x => x.id !== "rail").map(x => x.name), CITY.riskNote, CITY.inland.text, CITY.inland.link, CITY.emergency.night.hours, CITY.emergency.night.label, CITY.emergency.advice.text, "Sapporo Streetcar"];
t("26 言語：画面に出る札幌の文は全部辞書にある（ja も）", keys.every(k => dict[k]?.ja), keys.filter(k => !dict[k]?.ja).join(" | "));
console.log(`\n${ng ? "✗" : "✓"} sapporo: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
