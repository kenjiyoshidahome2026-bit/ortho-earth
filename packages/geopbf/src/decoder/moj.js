import { GeoPBF } from "../pbf-base.js";
import { inflateRaw } from 'pako';

// JGD2011 Japan plane rectangular coordinate system → WGS84 (module-level constants)
const DEG = Math.PI / 180;
const a   = 6378137.0, f = 1 / 298.257222101;
const e2  = 2 * f - f * f, m0 = 0.9999;
const e4  = e2 * e2, e6 = e2 * e4;
const arcConst = a * (1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256);
const e1  = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
const e12 = e1 * e1, e13 = e1 * e12, e14 = e1 * e13;
const A1  = 3 * e1 / 2 - 27 * e13 / 32;
const A2  = 21 * e12 / 16 - 55 * e14 / 32;
const A3  = 151 * e13 / 96;
const A4  = 1097 * e14 / 512;

const CS_ORIGINS = {
	 1:[33,129.5],    2:[33,131],       3:[36,132+10/60], 4:[33,133.5],
	 5:[36,134+20/60],6:[36,136],       7:[36,137+10/60], 8:[36,138.5],
	 9:[36,139+50/60],10:[40,140+50/60],
	11:[44,140.25],  12:[44,142.25],   13:[44,144.25],
	14:[26,142],     15:[26,127.5],    16:[26,124],
	17:[26,131],     18:[20,136],      19:[26,154],
};

const PREF_SYS = {
	'01':12,'02':10,'03':10,'04':10,'05':10,'06':10,'07': 9,
	'08': 9,'09': 9,'10': 8,'11': 9,'12': 9,'13': 9,'14': 9,
	'15': 8,'16': 7,'17': 7,'18': 6,'19': 8,'20': 8,'21': 7,
	'22': 8,'23': 7,'24': 6,'25': 6,'26': 6,'27': 6,'28': 5,
	'29': 6,'30': 5,'31': 4,'32': 3,'33': 4,'34': 4,'35': 2,
	'36': 4,'37': 4,'38': 4,'39': 5,'40': 2,'41': 1,'42': 1,
	'43': 2,'44': 2,'45': 2,'46': 2,'47':15,
};

// Per-sysNum M0/lam0 cache.
const _gkConst = new Map();
function getGKConst(sysNum) {
	if (_gkConst.has(sysNum)) return _gkConst.get(sysNum);
	const [lat0d, lon0d] = CS_ORIGINS[sysNum] || CS_ORIGINS[9];
	const phi0 = lat0d * DEG, lam0 = lon0d * DEG;
	const M0 = arcConst * phi0
	- a * ((3 / 8) * (e2 + e4 / 4 + 15 * e6 / 128) * Math.sin(2 * phi0)
	- (15 / 256) * (e4 + 3 * e6 / 4) * Math.sin(4 * phi0)
	+ (35 * e6 / 3072) * Math.sin(6 * phi0));
	const c = { lam0, M0 };
	_gkConst.set(sysNum, c);
	return c;
}

