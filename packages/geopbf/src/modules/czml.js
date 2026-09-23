// CZML ⇄ GeoJSON Feature の純関数（decoder/czml.js・encoder/czml.js・decoder/json.js の CZML 嗅ぎ分けが共有）。2026-09-17。
//
// CZML（Cesium の時系列シーン記述・JSON のパケット配列）を GeoPBF に写す約束事＝GPX と同じ形：
//   幾何は 2D（GeoPBF の頂点に Z も時刻も無い）。高さは属性 ele（Point＝数値・線/環＝点数と同じ長さの配列・入れ子）、
//   時刻は属性 time（ISO 文字列・sampled position は配列）。全点が高さ 0 なら ele は省く。
//   - position（静的）            → Point            （ele＝高さ・time＝時刻付き 1 標本ならその時刻）
//   - position（時刻付き標本列）  → LineString + time 配列（動く点の軌跡＝GPX の trk と同じ持ち方）
//   - polyline.positions          → LineString
//   - polygon.positions + holes   → Polygon（CZML の環は閉じない＝読みで閉じ、書きで開く）
//   - rectangle.coordinates       → Polygon（wsen 4 隅・書き戻しは czml.rectangle が残っていれば rectangle に戻す）
//   幾何にした部分以外のパケット（billboard / label / point / model / path / orientation / 各 graphics のスタイル …）は
//   属性 czml に JSON のまま抱える＝書き戻しでそのまま展開する（静的 CZML は往復で等価）。
//   id / name / description / availability は同名の属性。packet.properties のスカラーは素の属性へ、それ以外（時系列値・
//   予約名と衝突）は czml.properties へ。cartesian（ECEF）と cartographicRadians は WGS84 の経緯度に直す。referenceFrame: "INERTIAL" の
//   cartesian は標本の時刻で地球固定へ回してから（歳差＋恒星時・inertialToFixed）。
//   参照（"id#prop"）・幾何を持たないパケットは落とす（dropped に数える）。document パケットの clock は残さない
//   （Cesium は clock 無しなら availability から時計を組む）。

const RAD = 180 / Math.PI;
const A = 6378137, F = 1 / 298.257223563, E2 = F * (2 - F);

// ECEF（m）→ [lon°, lat°, h m]（WGS84・反復 5 回＝mm 以下）
export { inertialToFixed };
export function ecefToLLH(x, y, z) {
	const lon = Math.atan2(y, x), p = Math.hypot(x, y);
	let lat = Math.atan2(z, p * (1 - E2)), N = A, h = 0;
	for (let i = 0; i < 5; i++) {
		const s = Math.sin(lat);
		N = A / Math.sqrt(1 - E2 * s * s);
		h = p / Math.cos(lat) - N;
		lat = Math.atan2(z, p * (1 - E2 * N / (N + h)));
	}
	return [lon * RAD, lat * RAD, h];
}

// 慣性系（referenceFrame: "INERTIAL"＝ICRF/J2000）→ 地球固定（ECEF）。標本の時刻ごとに 歳差（IAU 1976：J2000 → その時刻の平均赤道）→
// 地球の自転（グリニッジ平均恒星時 IAU-82）で回す。章動（最大 17″）と極運動は入れない（LEO で最大 ~0.5 km）。
// 旧＝INERTIAL を見ずに ECEF として読み、恒星時の分（最大 1 周）だけ経度が回っていた（衛星の CZML の大半が INERTIAL・2026-09-23）。
// 式は公開の IAU 定数（geopbf は MIT＝GPL の ephem は読まない）。
const AS = Math.PI / 648000;
function inertialToFixed(x, y, z, ms) {
	const jd = ms / 864e5 + 2440587.5, T = (jd - 2451545.0) / 36525;
	const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * AS;
	const zz = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * AS;
	const th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * AS;
	// P = R3(−z)·R2(θ)·R3(−ζ)（受動回転）
	const cz = Math.cos(zeta), sz = Math.sin(zeta), cZ = Math.cos(zz), sZ = Math.sin(zz), ct = Math.cos(th), st = Math.sin(th);
	const x1 = cz * x - sz * y, y1 = sz * x + cz * y, z1 = z;                 // R3(−ζ)
	const x2 = ct * x1 - st * z1, y2 = y1, z2 = st * x1 + ct * z1;          // R2(θ)
	const x3 = cZ * x2 - sZ * y2, y3 = sZ * x2 + cZ * y2, z3 = z2;          // R3(−z)
	let g = (-6.2e-6 * T ** 3 + 0.093104 * T * T + (876600 * 3600 + 8640184.812866) * T + 67310.54841) * (Math.PI / 43200);   // 秒 → rad（1 秒＝15″）
	g %= 2 * Math.PI;
	const cg = Math.cos(g), sg = Math.sin(g);
	return [cg * x3 + sg * y3, -sg * x3 + cg * y3, z3];                    // R3(GMST)
}

