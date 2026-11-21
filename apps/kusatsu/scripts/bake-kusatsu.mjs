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
	policeNames: ["長野原警察署"],
	subwayOp: /(?!)/,
	busOp: /./, busMin: 30,                    // 町の中の停留所は全部（JR バス関東・草軽交通・西武観光バス・長電バス・町の巡回バス）
	fireRe: /^吾妻広域町村圏振興整備組合(?=西部消防署)/,   // 町を受け持つ署（吾妻広域消防の西部消防署）
	skip: [],
	allowEmpty: true,
	dropNames: /伊東園ホテル/,                 // P28（国・県の機関）に入っている民間のホテル
	ages: process.env.KUSATSU_AGES || "000040506659",
	en: { ja: "草津", en: "Kusatsu", pref: "群馬", osmStations: true },
	min: { walk: 500, places: 3, stawiki: 0, towns: 5, small: 3 },
};
if (import.meta.url === `file://${process.argv[1]}`) await bakeCity(BAKE, path.join(path.dirname(new URL(import.meta.url).pathname), ".cache"));
