#!/usr/bin/env node
// 福岡市デジタルツインの台帳を組む（外部網が要る＝手元の Mac で走らせる）→ リポの根の ortho-data/japan/fukuoka/*.json（git で追う・DATA.md）。
// 焼きの中身は横浜・京都と共通（packages/citytwin/scripts/bake-city.mjs）。ここは福岡の設定だけ。引数（--only= --inspect --refresh）は共通の焼きの頭を見る。
// 置く＝`npm run publish:pages -w world-data -- --scope=japan --only=fukuoka --write`（予行は --write なし）。
//   node apps/fukuoka/scripts/bake-fukuoka.mjs --inspect   # まず列名を確かめる
//   node apps/fukuoka/scripts/bake-fukuoka.mjs             # 全部（en と census は kuromoji が要る：npm i --no-save kuromoji@0.1.2）
import path from "node:path";
import { bakeCity } from "../../../packages/citytwin/scripts/bake-city.mjs";
import { CITY, FIT_BOX } from "../data.ts";

export const BAKE = {
	city: CITY,
	pref: "40", prefName: "福岡県", cityCode: "40130",
	wardRe: /^4013[0-7]$/,                   // 市（40130）と 7 区
	wardOnlyRe: /^4013[1-7]$/,               // 区だけ（糸島・春日・粕屋などを拾わない）
	subwayOp: /^福岡市/,                      // N02 の事業者＝福岡市交通局（地下鉄 空港線・箱崎線・七隈線）
	busOp: /^西日本鉄道/, busMin: 600,        // P11 の事業者＝西鉄バス（福岡市に市営バスは無い）
	fireRe: /^福岡市消防局/,
	ages: process.env.FUKUOKA_AGES || "000040506659",   // e-Stat 令和 7 年国勢調査 人口等基本集計 第 2-7 表（横浜・京都と同じ 1 本・40131〜40137 の行）
	fitBox: FIT_BOX,                          // 区と市の「収める枠」＝沖の小呂島（西区）を外す
	en: { ja: "福岡", en: "Fukuoka", pref: "福岡", osmStations: true },
	min: { walk: 30000, places: 300, stawiki: 80, towns: 500 },
};
if (import.meta.url === `file://${process.argv[1]}`) await bakeCity(BAKE, path.join(path.dirname(new URL(import.meta.url).pathname), ".cache"));
