#!/usr/bin/env node
// 草津町デジタルツインの台帳を焼く（外部網が要る＝手元の Mac で）→ ortho-data/japan/kusatsu/。中身は共通の packages/citytwin/scripts/bake-city.mjs。
//   node apps/kusatsu/scripts/bake-kusatsu.mjs [--inspect] [--only=wards,rail,…] [--refresh]
// 草津は「町村」の型（docs/citytwin-guide.md）＝駅・警察の本署は町の外（長野原町）＝生活圏の枠 lifeBox の中の物も採る。
import path from "node:path";
import { bakeCity } from "../../../packages/citytwin/scripts/bake-city.mjs";
import { CITY } from "../data.ts";

export const BAKE = {
	city: CITY,
	pref: "10", prefName: "群馬県", cityCode: "10426", gun: "吾妻郡",
	wardRe: /^10426$/,
	wardOnlyRe: /^10426$/,
	lifeBox: [138.52, 36.52, 138.74, 36.66],   // 生活圏＝長野原草津口駅・長野原警察署・西吾妻福祉病院まで
	stationNames: ["長野原草津口"],            // 町へのバスが出る玄関の駅だけ（直線で近い羽根尾・群馬大津は無人駅でバスが無い＝最寄り駅に出さない・Mac の確認 2026-11-21）
	policeNames: ["長野原警察署"],
	subwayOp: /(?!)/,
	busOp: /./, busMin: 30,                    // 町の中の停留所は全部（JR バス関東・草軽交通・西武観光バス・長電バス・町の巡回バス）
	fireRe: /^吾妻広域町村圏振興整備組合(?=西部消防署)/,   // 町を受け持つ署（吾妻広域消防の西部消防署）
	skip: [],
	allowEmpty: true,
	dropNames: /伊東園ホテル/,                 // P28（国・県の機関）に入っている民間のホテル
	ages: process.env.KUSATSU_AGES || "000040506659",
	// 英語：町村の住所（郡・町の名・大字・字を外す）・生活圏の外の町の住所・読みの辞書が外す名と駅（2026-11-21 の焼きの見直し）
	en: {
		ja: "草津", en: "Kusatsu", pref: "群馬", osmStations: true, kind: "町", gun: "吾妻郡", outside: { "長野原町": "Naganohara Town", "嬬恋村": "Tsumagoi Village", "中之条町": "Nakanojo Town" },
		exact: { "公民館": "Kusatsu Community Hall", "総合体育館": "Kusatsu General Gymnasium", "総合保健福祉センター": "Kusatsu Health and Welfare Center", "前口分館": "Maeguchi Community Hall" },
		fix: { "草津町役場": "Kusatsu Town Office", "草津町立図書館": "Kusatsu Town Library", "楽泉園中央会館": "Rakusen-en Central Hall", "栗生楽泉園": "National Sanatorium Kuryu Rakusen-en",
			"草津音楽の森国際コンサートホール": "Kusatsu International Concert Hall", "品木ダム水質管理所": "Shinaki Dam Water Quality Office",
			"西部消防署長野原分署": "Naganohara Branch of Agatsuma Western Fire Station", "西部消防署": "Agatsuma Western Fire Station", "西吾妻福祉病院": "Nishi-Agatsuma Welfare Hospital" },
		shelters: { "前口区民館": "Maeguchi Community Hall", "草津町立小学校": "Kusatsu Elementary School", "草津町総合体育館": "Kusatsu General Gymnasium", "草津町立中学校": "Kusatsu Junior High School",
			"健康増進センター大滝乃湯": "Otaki-no-yu Health Center", "天狗山レストハウス": "Tenguyama Rest House", "草津町立ベルツこども園": "Kusatsu Baelz Child Center" },
		stations: { "長野原草津口": "Naganohara-Kusatsuguchi", "万座・鹿沢口": "Manza-Kazawaguchi", "川原湯温泉": "Kawarayu-Onsen" },
	},
	min: { walk: 500, places: 3, stawiki: 0, towns: 2, small: 2 },   // KEN_ALL の草津町の町名は「草津」「前口」の 2 つ・小地域も 2 面（大字草津・大字前口）＝実数どおり（2026-11-21）
};
if (import.meta.url === `file://${process.argv[1]}`) await bakeCity(BAKE, path.join(path.dirname(new URL(import.meta.url).pathname), ".cache"));
