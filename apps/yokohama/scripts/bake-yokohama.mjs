#!/usr/bin/env node
// 横浜市デジタルツインの台帳を組む（外部網が要る＝手元の Mac で走らせる）→ リポの根の ortho-data/japan/yokohama/*.json（git で追う・DATA.md）。
// 焼きの中身は共通（packages/citytwin/scripts/bake-city.mjs）。ここは横浜の設定だけ。引数（--only= --inspect --refresh）は共通の焼きの頭を見る。
// 置く＝`npm run publish:pages -w world-data -- --scope=japan --only=yokohama --write`（予行は --write なし）。
import path from "node:path";
import { bakeCity } from "../../../packages/citytwin/scripts/bake-city.mjs";
import { CITY } from "../data.ts";

export const BAKE = {
	city: CITY,
	pref: "14", prefName: "神奈川県", cityCode: "14100",
	wardRe: /^141(00|0\d|1[0-8])$/,          // 市（14100）と 18 区
	wardOnlyRe: /^141(0[1-9]|1[0-8])$/,      // 区だけ（1413x の川崎・1415x の相模原を拾わない）
	subwayOp: /^横浜市/,                      // N02 の事業者＝横浜市交通局（地下鉄）
	busOp: /^横浜市(交通局)?$/, busMin: 1000,  // P11 の事業者＝市営バス
	fireRe: /^横浜市消防局/,
	ages: "000040506659",                    // e-Stat 令和 7 年国勢調査 人口等基本集計 第 2-7 表（神奈川県）
	en: { ja: "横浜", en: "Yokohama", pref: "神奈川" },
};
if (import.meta.url === `file://${process.argv[1]}`) await bakeCity(BAKE, path.join(path.dirname(new URL(import.meta.url).pathname), ".cache"));
