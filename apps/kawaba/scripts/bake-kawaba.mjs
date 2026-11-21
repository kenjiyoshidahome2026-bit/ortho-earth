#!/usr/bin/env node
// 川場村デジタルツインの台帳を焼く（外部網が要る＝手元の Mac で）→ ortho-data/japan/kawaba/。中身は共通の packages/citytwin/scripts/bake-city.mjs。
//   node apps/kawaba/scripts/bake-kawaba.mjs [--inspect] [--only=wards,rail,…] [--refresh]
// 川場は「町村」の型（docs/citytwin-guide.md）＝駅・警察の本署・消防署・大きな病院は村の外（沼田市）＝生活圏の枠 lifeBox の中の物も採る。
import path from "node:path";
import { bakeCity } from "../../../packages/citytwin/scripts/bake-city.mjs";
import { CITY } from "../data.ts";

export const BAKE = {
	city: CITY,
	pref: "10", prefName: "群馬県", cityCode: "10444", gun: "利根郡",
	wardRe: /^10444$/,
	wardOnlyRe: /^10444$/,
	lifeBox: [138.96, 36.60, 139.20, 36.81],   // 生活圏＝沼田の市街（沼田駅・沼田警察署・利根沼田広域消防・利根中央病院）と上毛高原駅まで
	policeNames: ["沼田警察署"],               // 村に本署は無い＝管轄の署を名で
	subwayOp: /(?!)/,
	busOp: /./, busMin: 10,                    // 村の中の停留所は全部（P11 の事業者は「川場村」＝村のバス）
	fireRe: /^(?=利根沼田広域中央消防署)/,     // 村を受け持つ署（利根沼田広域消防本部の中央消防署）だけ
	skip: ["zoning"],                          // 用途地域は無い（A29 に 10444 が無い）
	allowEmpty: true,                          // 国・県の機関（P28）は 0 件
	ages: process.env.KAWABA_AGES || "000040506659",
	// 英語：町村の住所（郡・村の名・大字を外す）・生活圏の外の市の住所・読みの辞書が外す名と駅（2026-11-21 の焼きの見直し）
	en: {
		ja: "川場", en: "Kawaba", pref: "群馬", osmStations: true, kind: "村", gun: "利根郡", outside: { "沼田市": "Numata City", "みなかみ町": "Minakami Town" },
		fix: { "川場村役場": "Kawaba Village Office", "川場村歴史民俗資料館": "Kawaba Village Museum of History and Folklore", "利根沼田広域中央消防署": "Tone-Numata Central Fire Station",
			"国立病院機構沼田病院": "NHO Numata Hospital", "利根中央病院": "Tone Chuo Hospital", "群馬パース病院": "Gunma Paz Hospital" },
		shelters: { "川場村体育館": "Kawaba Village Gymnasium", "ホテル田園プラザ（農林漁業体験実習館・やすらぎの家・担い手研修施設）": "Hotel Denen Plaza", "道の駅川場田園プラザ": "Roadside Station Kawaba Denen Plaza" },
		stations: { "水上": "Minakami", "上牧": "Kamimoku", "上毛高原": "Jomo-Kogen" },
	},
	min: { walk: 500, places: 3, stawiki: 0, towns: 5, small: 3 },
};
if (import.meta.url === `file://${process.argv[1]}`) await bakeCity(BAKE, path.join(path.dirname(new URL(import.meta.url).pathname), ".cache"));
