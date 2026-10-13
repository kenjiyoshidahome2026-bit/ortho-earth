/**
 * 法務省 登記所備付地図（地図XML）の読み＝moj-batch / moj-xml-to-pbf / moj-convert の 3 本が持っていた同じ関数を 1 本に（2026-10-03）。
 *
 *   CS_ORIGINS / planeToLatLon   公共座標系（JGD2011 平面直角座標系 19 系）→ WGS84 [lon, lat]（横メルカトル逆変換・8 桁丸め）
 *   parseSysNum(txt)             「公共座標9系」→ 9。番号が無ければ 0（＝フォールバックに委ねる）
 *   sysTagOf(xml)                <座標系> の中身（無ければ ''）
 *   xmlHeader(xml)               { sysTag, cityCode, cityName }
 *   xmlToFeatures(xml, fallback) 筆を 1 件ずつ yield（GeoJSON Feature・座標変換済み）。fallback＝任意座標系／系不明の時の系番号（既定 9）
 *   scanSysNum(xmls, fallback)   複数の XML（文字列の iterable）から番号付き公共座標系を先に探す＝任意座標系の XML に同じ市区町村の系を使う
 *
 * 都道府県→系番号（PREF_SYS）は jp/codes.js が正本＝呼ぶ側が渡す（このモジュールは DOM にも bucket にも依らない）。
 * geopbf の decoder/moj.js（ブラウザ版・正規表現を使わない字句読み）は別実装のまま＝出力バイト列の検定（t-moj）が守る。
 */

const DEG = Math.PI / 180;
const a = 6378137.0, f = 1 / 298.257222101;   // GRS80 長半径・扁平率
const e2 = 2 * f - f * f, m0 = 0.9999;         // 第1離心率^2・縮尺係数

// 19 系の原点（緯度°, 経度°）
export const CS_ORIGINS = {
	 1: [33, 129.5],      2: [33, 131],         3: [36, 132 + 10 / 60],  4: [33, 133.5],
	 5: [36, 134 + 20 / 60], 6: [36, 136],      7: [36, 137 + 10 / 60],  8: [36, 138.5],
	 9: [36, 139 + 50 / 60], 10: [40, 140 + 50 / 60],
	11: [44, 140.25],    12: [44, 142.25],     13: [44, 144.25],
	14: [26, 142],       15: [26, 127.5],      16: [26, 124],
	17: [26, 131],       18: [20, 136],        19: [26, 154],
};

