/**
 * 任意座標系図郭の edit 用ベイク：MOJ 地図XML zip → {code}-arbitrary.json
 *
 * 任意座標系の図郭だけを抜き、ローカル座標（メートル・図郭重心相対）のまま出力する。
 * 初期アンカーは「疑似公共」判定＝県代表系で planeToLatLon した重心が市区町村の
 * 想定 bbox 内に落ちるならその位置（任意ラベルでも中身が公共座標の図郭は多い）。
 * 落ちない真の任意系は bbox 中心へフォールバック（人手で置く前提）。
 *
 * 使い方: node scripts/bake-arbitrary.mjs <zipfile> <cityCode> [--sys 12] [--bbox lonMin,latMin,lonMax,latMax]
 * 例:     node scripts/bake-arbitrary.mjs sapporo-chuo.zip 01101 --sys 12 --bbox 141.20,42.95,141.45,43.15
 */
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import AdmZip from 'adm-zip';
const __dir = dirname(fileURLToPath(import.meta.url));

// ---- 公共座標系 → WGS84（moj-xml-to-pbf.js と同式）----
const DEG = Math.PI / 180;
const a = 6378137.0, f = 1 / 298.257222101;
const e2 = 2 * f - f * f, m0 = 0.9999;
const CS_ORIGINS = {
	 1:[33,129.5],  2:[33,131],     3:[36,132+10/60], 4:[33,133.5],
	 5:[36,134+20/60], 6:[36,136],  7:[36,137+10/60], 8:[36,138.5],
	 9:[36,139+50/60], 10:[40,140+50/60],
	11:[44,140.25], 12:[44,142.25], 13:[44,144.25],
	14:[26,142],    15:[26,127.5],  16:[26,124],
	17:[26,131],    18:[20,136],    19:[26,154],
};
function meridianArc(phi) {
	const e4 = e2 * e2, e6 = e2 * e4;
	return a * ((1 - e2/4 - 3*e4/64 - 5*e6/256) * phi
		- (3/8) * (e2 + e4/4 + 15*e6/128) * Math.sin(2*phi)
		+ (15/256) * (e4 + 3*e6/4) * Math.sin(4*phi)
		- (35*e6/3072) * Math.sin(6*phi));
}
function planeToLatLon(x, y, sysNum) {
	const [lat0d, lon0d] = CS_ORIGINS[sysNum] || CS_ORIGINS[9];
	const phi0 = lat0d * DEG, lam0 = lon0d * DEG;
	const e4 = e2*e2, e6 = e2*e4;
	const M0 = meridianArc(phi0), M = M0 + x / m0;
	const mu = M / (a * (1 - e2/4 - 3*e4/64 - 5*e6/256));
	const e1 = (1 - Math.sqrt(1-e2)) / (1 + Math.sqrt(1-e2));
	const e12 = e1*e1, e13 = e1*e12, e14 = e1*e13;
	const phi1 = mu + (3*e1/2 - 27*e13/32)*Math.sin(2*mu)
		+ (21*e12/16 - 55*e14/32)*Math.sin(4*mu)
		+ (151*e13/96)*Math.sin(6*mu) + (1097*e14/512)*Math.sin(8*mu);
	const sinP = Math.sin(phi1), cosP = Math.cos(phi1), tanP = Math.tan(phi1);
	const ep2 = e2/(1-e2), C1 = ep2*cosP*cosP, T1 = tanP*tanP;
	const N1 = a / Math.sqrt(1 - e2*sinP*sinP);
	const R1 = a * (1-e2) / Math.pow(1 - e2*sinP*sinP, 1.5);
	const D = y / (N1*m0), D2 = D*D, D3 = D*D2, D4 = D*D3, D5 = D*D4, D6 = D*D5;
	const phi = phi1 - (N1*tanP/R1) * (D2/2
		- (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*ep2)*D4/24
		+ (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*ep2 - 3*C1*C1)*D6/720);
	const lam = lam0 + (D - (1 + 2*T1 + C1)*D3/6
		+ (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*ep2 + 24*T1*T1)*D5/120) / cosP;
	return [lam/DEG, phi/DEG];
}

// ---- GSI 住所検索（大字名→代表点）：真の任意図郭の初期アンカー用。認証不要・大字単位でキャッシュ ----
const geocodeCache = new Map();
async function geocode(q) {
	if (geocodeCache.has(q)) return geocodeCache.get(q);
	let pt = null;
	try {
		const res = await fetch(`https://msearch.gsi.go.jp/address-search/AddressSearch?q=${encodeURIComponent(q)}`);
		const hits = await res.json();
		if (Array.isArray(hits) && hits.length) pt = hits[0].geometry.coordinates;   // [lon,lat]
	} catch { /* オフライン等＝nullでフォールバック */ }
	geocodeCache.set(q, pt);
	await new Promise(r => setTimeout(r, 150));   // 公共APIへの礼儀
	return pt;
}

