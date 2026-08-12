// 防災 bake 共通ヘルパ：市区町村への地物割当て（e-Stat 小地域境界を市区町村ポリゴン集合として使う）。
// KSJ の A33/A31 shapefile には市区町村コード属性が無い/揺れるため、空間割当てが正道:
//   A33（小さな区域ポリゴン）… 重心の点in面で1市区町村へ
//   A31（流域スケールの大ポリゴン）… bbox 交差で該当する全市区町村へ複製（各市ファイルを自己完結に）
import { gunzipSync } from 'zlib';

const API_BASE = process.env.API_BASE ?? 'https://api.ortho-earth.com';

async function fetchJsonl(url) {
	const res = await fetch(url);
	if (!res.ok) return null;
	let buf = Buffer.from(await res.arrayBuffer());
	if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
	const feats = [];
	for (const line of buf.toString('utf8').split('\n')) {
		const s = line.trim();
		if (s) { try { feats.push(JSON.parse(s)); } catch { /* skip */ } }
	}
	return feats.length ? feats : null;
}

export function bboxOfGeom(g, bb = [180, 90, -180, -90]) {
	const walk = c => { if (typeof c[0] === 'number') { if (c[0] < bb[0]) bb[0] = c[0]; if (c[0] > bb[2]) bb[2] = c[0]; if (c[1] < bb[1]) bb[1] = c[1]; if (c[1] > bb[3]) bb[3] = c[1]; } else c.forEach(walk); };
	if (g?.coordinates) walk(g.coordinates);
	return bb;
}
export const bboxHit = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

export function centroidOf(g) {   // 荒い重心（外周リング頂点平均）＝割当て用途には十分
	let sx = 0, sy = 0, n = 0;
	const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map(p => p[0]) : [];
	for (const r of rings) for (const c of r) { sx += c[0]; sy += c[1]; n++; }
	return n ? [sx / n, sy / n] : null;
}

function pointInRing(x, y, ring) {
	let hit = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const [xi, yi] = ring[i], [xj, yj] = ring[j];
		if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) hit = !hit;
	}
	return hit;
}
export function pointInGeom(x, y, g) {   // 外周リングのみ（穴は無視＝割当て用途では誤差）
	if (g.type === 'Polygon') return pointInRing(x, y, g.coordinates[0]);
	if (g.type === 'MultiPolygon') return g.coordinates.some(p => pointInRing(x, y, p[0]));
	return false;
}

// 都道府県の市区町村インデックス（e-Stat 小地域を市区町村単位に束ねる）
//   assign(lon,lat) → 市区町村コード|null（点in面・bbox 前置フィルタ）
//   cities → [{ code, bbox }]（bbox 交差割当て用）
export async function loadCityIndex(prefCode, estatManifest, year = '2020') {
	const codes = estatManifest.filter(e => e.code.startsWith(prefCode) && !e.name?.includes('全域')).map(e => e.code);
	const cities = [];
	for (const code of codes) {
		const feats = await fetchJsonl(`${API_BASE}/bucket/estat/${year}/${code}.geojsonl`);
		if (!feats) { console.warn(`  ⚠ estat境界なし: ${code}`); continue; }
		const geoms = feats.map(f => f.geometry).filter(Boolean);
		const bb = [180, 90, -180, -90];
		for (const g of geoms) bboxOfGeom(g, bb);
		cities.push({ code, bbox: bb, geoms });
		process.stdout.write(`\r  市区町村インデックス ${cities.length}/${codes.length}   `);
	}
	console.log('');
	return {
		cities,
		assign(lon, lat) {
			for (const c of cities) {
				if (lon < c.bbox[0] || lon > c.bbox[2] || lat < c.bbox[1] || lat > c.bbox[3]) continue;
				if (c.geoms.some(g => pointInGeom(lon, lat, g))) return c.code;
			}
			return null;
		},
	};
}

// 座標を小数6桁へ量子化（~0.1m）＝geojsonl のサイズを絞る（特に A31 の巨大ポリゴン）
export function quantizeGeom(g, digits = 6) {
	const q = v => Math.round(v * 10 ** digits) / 10 ** digits;
	const walk = c => typeof c[0] === 'number' ? [q(c[0]), q(c[1])] : c.map(walk);
	return g?.coordinates ? { ...g, coordinates: walk(g.coordinates) } : g;
}