const SAMPLE_KEYS = ["cartographicDegrees", "cartographicRadians", "cartesian", "cartesianVelocity"];
const isoOf = (t, epoch) => typeof t === "string" ? new Date(t).toISOString() : new Date(Date.parse(epoch || "1970-01-01T00:00:00Z") + t * 1000).toISOString();

// position / positions の値 → { pts: [[lon,lat,h]…], times: [iso…]|null, meta: 標本以外の指定 }。読めなければ null。
//   tagged＝position（単数）＝配列長が 1 標本分を超えれば時刻付き（[t, x, y, z, …]）。positions（複数）は常に点の並び。
export function readPosition(v, tagged) {
	if (v == null) return null;
	if (Array.isArray(v)) {   // 区間の並び＝標本を順に繋ぐ・meta は先頭から
		const parts = v.map(u => readPosition(u, tagged)).filter(Boolean);
		if (!parts.length) return null;
		return { pts: parts.flatMap(p => p.pts), times: parts.some(p => p.times) ? parts.flatMap(p => p.times || p.pts.map(() => null)) : null, meta: parts[0].meta };
	}
	if (typeof v !== "object" || v.reference != null) return null;
	const key = SAMPLE_KEYS.find(k => Array.isArray(v[k]));
	if (!key) return null;
	const arr = v[key], dim = key === "cartesianVelocity" ? 6 : 3;
	const stride = tagged && arr.length > dim ? dim + 1 : dim;
	const pts = [], times = stride > dim ? [] : null;
	// 慣性系は時刻が要る＝標本の時刻（無ければ epoch）で地球固定へ。時刻がまったく無い静的な INERTIAL だけは回せない＝そのまま（referenceFrame を温存）
	const inertial = v.referenceFrame === "INERTIAL" && (key === "cartesian" || key === "cartesianVelocity") && (times || v.epoch);
	for (let i = 0; i + stride <= arr.length; i += stride) {
		const o = stride > dim ? i + 1 : i;
		let x = +arr[o], y = +arr[o + 1], z = +arr[o + 2];
		const t = times ? isoOf(arr[i], v.epoch) : null;
		if (key === "cartographicRadians") x *= RAD, y *= RAD;
		else if (key !== "cartographicDegrees") {
			if (inertial) [x, y, z] = inertialToFixed(x, y, z, Date.parse(t || v.epoch));
			[x, y, z] = ecefToLLH(x, y, z);
		}
		pts.push([x, y, z]);
		if (times) times.push(t);
	}
	const meta = {};
	for (const k in v) if (!SAMPLE_KEYS.includes(k) && k !== "epoch" && k !== "interval" && !(inertial && k === "referenceFrame")) meta[k] = v[k];   // 地球固定へ直した＝書き戻し（経緯度）に INERTIAL を残さない
	return { pts, times, meta };
}

const heights = pts => pts.some(p => p[2]) ? pts.map(p => p[2]) : null;
const xy = pts => pts.map(p => [p[0], p[1]]);
const closeRing = r => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) ? [...r, r[0]] : r;
const nonEmpty = o => o && Object.keys(o).length ? o : undefined;
const isScalar = v => v == null || typeof v !== "object";
const RESERVED = new Set(["id", "name", "description", "availability", "czml", "ele", "time"]);
const HANDLED = new Set(["id", "name", "description", "availability", "properties", "position", "polyline", "polygon", "rectangle"]);

export const isCzml = q => Array.isArray(q) && q.some(p => p && typeof p === "object" && (p.id === "document" || p.position || p.polyline || p.polygon));

