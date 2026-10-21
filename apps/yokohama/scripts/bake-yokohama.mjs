#!/usr/bin/env node
// 横浜市デジタルツインの台帳を組む（外部網が要る＝手元の Mac で走らせる）→ リポの根の ortho-data/japan/yokohama/*.json（git で追う・DATA.md）。
// 置く＝`npm run publish:pages -w world-data -- --scope=japan --only=yokohama --write`（予行は --write なし）。頁は __DATA_JAPAN__ + "yokohama/" を読む。
//
//   node apps/yokohama/scripts/bake-yokohama.mjs            # 全部
//   node apps/yokohama/scripts/bake-yokohama.mjs --inspect  # 各 zip の属性の鍵と見本 3 行だけ出す（KSJ の列名を確かめる）
//   node apps/yokohama/scripts/bake-yokohama.mjs --only=wards,rail,bus,facilities,photos
//
// 出す物（座標は経度・緯度の小数 5 桁＝約 1m）：
//   wards.json      … 18 区の境界（N03）{ type:"FeatureCollection", features:[{ properties:{ code, name, bbox:[w,s,e,n] }, geometry }], city:[[[lon,lat]…]…] }（間引き 約 10m）
//                     city＝市の外周の環（区の境で接する辺を消して繋ぐ）＝頁が市の外を薄く覆う覆いの穴
//   rail.json       … 鉄道（N02）{ lines: FeatureCollection（properties { line, op, subway:0|1 }）, stations: [[lon, lat, 駅名, "事業者 路線・…", subway:0|1]] }
//   bus.json        … 横浜市営バスの停留所（P11）{ stops: [[lon, lat, 停留所名, "系統・…"]] }
//   facilities.json … 公共施設（KSJ の P05・P29・P27・P28・P17・P18・P04）{ cats: [名…], rows: [[lon, lat, 名称, 区分の番号, 住所, 種別]] }
//   photos.json     … 名所の写真（Wikipedia の記事の代表画像＝Wikimedia Commons）{ [名所 id]: { src, file, artist, license, page } }
// 生の zip は .cache/（git に入れない）に置き、2 回目からはそれを読む（--refresh で取り直し）。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { WARDS, SPOTS, CITY_BBOX } from "../data.ts";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "../../..");
const OUT = path.join(ROOT, "ortho-data/japan/yokohama");
const CACHE = path.join(HERE, ".cache");
const args = process.argv.slice(2);
const INSPECT = args.includes("--inspect"), REFRESH = args.includes("--refresh");
const ONLY = (args.find(a => a.startsWith("--only="))?.slice(7) || "wards,rail,bus,facilities,photos").split(",");
const KSJ = "https://nlftp.mlit.go.jp/ksj/gml/data/";
const UA = { "User-Agent": "ortho-earth-yokohama/0.1 (https://github.com/kenjiyoshidahome2026-bit/ortho-earth)" };
fs.mkdirSync(CACHE, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });

// 市の外接矩形に少し余白（市境をまたぐ線と駅を切らない）
const M = 0.02, BOX = [CITY_BBOX[0] - M, CITY_BBOX[1] - M, CITY_BBOX[2] + M, CITY_BBOX[3] + M];
const inBox = ([x, y]) => x >= BOX[0] && x <= BOX[2] && y >= BOX[1] && y <= BOX[3];
const r5 = v => Math.round(v * 1e5) / 1e5;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 取得（キャッシュ）──
async function getBuf(url) {
	const file = path.join(CACHE, url.replace(/^https?:\/\//, "").replace(/[^\w.-]+/g, "_"));
	if (!REFRESH && fs.existsSync(file)) return fs.readFileSync(file);
	for (let i = 0; ; i++) {
		const r = await fetch(url, { headers: UA }).catch(e => ({ ok: false, status: String(e) }));
		if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); fs.writeFileSync(file, b); return b; }
		if (i >= 3 || r.status === 404) throw new Error(`${url}: HTTP ${r.status}`);
		await sleep(2000 * 2 ** i);
	}
}

// ── zip（中央ディレクトリを読むだけ・deflate／無圧縮）──
function unzip(buf) {
	let eocd = buf.length - 22;
	while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
	if (eocd < 0) throw new Error("zip: EOCD なし");
	const n = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	const out = new Map();
	for (let i = 0; i < n; i++) {
		const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
		const flags = buf.readUInt16LE(p + 8), off = buf.readUInt32LE(p + 42);
		const raw = buf.subarray(p + 46, p + 46 + nl);
		const name = flags & 0x800 ? raw.toString("utf8") : new TextDecoder("shift_jis").decode(raw);
		p += 46 + nl + xl + cl;
		out.set(name, () => {
			const lo = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
			const data = buf.subarray(lo, lo + csize);
			return method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
		});
	}
	return out;
}
const pick = (zip, re) => [...zip.keys()].find(k => re.test(k.split("/").pop()));

