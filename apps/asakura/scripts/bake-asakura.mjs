#!/usr/bin/env node
// 朝倉市デジタルツインの台帳を焼く（外部網が要る＝手元の Mac で）→ ortho-data/japan/asakura/。中身は共通の packages/citytwin/scripts/bake-city.mjs。
//   node apps/asakura/scripts/bake-asakura.mjs [--inspect] [--only=wards,rail,…] [--refresh]
// 朝倉は区の無い市＝「区」は市そのもの 1 つ（40228）。地下鉄は無い。型＝一般市（docs/citytwin-guide.md）＝市の中だけで台帳が閉じる。
import path from "node:path";
import { bakeCity } from "../../../packages/citytwin/scripts/bake-city.mjs";
import { CITY } from "../data.ts";

export const BAKE = {
	city: CITY,
	pref: "40", prefName: "福岡県", cityCode: "40228",
	wardRe: /^40228$/,
	wardOnlyRe: /^40228$/,                    // 警察署の点の行政区域＝朝倉市だけ（朝倉警察署）
	subwayOp: /(?!)/,                          // 地下鉄は無い
	busOp: /^(朝倉市|西鉄バス久留米|西鉄バス二日市|（株）甘木観光バス)/, busMin: 100,   // P11 の事業者＝市内を走る全部（市のコミュニティバス・西鉄バス・甘木観光バス）
	fireRe: /^(?=甘木・朝倉)/,                 // 甘木・朝倉消防本部の署（名はそのまま＝頭を削らない）
	skip: [],
	ages: process.env.ASAKURA_AGES || "000040506659",   // e-Stat 令和 7 年国勢調査 人口等基本集計 第 2-7 表（全国の 1 本）
	en: { ja: "朝倉", en: "Asakura", pref: "福岡", osmStations: true },
	min: { walk: 5000, places: 20, stawiki: 1, towns: 50, small: 20 },
};
if (import.meta.url === `file://${process.argv[1]}`) await bakeCity(BAKE, path.join(path.dirname(new URL(import.meta.url).pathname), ".cache"));