// パケット配列 → { features, document, dropped }
export function czmlToFeatures(packets) {
	const features = [];
	let document = null, dropped = 0;
	for (const pk of packets) {
		if (!pk || typeof pk !== "object") continue;
		if (pk.id === "document") { document = pk; continue; }
		const props = {}, czml = {};
		if (pk.id != null) props.id = pk.id;
		if (pk.name != null) props.name = pk.name;
		if (pk.description != null) props.description = pk.description;
		if (pk.availability != null) props.availability = pk.availability;
		if (pk.properties && typeof pk.properties === "object") {
			for (const k in pk.properties) {
				const v = pk.properties[k];
				if (isScalar(v) && !RESERVED.has(k) && !k.includes(".")) props[k] = v;
				else (czml.properties ??= {})[k] = v;
			}
		}
		let geometry = null;
		let r;
		if (pk.position && (r = readPosition(pk.position, true))) {
			if (r.times && r.pts.length > 1) {
				geometry = { type: "LineString", coordinates: xy(r.pts) };
				props.time = r.times; const h = heights(r.pts); if (h) props.ele = h;
			} else {
				geometry = { type: "Point", coordinates: [r.pts[0][0], r.pts[0][1]] };
				if (r.pts[0][2]) props.ele = r.pts[0][2];
				if (r.times) props.time = r.times[0];
			}
			const m = nonEmpty(r.meta); if (m) czml.position = m;
		} else if (pk.polyline && (r = readPosition(pk.polyline.positions, false))) {
			geometry = { type: "LineString", coordinates: xy(r.pts) };
			const h = heights(r.pts); if (h) props.ele = h;
			const { positions, ...rest } = pk.polyline; const m = nonEmpty(r.meta); if (m) rest.positions = m;
			czml.polyline = rest;
		} else if (pk.polygon && (r = readPosition(pk.polygon.positions, false))) {
			const rings = [r.pts];
			const hs = pk.polygon.holes;
			const holeArrs = hs && typeof hs === "object" ? (Array.isArray(hs.cartographicDegrees) ? hs.cartographicDegrees.map(a => ({ cartographicDegrees: a }))
				: Array.isArray(hs.cartographicRadians) ? hs.cartographicRadians.map(a => ({ cartographicRadians: a }))
				: Array.isArray(hs.cartesian) ? hs.cartesian.map(a => ({ cartesian: a })) : []) : [];
			for (const ha of holeArrs) { const hr = readPosition(ha, false); if (hr && hr.pts.length >= 3) rings.push(hr.pts); }
			geometry = { type: "Polygon", coordinates: rings.map(ring => closeRing(xy(ring))) };
			if (rings.some(ring => heights(ring))) props.ele = rings.map(ring => closeRing(ring).map(p => p[2]));
			const { positions, holes, ...rest } = pk.polygon; const m = nonEmpty(r.meta); if (m) rest.positions = m;
			czml.polygon = rest;
		} else if (pk.rectangle && pk.rectangle.coordinates) {
			const c = pk.rectangle.coordinates;
			let w = null;
			if (Array.isArray(c.wsenDegrees) && c.wsenDegrees.length >= 4) w = c.wsenDegrees.slice(0, 4);
			else if (Array.isArray(c.wsen) && c.wsen.length >= 4) w = c.wsen.slice(0, 4).map(v => v * RAD);
			if (w) {
				geometry = { type: "Polygon", coordinates: [[[w[0], w[1]], [w[2], w[1]], [w[2], w[3]], [w[0], w[3]], [w[0], w[1]]]] };
				const { coordinates, ...rest } = pk.rectangle;
				czml.rectangle = rest;
			}
		}
		if (!geometry) { dropped++; continue; }
		for (const k in pk) if (!HANDLED.has(k)) czml[k] = pk[k];
		if (Object.keys(czml).length) props.czml = czml;
		features.push({ type: "Feature", geometry, properties: props });
	}
	return { features, document, dropped };
}

// ---- 書き戻し ----
const VISUALS = ["point", "billboard", "label", "model", "ellipse", "ellipsoid", "cylinder", "box"];
const at = (arr, ...idx) => { let v = arr; for (const i of idx) { if (!Array.isArray(v)) return null; v = v[i]; } return Array.isArray(v) ? null : v ?? null; };
const flat = (ring, ele, ...idx) => ring.flatMap(([lon, lat], i) => [lon, lat, +(at(ele, ...idx, i) ?? 0)]);
const openRing = r => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) ? r.slice(0, -1) : r;
const isoStr = t => t instanceof Date ? t.toISOString() : t == null ? null : String(t);

