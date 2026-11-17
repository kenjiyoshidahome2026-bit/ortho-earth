#!/usr/bin/env node
// data.ts の常設検定（Node だけ・外部網なし）＝旭川の市の設定（市・名所・ツアー・物語・救急・URL の状態）が共有モジュールの約束に合っているか。
// 旭川は区の無い市（区＝市そのもの 1 行）・地下鉄の無い市・PLATEAU の無い市。共有の芯の関数の検定は packages/citytwin/tests/t-core.mjs。
import { readFileSync } from "node:fs";
import { CITY, WARDS, SPOTS, TOUR, HAZARDS, CITY_BBOX, SUBWAY, TRANSIT, ASAHIKAWA_STORY, HILL_VIEWS, NIGHT_CENTERS, MAJOR_HOSPITALS, BLD_SETS, LOD2_PREFETCH, RAIL_LINES_EN,
	wardOfAddress, parseState, writeState, parsePlaces, asahikawaShelters, majorHospital, railLinesEn, TABS } from "../data.ts";
import { makeEn } from "../../../packages/citytwin/scripts/en-names.mjs";
import { BAKE } from "../scripts/bake-asahikawa.mjs";
let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const inCity = (lon, lat) => lon >= CITY_BBOX[0] && lon <= CITY_BBOX[2] && lat >= CITY_BBOX[1] && lat <= CITY_BBOX[3];

