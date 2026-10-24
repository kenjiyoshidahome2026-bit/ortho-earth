#!/usr/bin/env node
// 日本の地形の種＝地理院ベクトルタイルの注記（z4〜z9）から自然地名を機械的に選ぶ（world の NE scalerank と同じ考え方＝
// 「地理院が小縮尺で名前を置く物ほど大きな地形」。name/code/rank(=初出 z)/lon,lat(注記の位置)/kana を seed/terrains-anno.csv に書く）。
//   入力: .cache/anno-optimal_bvmap-v1-4-8.json / -9-9.json（anno-crawl.mjs）・.cache/anno-experimental_bvmap-4-8.json（川＝322 は experimental にしか無い）
//   出力: seed/terrains-anno.csv（生成物・手で編集しない。手動層は seed/terrains-manual.json）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const DIR = path.dirname(fileURLToPath(import.meta.url)), CACHE = path.join(DIR, ".cache");
const load = f => JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8"));

// 地理院の注記分類（vt_code / annoCtg）→ 分類。接尾辞で分ける物は suffix 表
export const CODE_CAT = { 311: "peak", 314: "peak", 315: "peak", 316: "peak", 321: "lake", 322: "river", 331: "plateau", 332: "pass", 333: "range", 343: "cape", 344: "sea", 345: "bay", 346: "peninsula", 347: "beach", 348: "trench", 351: "islands", 352: "island" };
const SUFFIX = [
	[/(山脈|山地|連山|連峰|山系|連峯)$/, "range"], [/(平野|平地|原野|野原|野)$/, "plain"], [/盆地$/, "basin"], [/(高原|高地|台地|台|原)$/, "plateau"], [/丘陵$/, "hills"],
	[/(海峡|水道|瀬戸)$/, "strait"], [/湾$/, "bay"], [/(灘|海)$/, "sea"], [/(堆|干瀬|礁)$/, "reef"],
	[/(海溝|舟状海盆|トラフ)$/, "trench"], [/海嶺$/, "ridge"], [/海盆$/, "basin"], [/(海山|海台|平頂海山)$/, "seamount"],
	[/(湿原|湿地)$/, "wetland"], [/(砂丘)$/, "dune"], [/(浜|海岸)$/, "beach"],
];
export const categoryOf = (code, name) => { const base = CODE_CAT[code]; if (!base) return null; if (![331, 333, 345, 348, 344, 347].includes(code)) return base; for (const [re, c] of SUFFIX) if (re.test(name)) return c; return base; };

const norm = s => String(s || "").replace(/\s+/g, "").replace(/[（(].*?[）)]/g, m => m);   // 全角空白などを落とす（括弧は残す＝「冨崎（観音埼）」）
const rows = new Map();   // name|code(#n) → { name, code, cat, z, lon, lat, kana, n }。同じ名が離れた場所（30 km 超）に出る時は別の地形（駒ヶ岳・大島・白根山）＝#2, #3…
const kmOf = (a, b) => Math.hypot((b[0] - a[0]) * 111.32 * Math.cos((a[1] + b[1]) * Math.PI / 360), (b[1] - a[1]) * 110.57);
const put = (name, code, z, lon, lat, kana) => {
	name = norm(name); if (!name || !(code in CODE_CAT)) return;
	const near = kmOf.bind(null, [lon, lat]);
	let r = null; for (let i = 1; ; i++) { const k = name + "|" + code + (i > 1 ? "#" + i : ""); const o = rows.get(k); if (!o) { if (!r) rows.set(k, r = { key: k, name, code, cat: categoryOf(code, name), z, lon, lat, kana: kana || "", n: 0 }); break; } if (near([o.lon, o.lat]) <= 30) { r = o; break; } }
	if (z < r.z) { r.z = z; r.lon = lon; r.lat = lat; } if (!r.kana && kana) r.kana = kana; r.n++;
};
for (const f of ["anno-optimal_bvmap-v1-4-8.json", "anno-optimal_bvmap-v1-9-9.json"]) for (const r of load(f)) put(r.vt_text, r.vt_code, r.z, r.lon, r.lat);
// 川（322）は optimal の z≤9 に無い＝experimental の z6〜8（z8 は 1 字ずつに割れた注記＝annoChar が全名・kana は英字）。位置は字の平均
const riv = new Map();
for (const r of load("anno-experimental_bvmap-4-8.json")) {
	if (r.annoCtg !== 322) continue;
	const name = norm(r.annoChar || (r.knj && r.knj.length > 1 ? r.knj : "")); if (!name) continue;
	const o = riv.get(name) || riv.set(name, { z: 99, pts: [], kana: "" }).get(name);
	if (r.z < o.z) { o.z = r.z; o.pts = []; } if (r.z === o.z) o.pts.push([r.lon, r.lat]); if (r.kana) o.kana = r.kana;
}
for (const [name, o] of riv) put(name, 322, o.z, +(o.pts.reduce((s, p) => s + p[0], 0) / o.pts.length).toFixed(4), +(o.pts.reduce((s, p) => s + p[1], 0) / o.pts.length).toFixed(4), o.kana);

// 山の 4 段（311 遠景・314 3000 m 級・315・316）＝同じ山が複数の段に出る（立山 311+314）→ 近い（30 km）同名は 1 件（小さい z）
const peaks = [...rows.values()].filter(r => r.cat === "peak").sort((a, b) => a.z - b.z), keep = new Set();
for (const r of peaks) { if (![...keep].some(k => k.name === r.name && kmOf([k.lon, k.lat], [r.lon, r.lat]) <= 30)) keep.add(r); }
const out = [...rows.values()].filter(r => r.cat !== "peak" || keep.has(r)).filter(r => r.code !== 361)
	.sort((a, b) => a.code - b.code || a.z - b.z || a.name.localeCompare(b.name, "ja"));
const esc = v => /[",\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v;
fs.writeFileSync(path.join(DIR, "seed/terrains-anno.csv"), "key,name,code,category,rank,lon,lat,kana\n" + out.map(r => [r.key, r.name, r.code, r.cat, r.z, r.lon, r.lat, r.kana].map(esc).join(",")).join("\n") + "\n");
const cnt = {}; for (const r of out) cnt[r.cat] = (cnt[r.cat] || 0) + 1;
console.log(out.length, "件", JSON.stringify(cnt));