function planeToLatLon(x, y, sysNum) {
	const { lam0, M0 } = getGKConst(sysNum);
	const mu = (M0 + x / m0) / arcConst;
	const phi1 = mu
	+ A1 * Math.sin(2 * mu) + A2 * Math.sin(4 * mu)
	+ A3 * Math.sin(6 * mu) + A4 * Math.sin(8 * mu);
	const sinP = Math.sin(phi1), cosP = Math.cos(phi1), tanP = Math.tan(phi1);
	const ep2 = e2 / (1 - e2), C1 = ep2 * cosP * cosP, T1 = tanP * tanP;
	const N1 = a / Math.sqrt(1 - e2 * sinP * sinP);
	const R1 = a * (1 - e2) / Math.pow(1 - e2 * sinP * sinP, 1.5);
	const D = y / (N1 * m0), D2 = D * D, D3 = D * D2, D4 = D2 * D2, D5 = D * D4, D6 = D4 * D2;
	const phi = phi1 - (N1 * tanP / R1) * (D2 / 2
	- (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D4 / 24
	+ (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D6 / 720);
	const lam = lam0 + (D - (1 + 2 * T1 + C1) * D3 / 6
	+ (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D5 / 120) / cosP;
	return [Math.round(lam / DEG * 1e8) / 1e8, Math.round(phi / DEG * 1e8) / 1e8];
}

// ---- Manual tokenizer helpers (no regex) ----

const _td = new TextDecoder();

// Return the text between open and close in str, searching from position from.
function strBetween(str, open, close, from = 0) {
	const s = str.indexOf(open, from);
	if (s === -1) return '';
	const e = str.indexOf(close, s + open.length);
	return e === -1 ? '' : str.substring(s + open.length, e);
}

// Return the value of attr="..." within seg, searching from position from.
function attrVal(seg, attr, from = 0) {
	const needle = attr + '="';
	const s = seg.indexOf(needle, from);
	if (s === -1) return null;
	const vs = s + needle.length;
	const ve = seg.indexOf('"', vs);
	return ve === -1 ? null : seg.substring(vs, ve);
}

// Read a number from seg[pos]; return [value, endPos].
function readNum(seg, pos) {
	let neg = seg.charCodeAt(pos) === 45; // '-'
	if (neg) pos++;
	let val = 0, dec = 0;
	for (; pos < seg.length; pos++) {
	const c = seg.charCodeAt(pos);
	if (c >= 48 && c <= 57) {
	  if (dec === 0) val = val * 10 + (c - 48);
	  else { val += (c - 48) / dec; dec *= 10; }
	} else if (c === 46 && dec === 0) { dec = 10; }
	else break;
	}
	return [neg ? -val : val, pos];
}

// Collect all idref="C..." values in seg[from, end).
function getCIds(seg, from, end) {
	const ids = [], needle = 'idref="C';
	let p = from;
	while (p < end) {
	const i = seg.indexOf(needle, p);
	if (i === -1 || i >= end) break;
	const vs = i + needle.length;
	const ve = seg.indexOf('"', vs);
	if (ve === -1 || ve > end) break;
	ids.push('C' + seg.substring(vs, ve));
	p = ve + 1;
	}
	return ids;
}

// Extract the coordinate system number N from a "N系" tag value.
function parseSysNum(txt) {
	if (!txt) return 0;
	const si = txt.indexOf('系');
	if (si === -1) return 0;
	let n = 0, mul = 1;
	for (let i = si - 1; i >= 0; i--) {
	const c = txt.charCodeAt(i);
	if (c < 48 || c > 57) break;
	n += (c - 48) * mul; mul *= 10;
	}
	return n;
}

// ---- Synchronous ZIP parser ----

// Read the central directory from a Uint8Array and return the entry list.
function zipCD(bytes) {
	const dv  = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const len = bytes.byteLength;

	// Locate EOCD signature from the end.
	let eocd = -1;
	for (let i = len - 22; i >= Math.max(0, len - 65558); i--) {
	if (bytes[i] === 0x50 && bytes[i+1] === 0x4b && bytes[i+2] === 0x05 && bytes[i+3] === 0x06) {
	  eocd = i; break;
	}
	}
	if (eocd < 0) return null;

	const cdOff  = dv.getUint32(eocd + 16, true);
	const cdSize = dv.getUint32(eocd + 12, true);
	const cd     = bytes.subarray(cdOff, cdOff + cdSize);
	const cdDV   = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);

	const entries = [];
	let pos = 0;
	while (pos + 46 <= cd.length) {
	if (cdDV.getUint32(pos, true) !== 0x02014b50) break;
	const method = cdDV.getUint16(pos + 10, true);
	const cSiz   = cdDV.getUint32(pos + 20, true);
	const fnLen  = cdDV.getUint16(pos + 28, true);
	const exLen  = cdDV.getUint16(pos + 30, true);
	const cmLen  = cdDV.getUint16(pos + 32, true);
	const lhOff  = cdDV.getUint32(pos + 42, true);
	const name   = _td.decode(cd.subarray(pos + 46, pos + 46 + fnLen));
	entries.push({ name, method, cSiz, lhOff });
	pos += 46 + fnLen + exLen + cmLen;
	}
	return entries;
}

// Read the local header and return the compressed data subarray (zero-copy).
function zipData(bytes, { lhOff, cSiz }) {
	const dv     = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const dataOff = lhOff + 30 + dv.getUint16(lhOff + 26, true) + dv.getUint16(lhOff + 28, true);
	return bytes.subarray(dataOff, dataOff + cSiz);
}

// method=0: stored (no decompression); method=8: deflate (pako sync).
function unzip(bytes, method) {
	return method === 0 ? bytes : inflateRaw(bytes);
}

// ---- Manual GML parser (no regex; converts coordinates to [lon,lat] in-place) ----

function* parseXml(text, defaultSysNum) {
	const len = text.length;

	const sysTag  = strBetween(text, '<座標系>', '</座標系>');
	const sysNum  = sysTag.includes('任意') ? defaultSysNum : (parseSysNum(sysTag) || defaultSysNum);
	const cityCode = strBetween(text, '<市区町村コード>', '</市区町村コード>');
	const cityName = strBetween(text, '<市区町村名>', '</市区町村名>');

	const pointMap   = new Map();
	const curveMap   = new Map();
	const surfaceMap = new Map();
	let seenSurface  = false, seenFeature = false;

	// Curve points are already converted to [lon,lat]; buildRing uses them directly.
	const buildRing = (cids) => {
	const pts = [];
	for (const cid of cids) {
	  const c = curveMap.get(cid);
	  if (!c || !c.pts.length) continue;
	  const cp = c.ori === '-' ? c.pts.slice().reverse() : c.pts;
	  pts.push(...(pts.length ? cp.slice(1) : cp));
	}
	if (pts.length > 1) {
	  const f = pts[0], l = pts[pts.length - 1];
	  if (f[0] !== l[0] || f[1] !== l[1]) pts.push(f);
	}
	return pts;
	};

	const T_PT = '<zmn:GM_Point ';   const C_PT = '</zmn:GM_Point>';
	const T_CV = '<zmn:GM_Curve ';   const C_CV = '</zmn:GM_Curve>';
	const T_SF = '<zmn:GM_Surface '; const C_SF = '</zmn:GM_Surface>';
	const T_FT = '<筆 ';             const C_FT = '</筆>';
	const XOP  = '<zmn:X>', YOP = '<zmn:Y>';
	const XOL  = XOP.length, YOL = YOP.length;

	let cursor = 0;

	while (cursor < len) {
	// Pick the earliest-occurring tag among the four types.
	let pos = len, tag = null, close = null, p;

	p = text.indexOf(T_PT, cursor);
	if (p !== -1 && p < pos) { pos = p; tag = T_PT; close = C_PT; }
	p = text.indexOf(T_CV, cursor);
	if (p !== -1 && p < pos) { pos = p; tag = T_CV; close = C_CV; }
	p = text.indexOf(T_SF, cursor);
	if (p !== -1 && p < pos) { pos = p; tag = T_SF; close = C_SF; }
	p = text.indexOf(T_FT, cursor);
	if (p !== -1 && p < pos) { pos = p; tag = T_FT; close = C_FT; }

	if (!tag) break;

	const closePos = text.indexOf(close, pos);
	if (closePos === -1) break;
	const end = closePos + close.length;
	const seg = text.substring(pos, end);
	cursor = end;

	if (tag === T_PT) {
	  // <zmn:GM_Point id="Pxxx">: convert X/Y immediately to [lon,lat].
	  const id = attrVal(seg, 'id');
	  if (!id) continue;
	  const xp = seg.indexOf(XOP);
	  if (xp === -1) continue;
	  const [x] = readNum(seg, xp + XOL);
	  const yp  = seg.indexOf(YOP, xp + XOL);
	  if (yp === -1) continue;
	  const [y] = readNum(seg, yp + YOL);
	  pointMap.set(id, planeToLatLon(x, y, sysNum));

	} else if (tag === T_CV) {
	  // <zmn:GM_Curve id="Cxxx">: inline XY pairs or point references.
	  const id = attrVal(seg, 'id');
	  if (!id) continue;
	  const ori = seg.includes('>-<') ? '-' : '+';
	  const pts = [];

	  // Scan inline XY pairs.
	  let sp = 0;
	  while (true) {
		const xp = seg.indexOf(XOP, sp);
		if (xp === -1) break;
		const [x, xEnd] = readNum(seg, xp + XOL);
		const yp = seg.indexOf(YOP, xEnd);
		if (yp === -1) break;
		const [y, yEnd] = readNum(seg, yp + YOL);
		pts.push(planeToLatLon(x, y, sysNum));
		sp = yEnd;
	  }

	  // Fall back to point references (idref="Pxxx") if no inline XY.
	  if (!pts.length) {
		const pneedle = 'idref="P';
		let pp2 = 0;
		while (true) {
		  const rp = seg.indexOf(pneedle, pp2);
		  if (rp === -1) break;
		  const vs = rp + pneedle.length;
		  const ve = seg.indexOf('"', vs);
		  if (ve === -1) break;
		  const pt = pointMap.get('P' + seg.substring(vs, ve));
		  if (pt) pts.push(pt);
		  pp2 = ve + 1;
		}
	  }

	  curveMap.set(id, { pts, ori });

	} else if (tag === T_SF) {
	  // <zmn:GM_Surface id="Fxxx">: exterior and interior curve ID lists.
	  if (!seenSurface) { seenSurface = true; pointMap.clear(); }
	  const id = attrVal(seg, 'id');
	  if (!id) continue;

	  const extOpen = '<zmn:GM_SurfaceBoundary.exterior>';
	  const extClose = '</zmn:GM_SurfaceBoundary.exterior>';
	  const extS = seg.indexOf(extOpen);
	  const extE = extS !== -1 ? seg.indexOf(extClose, extS + extOpen.length) : -1;
	  const ext  = (extS !== -1 && extE !== -1) ? getCIds(seg, extS + extOpen.length, extE) : [];

	  const intOpen = '<zmn:GM_SurfaceBoundary.interior>';
	  const intClose = '</zmn:GM_SurfaceBoundary.interior>';
	  const ints = [];
	  let ip = 0;
	  while (true) {
		const is = seg.indexOf(intOpen, ip);
		if (is === -1) break;
		const ie = seg.indexOf(intClose, is + intOpen.length);
		if (ie === -1) break;
		ints.push(getCIds(seg, is + intOpen.length, ie));
		ip = ie + intClose.length;
	  }

	  surfaceMap.set(id, { ext, ints });

	} else {
	  // <筆 ...> feature element.
	  if (!seenFeature) { seenFeature = true; curveMap.clear(); }
	  const fid = attrVal(seg, 'idref');
	  if (!fid) continue;
	  const s = surfaceMap.get(fid);
	  if (!s) continue;

	  const ext = buildRing(s.ext);
	  if (ext.length < 4) { surfaceMap.delete(fid); continue; }
	  surfaceMap.delete(fid);

	  yield {
		type: 'Feature',
		geometry: { type: 'Polygon', coordinates: [ext, ...s.ints.map(buildRing)] },
		properties: {
		  市区町村コード: cityCode,
		  市区町村名:     cityName,
		  大字コード:     strBetween(seg, '<大字コード>', '</大字コード>'),
		  大字名:         strBetween(seg, '<大字名>', '</大字名>'),
		  丁目コード:     strBetween(seg, '<丁目コード>', '</丁目コード>'),
		  小字コード:     strBetween(seg, '<小字コード>', '</小字コード>'),
		  地番:           strBetween(seg, '<地番>', '</地番>'),
		  精度区分:       strBetween(seg, '<精度区分>', '</精度区分>'),
		  座標値種別:     strBetween(seg, '<座標値種別>', '</座標値種別>'),
		},
	  };
	}
	}
}

const KEYS = ['市区町村コード','市区町村名','大字コード','大字名','丁目コード','小字コード','地番','精度区分','座標値種別'];

onmessage = async (e) => {
	try {
	const { file, name, precision, description, license, attribution } = e.data;

	// Read the outer ZIP into ArrayBuffer once; everything from here is synchronous and zero-copy.
	const fileBytes = new Uint8Array(await file.arrayBuffer());

	const outerEntries = zipCD(fileBytes);
	if (!outerEntries?.length) { postMessage(null); return; }

	const innerZipEntries = outerEntries.filter(e => e.name.toLowerCase().endsWith('.zip'));
	const total = innerZipEntries.length;
	if (!total) { postMessage(null); return; }

	const prefCode  = (name && name.length >= 2) ? name.substring(0, 2) : '13';
	const defaultSys = PREF_SYS[prefCode] || 9;

	const pbf = new GeoPBF({ name, precision, description, license, attribution });
	pbf.setHead(KEYS);

	// setBody callback executes synchronously inside writeMessage.
	// The Worker runs in a separate OS thread, so postMessage delivers progress to the main thread in real time.
	// This means no features[] array is needed, and pako's sync inflate avoids context switches.
	let hasFeature = false;
	pbf.setBody(() => {
	  for (let i = 0; i < total; i++) {
		const entry = innerZipEntries[i];
		try {
		  const izBytes   = unzip(zipData(fileBytes, entry), entry.method);
		  const izEntries = zipCD(izBytes);
		  if (!izEntries) { postMessage({ type: 'progress', loaded: i + 1, total, name }); continue; }

		  const xmlEntry = izEntries.find(e => {
			const n = e.name.toLowerCase();
			return n.endsWith('.xml') || n.endsWith('.gml');
		  });
		  if (!xmlEntry) { postMessage({ type: 'progress', loaded: i + 1, total, name }); continue; }

		  const xmlBytes = unzip(zipData(izBytes, xmlEntry), xmlEntry.method);
		  const xmlText  = _td.decode(xmlBytes);

		  for (const feat of parseXml(xmlText, defaultSys)) {
			pbf.setFeature(feat);
			hasFeature = true;
		  }
		} catch (err) {
		  console.warn('[moj] skip:', entry.name, err?.message);
		}
		postMessage({ type: 'progress', loaded: i + 1, total, name });
	  }
	});

	pbf.close();
	await pbf.getPosition();

	if (!hasFeature) { postMessage(null); return; }

	const res = pbf.arrayBuffer;
	postMessage({ type: 'mojdec', data: res }, [res]);
	} catch (err) {
	console.error('[moj decoder]', err);
	postMessage(null);
	}
};