// 1 地物 → パケット配列（Multi 幾何は部品ごとに 1 パケット・id に :n を足す）
export function featureToPackets(f, i) {
	const p = f.properties || {}, czml = (p.czml && typeof p.czml === "object") ? p.czml : {};
	const g = f.geometry; if (!g) return [];
	const base = () => {
		const pk = { id: String(p.id ?? `feature-${i}`) };   // name は id にしない（同名の 2 地物が Cesium で 1 エンティティに併合される）
		if (p.name != null) pk.name = p.name;
		if (p.description != null) pk.description = p.description;
		if (p.availability != null) pk.availability = p.availability;
		for (const k in czml) if (!["position", "polyline", "polygon", "rectangle", "properties"].includes(k)) pk[k] = czml[k];
		const props = { ...(czml.properties || {}) };
		for (const k in p) if (!RESERVED.has(k) && p[k] != null) props[k] = p[k];
		if (Object.keys(props).length) pk.properties = props;
		return pk;
	};
	const withVisual = pk => { if (!VISUALS.some(k => pk[k] != null)) pk.point = { pixelSize: 8 }; return pk; };
	const sub = (pk, n) => (pk.id = `${pk.id}:${n}`, pk);
	const pointPacket = (lon, lat, h, time) => {
		const pk = base(), t = isoStr(time);
		pk.position = { ...(czml.position || {}), cartographicDegrees: t ? [t, lon, lat, +(h ?? 0)] : [lon, lat, +(h ?? 0)] };
		return withVisual(pk);
	};
	const polylinePacket = (line, ele, ...idx) => {
		const pk = base(), pl = { ...(czml.polyline || {}) };
		pl.positions = { ...(pl.positions || {}), cartographicDegrees: flat(line, ele, ...idx) };
		pk.polyline = pl; return pk;
	};
	const polygonPacket = (rings, ele, ...idx) => {
		const pk = base();
		const outer = openRing(rings[0]);
		if (czml.rectangle && rings.length === 1 && outer.length === 4) {
			const xs = outer.map(q => q[0]), ys = outer.map(q => q[1]);
			pk.rectangle = { ...czml.rectangle, coordinates: { wsenDegrees: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] } };
			return pk;
		}
		const pg = { ...(czml.polygon || {}) };
		pg.positions = { ...(pg.positions || {}), cartographicDegrees: flat(outer, ele, ...idx, 0) };
		if (rings.length > 1) pg.holes = { cartographicDegrees: rings.slice(1).map((r, k) => flat(openRing(r), ele, ...idx, k + 1)) };
		pk.polygon = pg; return pk;
	};
	// 時刻付きの線＝動く点（GPX の trk・CZML の sampled position）。時刻の無い標本は置けないので飛ばす
	const sampledPacket = (segs, times, ele) => {
		const samples = [];
		segs.forEach((seg, s) => seg.forEach(([lon, lat], j) => {
			const t = isoStr(segs.length === 1 && !Array.isArray(times[0]) ? times[j] : at(times, s, j));
			const ms = t ? Date.parse(t) : NaN; if (!Number.isFinite(ms)) return;
			const h = segs.length === 1 && !Array.isArray(ele?.[0]) ? at(ele, j) : at(ele, s, j);
			samples.push([ms, lon, lat, +(h ?? 0)]);
		}));
		if (!samples.length) return null;
		samples.sort((a, b) => a[0] - b[0]);
		const t0 = samples[0][0], pk = base();
		pk.position = { ...(czml.position || {}), epoch: new Date(t0).toISOString(), cartographicDegrees: samples.flatMap(([ms, lon, lat, h]) => [(ms - t0) / 1000, lon, lat, h]) };
		return withVisual(pk);
	};
	const c = g.coordinates, ele = p.ele, time = p.time;
	switch (g.type) {
		case "Point": return [pointPacket(c[0], c[1], typeof ele === "number" ? ele : null, Array.isArray(time) ? time[0] : time)];
		case "MultiPoint": return c.map((q, k) => sub(pointPacket(q[0], q[1], at(ele, k), at(time, k)), k));
		case "LineString": return Array.isArray(time) ? [sampledPacket([c], time, ele)].filter(Boolean) : [polylinePacket(c, ele)];
		case "MultiLineString": return Array.isArray(time) ? [sampledPacket(c, time, ele)].filter(Boolean) : c.map((line, k) => sub(polylinePacket(line, ele, k), k));
		case "Polygon": return [polygonPacket(c, ele)];
		case "MultiPolygon": return c.map((rings, k) => sub(polygonPacket(rings, ele, k), k));
		default: return [];   // GeometryCollection は CZML に対応物が無い
	}
}

export function documentPacket(name, description) {
	const pk = { id: "document", name: name || "geopbf", version: "1.0" };
	if (description) pk.description = description;
	return pk;
}
