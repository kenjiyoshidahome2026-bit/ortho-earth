#!/usr/bin/env node
// 世界時計（/globe/clock）の小さな台帳 clock-zones.json を焼く＝国コード（ISO 3166-1 alpha-2）→ その国の IANA の時間帯の名前の列（zone.tab の順）。
// 出所＝IANA tz database の zone.tab（パブリックドメイン）。既定は手元の /usr/share/zoneinfo/zone.tab（tzdata）・引数でパスを渡せる。
// zone1970.tab ではなく zone.tab を使う理由＝zone1970 は「1970 年以降同じ時刻の国」を 1 つの名前に束ねる（NO→Europe/Berlin）＝
// 表示の名前（Intl が返す「中央ヨーロッパ標準時」）は同じでも、国ごとに自分の首都の名前を引きたい（Shift の一覧で「Oslo」と出す）。
// 夏時間の規則は持たない（ブラウザの Intl が持つ）＝ここは「国 → 名前」だけ。
//   node scripts/clock-zones-build.mjs [path/to/zone.tab]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = process.argv[2] || "/usr/share/zoneinfo/zone.tab";
const text = fs.readFileSync(src, "utf8");
const zi = path.join(path.dirname(src), "tzdata.zi");
const version = fs.existsSync(zi) ? (fs.readFileSync(zi, "utf8").match(/^# version (\S+)/m)?.[1] ?? "") : "";
const out = {};
for (const line of text.split("\n")) {
	if (!line || line.startsWith("#")) continue;
	const [cc, , tz] = line.split("\t");
	(out[cc] ??= []).push(tz);
}
const keys = Object.keys(out).sort();
const body = `{"_":"IANA zone.tab ${version} (public domain) — scripts/clock-zones-build.mjs",\n` + keys.map(k => `${JSON.stringify(k)}:${JSON.stringify(out[k])}`).join(",\n") + "}\n";
fs.writeFileSync(path.join(APP, "clock-zones.json"), body);
console.log(`clock-zones.json: ${keys.length} countries, ${Object.values(out).flat().length} zones (tzdata ${version || "?"}) ${Buffer.byteLength(body)} bytes`);
