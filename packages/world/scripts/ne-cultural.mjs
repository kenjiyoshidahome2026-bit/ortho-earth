#!/usr/bin/env node
// Natural Earth 10m（v5.1.2 固定）の鉄道・道路・市街地・湖・人口密集地（点）・admin1 を、world の key（seed/nations.csv）ごとに切り分けて
// out/ne-cultural.geopbf に 1 層で書く（属性 key / layer・--split で out/ne-cultural/<key>/<layer>.geopbf にも分割）。NE の Cultural 区分＝国別（ne-physical.mjs が Physical＝地形）。国の領域は createGeometryPNG と同じ定義（Kenji 指示 2026-09-14「key は world を参考に」）:
//   - 主（互いに重ならない分割）: ne_10m_admin_1_states_provinces を fixISO（iso_a2＋名前の割替え＋FR/NL の海外県）で key に束ねたもの
//   - 重ね（overlay）: key の admin1 が無い係争主体（B20 北キプロス・B28 SADR・B30 ソマリランド・B35/B37 アブハジア/南オセチア・
//     B36 沿ドニエストル・B38 アルツァフ・B89 クリミア・C02/C03 ドネツク/ルハンスク）は ne_10m_admin_0_disputed_areas の BRK_A3 で
//     独立に切り出す＝主の分割と重複する（world の geo_tub と同じ）。その型のポリゴンを admin_0.geopbf として同じフォルダに置く（Kenji 2026-09-15）
// 線（鉄道・道路）は境界で切り、面（市街地・湖）は境界を跨ぐものだけ polygon-clipping で交差を取る。この 3 層は属性を持たず key ごとに\n// 1 地物（MultiLineString / MultiPolygon）に束ねる（Kenji 2026-09-14・湖は同日追加）。境界を跨がない面はそのまま。
// 海上の断片（フェリー丸ごと＋線が領域の外を通る区間・1 km 未満の短い外れは海岸線の丸めとみなして繋ぐ）は国のデータに入れず routes/<layer>.geopbf に
// 属性付きで別置き＝航路として使う（Kenji 2026-09-14）。点は内外判定（どの領域にも入らない沿岸点は最寄りの領域へ＝ne_clip:"nearest"）。admin1 は属性で束ねる。
// 使い方: node scripts/ne-cultural.mjs [--out PATH(拡張子なし)] [--split] [--geojson] [--only JP,FR] [--layers railroads,roads] [--precision 6]
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import polygonClipping from "polygon-clipping";
import { GeoPBF } from "../../geopbf/src/pbf-base.js";
import { parseCSV } from "../build/csv.js";