t("区：区の無い市＝市そのもの 1 行（01204 旭川市）", WARDS.length === 1 && WARDS[0].code === "01204" && WARDS[0].name === "旭川市" && BAKE.cityCode === "01204" && BAKE.wardRe.test("01204") && !BAKE.wardRe.test("01452"));
t("市・名所・物語：座標は旭川市の外接矩形の中", [...WARDS, ...SPOTS, ...ASAHIKAWA_STORY, ...NIGHT_CENTERS].every(p => inCity(p.lon, p.lat)));
t("名所：id は重複しない・区は市", new Set(SPOTS.map(s => s.id)).size === SPOTS.length && SPOTS.every(s => s.ward === "01204"));
t("名所：note は文で終わる・名前は英語（ASCII）", SPOTS.every(s => /[.)]$/.test(s.note) && /^[\x20-\x7e]+$/.test(s.name)));
t("ツアー：全部が名所の id・重複なし", TOUR.every(id => SPOTS.some(s => s.id === id)) && new Set(TOUR).size === TOUR.length);
t("物語：年の順・写真の id は名所にある", ASAHIKAWA_STORY.every((c, i) => i === 0 || +c.year > +ASAHIKAWA_STORY[i - 1].year) && ASAHIKAWA_STORY.every(c => !c.photo || SPOTS.some(s => s.id === c.photo)));
t("物語：id は重複しない・名所の id と被らない", new Set(ASAHIKAWA_STORY.map(c => c.id)).size === ASAHIKAWA_STORY.length && ASAHIKAWA_STORY.every(c => !SPOTS.some(s => s.id === c.id)));
t("物語：眺めは 3 つ・傾きは 70° 以上", HILL_VIEWS.length === 3 && HILL_VIEWS.every(v => v.tilt >= 70 && inCity(v.lon, v.lat)));
t("地下鉄：無い（路線なし・どの路線名にも当たらない）", SUBWAY.length === 0 && !CITY.subwayRail.test("北海道旅客鉄道 函館線") && !CITY.subwayRail.test("") && !BAKE.subwayOp.test("旭川電気軌道"));
t("交通の層：鉄道・バス（地下鉄の層は無い）", TRANSIT.map(x => x.id).join() === "rail,bus");
t("路線の英語：JR の 4 線", railLinesEn("北海道旅客鉄道 宗谷線") === "JR Soya Line" && railLinesEn("北海道旅客鉄道 富良野線・北海道旅客鉄道 函館線") === "JR Furano Line・JR Hakodate Line" && Object.keys(RAIL_LINES_EN).length === 4);
t("災害：海に面さない旭川＝洪水と土砂だけ", HAZARDS.map(h => h.id).join() === "flood,dosha");
t("住所 → 市：旭川市…・北海道の付いた住所も・隣の町は当てない", wardOfAddress("旭川市6条通9丁目46")?.code === "01204" && wardOfAddress("北海道旭川市神楽3条6丁目1-1")?.code === "01204" && wardOfAddress("北海道上川郡東神楽町x") === null && wardOfAddress("札幌市中央区x") === null);
t("避難場所：旭川市の行だけ（台帳の住所は「北海道旭川市…」）", asahikawaShelters([[142.36, 43.77, "A", "北海道旭川市x", 1], [142.4, 43.7, "B", "北海道上川郡東神楽町y", 1]]).length === 1);
t("大きな病院：台帳の名に含まれる語で引く・英語の名", majorHospital("市立旭川病院") === "市立旭川病院" && majorHospital("某医院") === null && MAJOR_HOSPITALS.length >= 4 && MAJOR_HOSPITALS.every(h => /^[\x20-\x7e]+$/.test(h.en)));
t("急病：夜間急病センター 1 か所・時間（電話で確かめて）", NIGHT_CENTERS.length === 1 && /Call ahead/.test(CITY.emergency.night.hours) && !CITY.emergency.holiday);
t("建物：PLATEAU の無い市＝登録簿の組は空", BLD_SETS.length === 0 && LOD2_PREFETCH.length === 0 && CITY.bldNames("01204").length === 0);
const sets = JSON.parse(readFileSync(new URL("../../../packages/jp/assets/plateau-sets.json", import.meta.url), "utf8"));
t("建物：登録簿（plateau-sets.json）に旭川は無い（配信の無い市・あれば建物の組を足す）", !sets.some(s => /旭川/.test(s.name) || /\/01204-/.test(s.base)));
const st = parseState("?tab=risk&hz=flood,tsunami&spot=asahiyama-zoo&tr=rail,subway");
t("URL の状態：旭川に無い津波・地下鉄は捨てる・名所は読む", st.tab === "risk" && st.hz.join() === "flood" && st.spot === "asahiyama-zoo" && st.tr.join() === "rail");
t("URL の状態：往復", parseState(writeState("", st)).spot === "asahiyama-zoo" && TABS.includes(parseState("?tab=nope").tab));
t("保存した地点：市の外は捨てる", parsePlaces(JSON.stringify([{ n: "家", at: [142.36, 43.77] }, { n: "札幌", at: [141.35, 43.06] }])).length === 1);
// 英語化（焼きの設定 BAKE.en）＝旭川の住所（条通・条丁目）
const E = makeEn({ towns: [["神楽", "カグラ"], ["宮下通", "ミヤシタドオリ"]], wards: WARDS.map(w => [w.name.replace(/区$/, ""), w.en.replace(/-ku$/, "")]), tokenize: null, city: BAKE.en });
t("英語の住所：「6条通9丁目46」＝46 6-jo-dori 9-chome", E.addr("北海道旭川市6条通9丁目46", "Asahikawa City") === "46 6-jo-dori 9-chome, Asahikawa City", E.addr("北海道旭川市6条通9丁目46", "Asahikawa City"));
t("英語の住所：漢数字の条通・番号", E.addr("旭川市七条通十丁目1番地の2", "") === "1-2 7-jo-dori 10-chome", E.addr("旭川市七条通十丁目1番地の2", ""));
t("英語の住所：町の条丁目＝Kagura 3-jo 6-chome", E.addr("旭川市神楽3条6丁目1-1", "") === "1-1 Kagura 3-jo 6-chome", E.addr("旭川市神楽3条6丁目1-1", ""));
t("英語の住所：条の無い町の丁目", E.addr("旭川市宮下通7丁目2-5", "") === "2-5 Miyashitadori 7-chome", E.addr("旭川市宮下通7丁目2-5", ""));
t("英語の住所：札幌の条丁目は今まで通り", E.addr("札幌市中央区北1条西2丁目1-1", "Chuo-ku").startsWith("1-1 Kita 1-jo Nishi 2-chome"));
const dict = JSON.parse(readFileSync(new URL("../i18n/pages/asahikawa.json", import.meta.url), "utf8")).ui;
const keys = [CITY.title, CITY.cityName, CITY.allWards, CITY.outside, CITY.tourIntro, CITY.wholeCityTitle, CITY.flatNote, CITY.zonesTitle, ...WARDS.map(w => w.en), ...SPOTS.flatMap(s => [s.name, s.note]), ...ASAHIKAWA_STORY.flatMap(c => [c.name, c.note]), CITY.story.button, CITY.story.viewsButton, ...CITY.story.viewsCaption,
	CITY.subwayNote, ...TRANSIT.map(x => x.name), CITY.riskNote, ...(CITY.inland ? [CITY.inland.text, CITY.inland.link] : []), CITY.emergency.night.hours, ...(CITY.emergency.advice ? [CITY.emergency.advice.text] : [])];
t("26 言語：画面に出る旭川の文は全部辞書にある（ja も）", keys.every(k => dict[k]?.ja), keys.filter(k => !dict[k]?.ja).join(" | "));
console.log(`\n${ng ? "✗" : "✓"} asahikawa: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
