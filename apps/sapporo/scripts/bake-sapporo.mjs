#!/usr/bin/env node
// 札幌市デジタルツインの台帳を焼く（外部網が要る＝手元の Mac で）→ ortho-data/japan/sapporo/。中身は共通の packages/citytwin/scripts/bake-city.mjs（横浜・京都と同じ）。
//   node apps/sapporo/scripts/bake-sapporo.mjs [--inspect] [--only=wards,rail,…] [--refresh]
import path from "node:path";
import { bakeCity } from "../../../packages/citytwin/scripts/bake-city.mjs";
import { CITY } from "../data.ts";

export const BAKE = {
	city: CITY,
	pref: "01", prefName: "北海道", cityCode: "01100",
	wardRe: /^011(00|0\d|10)$/,              // 市（01100）と 10 区
	wardOnlyRe: /^011(0[1-9]|10)$/,          // 区だけ（江別・北広島・石狩などを拾わない）
	subwayOp: /^札幌市$/,                     // N02 の事業者＝札幌市（交通局の地下鉄 3 線だけ・市電は「一般社団法人札幌市交通事業振興公社」＝鉄道の層）
	busOp: /^(北海道中央バス|ジェイ・アール北海道バス|じょうてつ)/, busMin: 600,   // P11 の事業者＝札幌に市営バスは無い（2004 年までに民営へ）＝主な 3 社
	fireRe: /^札幌市消防局/,
	skip: ["eschool", "jschool"],             // 小・中学校区（A27・A32 の -21・-16）に札幌市の面が無い（2026-11-14 Mac で確認）
	ages: process.env.SAPPORO_AGES || "000040506659",   // e-Stat 令和 7 年国勢調査 人口等基本集計 第 2-7 表＝全国・都道府県・市区町村の 1 本（横浜・京都と同じ表）
	en: { ja: "札幌", en: "Sapporo", pref: "北海道", prefKind: "", localKind: "道", jo: true, osmStations: true },   // 北海道＝県名の後に「県」が無い・道立・住所の「北1条西2丁目」＝Kita 1-jo Nishi 2-chome
	min: { walk: 30000, places: 300, stawiki: 80, towns: 500 },
};
if (import.meta.url === `file://${process.argv[1]}`) await bakeCity(BAKE, path.join(path.dirname(new URL(import.meta.url).pathname), ".cache"));