globalThis.ImageData ??= class ImageData { constructor(data, width, height) { this.data = data; this.width = width; this.height = height; } };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NE_TAG = "v5.1.2";
const CACHE = path.join(ROOT, ".cache/ne");
const ARGS = process.argv.slice(2);
const opt = (name, dflt) => { const i = ARGS.indexOf("--" + name); return i < 0 ? dflt : (ARGS[i + 1] && !ARGS[i + 1].startsWith("--") ? ARGS[i + 1] : true); };
const OUT = path.resolve(ROOT, typeof opt("out") === "string" ? opt("out") : "out/ne-cultural");
const WANT_GEOJSON = !!opt("geojson", false);
const ONLY = typeof opt("only") === "string" ? new Set(opt("only").split(",")) : null;
const LAYERS = new Set((typeof opt("layers") === "string" ? opt("layers") : "railroads,roads,urban_areas,lakes,populated_places,admin_1,admin_0").split(","));
const PRECISION = +opt("precision", 6);
const ATTR = `Natural Earth 10m ${NE_TAG} (public domain), split by ortho-earth world keys`;
const T0 = Date.now();
const log = (...a) => console.error(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

// ── Natural Earth の取得（.cache/ne に版固定で置く・terrains-from-ne.py と同じ流儀） ────────────────────────
async function ne(name) {
	await mkdir(CACHE, { recursive: true });
	const p = path.join(CACHE, `${name}.${NE_TAG}.geojson`);
	if (!existsSync(p)) {
		log(`fetch ${name}`);
		const r = await fetch(`https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_TAG}/geojson/${name}.geojson`);
		if (!r.ok) throw new Error(`fetch failed ${name}: ${r.status}`);
		await writeFile(p, Buffer.from(await r.arrayBuffer()));
	}
	return JSON.parse(await readFile(p, "utf8")).features;
}

// ── key の割当（apps/uploader/src/world/createGeometryPNG.js の fixISO の移植・name_ja と name の両方で引く） ──
const NAME_KEY = {
	"デケリア": "CY", "Dhekelia": "CY", "アクロティリ": "CY", "Akrotiri": "CY", "北キプロス": "CY", "Northern Cyprus": "CY",
	"ソマリランド": "SO", "Somaliland": "SO", "グアンタナモ湾収容キャンプ": "CU", "Guantanamo Bay USNB": "CU",
	"バイコヌール": "KZ", "Baykonur lease in Qyzylorda": "KZ", "コーラル・シー諸島": "AU", "Coral Sea Islands": "AU",
	"ココス諸島": "CC", "Cocos (Keeling) Islands": "CC", "クリスマス島": "CX", "Christmas Island": "CX",
	"カシミール": "B45", "Kashmir": "B45", "南沙諸島": "B46", "Spratly Islands": "B46", "クリッパートン島": "FR-CP", "Clipperton Island": "FR-CP",
	"ブーベ島": "BV", "Bouvet Island": "BV", "スヴァールバル諸島": "SJ", "Svalbard": "SJ", "ヤンマイエン島": "SJ", "Jan Mayen": "SJ",
};
const ISO2_KEY = { "FR-RE": "RE", "FR-YT": "YT", "FR-GF": "GF", "FR-MQ": "MQ", "FR-GP": "GP", "NL-BQ1": "BQ", "NL-BQ2": "BQ", "NL-BQ3": "BQ" };
function keyOfAdmin1(p) {
	let k = NAME_KEY[p.name_ja] ?? NAME_KEY[p.name] ?? p.iso_a2;
	if ((k === "FR" || k === "NL") && ISO2_KEY[p.iso_3166_2]) k = ISO2_KEY[p.iso_3166_2];
	return k;
}

// ── 領域索引: 部分ポリゴン（外環＋穴）ごとに辺を緯度帯へ振り分け、1° 格子で候補を引く ────────────────────────
const ringOpen = r => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) ? r.slice(0, -1) : r;
class RegionIndex {
	constructor() { this.parts = []; this.grid = new Map(); this.stampN = 0; }
	add(key, rings, overlay = false) {            // rings: GeoJSON Polygon の座標（[外環, ...穴]）
		rings = rings.map(ringOpen).filter(r => r.length >= 3);
		if (!rings.length) return;
		let n = 0; for (const r of rings) n += r.length;
		const ex = new Float64Array(n * 4); let m = 0, minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
		for (const r of rings) for (let i = 0, L = r.length; i < L; i++) {
			const a = r[i], b = r[(i + 1) % L];
			ex[m++] = a[0]; ex[m++] = a[1]; ex[m++] = b[0]; ex[m++] = b[1];
			if (a[0] < minx) minx = a[0]; if (a[0] > maxx) maxx = a[0]; if (a[1] < miny) miny = a[1]; if (a[1] > maxy) maxy = a[1];
		}
		const nb = Math.min(4096, Math.max(1, Math.ceil(n / 12)));
		const bandH = (maxy - miny) / nb || 1;
		const band = y => Math.min(nb - 1, Math.max(0, Math.floor((y - miny) / bandH)));
		const counts = new Int32Array(nb + 1);
		for (let e = 0; e < n; e++) { const b0 = band(Math.min(ex[e * 4 + 1], ex[e * 4 + 3])), b1 = band(Math.max(ex[e * 4 + 1], ex[e * 4 + 3])); for (let b = b0; b <= b1; b++) counts[b + 1]++; }
		for (let b = 0; b < nb; b++) counts[b + 1] += counts[b];
		const off = counts, cur = counts.slice(0, nb), ids = new Int32Array(counts[nb]);
		for (let e = 0; e < n; e++) { const b0 = band(Math.min(ex[e * 4 + 1], ex[e * 4 + 3])), b1 = band(Math.max(ex[e * 4 + 1], ex[e * 4 + 3])); for (let b = b0; b <= b1; b++) ids[cur[b]++] = e; }
		const part = { id: this.parts.length, key, overlay, bbox: [minx, miny, maxx, maxy], ex, n, nb, bandH, miny, off, ids, stamp: new Int32Array(n), rings, cand: 0 };
		this.parts.push(part);
		for (let cx = Math.floor(minx); cx <= Math.floor(maxx); cx++) for (let cy = Math.floor(miny); cy <= Math.floor(maxy); cy++) {
			const c = cx * 1000 + cy; let a = this.grid.get(c); if (!a) this.grid.set(c, a = []); a.push(part);
		}
	}
	candidates(minx, miny, maxx, maxy) {
		const out = [], s = ++this.stampN;
		for (let cx = Math.floor(minx); cx <= Math.floor(maxx); cx++) for (let cy = Math.floor(miny); cy <= Math.floor(maxy); cy++) {
			const a = this.grid.get(cx * 1000 + cy); if (!a) continue;
			for (const p of a) if (p.cand !== s && p.bbox[0] <= maxx && p.bbox[2] >= minx && p.bbox[1] <= maxy && p.bbox[3] >= miny) { p.cand = s; out.push(p); }
		}
		return out;
	}
	static pip(p, x, y) {
		const [minx, miny, maxx, maxy] = p.bbox; if (x < minx || x > maxx || y < miny || y > maxy) return false;
		const b = Math.min(p.nb - 1, Math.max(0, Math.floor((y - p.miny) / p.bandH))), ex = p.ex; let inside = false;
		for (let i = p.off[b], end = p.off[b + 1]; i < end; i++) {
			const e = p.ids[i] * 4, x1 = ex[e], y1 = ex[e + 1], x2 = ex[e + 2], y2 = ex[e + 3];
			if ((y1 > y) !== (y2 > y) && x < x1 + (y - y1) * (x2 - x1) / (y2 - y1)) inside = !inside;
		}
		return inside;
	}
	static cuts(p, ax, ay, bx, by, out) {           // 線分 a-b と部分ポリゴンの辺の交点パラメータ t∈(0,1) を out へ
		const sminx = Math.min(ax, bx), smaxx = Math.max(ax, bx), sminy = Math.min(ay, by), smaxy = Math.max(ay, by);
		if (smaxx < p.bbox[0] || sminx > p.bbox[2] || smaxy < p.bbox[1] || sminy > p.bbox[3]) return;
		const band = y => Math.min(p.nb - 1, Math.max(0, Math.floor((y - p.miny) / p.bandH)));
		const b0 = band(sminy), b1 = band(smaxy), ex = p.ex, st = p.stamp, s = ++p.stampV || (p.stampV = 1);
		const rx = bx - ax, ry = by - ay;
		for (let b = b0; b <= b1; b++) for (let i = p.off[b], end = p.off[b + 1]; i < end; i++) {
			const e = p.ids[i]; if (st[e] === s) continue; st[e] = s;
			const x1 = ex[e * 4], y1 = ex[e * 4 + 1], x2 = ex[e * 4 + 2], y2 = ex[e * 4 + 3];
			if (Math.max(x1, x2) < sminx || Math.min(x1, x2) > smaxx || Math.max(y1, y2) < sminy || Math.min(y1, y2) > smaxy) continue;
			const sx = x2 - x1, sy = y2 - y1, den = rx * sy - ry * sx; if (den === 0) continue;
			const qx = x1 - ax, qy = y1 - ay, t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
			if (t > 0 && t < 1 && u >= 0 && u <= 1) out.push(t);
		}
	}
	classify(cands, x, y) { for (const p of cands) if (RegionIndex.pip(p, x, y)) return p.key; return null; }
	nearest(x, y) {                                 // どの領域にも入らない点 → 辺までの距離が最小の key（cos(lat) 補正の度）
		const cl = Math.max(0.05, Math.cos(y * Math.PI / 180));
		const bd = this.parts.map(p => { const dx = Math.max(p.bbox[0] - x, 0, x - p.bbox[2]) * cl, dy = Math.max(p.bbox[1] - y, 0, y - p.bbox[3]); return [dx * dx + dy * dy, p]; }).sort((a, b) => a[0] - b[0]);
		let best = Infinity, key = null;
		for (const [d0, p] of bd) {
			if (d0 >= best) break;
			const ex = p.ex;
			for (let e = 0; e < p.n; e++) {
				const x1 = ex[e * 4] * cl, y1 = ex[e * 4 + 1], x2 = ex[e * 4 + 2] * cl, y2 = ex[e * 4 + 3], px = x * cl, dx = x2 - x1, dy = y2 - y1;
				const l2 = dx * dx + dy * dy, t = l2 ? Math.min(1, Math.max(0, ((px - x1) * dx + (y - y1) * dy) / l2)) : 0;
				const ddx = px - (x1 + t * dx), ddy = y - (y1 + t * dy), d = ddx * ddx + ddy * ddy;
				if (d < best) { best = d; key = p.key; }
			}
		}
		return key;
	}
}

