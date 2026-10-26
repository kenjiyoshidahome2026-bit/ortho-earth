#!/usr/bin/env node
// 日本の公共 GIS データの「在りか（URL）」を引く道具（.claude/skills/jp-open-data・2026-10-26）。
// gishub-jp（apps/gishub-jp）が持つ目録をそのまま読む＝アプリが開ける物と同じ URL が返る。ダウンロードはしない。
//   node .claude/skills/jp-open-data/find.mjs place 横浜市青葉区
//   node .claude/skills/jp-open-data/find.mjs nlftp --q 用途地域
//   node .claude/skills/jp-open-data/find.mjs nlftp --code A29-2019 --city 14100
//   node .claude/skills/jp-open-data/find.mjs moj|maff|estat --city 13118
//   node .claude/skills/jp-open-data/find.mjs munic --city 14100 [--q 避難所]
//   node .claude/skills/jp-open-data/find.mjs fixed
// 共通：--check＝各 URL を Range 1 バイトで叩いて生死（status）を添える（上限 --max 件・既定 20）
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const G = resolve(ROOT, "apps/gishub-jp");
const API = "https://api.ortho-earth.com";
const ORTHO_DATA = "https://kenjiyoshidahome2026-bit.github.io/ortho-data/japan/";
const json = p => JSON.parse(readFileSync(resolve(ROOT, p), "utf8"));

const [cmd, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i++) {
	const a = rest[i];
	if (!a.startsWith("--")) { (opt._ ??= []).push(a); continue; }
	const k = a.slice(2), v = rest[i + 1];
	if (v === undefined || v.startsWith("--")) opt[k] = true; else { opt[k] = v; i++; }
}
const max = +(opt.max || 20);
const out = x => console.log(JSON.stringify(x, null, 1));

// ---- 地名 → 行政区域コード（apps/gishub-jp/scripts/admin-boundary.csv＝総務省の全国地方公共団体コード・廃止分も） ----
const ADMIN = readFileSync(resolve(G, "scripts/admin-boundary.csv"), "utf8").trim().split("\n").slice(1).map(l => {
	const [code, pref, city, prefKana, cityKana, status, changeDate, newCode, newName] = l.split(",");
	return { code, pref, city, prefKana, cityKana, status, changeDate, newCode, newName };
});
const PREF_NAMES = Object.fromEntries(ADMIN.filter(r => r.code.endsWith("000")).map(r => [r.code.slice(0, 2), r.pref]));
function place(q) {
	const s = String(q).replace(/\s/g, "");
	const hits = ADMIN.filter(r => !r.status && (`${r.pref}${r.city}`.includes(s) || r.city === s || r.cityKana === s || r.code === s));
	return hits.map(r => ({ code: r.code, pref: r.pref, city: r.city || null, kana: r.cityKana || r.prefKana }));
}
// --city は 5 桁コードか地名＝5 桁へ（地名で複数当たったら最初の 1 つ・曖昧なら place で先に確かめる）
function cityCode(v) {
	if (!v) return null;
	if (/^\d{5,6}$/.test(v)) return v.slice(0, 5);
	const h = place(v).filter(r => r.city);
	if (!h.length) throw new Error(`地名が引けない：${v}（place で確かめる）`);
	return h[0].code;
}
function prefCode(v) {
	if (!v) return null;
	if (/^\d{1,2}$/.test(v)) return v.padStart(2, "0");
	const e = Object.entries(PREF_NAMES).find(([, n]) => n === v || n.replace(/[都道府県]$/, "") === v);
	if (!e) throw new Error(`都道府県が引けない：${v}`);
	return e[0];
}

async function getJson(url) {
	const r = await fetch(url, { headers: { "User-Agent": "ortho-earth jp-open-data" } });
	if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
	const buf = Buffer.from(await r.arrayBuffer());
	const text = buf[0] === 0x1f && buf[1] === 0x8b ? (await import("node:zlib")).gunzipSync(buf).toString("utf8") : buf.toString("utf8");
	return JSON.parse(text);
}
async function check(rows) {
	for (const r of rows.filter(r => r.url).slice(0, max)) {
		const u = String(r.url).split("#")[0];
		try {
			const res = await fetch(u, { headers: { Range: "bytes=0-0", "User-Agent": "ortho-earth jp-open-data" }, signal: AbortSignal.timeout(20000) });
			r.status = res.status; await res.body?.cancel();
		} catch (e) { r.status = `ERR ${e.cause?.code || e.message}`; }
	}
	return rows;
}
const done = async rows => out(opt.check ? await check(rows) : rows);

// 県コード＝目録の pref_code、無ければファイル名の「_13_」「_13.geojson」から（mesh500r6 等は目録が全国扱いで名前にだけ県が入る）
const prefOf = f => {
	if (f.pref_code != null && f.pref_code !== "") return String(f.pref_code).padStart(2, "0");
	const m = [...String(f.target).split("/").pop().matchAll(/_(\d{2})(?=[_.])/g)].map(x => x[1]).filter(v => +v >= 1 && +v <= 47);
	return m.length ? m[m.length - 1] : null;
};

