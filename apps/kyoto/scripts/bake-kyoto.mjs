#!/usr/bin/env node
// 京都市デジタルツインの台帳を組む（外部網が要る＝手元の Mac で走らせる）→ リポの根の ortho-data/japan/kyoto/*.json（git で追う・DATA.md）。
// 焼きの中身は横浜と共通（packages/citytwin/scripts/bake-city.mjs）。ここは京都の設定だけ。引数（--only= --inspect --refresh）は共通の焼きの頭を見る。
// 置く＝`npm run publish:pages -w world-data -- --scope=japan --only=kyoto --write`（予行は --write なし）。
//   node apps/kyoto/scripts/bake-kyoto.mjs --inspect   # まず列名を確かめる
//   node apps/kyoto/scripts/bake-kyoto.mjs             # 全部（en と census は kuromoji が要る：npm i --no-save kuromoji@0.1.2）
import path from "node:path";
import { bakeCity } from "../../../packages/citytwin/scripts/bake-city.mjs";
import { CITY } from "../data.ts";

export const BAKE = {
	city: CITY,
	pref: "26", prefName: "京都府", cityCode: "26100",
	wardRe: /^261(00|0\d|1[01])$/,           // 市（26100）と 11 区
	wardOnlyRe: /^261(0[1-9]|1[01])$/,       // 区だけ（宇治・向日・長岡京などを拾わない）
	subwayOp: /^京都市/,                      // N02 の事業者＝京都市交通局（地下鉄 烏丸線・東西線）
	busOp: /^京都市(交通局)?$/, busMin: 600,   // P11 の事業者＝市バス
	fireRe: /^京都市消防局/,
	ages: process.env.KYOTO_AGES || "000040506659",   // e-Stat 令和 7 年国勢調査 人口等基本集計 第 2-7 表＝全国・都道府県・市区町村の 1 本（横浜と同じ表・26100〜26111 の行がある）
	skip: ["eschool", "jschool"],             // 小・中学校区（A27-21・A32-21）に京都市の面が無い（府の zip は市外の 21 市町だけ・A27-16／A32-16 も同じ・2026-11-14 確認）
	en: { ja: "京都", en: "Kyoto", pref: "京都", osmStations: true },   // 駅の英語＝OSM（読みの辞書は宝ヶ池＝Takara Kechi・中書島＝Chusho Shima にした・2026-11-14 実機）
	min: { walk: 30000, places: 300, stawiki: 80, towns: 500 },
};
if (import.meta.url === `file://${process.argv[1]}`) await bakeCity(BAKE, path.join(path.dirname(new URL(import.meta.url).pathname), ".cache"));