// ── shapefile（点・線・面）＋ dbf（Shift_JIS／UTF-8）＝geojson の無い古い KSJ 用 ──
function readDbf(b, enc) {
	const n = b.readUInt32LE(4), hl = b.readUInt16LE(8), rl = b.readUInt16LE(10);
	const dec = new TextDecoder(enc);
	const fields = [];
	for (let o = 32; b[o] !== 0x0d; o += 32) fields.push({ name: b.subarray(o, o + 11).toString("latin1").replace(/\0.*$/, ""), len: b[o + 16] });
	const rows = [];
	for (let i = 0; i < n; i++) {
		let o = hl + i * rl + 1; const row = {};
		for (const f of fields) { row[f.name] = dec.decode(b.subarray(o, o + f.len)).trim(); o += f.len; }
		rows.push(row);
	}
	return rows;
}
function readShp(b) {
	const geoms = [];
	for (let o = 100; o + 8 <= b.length;) {
		const len = b.readInt32BE(o + 4) * 2, t = b.readInt32LE(o + 8), c = o + 8;
		if (t === 1) geoms.push({ type: "Point", coordinates: [b.readDoubleLE(c + 4), b.readDoubleLE(c + 12)] });
		else if (t === 3 || t === 5) {
			const np = b.readInt32LE(c + 36), nn = b.readInt32LE(c + 40), parts = [];
			for (let i = 0; i < np; i++) parts.push(b.readInt32LE(c + 44 + i * 4));
			const pts = c + 44 + np * 4, rings = [];
			for (let i = 0; i < np; i++) { const ring = []; for (let k = parts[i]; k < (parts[i + 1] ?? nn); k++) ring.push([b.readDoubleLE(pts + k * 16), b.readDoubleLE(pts + k * 16 + 8)]); rings.push(ring); }
			geoms.push(t === 3 ? { type: "MultiLineString", coordinates: rings } : { type: "MultiPolygon", coordinates: rings.map(r => [r]) });
		} else geoms.push(null);
		o += 8 + len;
	}
	return geoms;
}
/** KSJ の zip → 地物の配列。名前が re に合う .geojson を優先、無ければ .shp＋.dbf */
async function ksjFeatures(url, re) {
	const zip = unzip(await getBuf(url));
	const gj = pick(zip, new RegExp(re.source + "\\.geojson$", "i"));
	if (gj) return JSON.parse(zip.get(gj)().toString("utf8")).features;
	const shp = pick(zip, new RegExp(re.source + "\\.shp$", "i")), dbf = shp && pick(zip, new RegExp(re.source + "\\.dbf$", "i"));
	if (!shp || !dbf) throw new Error(`${url}: ${re} の geojson も shp も無い。中身＝${[...zip.keys()].join(", ")}`);
	const cpg = pick(zip, new RegExp(re.source + "\\.cpg$", "i"));
	const enc = cpg && /utf/i.test(zip.get(cpg)().toString()) ? "utf-8" : "shift_jis";
	const g = readShp(zip.get(shp)()), rows = readDbf(zip.get(dbf)(), enc);
	return rows.map((properties, i) => ({ type: "Feature", properties, geometry: g[i] }));
}
const firstPt = g => { let c = g?.coordinates; while (Array.isArray(c?.[0])) c = c[0]; return c; };
const inspect = (label, feats) => {
	console.log(`\n■ ${label}: ${feats.length} 件  鍵＝${Object.keys(feats[0]?.properties || {}).join(" ")}`);
	for (const f of feats.filter(f => inBox(firstPt(f.geometry) || [0, 0])).slice(0, 3)) console.log("  ", JSON.stringify(f.properties), f.geometry?.type);
};
const write = (name, obj) => { const s = JSON.stringify(obj); fs.writeFileSync(path.join(OUT, name), s); console.log(`→ ortho-data/japan/yokohama/${name}  ${(s.length / 1024).toFixed(0)} KB`); };

