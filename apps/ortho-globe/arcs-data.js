// 弧の頁（arcs.html）の純関数＝DOM も GPU も持たない（node の検定 tests/t-arcs-data.mjs が読む）。
//   大円（いちばん近い道）と等角航路（メルカトルで真っすぐな線）の距離と点列・弧の持ち上げ（arcs-gl と同じ式）・
//   OpenFlights（airports.dat／routes.dat）の読み・利用者の CSV（出発と到着の列）の読み。
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const EARTH_KM = 6371.0088;   // 平均半径（IUGG）＝距離の表示に使う

const wrap180 = x => ((x + 540) % 360) - 180;

// ── 大円 ──────────────────────────────────────────────────────────────────
/** 2 点の大円距離（km・haversine） */
export function gcDistance(a, b) {
	const p1 = a[1] * D2R, p2 = b[1] * D2R, dp = p2 - p1, dl = (b[0] - a[0]) * D2R;
	const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
	return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
const toXYZ = (lon, lat) => { const l = lon * D2R, p = lat * D2R, c = Math.cos(p); return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)]; };
const toLL = v => [Math.atan2(v[1], v[0]) * R2D, Math.atan2(v[2], Math.hypot(v[0], v[1])) * R2D];
/** 大円の上の点（t＝0..1・球面の線形補間）と、arcs-gl と同じ持ち上げ（h＝弦長に対する高さの比 → 高さは地球の半径を 1 とした値） */
export function gcPoint(a, b, t, h = 0) {
	const A = toXYZ(a[0], a[1]), B = toXYZ(b[0], b[1]);
	const th = Math.acos(Math.max(-1, Math.min(1, A[0] * B[0] + A[1] * B[1] + A[2] * B[2])));
	let cA, cB;
	if (th < 1e-4) { cA = 1 - t; cB = t; } else { const s = Math.sin(th); cA = Math.sin((1 - t) * th) / s; cB = Math.sin(t * th) / s; }
	const ll = toLL([cA * A[0] + cB * B[0], cA * A[1] + cB * B[1], cA * A[2] + cB * B[2]]);
	return [ll[0], ll[1], 4 * h * 2 * Math.sin(th / 2) * t * (1 - t)];   // arcs-gl の arcRel と同じ高さ（4·h·弦長·t(1−t)）
}
/** 大円の点列（n+1 点・経度は連続に解く＝日付変更線で跳ばない）。h を渡すと 3 つ目に高さ（半径 1 単位） */
export function gcPath(a, b, n = 64, h = 0) {
	const out = []; let prev = null;
	for (let i = 0; i <= n; i++) {
		const p = gcPoint(a, b, i / n, h);
		if (prev != null) p[0] = prev + wrap180(p[0] - prev);
		prev = p[0]; out.push(h ? p : [p[0], p[1]]);
	}
	return out;
}

// ── 等角航路（rhumb line・loxodrome）＝メルカトルの地図で真っすぐな線 ─────────────────
const mercY = lat => Math.log(Math.tan(Math.PI / 4 + Math.max(-89.9, Math.min(89.9, lat)) * D2R / 2));
const invMercY = y => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * R2D;
/** 等角航路の距離（km）＝経度差は短い向き（±180° の内）で取る */
export function rhumbDistance(a, b) {
	const dp = (b[1] - a[1]) * D2R, dl = wrap180(b[0] - a[0]) * D2R;
	const dpsi = mercY(b[1]) - mercY(a[1]);
	const q = Math.abs(dpsi) > 1e-12 ? dp / dpsi : Math.cos(a[1] * D2R);
	return EARTH_KM * Math.hypot(dp, q * dl);
}
/** 等角航路の点列（メルカトルの上で直線に刻む＝経度は連続） */
export function rhumbPath(a, b, n = 64) {
	const dl = wrap180(b[0] - a[0]), y0 = mercY(a[1]), y1 = mercY(b[1]), out = [];
	for (let i = 0; i <= n; i++) { const t = i / n; out.push([a[0] + dl * t, invMercY(y0 + (y1 - y0) * t)]); }
	return out;
}
/** 等角航路の向き（真北から時計回りの度）＝航路のあいだ一定 */
export function rhumbBearing(a, b) {
	const dl = wrap180(b[0] - a[0]) * D2R, dpsi = mercY(b[1]) - mercY(a[1]);
	return (Math.atan2(dl, dpsi) * R2D + 360) % 360;
}
export { mercY, invMercY, wrap180 };

// ── 光の粒（trips）の道＝弧と同じ線の上を、出発から到着へ ──────────────────────────────
/** 弧 1 本 → { path: [[lon, lat, 高さ m], …], timestamps }。速さ一定（距離に比例した時間）・phase＝出発の時刻 */
export function tripOf(a, b, { h = 0, n = 32, radiusM = 6371008.8, kmPerSec = 4000, phase = 0 } = {}) {
	const pts = gcPath(a, b, n, h || 1e-9), dur = Math.max(0.6, gcDistance(a, b) / kmPerSec);
	return { path: pts.map(p => [p[0], p[1], h ? p[2] * radiusM : 0]), timestamps: pts.map((_, i) => phase + dur * i / n) };
}

