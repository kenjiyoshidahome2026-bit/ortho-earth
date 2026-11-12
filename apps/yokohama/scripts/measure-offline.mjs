#!/usr/bin/env node
// 横浜の完全オフライン化（Kenji 2026-11-12「通信が可能な場所で一気にダウンロードしてデータベースを更新」）の容量見積り。
// 横浜市の外接矩形について、基図（地理院 optimal_bvmap）・災害の想定（重ねるハザードマップ）・建物（PLATEAU 3D Tiles 18 区＋橋梁）・
// 台帳（ortho-data）・避難場所の数と容量を数える。ネットのある Mac で走らせる（コンテナは外へ出られない）。
//   node apps/yokohama/scripts/measure-offline.mjs [--zmax=16] [--sample=250] [--out=measure.json]
// 小さいズームは全部取って数える。大きいズームは無作為に sample 枚だけ取り、平均×枚数で見積もる（404＝その枡に何も無い＝0 B）。
// 3D Tiles は tileset.json を辿って content の URL を全部集め、HEAD の Content-Length で数える（無ければ GET）。
import { writeFileSync } from "node:fs";

const arg = (k, d) => { const a = process.argv.find(s => s.startsWith(`--${k}=`)); return a ? a.split("=")[1] : d; };
const ZMAX = +arg("zmax", 16), SAMPLE = +arg("sample", 250), OUT = arg("out", "");
const BBOX = [139.46, 35.31, 139.73, 35.60];   // data.ts CITY_BBOX
const BASEMAP = "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/{z}/{x}/{y}.pbf";
const DP = "https://disaportaldata.gsi.go.jp/raster/";
const HAZARDS = { flood: "01_flood_l2_shinsuishin_data", hightide: "03_hightide_l2_shinsuishin_data", tsunami: "04_tsunami_newlegend_data",
	dosha1: "05_dosekiryukeikaikuiki", dosha2: "05_kyukeishakeikaikuiki", dosha3: "05_jisuberikeikaikuiki" };
const LEDGERS = "https://kenjiyoshidahome2026-bit.github.io/ortho-data/japan/yokohama/";
const SHELTERS = "https://api.ortho-earth.com/bucket/bousai/hinan/14.json";

const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
const tiles = z => { const out = []; for (let x = lon2x(BBOX[0], z); x <= lon2x(BBOX[2], z); x++) for (let y = lat2y(BBOX[3], z); y <= lat2y(BBOX[1], z); y++) out.push([z, x, y]); return out; };
const url = (tpl, [z, x, y]) => tpl.replace("{z}", z).replace("{x}", x).replace("{y}", y);

async function pool(items, n, fn) { let i = 0; const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }; await Promise.all(Array.from({ length: n }, run)); }
async function bytesOf(u, head = false) {
	for (let a = 0; a < 3; a++) {
		try {
			const r = await fetch(u, { method: head ? "HEAD" : "GET" });
			if (r.status === 404) return 0;
			if (!r.ok) throw new Error(String(r.status));
			if (head) { const n = +(r.headers.get("content-length") || NaN); if (Number.isFinite(n)) return n; return bytesOf(u, false); }
			return (await r.arrayBuffer()).byteLength;
		} catch (e) { if (a === 2) { console.warn("  !", u, e.message); return -1; } await new Promise(s => setTimeout(s, 500 * (a + 1))); }
	}
}
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

async function xyz(name, tpl, zmin, zmax) {
	let total = 0, count = 0, present = 0; const per = [];
	for (let z = zmin; z <= zmax; z++) {
		const all = tiles(z), pick = all.length <= SAMPLE ? all : shuffle(all.slice()).slice(0, SAMPLE);
		let sum = 0, hit = 0, ok = 0;
		await pool(pick, 12, async t => { const b = await bytesOf(url(tpl, t)); if (b >= 0) { ok++; sum += b; if (b > 0) hit++; } });
		const est = ok ? sum / ok * all.length : 0, estHit = ok ? hit / ok * all.length : 0;
		per.push({ z, tiles: all.length, sampled: pick.length, present: Math.round(estHit), mb: +(est / 1e6).toFixed(1) });
		total += est; count += all.length; present += estHit;
	}
	console.log(`${name}: ${count} tiles (${Math.round(present)} with data) ≈ ${(total / 1e6).toFixed(0)} MB`, per.map(p => `z${p.z}:${p.mb}`).join(" "));
	return { name, tiles: count, present: Math.round(present), mb: +(total / 1e6).toFixed(1), per };
}

