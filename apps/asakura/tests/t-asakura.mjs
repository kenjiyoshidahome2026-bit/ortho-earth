#!/usr/bin/env node
// data.ts の常設検定（Node だけ・外部網なし）＝朝倉市の設定（名所・ツアー・物語・救急・URL の状態）が共有モジュールの約束に合っているか。
// 朝倉市は区の無い自治体（1 行）・地下鉄なし・PLATEAU なし。型＝一般市（docs/citytwin-guide.md）。共有の芯の関数の検定は packages/citytwin/tests/t-core.mjs。
import { readFileSync, existsSync } from "node:fs";
import { CITY, WARDS, SPOTS, TOUR, HAZARDS, CITY_BBOX, SUBWAY, TRANSIT, STORY, HILL_VIEWS, NIGHT_CENTERS, MAJOR_HOSPITALS, BLD_SETS, LOD2_PREFETCH, RAIL_LINES_EN,
	wardOfAddress, parseState, writeState, parsePlaces, cityShelters, majorHospital, railLinesEn, TABS } from "../data.ts";
import { BAKE } from "../scripts/bake-asakura.mjs";
let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const inCity = (lon, lat) => lon >= CITY_BBOX[0] && lon <= CITY_BBOX[2] && lat >= CITY_BBOX[1] && lat <= CITY_BBOX[3];
const CODE = "40228", JA = "朝倉市";