// 矩形クリップ（Sutherland–Hodgman・凸クリップ領域＝bbox の4半平面）。
// A31 の流域ポリゴンを市区町村 bbox で切り抜く＝「跨る全市へ丸ごと複製」のサイズ爆発を断つ
//（実測: 東京メッシュ5339が複製で2.1GB→クリップで市の窓内だけに）。穴リングも独立にクリップで正しい。
function clipRingHalf(pts, inside, cross) {
	const out = [];
	for (let i = 0; i < pts.length; i++) {
		const a = pts[i], b = pts[(i + 1) % pts.length];
		const ia = inside(a), ib = inside(b);
		if (ia) { out.push(a); if (!ib) out.push(cross(a, b)); }
		else if (ib) out.push(cross(a, b));
	}
	return out;
}
export function clipRingToBbox(ring, bb) {
	const R = ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
	const ix = (a, b, X) => { const t = (X - a[0]) / (b[0] - a[0]); return [X, a[1] + t * (b[1] - a[1])]; };
	const iy = (a, b, Y) => { const t = (Y - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), Y]; };
	let p = R;
	p = clipRingHalf(p, v => v[0] >= bb[0], (a, b) => ix(a, b, bb[0])); if (p.length < 3) return null;
	p = clipRingHalf(p, v => v[0] <= bb[2], (a, b) => ix(a, b, bb[2])); if (p.length < 3) return null;
	p = clipRingHalf(p, v => v[1] >= bb[1], (a, b) => iy(a, b, bb[1])); if (p.length < 3) return null;
	p = clipRingHalf(p, v => v[1] <= bb[3], (a, b) => iy(a, b, bb[3])); if (p.length < 3) return null;
	p.push(p[0]);
	return p;
}
export function clipGeomToBbox(g, bb) {
	const comps = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
	const kept = [];
	for (const rings of comps) {
		const outer = clipRingToBbox(rings[0], bb);
		if (!outer) continue;
		const c = [outer];
		for (let h = 1; h < rings.length; h++) { const hole = clipRingToBbox(rings[h], bb); if (hole) c.push(hole); }
		kept.push(c);
	}
	if (!kept.length) return null;
	return kept.length === 1 ? { type: 'Polygon', coordinates: kept[0] } : { type: 'MultiPolygon', coordinates: kept };
}

// リングの冗長頂点間引き（実効三角形面積 < minArea の頂点を落とす一走査＝Visvalingam の非反復近似）。
// A31 はラスタ起源の階段辺＝共線・微小頂点が大半（等ランク面の視覚は不変）。閉合・最少4点は保持。
export function thinRings(g, minArea = 1.5e-9) {   // ~ (4m)² 相当（deg²）
	const tri = (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
	const thin = ring => {
		if (ring.length <= 5) return ring;
		const out = [ring[0]];
		for (let i = 1; i < ring.length - 1; i++) {
			const a = out[out.length - 1], b = ring[i], c = ring[i + 1];
			if (tri(a, b, c) >= minArea) out.push(b);
		}
		out.push(ring[ring.length - 1]);
		return out.length >= 4 ? out : ring;
	};
	const walk = c => typeof c[0][0] === 'number' ? thin(c) : c.map(walk);
	return g?.coordinates ? { ...g, coordinates: walk(g.coordinates) } : g;
}

// shapefile zip → Feature 反復（.shp/.dbf の全ペア・shift_jis）。AdmZip/shapefile は呼び出し側が渡す。
// opts.match＝対象 .shp の絞り込み（A31 は zip 内に 計画/想定最大/継続時間/家屋倒壊 の4層が同居＝要選別）
export async function* zipFeatures(zip, shapefile, { match = null } = {}) {
	const entries = zip.getEntries();
	const shps = entries.filter(e => e.entryName.toLowerCase().endsWith('.shp'))
		.filter(e => !match || match.test(e.entryName.split(/[\\/]/).pop()));
	for (const shp of shps) {
		const base = shp.entryName.replace(/\.shp$/i, '');
		const dbf = entries.find(e => e.entryName.toLowerCase() === (base + '.dbf').toLowerCase());
		if (!dbf) continue;
		const source = await shapefile.open(shp.getData().buffer, dbf.getData().buffer, { encoding: 'shift_jis' });
		let r = await source.read();
		while (!r.done) {
			if (r.value?.geometry) yield { feature: r.value, shpName: shp.entryName };
			r = await source.read();
		}
	}
}

// 属性名の揺れ吸収：候補リストの最初に実在するキーを返す
export const pickField = (props, candidates) => candidates.find(k => k in props) ?? null;