// 3D Tiles：tileset.json を辿る（子の tileset.json も）
async function tileset(name, root) {
	const contents = new Set(), seen = new Set();
	const walk = async (u) => {
		if (seen.has(u)) return; seen.add(u);
		const j = await (await fetch(u)).json();
		const kids = [];
		const visit = (t) => {
			for (const c of [t.content, ...(t.contents || [])].filter(Boolean)) {
				const ref = c.uri ?? c.url; if (!ref) continue;
				const abs = new URL(ref, u).href;
				if (/\.json(\?|$)/.test(abs)) kids.push(abs); else contents.add(abs);
			}
			for (const ch of t.children || []) visit(ch);
		};
		visit(j.root);
		for (const k of kids) await walk(k);
	};
	await walk(root);
	let sum = 0, fail = 0; const list = [...contents];
	await pool(list, 16, async u => { const b = await bytesOf(u, true); if (b < 0) fail++; else sum += b; });
	console.log(`${name}: ${list.length} files ≈ ${(sum / 1e6).toFixed(0)} MB${fail ? ` (${fail} failed)` : ""}`);
	return { name, files: list.length, mb: +(sum / 1e6).toFixed(1), failed: fail };
}

const res = { at: new Date().toISOString(), bbox: BBOX, zmax: ZMAX, basemap: null, hazards: [], buildings: [], ledgers: null, shelters: null };
res.basemap = await xyz("basemap (GSI optimal_bvmap)", BASEMAP, 4, ZMAX);
for (const [k, d] of Object.entries(HAZARDS)) res.hazards.push(await xyz(`hazard ${k}`, `${DP}${d}/{z}/{x}/{y}.png`, 10, 17));

// 建物＝エンジンの登録簿（packages/jp/assets/plateau-sets.json）の横浜 18 区＋橋梁
const sets = (await import("node:fs")).readFileSync(new URL("../../../packages/jp/assets/plateau-sets.json", import.meta.url), "utf8");
for (const s of JSON.parse(sets).filter(s => s.name.startsWith("横浜"))) res.buildings.push({ ...(await tileset(s.name, s.base + "tileset.json")), lod: s.lod ?? 2 });

// 台帳（ortho-data）と避難場所
const files = ["wards", "rail", "bus", "facilities", "facilities-en", "photos", "places", "school-e", "school-j", "zoning", "station-wiki", "census"].map(n => `${LEDGERS}${n}.json`);
let led = 0; await pool(files, 6, async u => { const b = await bytesOf(u); if (b > 0) led += b; });
res.ledgers = { mb: +(led / 1e6).toFixed(1), note: "walk/*.bin 4.5 MB と census/ 1.7 MB は repo の ortho-data で実測済み" };
res.shelters = { mb: +((await bytesOf(SHELTERS)) / 1e6).toFixed(2) };

const sum = (a) => a.reduce((s, x) => s + x.mb, 0);
const bLod1 = sum(res.buildings.filter(b => b.lod === 1)), bLod2 = sum(res.buildings.filter(b => b.lod !== 1));
console.log(`\n== 合計（目安）==\n基図 z4-${ZMAX}: ${res.basemap.mb} MB\n災害の想定 6 種 z10-17: ${sum(res.hazards).toFixed(0)} MB\n建物 LOD1 13 区: ${bLod1.toFixed(0)} MB / LOD2 5 区＋橋梁: ${bLod2.toFixed(0)} MB\n台帳: ${res.ledgers.mb} MB＋歩く道 4.5 MB・統計 1.7 MB / 避難場所: ${res.shelters.mb} MB`);
if (OUT) writeFileSync(OUT, JSON.stringify(res, null, 1));