// ── 線の切り分け ────────────────────────────────────────────────────────────────────────────────────────
const lerp = (ax, ay, bx, by, t) => [ax + (bx - ax) * t, ay + (by - ay) * t];
// 点のタグ: 元の頂点 v は v*2・線分 s 上に挿入した切れ目は s*2+1。同じ key で繋ぎ直した後、前後が同じ線分に属する挿入点は共線＝落とす
const segsOf = t => (t & 1) ? [t >> 1, t >> 1] : [(t >> 1) - 1, t >> 1];
function dropInserted(pts) {
	const out = [pts[0]];
	for (let i = 1; i + 1 < pts.length; i++) {
		const t = pts[i][2];
		if (t & 1) { const s = t >> 1, a = segsOf(pts[i - 1][2]), b = segsOf(pts[i + 1][2]); if (a[0] <= s && s <= a[1] && b[0] <= s && s <= b[1]) continue; }
		out.push(pts[i]);
	}
	out.push(pts[pts.length - 1]);
	return out.map(p => [p[0], p[1]]);
}
function splitLine(idx, coords) {                   // → pieces: [{key, pts:[[x,y],…]}]（線に沿った順）
	const pieces = []; let cur = null, curKey;
	for (let i = 0; i + 1 < coords.length; i++) {
		const [ax, ay] = coords[i], [bx, by] = coords[i + 1];
		if (ax === bx && ay === by) continue;
		const cands = idx.candidates(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
		const ts = []; for (const p of cands) RegionIndex.cuts(p, ax, ay, bx, by, ts);
		ts.sort((a, b) => a - b);
		const bounds = [0]; for (const t of ts) if (t - bounds[bounds.length - 1] > 1e-12) bounds.push(t); if (1 - bounds[bounds.length - 1] > 1e-12) bounds.push(1); else bounds[bounds.length - 1] = 1;
		for (let j = 0; j + 1 < bounds.length; j++) {
			const t0 = bounds[j], t1 = bounds[j + 1];
			let key;
			if (bounds.length === 2 && curKey !== undefined) key = curKey;
			else { const [mx, my] = lerp(ax, ay, bx, by, (t0 + t1) / 2); key = idx.classify(cands, mx, my); }
			const p0 = t0 === 0 ? [ax, ay, i * 2] : [...lerp(ax, ay, bx, by, t0), i * 2 + 1], p1 = t1 === 1 ? [bx, by, (i + 1) * 2] : [...lerp(ax, ay, bx, by, t1), i * 2 + 1];
			if (cur && cur.key === key) { if (cur.seg === i) cur.pts[cur.pts.length - 1] = p1; else cur.pts.push(p1); }   // 同じ線分内の切れ目は共線＝末尾を伸ばす
			else { cur = { key, pts: [p0, p1], seg: i }; pieces.push(cur); }
			cur.seg = i; curKey = key;
		}
	}
	return pieces;
}
const SEA_MIN_KM = 1;                                // これより短い海上断片は海岸線の丸めで一瞬外に出ただけ＝隣の key に繋ぐ
const lenKm = pts => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot((pts[i][0] - pts[i - 1][0]) * Math.cos(pts[i][1] * Math.PI / 180), pts[i][1] - pts[i - 1][1]); return s * 111; };
function resolveNull(pieces, exclusive, sea) {       // key=null（海・どの領域にも入らない）断片: 短ければ隣へ繋ぐ・それ以外は航路（sea）へ（Kenji 2026-09-14「国のデータとしては不要」）
	for (let k = 0; k < pieces.length; k++) {
		const pc = pieces[k]; if (pc.key !== null) continue;
		const prev = pieces[k - 1], next = pieces[k + 1];
		if (prev && next && prev.key === next.key && lenKm(pc.pts) < SEA_MIN_KM) pc.key = prev.key;
		else if (exclusive && (prev || next) && !(prev && next) && lenKm(pc.pts) < SEA_MIN_KM) pc.key = (prev || next).key;   // 端の短い突き出し（桟橋）
		else if (exclusive) sea.push(pc.pts);
	}
	return pieces.filter(p => p.key !== null);
}
function groupPieces(pieces) {                      // 隣同士の同 key を繋ぎ、key → 線の配列
	const g = new Map(); let last = null;
	for (const pc of pieces) {
		if (last && last.key === pc.key) { last.pts.push(...pc.pts.slice(1)); continue; }
		last = { key: pc.key, pts: pc.pts.slice() };
		let a = g.get(pc.key); if (!a) g.set(pc.key, a = []); a.push(last);
	}
	return g;
}