// ---- 国土数値情報（国交省）＝R2 の目録（scripts/make-catalog-json.js が nlftp から作った物）----
async function nlftp() {
	const index = await getJson(`${API}/bucket/catalog/index.json`);
	if (!opt.code) {   // 探す：題名・コードで
		const q = String(opt.q || opt._?.[0] || "");
		return out(index.filter(d => !q || `${d.title}${d.dataset_code}${d.note || ""}`.includes(q))
			.map(d => ({ code: d.dataset_code, title: d.title, license: d.license, files: d.file_count })));
	}
	const ds = await getJson(`${API}/bucket/catalog/${opt.code}.json`);
	const pc = prefCode(opt.pref) || (opt.city ? cityCode(opt.city).slice(0, 2) : null), cc = opt.city ? cityCode(opt.city) : null;
	let files = ds.files || [];
	if (files.some(f => f.format === "geojson")) files = files.filter(f => f.format !== "shp");   // アプリと同じ＝GeoJSON があれば SHP は出さない
	if (opt.year) files = files.filter(f => String(f.year) === String(opt.year));
	else { const y = Math.max(...files.map(f => +f.year || 0)); if (y) files = files.filter(f => +f.year === y); }   // 既定＝最新年
	if (opt.fmt) files = files.filter(f => f.format === opt.fmt);
	if (opt.mesh) files = files.filter(f => String(f.location_code) === String(opt.mesh));
	if (pc) {
		const inPref = files.filter(f => prefOf(f) === pc);
		if (inPref.length) files = inPref;
		else if (files.some(f => /^\d{4}$/.test(String(f.location_code ?? "")))) {   // 1 次メッシュ単位（A31b 等）＝県では絞れない
			console.error(`※ ${ds.dataset_code} は 1 次メッシュ単位のファイル（${files.length} 本）＝県では絞れない。--mesh <4 桁>（例 東京 5339）で絞る`);
			files = [];
		} else files = files.filter(f => f.scope === "全国" || f.pref_code == null);   // 県の物が無ければ全国版
	}
	if (cc) {
		const byCity = c => files.filter(f => new RegExp(`_${c}\\.(geojson|shp)$`, "i").test(f.target.split("#")[1] || ""));
		let inCity = byCity(cc);
		if (!inCity.length && !cc.endsWith("00")) inCity = byCity(`${cc.slice(0, 3)}00`);   // 政令市の区（14101）＝市（14100）のファイル
		if (inCity.length) files = inCity;
	}
	await done(files.map(f => ({
		dataset: ds.dataset_code, title: ds.title, year: f.year, scope: f.scope, pref: prefOf(f), mesh: /^\d{4}$/.test(String(f.location_code ?? "")) ? f.location_code : undefined, format: f.format,
		url: f.target, zip: f.target.split("#")[0], member: f.target.split("#")[1] || null, size: f.size ?? null,
		license: ds.license, attribution: "国土交通省 国土数値情報", page: ds.page_url || null,
	})));
}

// ---- 法務省 登記所備付地図（G空間情報センター）----
async function moj() {
	const cc = cityCode(opt.city);
	if (!cc) throw new Error("--city が要る");
	const geo = json("apps/gishub-jp/moj/geojson.json").filter(e => e.name.startsWith(cc));
	const pbf = json("apps/gishub-jp/moj/pbf-manifest.json").filter(e => e.cityCode === cc);
	const zips = json("apps/gishub-jp/moj/manifest.json").filter(e => e.cityCode === cc);
	await done([
		...geo.map(e => ({ kind: "筆ポリゴン GeoJSON（変換済み・速い）", name: e.name, url: e.target, page: e.link, license: "CC BY 4.0", attribution: "法務省 登記所備付地図" })),
		...pbf.map(e => ({ kind: "筆ポリゴン GeoPBF（変換済み）", name: e.name, url: e.target, license: "CC BY 4.0", attribution: e.attribution })),
		...zips.map(e => ({ kind: "原本 zip（地図 XML）", name: e.title, url: e.url, size: e.size, page: `https://www.geospatial.jp/ckan/dataset/${e.packageName}`, license: "CC BY 4.0", attribution: "法務省 登記所備付地図" })),
	]);
}