// 子午線弧長（赤道から緯度 phi まで）
export function meridianArc(phi) {
	const e4 = e2 * e2, e6 = e2 * e4;
	return a * ((1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi
		- (3 / 8) * (e2 + e4 / 4 + 15 * e6 / 128) * Math.sin(2 * phi)
		+ (15 / 256) * (e4 + 3 * e6 / 4) * Math.sin(4 * phi)
		- (35 * e6 / 3072) * Math.sin(6 * phi));
}

// 横メルカトル逆変換：平面直角（x=北, y=東・m）→ [lon, lat]（度・小数 8 桁）
export function planeToLatLon(x, y, sysNum) {
	const [lat0d, lon0d] = CS_ORIGINS[sysNum] || CS_ORIGINS[9];
	const phi0 = lat0d * DEG, lam0 = lon0d * DEG;
	const e4 = e2 * e2, e6 = e2 * e4;
	const M0 = meridianArc(phi0), M = M0 + x / m0;
	const mu = M / (a * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
	const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
	const e12 = e1 * e1, e13 = e1 * e12, e14 = e1 * e13;
	const phi1 = mu + (3 * e1 / 2 - 27 * e13 / 32) * Math.sin(2 * mu)
		+ (21 * e12 / 16 - 55 * e14 / 32) * Math.sin(4 * mu)
		+ (151 * e13 / 96) * Math.sin(6 * mu) + (1097 * e14 / 512) * Math.sin(8 * mu);
	const sinP = Math.sin(phi1), cosP = Math.cos(phi1), tanP = Math.tan(phi1);
	const ep2 = e2 / (1 - e2), C1 = ep2 * cosP * cosP, T1 = tanP * tanP;
	const N1 = a / Math.sqrt(1 - e2 * sinP * sinP);
	const R1 = a * (1 - e2) / Math.pow(1 - e2 * sinP * sinP, 1.5);
	const D = y / (N1 * m0), D2 = D * D, D3 = D * D2, D4 = D * D3, D5 = D * D4, D6 = D * D5;
	const phi = phi1 - (N1 * tanP / R1) * (D2 / 2
		- (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D4 / 24
		+ (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D6 / 720);
	const lam = lam0 + (D - (1 + 2 * T1 + C1) * D3 / 6
		+ (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D5 / 120) / cosP;
	return [parseFloat((lam / DEG).toFixed(8)), parseFloat((phi / DEG).toFixed(8))];
}

// 座標系テキスト → 系番号（不明は 0 ＝フォールバックに委ねる）
export function parseSysNum(txt) {
	const m = txt?.match(/(\d+)系/); return m ? parseInt(m[1]) : 0;
}

const tagOf = (xml, t) => (xml.match(new RegExp(`<${t}>(.*?)</${t}>`)) || [])[1] || '';
export const sysTagOf = xml => tagOf(xml, '座標系');
export const xmlHeader = xml => ({ sysTag: sysTagOf(xml), cityCode: tagOf(xml, '市区町村コード'), cityName: tagOf(xml, '市区町村名') });

// 任意座標系の XML が混じる市区町村＝同じ zip の中の番号付き公共座標系を先に探し、その系で読む（無ければ fallback）
export function scanSysNum(xmls, fallback = 9) {
	for (const xml of xmls) {
		const tag = sysTagOf(xml);
		if (!/任意/.test(tag)) { const n = parseSysNum(tag); if (n) return n; }
	}
	return fallback;
}

// XML → GeoJSON Feature（Polygon）を 1 筆ずつ yield。GM_Point → GM_Curve → GM_Surface → 筆 の 4 パス（正規表現）
export function* xmlToFeatures(xml, defaultSysNum = 9) {
	const { sysTag, cityCode, cityName } = xmlHeader(xml);
	const sysNum = /任意/.test(sysTag) ? defaultSysNum : (parseSysNum(sysTag) || defaultSysNum);

	// GM_Point
	const pointMap = new Map();
	const pr = /<zmn:GM_Point id="(P\d+)">\s*<zmn:GM_Point\.position>\s*<zmn:DirectPosition>\s*<zmn:X>([-\d.]+)<\/zmn:X>\s*<zmn:Y>([-\d.]+)<\/zmn:Y>/g;
	let m;
	while ((m = pr.exec(xml)) !== null) pointMap.set(m[1], { x: parseFloat(m[2]), y: parseFloat(m[3]) });

	// GM_Curve
	const curveMap = new Map();
	const cr = /<zmn:GM_Curve id="(C\d+)">([\s\S]*?)<\/zmn:GM_Curve>/g;
	while ((m = cr.exec(xml)) !== null) {
		const id = m[1], body = m[2];
		const ori = (body.match(/<zmn:GM_OrientablePrimitive\.orientation>([+-])/) || [])[1] || '+';
		const pts = [];
		const dr = /<zmn:GM_Position\.direct>\s*<zmn:X>([-\d.]+)<\/zmn:X>\s*<zmn:Y>([-\d.]+)<\/zmn:Y>\s*<\/zmn:GM_Position\.direct>/g;
		let dm;
		while ((dm = dr.exec(body)) !== null) pts.push({ x: parseFloat(dm[1]), y: parseFloat(dm[2]) });
		if (!pts.length) {
			const ir = /<zmn:GM_PointRef\.point idref="(P\d+)"\/>/g;
			let im;
			while ((im = ir.exec(body)) !== null) { const p = pointMap.get(im[1]); if (p) pts.push(p); }
		}
		curveMap.set(id, { pts, ori });
	}
	pointMap.clear();

	// GM_Surface
	const surfaceMap = new Map();
	const getCIds = str => { const ids = [], g = /<zmn:GM_CompositeCurve\.generator idref="(C\d+)"\/>/g; let gm; while ((gm = g.exec(str)) !== null) ids.push(gm[1]); return ids; };
	const sr = /<zmn:GM_Surface id="(F\d+)">([\s\S]*?)<\/zmn:GM_Surface>/g;
	while ((m = sr.exec(xml)) !== null) {
		const id = m[1], body = m[2];
		const extM = body.match(/<zmn:GM_SurfaceBoundary\.exterior>([\s\S]*?)<\/zmn:GM_SurfaceBoundary\.exterior>/);
		const ints = [], intR = /<zmn:GM_SurfaceBoundary\.interior>([\s\S]*?)<\/zmn:GM_SurfaceBoundary\.interior>/g;
		let im;
		while ((im = intR.exec(body)) !== null) ints.push(getCIds(im[1]));
		surfaceMap.set(id, { ext: extM ? getCIds(extM[1]) : [], ints });
	}

	const buildRing = cids => {
		const pts = [];
		for (const cid of cids) {
			const c = curveMap.get(cid); if (!c || !c.pts.length) continue;
			const cp = c.ori === '-' ? [...c.pts].reverse() : c.pts;
			pts.push(...(pts.length ? cp.slice(1) : cp));
		}
		if (pts.length > 1) { const f = pts[0], l = pts[pts.length - 1]; if (f.x !== l.x || f.y !== l.y) pts.push(f); }
		return pts.map(({ x, y }) => planeToLatLon(x, y, sysNum));
	};

	// 筆
	const fr = /<筆 id="(H\d+)">([\s\S]*?)<\/筆>/g;
	while ((m = fr.exec(xml)) !== null) {
		const body = m[2];
		const tag = t => tagOf(body, t);
		const fid = (body.match(/<形状 idref="(F\d+)"\/>/) || [])[1];
		if (!fid) continue;
		const s = surfaceMap.get(fid); if (!s) continue;
		const ext = buildRing(s.ext); if (ext.length < 4) continue;
		yield {
			type: 'Feature',
			geometry: { type: 'Polygon', coordinates: [ext, ...s.ints.map(buildRing)] },
			properties: { 市区町村コード: cityCode, 市区町村名: cityName, 大字コード: tag('大字コード'),
				大字名: tag('大字名'), 丁目コード: tag('丁目コード'), 小字コード: tag('小字コード'),
				地番: tag('地番'), 精度区分: tag('精度区分'), 座標値種別: tag('座標値種別') },
		};
	}
}