// ── 面の切り分け（市街地） ────────────────────────────────────────────────────────────────────────────
function clipRingRect(ring, minx, miny, maxx, maxy) {
	let pts = ringOpen(ring);
	const half = (axis, val, less) => {
		const out = []; let p = pts[pts.length - 1], pin = less ? p[axis] <= val : p[axis] >= val;
		for (const q of pts) {
			const qin = less ? q[axis] <= val : q[axis] >= val;
			const ix = () => { const t = (val - p[axis]) / (q[axis] - p[axis]); return axis === 0 ? [val, p[1] + t * (q[1] - p[1])] : [p[0] + t * (q[0] - p[0]), val]; };
			if (qin) { if (!pin) out.push(ix()); out.push(q); } else if (pin) out.push(ix());
			p = q; pin = qin;
		}
		pts = out;
	};
	half(0, minx, false); if (pts.length < 3) return null;
	half(0, maxx, true); if (pts.length < 3) return null;
	half(1, miny, false); if (pts.length < 3) return null;
	half(1, maxy, true); if (pts.length < 3) return null;
	return pts;
}
function splitPolygon(idx, rings, exclusive) {      // → Map key → [polygonCoords…]（境界を跨がなければ丸ごと・跨げば交差）
	let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
	for (const [x, y] of rings[0]) { if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; }
	const cands = idx.candidates(minx, miny, maxx, maxy), out = new Map();
	let needBool = cands.some(p => p.bbox[0] >= minx && p.bbox[2] <= maxx && p.bbox[1] >= miny && p.bbox[3] <= maxy);   // 領域を丸ごと含む（ローマ×バチカン）
	if (!needBool) outer: for (const r of rings) { const o = ringOpen(r); for (let i = 0; i < o.length; i++) { const a = o[i], b = o[(i + 1) % o.length], ts = []; for (const p of cands) { RegionIndex.cuts(p, a[0], a[1], b[0], b[1], ts); if (ts.length) { needBool = true; break outer; } } } }
	if (!needBool) {
		const [x, y] = rings[0][0];
		let key = idx.classify(cands, x, y);
		if (key === null && exclusive) { key = idx.nearest(x, y); if (key !== null) out.nearest = true; }
		if (key !== null) out.set(key, [rings]);
		return out;
	}
	const keys = [...new Set(cands.map(p => p.key))];
	for (const key of keys) {
		const multi = [];
		for (const p of cands) {
			if (p.key !== key) continue;
			const cl = p.rings.map(r => clipRingRect(r, minx - 0.01, miny - 0.01, maxx + 0.01, maxy + 0.01));
			if (cl[0]) multi.push(cl.filter(Boolean));
		}
		if (!multi.length) continue;
		let res; try { res = polygonClipping.intersection(rings, multi); } catch (e) { log(`polygon-clipping failed (${key}): ${e.message}`); continue; }
		if (res.length) { out.set(key, res); out.cut = true; }
	}
	return out;
}