// ---- 塗り適性：ポリゴン面積/bbox面積（shoelace）。細長い筆＝道路・水路は塗ると図郭全面が
// ベタ化する（区画整理図郭は道路も筆＝隙間なく敷き詰め）ので線のみにする ----
function fillFactor(ring) {
	let s = 0;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
	const area = Math.abs(s / 2);
	let x0 = 1/0, y0 = 1/0, x1 = -1/0, y1 = -1/0;
	for (const p of ring) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
	return area / (((x1 - x0) * (y1 - y0)) || 1e-9);
}
// 塗る筆＝数字地番（通常の宅地等）かつ太い形状。道/地区外/別図/長狭物や細長筆は線のみ。
const isFillable = f => /^\d/.test(f.chiban || '') && fillFactor(f.ring) >= 0.35;

// ---- 地図XML → 図郭1枚分の筆（ローカル座標のまま）----
function parseSheet(xml) {
	const sysTag = (xml.match(/<座標系>(.*?)<\/座標系>/) || [])[1] || '';
	const cityName = (xml.match(/<市区町村名>(.*?)<\/市区町村名>/) || [])[1] || '';
	const pointMap = new Map();
	const pr = /<zmn:GM_Point id="(P\d+)">\s*<zmn:GM_Point\.position>\s*<zmn:DirectPosition>\s*<zmn:X>([-\d.]+)<\/zmn:X>\s*<zmn:Y>([-\d.]+)<\/zmn:Y>/g;
	let m;
	while ((m = pr.exec(xml)) !== null) pointMap.set(m[1], { x: parseFloat(m[2]), y: parseFloat(m[3]) });
	const curveMap = new Map();
	const cr = /<zmn:GM_Curve id="(C\d+)">([\s\S]*?)<\/zmn:GM_Curve>/g;
	while ((m = cr.exec(xml)) !== null) {
		const id = m[1], body = m[2];
		const ori = (body.match(/<zmn:GM_OrientablePrimitive\.orientation>([+-])/) || [])[1] || '+';
		const pts = [];
		const dr = /<zmn:GM_Position\.direct>\s*<zmn:X>([-\d.]+)<\/zmn:X>\s*<zmn:Y>([-\d.]+)<\/zmn:Y>\s*<\/zmn:GM_Position\.direct>/g;
		let dm;
		while ((dm = dr.exec(body)) !== null) pts.push({ x: parseFloat(dm[1]), y: parseFloat(dm[2]) });
		if (!pts.length) { const ir = /<zmn:GM_PointRef\.point idref="(P\d+)"\/>/g; let im; while ((im = ir.exec(body)) !== null) { const p = pointMap.get(im[1]); if (p) pts.push(p); } }
		curveMap.set(id, { pts, ori });
	}
	const surfaceMap = new Map();
	const getCIds = str => { const ids = [], g = /<zmn:GM_CompositeCurve\.generator idref="(C\d+)"\/>/g; let gm; while ((gm = g.exec(str)) !== null) ids.push(gm[1]); return ids; };
	const sr = /<zmn:GM_Surface id="(F\d+)">([\s\S]*?)<\/zmn:GM_Surface>/g;
	while ((m = sr.exec(xml)) !== null) {
		const body = m[2];
		const extM = body.match(/<zmn:GM_SurfaceBoundary\.exterior>([\s\S]*?)<\/zmn:GM_SurfaceBoundary\.exterior>/);
		// interior ring（穴）を捨てると環状道路（長狭物）の内側までベタ塗りされ街区が長方形に潰れる
		const ints = [], intR = /<zmn:GM_SurfaceBoundary\.interior>([\s\S]*?)<\/zmn:GM_SurfaceBoundary\.interior>/g;
		let im;
		while ((im = intR.exec(body)) !== null) ints.push(getCIds(im[1]));
		surfaceMap.set(m[1], { ext: extM ? getCIds(extM[1]) : [], ints });
	}
	const buildRing = cids => {
		const pts = [];
		for (const cid of cids) {
			const c = curveMap.get(cid); if (!c || !c.pts.length) continue;
			const cp = c.ori === '-' ? [...c.pts].reverse() : c.pts;
			pts.push(...(pts.length ? cp.slice(1) : cp));
		}
		return pts;
	};
	const fude = [];
	const fr = /<筆 id="(H\d+)">([\s\S]*?)<\/筆>/g;
	while ((m = fr.exec(xml)) !== null) {
		const body = m[2];
		const tag = t => (body.match(new RegExp(`<${t}>(.*?)</${t}>`)) || [])[1] || '';
		const fid = (body.match(/<形状 idref="(F\d+)"\/>/) || [])[1];
		if (!fid) continue;
		const s = surfaceMap.get(fid); if (!s) continue;
		const ext = buildRing(s.ext); if (ext.length < 3) continue;
		const holes = s.ints.map(buildRing).filter(r => r.length >= 3);
		fude.push({ oaza: tag('大字名'), chiban: tag('地番'), ring: ext, ...(holes.length ? { holes } : {}) });
	}
	return { sysTag, cityName, fude };
}

