#!/usr/bin/env node
// data.ts の常設検定（Node だけ・外部網なし）＝区と名所の台帳・ツアーの並び・ハザードと写真の URL の形・避難場所の選び方・URL の状態の往復。
import { WARDS, SPOTS, TOUR, HAZARDS, ERAS, CITY_BBOX, HINAN_FLAGS, yokohamaShelters, wardOfAddress, flagsOf, parseState, writeState } from "../data.ts";
let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const inCity = (lon, lat) => lon >= CITY_BBOX[0] && lon <= CITY_BBOX[2] && lat >= CITY_BBOX[1] && lat <= CITY_BBOX[3];

t("区：18 区・コードは 14101〜14118 の連番", WARDS.length === 18 && WARDS.every((w, i) => w.code === String(14101 + i)), WARDS.map(w => w.code).join());
t("区：名前は「区」で終わり重複しない", WARDS.every(w => w.name.endsWith("区")) && new Set(WARDS.map(w => w.name)).size === 18);
t("区・名所：座標は横浜市の外接矩形の中", [...WARDS, ...SPOTS].every(p => inCity(p.lon, p.lat)), [...WARDS, ...SPOTS].filter(p => !inCity(p.lon, p.lat)).map(p => p.name).join());
t("名所：id が重複せず、区は台帳にある", new Set(SPOTS.map(s => s.id)).size === SPOTS.length && SPOTS.every(s => WARDS.some(w => w.code === s.ward)));
t("名所：視点の値が地図の域（z 12〜19・tilt 0〜75）", SPOTS.every(s => s.zoom >= 12 && s.zoom <= 19 && s.tilt >= 0 && s.tilt <= 75));
t("ツアー：並びは全部名所の id・重複なし", TOUR.length >= 5 && TOUR.every(id => SPOTS.some(s => s.id === id)) && new Set(TOUR).size === TOUR.length);
t("ハザード：URL は {z}/{x}/{y} の型紙（https）・凡例あり", HAZARDS.every(h => h.urls.length && h.urls.every(u => /^https:\/\/disaportaldata\.gsi\.go\.jp\/raster\/[\w]+\/\{z\}\/\{x\}\/\{y\}\.png$/.test(u)) && h.legend.length));
t("写真：先頭は写真なし・他は地理院の型紙", ERAS[0].url === null && ERAS.slice(1).every(e => /^https:\/\/cyberjapandata\.gsi\.go\.jp\/xyz\/\w+\/\{z\}\/\{x\}\/\{y\}\.(jpg|png)$/.test(e.url) && e.minZoom < e.maxZoom));

const rows = [[139.63, 35.45, "みなとみらい本町小学校", "神奈川県横浜市西区みなとみらい4-3-1", 0b11001], [139.70, 35.53, "川崎の公園", "神奈川県川崎市川崎区", 1], [NaN, 35.4, "壊れ", "横浜市中区", 1], [139.6, 35.4, "住所なし", null, 1]];
const ys = yokohamaShelters(rows);
t("避難場所：住所が横浜市の行だけ・座標の壊れた行は落とす", ys.length === 1 && ys[0][2] === "みなとみらい本町小学校", JSON.stringify(ys));
t("避難場所：住所から区", wardOfAddress(ys[0][3])?.code === "14103" && wardOfAddress("神奈川県川崎市") === null);
t("避難場所：対応災害のビット", HINAN_FLAGS.length === 8 && flagsOf(0b11001).join() === "洪水,地震,津波");

const s = parseState("?tab=risk&hz=flood,bogus,tsunami,flood&era=1974&ward=14104&spot=mm21&data=x");
t("状態：読む（知らない値は落とし重複は畳む）", s.tab === "risk" && s.hz.join() === "flood,tsunami" && s.era === "1974" && s.ward === "14104" && s.spot === "mm21", JSON.stringify(s));
t("状態：既定値は書かず、他の鍵は残す", writeState("?data=x", { tab: "city", hz: [], era: "map", ward: "", spot: "" }) === "?data=x");
t("状態：往復", JSON.stringify(parseState(writeState("", s))) === JSON.stringify(s));
t("状態：壊れた値は既定へ", JSON.stringify(parseState("?tab=x&era=1800&ward=13101")) === JSON.stringify({ tab: "city", hz: [], era: "map", ward: "", spot: "" }));
console.log(`\n${ng ? "✗" : "✓"} yokohama: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