// ── 間引き（Douglas–Peucker・度のまま＝横浜の範囲なら十分）──
function dp(pts, tol) {
	if (pts.length < 4) return pts;
	const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
	const st = [[0, pts.length - 1]];
	while (st.length) {
		const [a, b] = st.pop(); let md = 0, mi = -1;
		const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1e-18;
		for (let i = a + 1; i < b; i++) { const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / L)); const d = Math.hypot(pts[i][0] - ax - t * dx, pts[i][1] - ay - t * dy); if (d > md) { md = d; mi = i; } }
		if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
	}
	return pts.filter((_, i) => keep[i]).map(([x, y]) => [r5(x), r5(y)]);
}

// 市の外周＝全区の環の辺のうち、2 区で共有される辺（N03 は隣の区と同じ頂点を持つ）を消し、残った辺を繋いで環にする
function outline(rings) {
	const pk = p => `${p[0]},${p[1]}`, ek = (a, b) => pk(a) < pk(b) ? `${pk(a)}|${pk(b)}` : `${pk(b)}|${pk(a)}`;   // 向きを問わない辺の鍵
	const cnt = new Map();
	for (const r of rings) for (let i = 0; i + 1 < r.length; i++) { const k = ek(r[i], r[i + 1]); cnt.set(k, (cnt.get(k) || 0) + 1); }
	const next = new Map();   // 外周の辺だけ：始点 → 終点
	for (const r of rings) for (let i = 0; i + 1 < r.length; i++) {
		const a = r[i], b = r[i + 1];
		if (cnt.get(ek(a, b)) > 1) continue;
		if (!next.has(pk(a))) next.set(pk(a), []);
		next.get(pk(a)).push(b);
	}
	const out = [];
	for (const [k0, ends] of next) while (ends.length) {
		const ring = [k0.split(",").map(Number)]; let cur = ends.pop();
		for (let g = 0; g < 1e6; g++) {
			ring.push(cur);
			const k = pk(cur); if (k === k0) break;
			const nx = next.get(k); if (!nx?.length) break;
			cur = nx.pop();
		}
		if (ring.length >= 4 && `${ring.at(-1)}` === `${ring[0]}`) out.push(ring);
	}
	return out;
}

// ── 1. 区の境界（N03）──
async function wards() {
	const feats = await ksjFeatures(`${KSJ}N03/N03-2025/N03-20250101_14_GML.zip`, /N03-\d+_14/);
	if (INSPECT) return inspect("N03", feats);
	const out = [], rawRings = [];
	for (const w of WARDS) {
		const polys = [];
		for (const f of feats) if (f.properties.N03_007 === w.code) {
			const g = f.geometry; const ps = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
			for (const p of ps) { rawRings.push(p[0]); const ring = dp(p[0], 0.0001); if (ring.length >= 4) polys.push([ring]); }   // 0.0001°＝約 10m・穴は持たない（区に穴は無い）
		}
		if (!polys.length) throw new Error(`N03: ${w.name}（${w.code}）が無い`);
		let bb = [180, 90, -180, -90];
		for (const p of polys) for (const [x, y] of p[0]) bb = [Math.min(bb[0], x), Math.min(bb[1], y), Math.max(bb[2], x), Math.max(bb[3], y)];
		out.push({ type: "Feature", properties: { code: w.code, name: w.name, bbox: bb.map(r5) }, geometry: { type: "MultiPolygon", coordinates: polys } });
	}
	const city = outline(rawRings).map(r => dp(r, 0.0001)).filter(r => r.length >= 4);
	console.log(`区：${out.length}・市の外周の環 ${city.length}`);
	write("wards.json", { type: "FeatureCollection", features: out, city });
}