// ---- main ----
const args = process.argv.slice(2);
const zipPath = args[0], cityCode = args[1];
const sysIdx = args.indexOf('--sys');
const sysNum = sysIdx >= 0 ? parseInt(args[sysIdx + 1]) : 9;
const bboxIdx = args.indexOf('--bbox');
const bbox = bboxIdx >= 0 ? args[bboxIdx + 1].split(',').map(Number) : null;
if (!zipPath || !cityCode) { console.error('usage: node bake-arbitrary.mjs <zip> <cityCode> [--sys N] [--bbox lonMin,latMin,lonMax,latMax]'); process.exit(1); }

const outer = new AdmZip(zipPath);
const sheets = [];
const publicFude = [];   // 公共系図郭の筆（変換済み lon/lat）＝edit の参照レイヤ
for (const e of outer.getEntries().filter(e => e.entryName.endsWith('.zip'))) {
	const iz = new AdmZip(e.getData());
	const xe = iz.getEntries().find(x => x.entryName.endsWith('.xml'));
	if (!xe) continue;
	const xml = xe.getData().toString('utf-8');
	const { sysTag, cityName, fude } = parseSheet(xml);
	if (!fude.length) continue;

	// 公共系図郭 → その系で lon/lat 化して参照レイヤへ
	if (!/任意/.test(sysTag)) {
		const sysM = sysTag.match(/(\d+)系/);
		const sn = sysM ? parseInt(sysM[1]) : sysNum;
		const toLL = p => { const [lo, la] = planeToLatLon(p.x, p.y, sn);
			return [Math.round(lo * 1e7) / 1e7, Math.round(la * 1e7) / 1e7]; };
		// 図郭bbox（プレースホルダ枠の判定用）
		let bx0 = 1/0, by0 = 1/0, bx1 = -1/0, by1 = -1/0;
		for (const f of fude) for (const p of f.ring) {
			if (p.x < bx0) bx0 = p.x; if (p.y < by0) by0 = p.y;
			if (p.x > bx1) bx1 = p.x; if (p.y > by1) by1 = p.y;
		}
		const sheetArea = (bx1 - bx0) * (by1 - by0) || 1;
		for (const f of fude) {
			let fx0 = 1/0, fy0 = 1/0, fx1 = -1/0, fy1 = -1/0;
			for (const p of f.ring) {
				if (p.x < fx0) fx0 = p.x; if (p.y < fy0) fy0 = p.y;
				if (p.x > fx1) fx1 = p.x; if (p.y > fy1) fy1 = p.y;
			}
			const ratio = (fx1 - fx0) * (fy1 - fy0) / sheetArea;
			// プレースホルダ枠（長狭物不明等＝図郭枠サイズの長方形。点数は5点〜77点と幅がある）→ 線ごと捨てる
			if (fude.length > 5 && (ratio >= 0.8 || (f.ring.length <= 6 && ratio >= 0.5))) continue;
			// 塗るのは数字地番×太い形状のみ（道路・水路・地区外・細長筆を塗ると図郭全面ベタ＝長方形化）
			const noFill = ratio >= 0.3 || !isFillable(f);
			publicFude.push({
				oaza: f.oaza, chiban: f.chiban,
				...(noFill ? { noFill: 1 } : {}),
				ring: f.ring.map(toLL),
				...(f.holes ? { holes: f.holes.map(h => h.map(toLL)) } : {}),
			});
		}
		continue;
	}

	// 図郭重心＋bbox（ローカル）
	let sx = 0, sy = 0, n = 0;
	let ax0 = 1/0, ay0 = 1/0, ax1 = -1/0, ay1 = -1/0;
	for (const f of fude) for (const p of f.ring) {
		sx += p.x; sy += p.y; n++;
		if (p.x < ax0) ax0 = p.x; if (p.y < ay0) ay0 = p.y;
		if (p.x > ax1) ax1 = p.x; if (p.y > ay1) ay1 = p.y;
	}
	const cx = sx / n, cy = sy / n;
	const shArea = (ax1 - ax0) * (ay1 - ay0) || 1;
	const bboxRatio = f => {
		let x0 = 1/0, y0 = 1/0, x1 = -1/0, y1 = -1/0;
		for (const p of f.ring) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y; }
		return (x1 - x0) * (y1 - y0) / shArea;
	};

	// 初期アンカー3段構え：①疑似公共（県代表系変換の重心が bbox 内）→②大字名の住所突合（GSIジオコーダ）→③bbox中心
	let anchor = null, pseudo = false, geocoded = false;
	const [lon, lat] = planeToLatLon(cx, cy, sysNum);
	if (bbox && lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]) { anchor = [lon, lat]; pseudo = true; }
	if (!anchor) {
		// 図郭の最頻大字で住所検索＝「住所突合で近くに置けば操作効率は高い」の実装
		const counts = new Map();
		for (const f of fude) if (f.oaza) counts.set(f.oaza, (counts.get(f.oaza) || 0) + 1);
		const topOaza = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
		if (topOaza && cityName) {
			const pt = await geocode(cityName + topOaza);
			if (pt && (!bbox || (pt[0] >= bbox[0] - 0.05 && pt[0] <= bbox[2] + 0.05 && pt[1] >= bbox[1] - 0.05 && pt[1] <= bbox[3] + 0.05))) {
				anchor = pt; geocoded = true;
			}
		}
	}
	if (!anchor) anchor = bbox ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] : [141.35, 43.06];

	const oazaSet = [...new Set(fude.map(f => f.oaza).filter(Boolean))];
	sheets.push({
		id: e.entryName.replace(/\.zip$/i, ''),
		oaza: oazaSet,
		pseudoPublic: pseudo,
		geocoded,
		anchor: [Math.round(anchor[0] * 1e7) / 1e7, Math.round(anchor[1] * 1e7) / 1e7],
		// ローカル座標は重心相対（m・cm精度）。x=北, y=東（地図XML規約）
		fude: fude.filter(f => !(fude.length > 5 && (bboxRatio(f) >= 0.8 || (f.ring.length <= 6 && bboxRatio(f) >= 0.5))))   // プレースホルダ枠除去（公共側と同基準）
			.map(f => {
				const rel = p => [Math.round((p.x - cx) * 100) / 100, Math.round((p.y - cy) * 100) / 100];
				return { oaza: f.oaza, chiban: f.chiban, ring: f.ring.map(rel),
					...(bboxRatio(f) >= 0.3 || !isFillable(f) ? { noFill: 1 } : {}),
					...(f.holes ? { holes: f.holes.map(h => h.map(rel)) } : {}) };
			}),
	});
	console.log(`  ${e.entryName}  筆=${fude.length}  大字=${oazaSet.slice(0,3).join(',') || '?'}  ${pseudo ? '疑似公共→着地' : geocoded ? '住所突合→大字付近' : '→bbox中心'}  anchor=${anchor.map(v=>v.toFixed(4))}`);
}

// 同一アンカー（同じ大字等）に積み重なった図郭を格子状に展開＝選択・整理しやすく
const byAnchor = new Map();
for (const sh of sheets) {
	const k = sh.anchor.join(',');
	if (!byAnchor.has(k)) byAnchor.set(k, []);
	byAnchor.get(k).push(sh);
}
for (const group of byAnchor.values()) {
	if (group.length < 2) continue;
	group.forEach((sh, i) => {
		const col = (i % 3) - 1, row = Math.floor(i / 3) - Math.floor((group.length - 1) / 6);
		sh.anchor = [Math.round((sh.anchor[0] + col * 0.004) * 1e7) / 1e7,
		             Math.round((sh.anchor[1] - row * 0.003) * 1e7) / 1e7];   // 約350×330mの格子で展開
	});
}

const out = join(__dir, '..', 'public', 'moj-local', `${cityCode}-arbitrary.json`);
writeFileSync(out, JSON.stringify({ cityCode, sys: sysNum, sheets, publicFude }));
console.log(`→ ${out}  (任意 ${sheets.length} 図郭 / 公共参照 ${publicFude.length} 筆)`);
