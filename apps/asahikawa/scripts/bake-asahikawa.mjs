#!/usr/bin/env node
// 旭川市デジタルツインの台帳を焼く（外部網が要る＝手元の Mac で）→ ortho-data/japan/asahikawa/。中身は共通の packages/citytwin/scripts/bake-city.mjs（横浜・京都・福岡・札幌と同じ）。
//   node apps/asahikawa/scripts/bake-asahikawa.mjs [--inspect] [--only=wards,rail,…] [--refresh]
// 旭川は区の無い市＝「区」は市そのもの 1 つ（01204）。地下鉄は無い（subwayOp はどれにも当たらない）。
import path from "node:path";
import { bakeCity } from "../../../packages/citytwin/scripts/bake-city.mjs";
import { CITY } from "../data.ts";

export const BAKE = {
	city: CITY,
	pref: "01", prefName: "北海道", cityCode: "01204",
	wardRe: /^01204$/,                        // 市（区は無い）
	wardOnlyRe: /^01204$/,                    // 警察署の点の行政区域＝旭川市だけ（鷹栖・東神楽などを拾わない）
	subwayOp: /(?!)/,                          // 地下鉄は無い
	busOp: /^(旭川電気軌道|道北バス)/, busMin: 300,   // P11 の事業者＝旭川に市営バスは無い＝市内の路線バスの主な 2 社
	fireRe: /^旭川市消防本部/,
	skip: [],
	ages: process.env.ASAHIKAWA_AGES || "000040506659",   // e-Stat 令和 7 年国勢調査 人口等基本集計 第 2-7 表（札幌と同じ表）
	en: { ja: "旭川", en: "Asahikawa", pref: "北海道", prefKind: "", localKind: "道", jo: true, osmStations: true },   // 住所の「6条通9丁目」＝6-jo-dori 9-chome・「神楽3条6丁目」＝Kagura 3-jo 6-chome
	min: { walk: 15000, places: 60, stawiki: 10, towns: 200 },
};
if (import.meta.url === `file://${process.argv[1]}`) await bakeCity(BAKE, path.join(path.dirname(new URL(import.meta.url).pathname), ".cache"));