// ── 主処理 ──────────────────────────────────────────────────────────────────────────────────────────
const nations = (await readFile(path.join(ROOT, "seed/nations.csv"), "utf8")).trim().split("\n").slice(1).map(l => { const c = l.split(","); return { key: c[0], qid: c[1], name: c[2], territory: c[5], conflict: c[6] }; });
const NATION = new Map(nations.map(n => [n.key, n.name]));
const NATION_ROW = new Map(nations.map(n => [n.key, n]));
const wanted = key => NATION.has(key) && (!ONLY || ONLY.has(key));

log("admin1 読込…");
const admin1 = await ne("ne_10m_admin_1_states_provinces");
const main = new RegionIndex(), adminByKey = new Map(), keyRegion = new Map(), unknownKeys = new Map();
for (const f of admin1) {
	const p = f.properties, key = keyOfAdmin1(p);
	if (!NATION.has(key)) { unknownKeys.set(key, (unknownKeys.get(key) || 0) + 1); continue; }
	if ((p.name_ja === "ハワイ州" || p.name === "Hawaii") && f.geometry.type === "MultiPolygon") f.geometry.coordinates = f.geometry.coordinates.filter(t => t[0][0][0] > -160);   // 北西ハワイ諸島・ミッドウェー（UM）を分離（原典踏襲）
	const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
	for (const rings of polys) main.add(key, rings);
	let a = adminByKey.get(key); if (!a) adminByKey.set(key, a = []); a.push(f);
	keyRegion.set(key, "admin1");
}
log(`admin1: ${main.parts.length} 部分ポリゴン・${adminByKey.size} key。nations 外の key: ${[...unknownKeys].map(([k, n]) => `${k}×${n}`).join(", ") || "なし"}`);

log("係争地 読込…");
const disputed = await ne("ne_10m_admin_0_disputed_areas");
const overlays = new Map();                          // key → RegionIndex（nations にあって admin1 で形が無い主体）
const admin0Feats = [];                              // その切り抜きの型＝admin_0 層として書く
for (const f of disputed) {
	const key = f.properties.BRK_A3;
	if (!NATION.has(key) || adminByKey.has(key)) continue;
	let idx = overlays.get(key); if (!idx) overlays.set(key, idx = new RegionIndex());
	const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
	for (const rings of polys) idx.add(key, rings, true);
	keyRegion.set(key, "disputed:" + key);
	admin0Feats.push({ type: "Feature", properties: { ...f.properties, key }, geometry: f.geometry });   // 切り抜きの型そのもの＝重ね切り主体だけ（ISO の国は admin_1 が輪郭を兼ねる）
}
log(`overlay: ${[...overlays.keys()].join(", ")}`);
const noGeom = nations.filter(n => !keyRegion.has(n.key)).map(n => n.key);
if (noGeom.length) log(`形状なし（出力しない）: ${noGeom.join(", ")}`);

const out = new Map();                               // key → layer → features
const push = (key, layer, f) => { if (!wanted(key)) return; let o = out.get(key); if (!o) out.set(key, o = {}); (o[layer] ||= []).push(f); };
if (LAYERS.has("admin_0")) for (const f of admin0Feats) push(f.properties.key, "admin_0", f);
const POLYGON_LAYERS = new Set(["urban_areas", "lakes"]);
const geomOnly = new Map();                          // key → layer → 幾何の配列（鉄道・道路・市街地＝属性なし・key ごとに 1 地物へ束ねる）
const pushGeom = (key, layer, g) => { if (!wanted(key)) return; let o = geomOnly.get(key); if (!o) geomOnly.set(key, o = {}); (o[layer] ||= []).push(g); };
const report = {};
const routes = { railroads: [], roads: [] };         // 航路＝フェリー（丸ごと）と海上の断片。国のデータには入れない
const isFerry = p => p.featurecla === "Ferry" || p.featurecla === "Railroad ferry" || /^Ferry/.test(p.type || "");   // roads は featurecla=Road のまま type=Ferry Route のものがある
const runs = [[main, true, null], ...[...overlays].map(([k, idx]) => [idx, false, k])];   // [索引, 排他か, overlay key]