t("区：区の無い自治体＝そのもの 1 行", WARDS.length === 1 && WARDS[0].code === CODE && WARDS[0].name === JA && BAKE.cityCode === CODE && BAKE.wardRe.test(CODE) && !BAKE.wardRe.test("40447"));
t("名所・物語・急病の診療所：座標は外接矩形の中", [...WARDS, ...SPOTS, ...STORY].every(p => inCity(p.lon, p.lat)), [...SPOTS, ...STORY].filter(p => !inCity(p.lon, p.lat)).map(p => p.id).join());
t("名所：id は重複しない", new Set(SPOTS.map(s => s.id)).size === SPOTS.length && SPOTS.every(s => s.ward === CODE));
t("名所：note は文で終わる・名前は英語（ASCII）", SPOTS.every(s => /[.)]$/.test(s.note) && /^[\x20-\x7e]+$/.test(s.name)));
t("ツアー：全部が名所の id・重複なし", TOUR.every(id => SPOTS.some(s => s.id === id)) && new Set(TOUR).size === TOUR.length);
t("物語：年の順・写真の id は名所にある", STORY.every((c, i) => i === 0 || +c.year > +STORY[i - 1].year) && STORY.every(c => !c.photo || SPOTS.some(s => s.id === c.photo)));
t("物語：id は重複しない・名所の id と被らない", new Set(STORY.map(c => c.id)).size === STORY.length && STORY.every(c => !SPOTS.some(s => s.id === c.id)));
t("物語：眺めは 3 つ・傾きは 70° 以上", HILL_VIEWS.length === 3 && HILL_VIEWS.every(v => v.tilt >= 70 && inCity(v.lon, v.lat)));
t("地下鉄：無い", SUBWAY.length === 0 && !CITY.subwayRail.test("") && !BAKE.subwayOp.test("x"));
t("交通の層：鉄道・バス", TRANSIT.map(x => x.id).join() === "rail,bus");
t("路線の英語：表に無い路線は日本語のまま", Object.values(RAIL_LINES_EN).every(v => /^[\x20-\x7e]+$/.test(v)) && railLinesEn("某鉄道 某線") === "某鉄道 某線");
t("災害：海に面さない＝洪水と土砂だけ", HAZARDS.map(h => h.id).join() === "flood,dosha");
t("住所 → 自治体：県・郡の付いた住所も・隣は当てない", wardOfAddress("福岡県朝倉市菩提寺412-2")?.code === CODE && wardOfAddress("朝倉市秋月野鳥532-2")?.code === CODE && wardOfAddress("福岡県朝倉郡筑前町篠隈373") === null);
t("避難場所：この自治体の行だけ", cityShelters([[130.66, 33.42, "A", "福岡県朝倉市菩提寺412-2", 1], [130.66, 33.42, "B", "福岡県朝倉郡筑前町篠隈373", 1]]).length === 1);
t("大きな病院：台帳の名に含まれる語で引く・英語の名", majorHospital("朝倉医師会病院") !== null && majorHospital("某医院") === null && MAJOR_HOSPITALS.every(h => /^[\x20-\x7e]+$/.test(h.en)));
t("急病：夜間の診療所は公式の頁で確かめた物だけ（座標は生活圏の中）", NIGHT_CENTERS.every(c => c.tel && c.addr && c.en && c.enName));
t("建物：PLATEAU の無い自治体＝登録簿の組は空", BLD_SETS.length === 0 && LOD2_PREFETCH.length === 0 && CITY.bldNames(CODE).length === 0);
const sets = JSON.parse(readFileSync(new URL("../../../packages/jp/assets/plateau-sets.json", import.meta.url), "utf8"));
t("建物：登録簿（plateau-sets.json）に無い（配信が始まったら建物の組を足す）", !sets.some(s => new RegExp(`/${CODE}-`).test(s.base)));
t("一般市の型：市の中で台帳が閉じる（生活圏の枠は無い）", !BAKE.lifeBox && !BAKE.gun && !BAKE.policeNames);
const st = parseState("?tab=risk&hz=flood,tsunami&spot=akizuki-castle&tr=rail,subway");
t("URL の状態：無い津波・地下鉄は捨てる・名所は読む", st.tab === "risk" && st.hz.join() === "flood" && st.spot === "akizuki-castle" && st.tr.join() === "rail");
t("URL の状態：往復", parseState(writeState("", st)).spot === "akizuki-castle" && TABS.includes(parseState("?tab=nope").tab));
t("保存した地点：外は捨てる", parsePlaces(JSON.stringify([{ n: "家", at: [130.66, 33.42] }, { n: "東京", at: [139.76, 35.68] }])).length === 1);
// 台帳（ortho-data/japan/asakura/）＝焼いた後なら中身も確かめる
const led = f => new URL(`../../../ortho-data/japan/asakura/${f}`, import.meta.url);
if (existsSync(led("facilities.json"))) {
	const fac = JSON.parse(readFileSync(led("facilities.json"), "utf8")).rows, rail = JSON.parse(readFileSync(led("rail.json"), "utf8")).stations;
	t("台帳：大きな病院は全部、施設の台帳にある", MAJOR_HOSPITALS.every(h => fac.some(r => r[2].includes(h.key))), MAJOR_HOSPITALS.filter(h => !fac.some(r => r[2].includes(h.key))).map(h => h.key).join());
	t("台帳：駅がある（町村は生活圏の駅）・路線は英語の表にある", rail.length > 0 && rail.every(s => String(s[3]).split("・").every(l => RAIL_LINES_EN[l])), [...new Set(rail.flatMap(s => String(s[3]).split("・")).filter(l => !RAIL_LINES_EN[l]))].join());
	t("台帳：警察の本署と消防署がある（町村は生活圏の署）", fac.some(r => r[5] === "警察署") && fac.some(r => r[5] === "消防署"));
}
const dict = JSON.parse(readFileSync(new URL("../i18n/pages/asakura.json", import.meta.url), "utf8")).ui;
const keys = [CITY.title, CITY.cityName, CITY.allWards, CITY.outside, CITY.tourIntro, CITY.wholeCityTitle, CITY.flatNote, CITY.zonesTitle, ...WARDS.map(w => w.en), ...SPOTS.flatMap(s => [s.name, s.note]), ...STORY.flatMap(c => [c.name, c.note]), CITY.story.button, CITY.story.viewsButton, ...CITY.story.viewsCaption,
	CITY.subwayNote, ...TRANSIT.map(x => x.name), CITY.riskNote, ...(CITY.inland ? [CITY.inland.text, CITY.inland.link] : []), ...(CITY.emergency?.night ? [CITY.emergency.night.hours] : []), ...(CITY.emergency?.advice ? [CITY.emergency.advice.text] : [])];
t("26 言語：画面に出る文は全部辞書にある（ja も）", keys.every(k => dict[k]?.ja), keys.filter(k => !dict[k]?.ja).join(" | "));
console.log(`\n${ng ? "✗" : "✓"} asakura: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