// ── OpenFlights（airports.dat・routes.dat）─────────────────────────────────────────
// 引用符つきの CSV 1 行（OpenFlights は "…" の中にカンマがある・\N は欠測）
export function splitCSVLine(line, sep = ",") {
	const out = []; let cur = "", q = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
		else if (c === '"') q = true;
		else if (c === sep) { out.push(cur); cur = ""; }
		else cur += c;
	}
	out.push(cur);
	return out;
}
const nul = v => v == null || v === "\\N" || v === "" ? null : v;
/** airports.dat → Map<id, { id, name, city, country, iata, icao, lon, lat }> */
export function parseAirports(text) {
	const m = new Map();
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		const f = splitCSVLine(line), lat = +f[6], lon = +f[7];
		if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
		m.set(+f[0], { id: +f[0], name: f[1], city: nul(f[2]), country: nul(f[3]), iata: nul(f[4]), icao: nul(f[5]), lon, lat });
	}
	return m;
}
/** routes.dat → 向きのある空港の対ごとに 1 本（{ s, t, n＝その対を飛ぶ航空会社の数, km }）。乗り継ぎ（stops>0）と、空港が台帳に無い行は捨てる */
export function parseRoutes(text, airports) {
	const pairs = new Map();
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		const f = line.split(",");
		if (+f[7] > 0) continue;
		const s = +f[3], t = +f[5];
		if (!airports.has(s) || !airports.has(t) || s === t) continue;
		const k = s * 100000 + t;
		const r = pairs.get(k); if (r) r.n++; else pairs.set(k, { s, t, n: 1 });
	}
	const out = [];
	for (const r of pairs.values()) { const a = airports.get(r.s), b = airports.get(r.t); r.km = gcDistance([a.lon, a.lat], [b.lon, b.lat]); out.push(r); }
	return out;
}