// ---- 農林水産省 筆ポリゴン＝ortho-earth の bucket に変換済み GeoPBF（原本 open.fude.maff.go.jp）----
const MAFF_NO_DATA = /MAFF_NO_DATA = new Set\(\[([\s\S]*?)\]\)/.exec(readFileSync(resolve(G, "maff/ui.ts"), "utf8"))?.[1].match(/\d{6}/g) ?? [];
async function maff() {
	const cc = cityCode(opt.city), pc = prefCode(opt.pref);
	const rows = json("apps/gishub-jp/maff/manifest.json").filter(e => cc ? e.prefCityCd.startsWith(cc) : pc ? e.prefCd === pc : false);
	if (!rows.length) throw new Error("--city か --pref が要る（または該当なし）");
	await done(rows.map(e => MAFF_NO_DATA.includes(e.prefCityCd)
		? { city: `${e.prefName}${e.cityName}`, url: null, note: "筆ポリゴン（農地）の無い区＝データ無し" }
		: { city: `${e.prefName}${e.cityName}`, year: e.year, format: "geopbf", url: `${API}/bucket/GIS/pbf/maff_${e.prefCityCd}.geopbf`, size: e.size || null,
			license: "CC BY 4.0", attribution: "農林水産省 筆ポリゴン", page: "https://open.fude.maff.go.jp/" }));
}

// ---- 総務省 統計 GIS 小地域境界（e-Stat・2020 国勢調査）----
async function estat() {
	const cc = cityCode(opt.city), pc = prefCode(opt.pref);
	const SURVEY = /ESTAT_SURVEY\s*=\s*'([^']+)'/.exec(readFileSync(resolve(G, "estat/ui.ts"), "utf8"))[1];
	const rows = json("apps/gishub-jp/estat/manifest.json").filter(e => cc ? e.code === cc : pc ? e.prefCode === pc : false);
	if (!rows.length) throw new Error("--city か --pref が要る（または該当なし）");
	await done(rows.map(e => ({ city: e.name, code: e.code, format: "shape（zip・e-Stat は CORS 不可＝ブラウザからは proxy 経由）",
		url: `https://www.e-stat.go.jp/gis/statmap-search/data?dlserveyId=${SURVEY}&code=${e.code}&coordSys=1&format=shape&downloadType=5&datum=2011`,
		size: e.size, license: "CC BY（政府標準利用規約）", attribution: "総務省統計局 e-Stat 統計GIS" })));
}

// ---- 市区町村のオープンデータ（G空間情報センター・データカタログ横断検索の写し）----
async function munic() {
	const cc = cityCode(opt.city);
	if (!cc) throw new Error("--city が要る");
	const f = resolve(G, `munic/pref/${cc.slice(0, 2)}.json`);
	if (!existsSync(f)) return out([]);
	const q = String(opt.q || "");
	const all = JSON.parse(readFileSync(f, "utf8"));
	let list = all.filter(e => e.code === cc);
	if (!list.length) list = all.filter(e => e.code === `${cc.slice(0, 3)}00`);   // 政令市の区（14101 等）＝市（14100）の物
	const rows = [];
	for (const e of list) for (const s of e.sets) for (const r of s.res) {
		if (q && !`${s.title}${s.cat}${r.name}`.includes(q)) continue;
		rows.push({ city: `${e.pref}${e.city}`, set: s.title, category: s.cat, name: r.name, format: r.fmt, url: r.url, page: s.page, license: s.license, source: s.src });
	}
	await done(rows);
}

// ---- 決まった URL の物 ----
async function fixed() {
	const manifest = json("packages/jp/shared-data/manifest.json");
	await done([
		{ name: "国立公園 区域・地種区分（全 35 公園）", url: `${API}/bucket/GIS/pbf/nps_all`, format: "geopbf", license: "政府標準利用規約（CC BY 4.0 互換）", attribution: "環境省 環境ジオポータル" },
		{ name: "地震観測施設（11 観測網）", url: `${ORTHO_DATA}jishin/seismic.geopbf`, format: "geopbf", license: "文科省利用規約（CC BY 互換）", attribution: "地震調査研究推進本部" },
		{ name: "震源断層モデル（2009 年版）", url: `${ORTHO_DATA}jishin/fault.geopbf`, format: "geopbf", license: "文科省利用規約（CC BY 互換）", attribution: "地震調査研究推進本部" },
		{ name: "アメダス観測所", url: `${ORTHO_DATA}jma/amedas.geopbf`, format: "geopbf", license: "公共データ利用規約（CC BY 互換）", attribution: "気象庁" },
		...Object.entries(manifest).map(([name, key]) => ({ name: `国勢調査などの集計表 ${name}`, url: `${API}/bucket/${key}`, format: name.split(".").pop(), license: "CC BY", attribution: "総務省統計局" })),
	]);
}

const CMDS = { place: async () => out(place(opt._?.[0] || opt.q || "")), nlftp, moj, maff, estat, munic, fixed };
if (!CMDS[cmd]) { console.error(`使い方：find.mjs ${Object.keys(CMDS).join("|")} [--q 語] [--code 国土数値情報のコード] [--pref 県] [--city 市区町村] [--year 年] [--fmt geojson|shp] [--mesh 4 桁] [--check] [--max N]`); process.exit(1); }
CMDS[cmd]().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });
