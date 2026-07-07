/**
 * 荒川区(13118) 任意座標系プロトタイプ: 大字・丁目単位で e-Stat 小地域境界に相似変換フィット
 * あくまで表示用の近似。法的な筆界確定ではない。
 */
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import * as shapefile from 'shapefile';

const XML_DIR = '/private/tmp/claude-501/-Users-yoshida-ortho-earth/af310229-32f6-4664-875b-c9ee9e6de351/scratchpad/13118';
const ESTAT_DIR = '/Users/yoshida/ortho-earth/apps/gishub-jp/estat';
const OUT = '/private/tmp/claude-501/-Users-yoshida-ortho-earth/af310229-32f6-4664-875b-c9ee9e6de351/scratchpad/13118-rubbersheet.geojson';

// ---- 漢数字 → 数値 (1-99) ----
const KANJI_DIGITS = { 一:1, 二:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
function kanjiToNum(s) {
	if (!s) return null;
	if (s === '十') return 10;
	let m = s.match(/^十([一二三四五六七八九])$/);
	if (m) return 10 + KANJI_DIGITS[m[1]];
	m = s.match(/^([一二三四五六七八九])十([一二三四五六七八九]?)$/);
	if (m) return KANJI_DIGITS[m[1]] * 10 + (m[2] ? KANJI_DIGITS[m[2]] : 0);
	if (KANJI_DIGITS[s] != null) return KANJI_DIGITS[s];
	return null;
}
// 全角数字 → 数値
function fullwidthToNum(s) {
	if (!s) return null;
	const half = s.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
	const m = half.match(/(\d+)/);
	return m ? parseInt(m[1]) : null;
}

// e-Stat S_NAME (例: "南千住一丁目") → { base: "南千住", chome: 1 }
function parseEstatName(name) {
	const m = name.match(/^(.+?)([一二三四五六七八九十]+)丁目$/);
	if (m) return { base: m[1], chome: kanjiToNum(m[2]) };
	return { base: name, chome: null }; // 丁目なし（大字のみ）の地域
}

// ---- 1. e-Stat 小地域境界読み込み ----
async function loadEstat() {
	const source = await shapefile.open(`${ESTAT_DIR}/r2ka13118.shp`, `${ESTAT_DIR}/r2ka13118.dbf`, { encoding: 'shift-jis' });
	const areas = [];
	while (true) {
		const r = await source.read();
		if (r.done) break;
		const { base, chome } = parseEstatName(r.value.properties.S_NAME);
		areas.push({ base, chome, sName: r.value.properties.S_NAME, geometry: r.value.geometry });
	}
	return areas;
}

// ---- 2. moj XML (荒川区・任意座標系) 読み込み ----
// moj-xml-to-pbf.js の xmlToFeatures と同じ「タグ種別ごとに正規表現で1パス」方式（O(n)）。
// 手書きカーソルトークナイザー（毎回全文再走査）は O(n^2) になり巨大ファイルで詰まったため不採用。
function parseMojXml(xml) {
	const pointMap = new Map();
	const pr = /<zmn:GM_Point id="(P\d+)">\s*<zmn:GM_Point\.position>\s*<zmn:DirectPosition>\s*<zmn:X>([-\d.]+)<\/zmn:X>\s*<zmn:Y>([-\d.]+)<\/zmn:Y>/g;
	let m;
	while ((m = pr.exec(xml)) !== null) pointMap.set(m[1], [parseFloat(m[2]), parseFloat(m[3])]);

	const curveMap = new Map();
	const cr = /<zmn:GM_Curve id="(C\d+)">([\s\S]*?)<\/zmn:GM_Curve>/g;
	while ((m = cr.exec(xml)) !== null) {
		const id = m[1], body = m[2];
		const ori = (body.match(/<zmn:GM_OrientablePrimitive\.orientation>([+-])/) || [])[1] || '+';
		const pts = [];
		const dr = /<zmn:GM_Position\.direct>\s*<zmn:X>([-\d.]+)<\/zmn:X>\s*<zmn:Y>([-\d.]+)<\/zmn:Y>\s*<\/zmn:GM_Position\.direct>/g;
		let dm;
		while ((dm = dr.exec(body)) !== null) pts.push([parseFloat(dm[1]), parseFloat(dm[2])]);
		if (!pts.length) {
			const ir = /<zmn:GM_PointRef\.point idref="(P\d+)"\/>/g;
			let im;
			while ((im = ir.exec(body)) !== null) { const p = pointMap.get(im[1]); if (p) pts.push(p); }
		}
		curveMap.set(id, { pts, ori });
	}
	pointMap.clear();

	const surfaceMap = new Map();
	const getCIds = str => { const ids = [], g = /<zmn:GM_CompositeCurve\.generator idref="(C\d+)"\/>/g; let gm; while ((gm = g.exec(str)) !== null) ids.push(gm[1]); return ids; };
	const sr = /<zmn:GM_Surface id="(F\d+)">([\s\S]*?)<\/zmn:GM_Surface>/g;
	while ((m = sr.exec(xml)) !== null) {
		const id = m[1], body = m[2];
		const extM = body.match(/<zmn:GM_SurfaceBoundary\.exterior>([\s\S]*?)<\/zmn:GM_SurfaceBoundary\.exterior>/);
		surfaceMap.set(id, { ext: extM ? getCIds(extM[1]) : [] });
	}

	const feats = [];
	const fr = /<筆 id="(H\d+)">([\s\S]*?)<\/筆>/g;
	while ((m = fr.exec(xml)) !== null) {
		const body = m[2];
		const tag = t => (body.match(new RegExp(`<${t}>(.*?)</${t}>`)) || [])[1] || '';
		const fid = (body.match(/<形状 idref="(F\d+)"\/>/) || [])[1];
		if (!fid) continue;
		const s = surfaceMap.get(fid); if (!s) continue;
		const pts = [];
		for (const cid of s.ext) {
			const c = curveMap.get(cid); if (!c || !c.pts.length) continue;
			const cp = c.ori === '-' ? [...c.pts].reverse() : c.pts;
			pts.push(...(pts.length ? cp.slice(1) : cp));
		}
		if (pts.length < 3) continue;
		feats.push({ daiji: tag('大字名'), chome: fullwidthToNum(tag('丁目名')), pts, chiban: tag('地番') });
	}
	return feats;
}

console.log('e-Stat 小地域 読み込み中...');
const estatAreas = await loadEstat();
console.log(`  ${estatAreas.length} 小地域`);

console.log('moj XML 読み込み中...');
let mojFeats = [];
for (let i = 1; i <= 19; i++) {
	const xml = readFileSync(`${XML_DIR}/tmp${i}/13118-0115-${i}.xml`, 'utf8');
	mojFeats.push(...parseMojXml(xml));
}
console.log(`  ${mojFeats.length} 筆`);

// ---- 3. 大字+丁目でグループ化 ----
function groupKey(daiji, chome) { return `${daiji}::${chome ?? ''}`; }
const mojGroups = new Map();
for (const f of mojFeats) {
	const k = groupKey(f.daiji, f.chome);
	if (!mojGroups.has(k)) mojGroups.set(k, []);
	mojGroups.get(k).push(f);
}
const estatGroups = new Map();
for (const a of estatAreas) estatGroups.set(groupKey(a.base, a.chome), a);

console.log(`moj グループ数: ${mojGroups.size}, e-Stat グループ数: ${estatGroups.size}`);
let matched = 0, unmatched = [];
for (const k of mojGroups.keys()) {
	if (estatGroups.has(k)) matched++; else unmatched.push(k);
}
console.log(`マッチ: ${matched} / ${mojGroups.size}`);
console.log('未マッチ例:', unmatched.slice(0, 15));

// ---- 4. 相似変換フィット (重心+回転+スケール, 主成分軸ベース) ----
function centroid(pts) {
	let sx = 0, sy = 0;
	for (const [x, y] of pts) { sx += x; sy += y; }
	return [sx / pts.length, sy / pts.length];
}
function flattenPolygon(geom) {
	// GeoJSON Polygon/MultiPolygon の全頂点をフラットに
	const pts = [];
	const walk = c => { if (typeof c[0] === 'number') pts.push(c); else c.forEach(walk); };
	walk(geom.coordinates);
	return pts;
}
function rms(pts, c) {
	let s = 0;
	for (const [x, y] of pts) { const dx = x - c[0], dy = y - c[1]; s += dx * dx + dy * dy; }
	return Math.sqrt(s / pts.length);
}

// 形（shape）で合わせるのではなく、地名（大字名+丁目名）の対応だけで位置決めする。
// moj のローカル座標は (X=北方向, Y=東方向) の順で格納されている（本家 planeToLatLon も
// X→緯度・Y→経度の対応）。GeoJSON は [lon,lat]=[東,北] の順なので、回転を推定するのではなく
// 「東→lon, 北→lat」という軸の対応をそのまま使い、重心とスケールだけを地名の位置に合わせる。
// 回転探索(Chamfer距離での当て推量)は荒川区の実験で見た目が改善せず、むしろ地名だけを
// 信頼する方が「人力ドラッグ前提の初期位置」として説明しやすく安全という判断。
function fitTransform(srcPts, dstGeom) {
	const dstPts = flattenPolygon(dstGeom);
	const srcC = centroid(srcPts), dstC = centroid(dstPts);
	const srcScale = rms(srcPts, srcC), dstScale = rms(dstPts, dstC);
	const scale = dstScale / srcScale;
	return ([x, y]) => {
		const north = x - srcC[0], east = y - srcC[1];
		return [dstC[0] + east * scale, dstC[1] + north * scale];
	};
}

// ---- 5. 変換適用してGeoJSON化 ----
const outFeatures = [];
let noMatch = 0;
for (const [k, feats] of mojGroups) {
	const estat = estatGroups.get(k);
	if (!estat) { noMatch += feats.length; continue; }
	const allPts = feats.flatMap(f => f.pts);
	const transform = fitTransform(allPts, estat.geometry);
	for (const f of feats) {
		const coords = f.pts.map(transform);
		const first = coords[0], last = coords[coords.length - 1];
		if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
		outFeatures.push({
			type: 'Feature',
			properties: { daiji: f.daiji, chome: f.chome, chiban: f.chiban },
			geometry: { type: 'Polygon', coordinates: [coords] },
		});
	}
}
console.log(`出力: ${outFeatures.length} 筆（マッチせず除外: ${noMatch}）`);
writeFileSync(OUT, JSON.stringify({ type: 'FeatureCollection', features: outFeatures }));
console.log('書き出し:', OUT);
