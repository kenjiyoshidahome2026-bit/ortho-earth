#!/usr/bin/env node
// data.ts の常設検定（Node だけ・外部網なし）＝区と名所の台帳・ツアーの並び・地下鉄の駅番号・ハザードの URL の形・避難場所の選び方・URL の状態の往復。
import { WARDS, SPOTS, TOUR, HAZARDS, CITY_BBOX, HINAN_FLAGS, SUBWAY, FACILITY_CATS, TRANSIT, subwayCodes, yokohamaShelters, wardOfAddress, flagsOf, parseState, writeState, DEPTH, tilePixel, legendIndex, floorsOfDepth, distM, nearestRows, walkMin, WALK_RINGS, walkRadius, circleRing, countRings } from "../data.ts";
let ok = 0, ng = 0;
const t = (name, cond, extra = "") => { if (cond) { ok++; console.log("✓ " + name); } else { ng++; console.error("✗ " + name + (extra ? "  " + extra : "")); } };
const inCity = (lon, lat) => lon >= CITY_BBOX[0] && lon <= CITY_BBOX[2] && lat >= CITY_BBOX[1] && lat <= CITY_BBOX[3];

t("区：18 区・コードは 14101〜14118 の連番", WARDS.length === 18 && WARDS.every((w, i) => w.code === String(14101 + i)), WARDS.map(w => w.code).join());
t("区：名前は「区」で終わり重複しない", WARDS.every(w => w.name.endsWith("区")) && new Set(WARDS.map(w => w.name)).size === 18);
t("区・名所：座標は横浜市の外接矩形の中", [...WARDS, ...SPOTS].every(p => inCity(p.lon, p.lat)), [...WARDS, ...SPOTS].filter(p => !inCity(p.lon, p.lat)).map(p => p.name).join());
t("名所：id が重複せず、区は台帳にある", new Set(SPOTS.map(s => s.id)).size === SPOTS.length && SPOTS.every(s => WARDS.some(w => w.code === s.ward)));
t("名所：写真の記事名がある", SPOTS.every(s => typeof s.wiki === "string" && s.wiki.length > 1));
t("名所：視点の値が地図の域（z 12〜19・tilt 0〜75）", SPOTS.every(s => s.zoom >= 12 && s.zoom <= 19 && s.tilt >= 0 && s.tilt <= 75));
t("ツアー：並びは全部名所の id・重複なし", TOUR.length >= 5 && TOUR.every(id => SPOTS.some(s => s.id === id)) && new Set(TOUR).size === TOUR.length);
t("ハザード：URL は {z}/{x}/{y} の型紙（https）・凡例あり", HAZARDS.every(h => h.urls.length && h.urls.every(u => /^https:\/\/disaportaldata\.gsi\.go\.jp\/raster\/[\w]+\/\{z\}\/\{x\}\/\{y\}\.png$/.test(u)) && h.legend.length));
t("地下鉄：ブルー 32 駅・グリーン 10 駅・駅名の重複なし", SUBWAY[0].stations.length === 32 && SUBWAY[1].stations.length === 10 && SUBWAY.every(l => new Set(l.stations).size === l.stations.length));
t("地下鉄：駅番号（横浜＝B20・日吉＝G10・センター南＝B29 と G04）", subwayCodes("横浜")[0]?.code === "B20" && subwayCodes("日吉駅")[0]?.code === "G10" && subwayCodes("センター南").map(c => c.code).join() === "B29,G04" && subwayCodes("渋谷").length === 0);
t("公共施設：区分は 7・色は #rrggbb", FACILITY_CATS.length === 7 && FACILITY_CATS.every(c => /^#[0-9a-f]{6}$/.test(c.color)));

const rows = [[139.63, 35.45, "みなとみらい本町小学校", "神奈川県横浜市西区みなとみらい4-3-1", 0b11001], [139.70, 35.53, "川崎の公園", "神奈川県川崎市川崎区", 1], [NaN, 35.4, "壊れ", "横浜市中区", 1], [139.6, 35.4, "住所なし", null, 1]];
const ys = yokohamaShelters(rows);
t("避難場所：住所が横浜市の行だけ・座標の壊れた行は落とす", ys.length === 1 && ys[0][2] === "みなとみらい本町小学校", JSON.stringify(ys));
t("避難場所：住所から区", wardOfAddress(ys[0][3])?.code === "14103" && wardOfAddress("神奈川県川崎市") === null);
t("避難場所：対応災害のビット", HINAN_FLAGS.length === 8 && flagsOf(0b11001).join() === "Flood,Earthquake,Tsunami");

const s = parseState("?tab=risk&hz=flood,bogus,tsunami,flood&era=1974&ward=14104&spot=mm21&tr=bus,x,subway&data=x");
t("状態：読む（知らない値は落とし重複は畳む）", s.tab === "risk" && s.hz.join() === "flood,tsunami" && s.ward === "14104" && s.spot === "mm21" && s.tr.join() === "subway,bus", JSON.stringify(s));
const DEF = { tab: "sight", ward: "", hz: [], spot: "", tr: ["subway"] };
t("状態：既定値は書かず、他の鍵は残す（旧 era は消す）", writeState("?data=x&era=1974", DEF) === "?data=x");
t("状態：交通を全部消した＝tr= を残す（既定の地下鉄に戻さない）", writeState("", { ...DEF, tr: [] }) === "?tr=" && parseState("?tr=").tr.length === 0);
t("状態：旧い面の名（city→観光・time→解析）", parseState("?tab=city").tab === "sight" && parseState("?tab=time").tab === "tools" && TRANSIT[0].id === "subway");
t("状態：往復", JSON.stringify(parseState(writeState("", s))) === JSON.stringify(s));
t("状態：壊れた値は既定へ", JSON.stringify(parseState("?tab=x&era=1800&ward=13101")) === JSON.stringify(DEF));

const tp = tilePixel(139.6380, 35.4437, 17);
t("地点：タイルと画素（z17・横浜駅付近）", tp.x === Math.floor((139.6380 + 180) / 360 * 2 ** 17) && tp.px >= 0 && tp.px < 256 && tp.py >= 0 && tp.py < 256 && tilePixel(-180, 0, 1).x === 0 && tilePixel(0, 0, 1).py === 0, JSON.stringify(tp));
const c0 = parseInt(DEPTH[2].color.slice(1), 16);
t("地点：画素の色→凡例（透明は -1・近い色・遠い色は -1）", legendIndex(DEPTH, c0 >> 16, c0 >> 8 & 255, c0 & 255, 255) === 2 && legendIndex(DEPTH, c0 >> 16, c0 >> 8 & 255, c0 & 255, 0) === -1 && legendIndex(DEPTH, 0, 0, 0, 255) === -1);
t("地点：浸水の帯→階（床下 0・5m 帯で 2 階・20m 以上 7）", floorsOfDepth(0) === 0 && floorsOfDepth(2) === 2 && floorsOfDepth(5) === 7 && floorsOfDepth(9) === 0);
const d = distM([139.6380, 35.4437], [139.6380, 35.4537]);
t("地点：距離（緯度 0.01 度＝約 1112m）・徒歩分（80m/分×1.3）", Math.abs(d - 1112) < 3 && walkMin(d) === 18 && walkMin(0) === 1, String(d));
const nr = nearestRows([[139.70, 35.44, "遠"], [139.64, 35.444, "近"], [139.65, 35.45, "中"]], [139.638, 35.4437], 2);
t("地点：近い順に k 件", nr.length === 2 && nr[0].row[2] === "近" && nr[1].row[2] === "中" && nr[0].m < nr[1].m);
const ring = circleRing([139.638, 35.4437], 500, 64);
t("徒歩圏：円は閉じ、どの点も中心から半径の距離（±1%）", ring.length === 65 && ring[0][0] === ring[64][0] && ring.every(p => Math.abs(distM([139.638, 35.4437], p) - 500) < 5));
t("徒歩圏：5・10・15 分＝直線 約 308・615・923m", WALK_RINGS.join() === "5,10,15" && Math.round(walkRadius(10)) === 615);
t("徒歩圏：輪ごとの数（内側の輪は外側にも数える・絞り込み）", JSON.stringify(countRings([[139.638, 35.4457, 0], [139.638, 35.4487, 1], [139.638, 35.47, 0]], [139.638, 35.4437])) === "[1,2,2]" && JSON.stringify(countRings([[139.638, 35.4457, 0], [139.638, 35.4487, 1]], [139.638, 35.4437], r => r[2] === 1)) === "[0,1,1]");
console.log(`\n${ng ? "✗" : "✓"} yokohama: ${ok} ok, ${ng} ng`);
process.exit(ng ? 1 : 0);