// ── 2. 鉄道（N02）＝線と駅。横浜市交通局（事業者「横浜市」）＝地下鉄 ──
async function rail() {
	const zipUrl = `${KSJ}N02/N02-25/N02-25_GML.zip`;
	const lines = await ksjFeatures(zipUrl, /N02-\d+_RailroadSection/), st = await ksjFeatures(zipUrl, /N02-\d+_Station/);
	if (INSPECT) { inspect("N02 RailroadSection", lines); return inspect("N02 Station", st); }
	const isSub = p => /^横浜市/.test(p.N02_004 || "");
	const ln = [];
	for (const f of lines) {
		const g = f.geometry; const parts = g.type === "LineString" ? [g.coordinates] : g.coordinates;
		const keep = parts.filter(c => c.some(inBox)).map(c => dp(c, 0.00003));
		if (keep.length) ln.push({ type: "Feature", properties: { line: f.properties.N02_003, op: f.properties.N02_004, subway: isSub(f.properties) ? 1 : 0 }, geometry: { type: "MultiLineString", coordinates: keep } });
	}
	// 駅＝N02 は駅のホームの線＝中点を代表点に。同じ名前で 400m 以内（乗換駅）は 1 点に畳み、乗り入れる路線を並べる。地下鉄は地下鉄だけで畳む（記号を付けるため）
	const raw = [];
	for (const f of st) {
		const c = (f.geometry.type === "LineString" ? f.geometry.coordinates : f.geometry.coordinates.flat());
		const m = c[Math.floor(c.length / 2)];
		if (inBox(m)) raw.push({ x: m[0], y: m[1], name: f.properties.N02_005, line: `${f.properties.N02_004} ${f.properties.N02_003}`, subway: isSub(f.properties) ? 1 : 0 });
	}
	const groups = [];
	for (const s of raw) {
		const g = groups.find(g => g.name === s.name && g.subway === s.subway && Math.hypot((g.x / g.n - s.x) * 0.82, g.y / g.n - s.y) < 0.004);
		if (g) { g.x += s.x; g.y += s.y; g.n++; g.lines.add(s.line); } else groups.push({ ...s, n: 1, lines: new Set([s.line]) });
	}
	const stations = groups.map(g => [r5(g.x / g.n), r5(g.y / g.n), g.name, [...g.lines].join("・"), g.subway]);
	console.log(`鉄道：線 ${ln.length}・駅 ${stations.length}（地下鉄 ${stations.filter(s => s[4]).length}）`);
	write("rail.json", { lines: { type: "FeatureCollection", features: ln }, stations });
}

// ── 3. 市営バスの停留所（P11）＝事業者に「横浜市」を含む停留所 ──
async function bus() {
	const feats = await ksjFeatures(`${KSJ}P11/P11-22/P11-22_14_GML.zip`, /P11-\d+_14/);
	if (INSPECT) return inspect("P11", feats);
	const vals = (p, re) => Object.keys(p).filter(k => re.test(k)).map(k => String(p[k] ?? "").trim()).filter(v => v && v !== "null" && v !== "None");
	const stops = [];
	for (const f of feats) {
		const p = f.properties, c = firstPt(f.geometry);
		if (!c || !inBox(c) || !vals(p, /^P11_003/).some(v => v.includes("横浜市"))) continue;
		stops.push([r5(c[0]), r5(c[1]), p.P11_001, [...new Set(vals(p, /^P11_004/))].join("・")]);
	}
	if (stops.length < 1000) throw new Error(`P11: 市営バスの停留所が ${stops.length} 件しか無い（列名を --inspect で確かめる）`);
	console.log(`市営バス：停留所 ${stops.length}`);
	write("bus.json", { stops });
}