function doLines(name, features) {
	const r = report[name] = { features: features.length, out: 0, cut: 0, ferry: 0, seaFragments: 0, wholeSea: 0 };
	for (const [idx, exclusive] of runs) for (const f of features) {
		if (!f.geometry) continue;
		if (isFerry(f.properties)) { if (exclusive) { routes[name].push({ type: "Feature", properties: { ...f.properties, ne_clip: "ferry" }, geometry: f.geometry }); r.ferry++; } continue; }
		const lines = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
		const per = new Map(), sea = [];
		for (const coords of lines) {
			const pieces = resolveNull(splitLine(idx, coords), exclusive, sea);
			for (const [key, arr] of groupPieces(pieces)) { let a = per.get(key); if (!a) per.set(key, a = []); a.push(...arr.map(x => x.pts)); }
		}
		const cut = per.size > 1 || sea.length > 0 || [...per.values()].some(a => a.length > lines.length) || ([...per.values()][0] || []).some((pts, i) => pts.length !== lines[i]?.length);
		for (const [key, arr] of per) {
			for (const pts of arr) pushGeom(key, name, dropInserted(pts));
			if (exclusive) { r.out++; if (cut) r.cut++; }
		}
		if (sea.length) {
			const g = sea.map(dropInserted);
			routes[name].push({ type: "Feature", properties: { ...f.properties, ne_clip: per.size ? "sea" : "sea-whole" }, geometry: g.length === 1 ? { type: "LineString", coordinates: g[0] } : { type: "MultiLineString", coordinates: g } });
			r.seaFragments++; if (!per.size) r.wholeSea++;
		}
	}
	log(`${name}: ${r.features} → ${r.out}（切断 ${r.cut}・フェリー ${r.ferry}・海上断片あり ${r.seaFragments}＝うち丸ごと海 ${r.wholeSea}）`);
}
function doPolygons(name, features) {
	const r = report[name] = { features: features.length, out: 0, cut: 0, nearest: 0 };
	for (const [idx, exclusive] of runs) for (const f of features) {
		if (!f.geometry) continue;
		const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
		const per = new Map(); let cut = false, nearest = false;
		for (const rings of polys) { const m = splitPolygon(idx, rings, exclusive); cut ||= !!m.cut; nearest ||= !!m.nearest; for (const [key, arr] of m) { let a = per.get(key); if (!a) per.set(key, a = []); a.push(...arr); } }
		cut ||= per.size > 1;
		for (const [key, arr] of per) {
			for (const poly of arr) pushGeom(key, name, poly);
			if (exclusive) { r.out++; if (cut) r.cut++; if (nearest) r.nearest++; }
		}
	}
	log(`${name}: ${r.features} → ${r.out}（切断 ${r.cut}・最寄り割当 ${r.nearest}）`);
}
function doPoints(name, features) {
	const r = report[name] = { features: features.length, out: 0, nearest: 0, attrMismatch: 0 };
	for (const [idx, exclusive] of runs) for (const f of features) {
		if (!f.geometry) continue;
		const [x, y] = f.geometry.coordinates;
		let key = idx.classify(idx.candidates(x, y, x, y), x, y), nearest = false;
		if (key === null && exclusive) { key = idx.nearest(x, y); nearest = true; }
		if (key === null) continue;
		const props = { ...f.properties, key }; if (nearest) props.ne_clip = "nearest";
		push(key, name, { type: "Feature", properties: props, geometry: f.geometry });
		if (exclusive) { r.out++; if (nearest) r.nearest++; if (/^[A-Z]{2}$/.test(f.properties.ISO_A2) && f.properties.ISO_A2 !== key) r.attrMismatch++; }
	}
	log(`${name}: ${r.features} → ${r.out}（最寄り割当 ${r.nearest}・NE の ISO_A2 と不一致 ${r.attrMismatch}）`);
}

if (LAYERS.has("railroads")) doLines("railroads", await ne("ne_10m_railroads"));
if (LAYERS.has("roads")) doLines("roads", await ne("ne_10m_roads"));
if (LAYERS.has("urban_areas")) doPolygons("urban_areas", await ne("ne_10m_urban_areas"));
if (LAYERS.has("lakes")) doPolygons("lakes", await ne("ne_10m_lakes"));
if (LAYERS.has("populated_places")) doPoints("populated_places", await ne("ne_10m_populated_places"));
if (LAYERS.has("admin_1")) { let n = 0; for (const [key, fs] of adminByKey) for (const f of fs) { push(key, "admin_1", { type: "Feature", properties: { ...f.properties, key }, geometry: f.geometry }); n++; } report.admin_1 = { features: admin1.length, out: n }; log(`admin_1: ${n}`); }

for (const [key, o] of geomOnly) for (const [layer, geoms] of Object.entries(o))
	push(key, layer, { type: "Feature", properties: {}, geometry: POLYGON_LAYERS.has(layer) ? { type: "MultiPolygon", coordinates: geoms } : { type: "MultiLineString", coordinates: geoms } });

