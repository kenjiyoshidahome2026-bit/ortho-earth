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
	// 英語：読みの辞書が外す名（2026-11-21 の焼きの見直し）
	en: {
		ja: "朝倉", en: "Asakura", pref: "福岡", osmStations: true,
		fix: { "朝倉市役所": "Asakura City Hall", "朝倉医師会病院": "Asakura Medical Association Hospital", "朝倉健生病院": "Asakura Kensei Hospital", "香月病院": "Katsuki Hospital",
			"甘木中央病院": "Amagi Chuo Hospital", "原鶴振興センター": "Harazuru Promotion Center", "サンライズ杷木": "Sunrise Haki", "B&G海洋センター": "Amagi B&G Marine Center",
			"甘木・朝倉消防本部": "Amagi-Asakura Fire Department", "家庭裁判所甘木出張所": "Fukuoka Family Court, Amagi Branch", "甘木税務署": "Amagi Tax Office", "秋月郷土館": "Akizuki Museum",
			"中央図書館": "Asakura Central Library", "水資源機構筑後上流総合管理所": "Japan Water Agency, Upper Chikugo River Office",
			"両筑平野用水総合事業所": "Japan Water Agency, Ryochiku Heiya Irrigation Office", "内水面研究所": "Fukuoka Inland Water Fisheries Research Institute" },
	},
	min: { walk: 5000, places: 20, stawiki: 1, towns: 50, small: 20 },
};
if (import.meta.url === `file://${process.argv[1]}`) await bakeCity(BAKE, path.join(path.dirname(new URL(import.meta.url).pathname), ".cache"));