// ── 4. 公共施設（KSJ の点データを束ねる）。cat＝頁の区分（data.ts の FACILITY_CATS と同じ並び）──
// name・addr・kind＝属性の鍵。keep＝この行を採るか（公立だけ等）。kind は区分の中の種別（「小学校」等）＝吹き出しに出す
const CATS = ["区役所・行政", "地区センター・集会", "学校", "図書館・文化", "消防", "警察", "病院"];
const SRC = [
	{ url: "P05/P05-22/P05-22_14_GML.zip", re: /P05-\d+_14/, label: "P05 市町村役場等・公的集会施設",
		cat: p => /役所|役場|支所|出張所|本庁|事務所/.test(p.P05_003) ? 0 : 1, name: "P05_003", addr: "P05_004", kind: p => ({ 1: "本庁", 2: "支所・出張所", 3: "公民館", 4: "集会施設" })[p.P05_002] || "" },
	{ url: "P29/P29-23/P29-23_14_GML.zip", re: /P29-\d+_14/, label: "P29 学校",
		cat: () => 2, name: "P29_004", addr: "P29_005", keep: p => ["1", "2", "3"].includes(String(p.P29_006)),   // 管理者＝国・都道府県・市区町村（公立）だけ
		kind: p => ({ 16001: "小学校", 16002: "中学校", 16003: "義務教育学校", 16004: "高等学校", 16005: "中等教育学校", 16006: "特別支援学校", 16007: "大学", 16008: "短期大学", 16009: "高等専門学校", 16011: "幼稚園", 16012: "幼保連携型認定こども園" })[p.P29_003] || "" },
	{ url: "P27/P27-13/P27-13_14_GML.zip", re: /P27-\d+_14/, label: "P27 文化施設", cat: () => 3, name: "P27_005", addr: "P27_006", kind: p => ({ 1: "図書館", 2: "博物館・美術館", 3: "公民館", 4: "劇場・ホール", 5: "その他" })[p.P27_004] || "" },
	{ url: "P28/P28-22/P28-22_14_GML.zip", re: /P28-\d+_14/, label: "P28 国・都道府県の機関", cat: () => 0, name: "P28_005", addr: "P28_006", kind: () => "国・県の機関" },
	{ url: "P17/P17-12/P17-12_14_GML.zip", re: /P17-\d+_14/, label: "P17 消防署", cat: () => 4, name: "P17_004", addr: "P17_005", kind: p => ({ 1: "消防本部", 2: "消防署", 3: "出張所" })[p.P17_003] || "" },
	{ url: "P18/P18-12/P18-12_14_GML.zip", re: /P18-\d+_14/, label: "P18 警察署", cat: () => 5, name: "P18_004", addr: "P18_005", kind: p => ({ 1: "警察本部", 2: "警察署", 3: "交番", 4: "駐在所" })[p.P18_003] || "" },
	{ url: "P04/P04-20/P04-20_14_GML.zip", re: /P04-\d+_14/, label: "P04 医療機関", cat: () => 6, name: "P04_002", addr: "P04_003", keep: p => String(p.P04_001) === "1", kind: () => "病院" },   // 病院だけ（診療所は数が多すぎる）
];
async function facilities() {
	const rows = [];
	for (const s of SRC) {
		let feats;
		try { feats = await ksjFeatures(KSJ + s.url, s.re); } catch (e) { console.warn(`✗ ${s.label}: ${e.message}`); if (!INSPECT) throw e; continue; }
		if (INSPECT) { inspect(s.label, feats); continue; }
		let n = 0;
		for (const f of feats) {
			const p = f.properties, c = firstPt(f.geometry);
			if (!c || !inBox(c) || (s.keep && !s.keep(p))) continue;
			const addr = String(p[s.addr] ?? "");
			if (addr && !/横浜市/.test(addr) && !/^141\d\d/.test(String(Object.values(p)[0]))) continue;   // 市外（川崎・鎌倉…）は落とす
			const name = String(p[s.name] ?? "").trim();
			if (!name) continue;
			rows.push([r5(c[0]), r5(c[1]), name, s.cat(p), addr, s.kind(p)]); n++;
		}
		console.log(`${s.label}: ${n} 件`);
		if (!n) throw new Error(`${s.label}: 0 件（列名を --inspect で確かめる）`);
	}
	if (INSPECT) return;
	write("facilities.json", { cats: CATS, rows });
}

// ── 5. 名所の写真（ja.wikipedia の代表画像 → Commons の作者と使用許諾）──
async function photos() {
	const api = "https://ja.wikipedia.org/w/api.php", commons = "https://commons.wikimedia.org/w/api.php";
	const get = async (base, q) => { await sleep(1500); const r = await fetch(`${base}?${new URLSearchParams({ format: "json", formatversion: "2", origin: "*", ...q })}`, { headers: UA }); if (!r.ok) throw new Error(`${base}: HTTP ${r.status}`); return r.json(); };
	const out = {};
	for (const s of SPOTS) {
		const d = await get(api, { action: "query", prop: "pageimages", piprop: "thumbnail|name", pithumbsize: "640", titles: s.wiki, redirects: "1" });
		const pg = d.query?.pages?.[0];
		if (!pg?.pageimage || !pg.thumbnail) { console.warn(`✗ 写真なし：${s.name}（${s.wiki}）`); continue; }
		const ii = (await get(commons, { action: "query", prop: "imageinfo", iiprop: "extmetadata", titles: `File:${pg.pageimage}` })).query?.pages?.[0]?.imageinfo?.[0]?.extmetadata;
		if (!ii) { console.warn(`✗ Commons に無い（ja だけの画像）：${s.name}`); continue; }
		const text = v => String(v?.value ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
		out[s.id] = { src: pg.thumbnail.source, file: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(pg.pageimage)}`, artist: text(ii.Artist).slice(0, 80), license: text(ii.LicenseShortName), page: `https://ja.wikipedia.org/wiki/${encodeURIComponent(pg.title)}` };
		console.log(`写真：${s.name} ← ${pg.pageimage}（${out[s.id].license}）`);
	}
	write("photos.json", out);
}

for (const [k, fn] of Object.entries({ wards, rail, bus, facilities, photos })) if (ONLY.includes(k) && !(INSPECT && k === "photos")) await fn();
console.log(INSPECT ? "\n（--inspect：何も書いていない）" : "\n✓ 出来た。置く＝npm run publish:pages -w world-data -- --scope=japan --only=yokohama --write");