// ── 書き出し ──────────────────────────────────────────────────────────────────────────────────────
// 既定＝方式A: 全部を平らに 1 層へ（属性 key / layer・混在ジオメトリ）＝ out/ne-cultural.geopbf ＋ out/ne-cultural.json（要約）。
// 国別ファイル（out/ne-cultural/<key>/<layer>.geopbf）は内容が等価なので既定では書かず、--split の時だけ（Kenji 2026-09-15）。
const index = { source: `Natural Earth 10m ${NE_TAG}`, generated: new Date().toISOString(), precision: PRECISION, layers: [...LAYERS], keys: {}, report, unknownKeys: Object.fromEntries(unknownKeys), noGeometry: noGeom };
const countVerts = features => { let v = 0; const walk = c => Array.isArray(c[0]) ? c.forEach(walk) : v++; for (const f of features) walk(f.geometry.coordinates); return v; };
const encode = async (name, features, description) => gzipSync(Buffer.from((await new GeoPBF({ name, precision: PRECISION, attribution: ATTR, description }).set({ type: "FeatureCollection", name, features })).arrayBuffer), { level: 9 });
for (const key of [...out.keys()].sort()) {
	const entry = index.keys[key] = { name: NATION.get(key), qid: NATION_ROW.get(key).qid, region: keyRegion.get(key), layers: {} };
	for (const [layer, features] of Object.entries(out.get(key))) entry.layers[layer] = { features: features.length, parts: geomOnly.get(key)?.[layer]?.length, vertices: countVerts(features) };
}
// nations.csv にあって出力が無い key。geoms/<key>.png と同じ辿り方（sovereignt → claim）で代わりに読む key を fallback に書く
// （sovereignt＝conflicts.csv で territory/sovereignt がこの key の係争地・claim＝overrides.json の claim。AFX なら claim=[AF]）
const conflicts = parseCSV(await readFile(path.join(ROOT, "seed/conflicts.csv"), "utf8")), overrides = JSON.parse(await readFile(path.join(ROOT, "seed/overrides.json"), "utf8"));
index.missingKeys = nations.filter(n => !out.has(n.key)).map(n => {
	const sovereignt = conflicts.filter(c => (c.territory || c.sovereignt) === n.key).map(c => c.key), claim = overrides[n.key]?.claim || [];
	return { key: n.key, qid: n.qid, name: n.name, territory: n.territory || undefined, conflict: n.conflict || undefined, sovereignt: sovereignt.length ? sovereignt : undefined, claim: claim.length ? claim : undefined, fallback: sovereignt.length ? sovereignt : claim, region: keyRegion.get(n.key) || null };
});
index.routes = Object.fromEntries(Object.entries(routes).filter(([, f]) => f.length).map(([layer, f]) => [layer, { features: f.length, vertices: countVerts(f) }]));

const all = [];
for (const key of [...out.keys()].sort()) for (const [layer, features] of Object.entries(out.get(key))) for (const f of features) all.push({ type: "Feature", properties: { key, layer, ...f.properties }, geometry: f.geometry });
for (const [layer, features] of Object.entries(routes)) for (const f of features) all.push({ type: "Feature", properties: { layer: "routes", source: layer, ...f.properties }, geometry: f.geometry });
await mkdir(path.dirname(OUT), { recursive: true });
const buf = await encode("ne-cultural", all, `Natural Earth 10m ${NE_TAG} split by ortho-earth world keys: all keys and layers in one (properties key / layer)`);
await writeFile(OUT + ".geopbf", buf);
if (WANT_GEOJSON) await writeFile(OUT + ".geojson", JSON.stringify({ type: "FeatureCollection", name: "ne-cultural", features: all }));
index.single = { file: path.basename(OUT) + ".geopbf", features: all.length, vertices: countVerts(all), bytes: buf.length };
await writeFile(OUT + ".json", JSON.stringify(index, null, 1));
log(`${OUT}.geopbf: ${Object.keys(index.keys).length} key・${all.length} 地物・${(buf.length / 1e6).toFixed(1)} MB (gzip)`);

if (opt("split", false)) {   // 国別ファイル（等価な内容の分割形）
	let files = 0, bytes = 0;
	for (const key of [...out.keys()].sort()) {
		const dir = path.join(OUT, key); await mkdir(dir, { recursive: true });
		for (const [layer, features] of Object.entries(out.get(key))) {
			const b = await encode(layer, features, `${key} ${NATION.get(key)} — ne_10m_${layer}`);
			await writeFile(path.join(dir, `${layer}.geopbf`), b); files++; bytes += b.length;
			if (WANT_GEOJSON) await writeFile(path.join(dir, `${layer}.geojson`), JSON.stringify({ type: "FeatureCollection", name: layer, features }));
		}
	}
	for (const [layer, features] of Object.entries(routes)) {
		if (!features.length) continue;
		await mkdir(path.join(OUT, "routes"), { recursive: true });
		const b = await encode(layer, features, `routes (ferries and sea fragments) — ne_10m_${layer}`);
		await writeFile(path.join(OUT, "routes", `${layer}.geopbf`), b); files++; bytes += b.length;
	}
	log(`--split: ${OUT}/ に ${files} ファイル・${(bytes / 1e6).toFixed(1)} MB (gzip)`);
}