// ── 利用者の表（CSV）＝出発と到着の列 → 弧 ─────────────────────────────────────────
const sepOf = head => (head.match(/\t/g)?.length ?? 0) > (head.match(/,/g)?.length ?? 0) ? "\t" : (head.match(/;/g)?.length ?? 0) > (head.match(/,/g)?.length ?? 0) ? ";" : ",";
/** CSV の文字列 → { cols, rows（文字列の配列の配列）} */
export function parseTable(text) {
	const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter(l => l.trim());
	if (!lines.length) return { cols: [], rows: [] };
	const sep = sepOf(lines[0]);
	return { cols: splitCSVLine(lines[0], sep).map(s => s.trim()), rows: lines.slice(1).map(l => splitCSVLine(l, sep).map(s => s.trim())) };
}
const SRC = "from|src|source|origin|orig|start|dep|departure|o";
const DST = "to|dst|dest|destination|target|end|arr|arrival|d";
const LON = "lon|lng|long|longitude|x", LAT = "lat|latitude|y";
const reCol = (side, axis) => new RegExp(`^(?:${side})[ _.-]?(?:${axis})$|^(?:${axis})[ _.-]?(?:${side})$`, "i");
const findCol = (cols, re) => cols.findIndex(c => re.test(c));
/** 列の役割を当てる＝{ kind: "coords", sLon, sLat, tLon, tLat } か { kind: "codes", s, t } と weight（太さの列・無ければ −1）。分からなければ null */
export function detectColumns(cols) {
	const weight = findCol(cols, /^(count|value|weight|flights?|passengers?|pax|trips?|n|amount|volume|total|people|migrants?)$/i);
	const sLon = findCol(cols, reCol(SRC, LON)), sLat = findCol(cols, reCol(SRC, LAT)), tLon = findCol(cols, reCol(DST, LON)), tLat = findCol(cols, reCol(DST, LAT));
	if ([sLon, sLat, tLon, tLat].every(i => i >= 0)) return { kind: "coords", sLon, sLat, tLon, tLat, weight };
	// 列名に lon/lat がある 4 列（前の 2 つ＝出発・後の 2 つ＝到着）
	const lons = cols.map((c, i) => /(^|[ _.-])(lon|lng|long|longitude)$/i.test(c) ? i : -1).filter(i => i >= 0);
	const lats = cols.map((c, i) => /(^|[ _.-])(lat|latitude)$/i.test(c) ? i : -1).filter(i => i >= 0);
	if (lons.length === 2 && lats.length === 2) return { kind: "coords", sLon: lons[0], sLat: lats[0], tLon: lons[1], tLat: lats[1], weight };
	const s = findCol(cols, new RegExp(`^(?:${SRC})(?:[ _.-]?(?:code|iata|icao|iso|iso2|iso3|country|airport|city|name))?$`, "i"));
	const t = findCol(cols, new RegExp(`^(?:${DST})(?:[ _.-]?(?:code|iata|icao|iso|iso2|iso3|country|airport|city|name))?$`, "i"));
	if (s >= 0 && t >= 0 && s !== t) return { kind: "codes", s, t, weight };
	if (cols.length >= 2) return { kind: "codes", s: 0, t: 1, weight };   // 名前で当たらない＝先頭の 2 列を出発と到着とみなす
	return null;
}
/** 記号 → 位置の引き表を作る。airports＝parseAirports の Map（無ければ空港は引かない）・nations＝[{ iso: [iso2, iso3], coord: [lon, lat], name }] */
export function makeResolver({ airports, nations } = {}) {
	const iata = new Map(), icao = new Map(), iso2 = new Map(), iso3 = new Map(), names = new Map();
	if (airports) for (const a of airports.values()) { if (a.iata) iata.set(a.iata.toUpperCase(), a); if (a.icao) icao.set(a.icao.toUpperCase(), a); }
	if (nations) for (const n of nations) {
		if (!n.coord) continue;
		if (n.iso?.[0]) iso2.set(String(n.iso[0]).toUpperCase(), n);
		if (n.iso?.[1]) iso3.set(String(n.iso[1]).toUpperCase(), n);
		for (const nm of [n.name, n.nameEn]) if (nm) names.set(String(nm).toLowerCase(), n);
	}
	const kinds = {
		iata: v => /^[A-Z]{3}$/.test(v) ? iata.get(v) : null,
		icao: v => /^[A-Z0-9]{4}$/.test(v) ? icao.get(v) : null,
		iso2: v => /^[A-Z]{2}$/.test(v) ? iso2.get(v) : null,
		iso3: v => /^[A-Z]{3}$/.test(v) ? iso3.get(v) : null,
		name: (v, raw) => names.get(raw.toLowerCase()) ?? null,
	};
	const posOf = x => x ? (x.coord ? [x.coord[0], x.coord[1]] : [x.lon, x.lat]) : null;
	const labelOf = x => x ? (x.iata ? `${x.iata} ${x.city || x.name}` : x.name || "") : "";
	// 列ごとに一番多く当たる読み方を選ぶ（3 文字は空港の IATA と国の ISO3 の両方があり得る＝多数決）
	const pick = values => {
		let best = null, bestN = 0;
		for (const k of Object.keys(kinds)) { let n = 0; for (const raw of values) if (kinds[k](String(raw).toUpperCase(), String(raw))) n++; if (n > bestN) { best = k; bestN = n; } }
		return best;
	};
	// 列の読み方で当たらない値は、他の読み方でも試す（同じ列に JP と JPN が混ざる表）
	const ORDER = ["iso2", "iso3", "iata", "icao", "name"];
	const resolve = (kind, raw) => {
		const up = String(raw).toUpperCase(), s = String(raw);
		let x = kind ? kinds[kind](up, s) : null;
		for (const k of ORDER) { if (x) break; if (k !== kind) x = kinds[k](up, s); }
		return x ? { pos: posOf(x), label: labelOf(x) } : null;
	};
	return { pick, resolve, needsAirports: values => values.some(v => /^[A-Z0-9]{3,4}$/i.test(String(v).trim())) };
}
const num = v => { const n = +String(v).replace(/,/g, ""); return Number.isFinite(n) ? n : NaN; };
/** 表 → 弧の配列 { s, t, w, sLabel, tLabel, km }。resolver は codes の時だけ要る。戻りに { arcs, skipped, how } */
export function tableToArcs(table, det, resolver) {
	const arcs = []; let skipped = 0, how = det?.kind ?? null;
	if (!det) return { arcs, skipped: table.rows.length, how };
	const W = r => det.weight >= 0 ? num(r[det.weight]) : 1;
	if (det.kind === "coords") {
		for (const r of table.rows) {
			const s = [num(r[det.sLon]), num(r[det.sLat])], t = [num(r[det.tLon]), num(r[det.tLat])];
			if (![...s, ...t].every(Number.isFinite) || Math.abs(s[1]) > 90 || Math.abs(t[1]) > 90) { skipped++; continue; }
			arcs.push({ s, t, w: W(r), sLabel: `${s[1].toFixed(2)}, ${s[0].toFixed(2)}`, tLabel: `${t[1].toFixed(2)}, ${t[0].toFixed(2)}`, km: gcDistance(s, t) });
		}
		return { arcs, skipped, how };
	}
	const ks = resolver.pick(table.rows.map(r => r[det.s]).filter(Boolean)), kt = resolver.pick(table.rows.map(r => r[det.t]).filter(Boolean));
	how = ks ?? kt;
	for (const r of table.rows) {
		const a = resolver.resolve(ks, r[det.s] ?? ""), b = resolver.resolve(kt, r[det.t] ?? "");
		if (!a || !b) { skipped++; continue; }
		arcs.push({ s: a.pos, t: b.pos, w: W(r), sLabel: a.label || r[det.s], tLabel: b.label || r[det.t], km: gcDistance(a.pos, b.pos) });
	}
	return { arcs, skipped, how };
}
