/**
 * encodeXLSX — 依存ゼロの最小 OOXML (SpreadsheetML) 書き出し。
 * xlsx の実体は ZIP + XML 数枚。読み込み一式（225KB gz・npm 版 0.18.5 は CVE 固定）は
 * 出荷物には要らないので、書き出しだけを encodeZIP と同じ流儀（CompressionStream）で持つ。
 *
 *   encodeXLSX(csvString | rows[][], "name.xlsx") -> File
 *
 * セル型: JS の number/boolean はそのまま数値・論理値セル、他は inlineStr（sharedStrings 不要）。
 * CSV 入力では「引用符付き＝文字列」を尊重＝getCSV が ^0\d を括る意図（自治体コード等の
 * 先頭ゼロ）がそのまま Excel まで届く。
 */

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_ROWS = 1048576, MAX_COLS = 16384;   // Excel の実装上限

/* ---------- CSV (RFC4180) → 2次元配列 ---------- */
// 引用されていない数値だけを number 化する。整数は往復一致を要求＝長い ID コードや
// 先頭ゼロを数値に潰さない。小数はそのまま数値（合計が効くように）。
const NUM = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;
const cast = s => {
	if (!NUM.test(s)) return s;
	const n = Number(s);
	if (!Number.isFinite(n)) return s;
	if (/[.eE]/.test(s)) return n;
	return String(n) === s ? n : s;
};
export function csvToRows(csv) {
	const rows = []; let row = [], f = '', q = false, quoted = false;
	const endF = () => { row.push(quoted ? f : cast(f)); f = ''; quoted = false; };
	const endR = () => { endF(); rows.push(row); row = []; };
	for (let i = 0; i < csv.length; i++) {
		const c = csv[i];
		if (q) {
			if (c !== '"') { f += c; continue; }
			if (csv[i + 1] === '"') { f += '"'; i++; continue; }
			q = false; continue;
		}
		if (c === '"' && f === '') { q = true; quoted = true; continue; }
		if (c === ',') { endF(); continue; }
		if (c === '\r') { if (csv[i + 1] === '\n') i++; endR(); continue; }
		if (c === '\n') { endR(); continue; }
		f += c;
	}
	if (f !== '' || quoted || row.length) endR();
	while (rows.length && rows[rows.length - 1].every(v => v === '')) rows.pop();
	return rows;
}

/* ---------- XML ---------- */
// XML 1.0 が受け付けない制御文字は落とす（getCSV は任意文字列を吐きうる）
const esc = s => String(s)
	.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const colName = n => { let s = ''; for (n++; n > 0;) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; } return s; };
const XD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_OD  = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function sheetXML(rows, nCols) {
	const out = [XD,
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
		`<dimension ref="A1:${colName(Math.max(0, nCols - 1))}${Math.max(1, rows.length)}"/>`,
		'<sheetData>'];
	for (let r = 0; r < rows.length; r++) {
		const row = rows[r]; out.push(`<row r="${r + 1}">`);
		for (let c = 0; c < row.length; c++) {
			const v = row[c], ref = `${colName(c)}${r + 1}`;
			if (v === null || v === undefined || v === '') continue;
			if (typeof v === 'number' && Number.isFinite(v)) out.push(`<c r="${ref}"><v>${v}</v></c>`);
			else if (typeof v === 'boolean') out.push(`<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`);
			else out.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`);
		}
		out.push('</row>');
	}
	out.push('</sheetData></worksheet>');
	return out.join('');
}

/* ---------- ZIP（サイズをローカルヘッダに直書き＝データ記述子なし＝最も素直な形） ---------- */
const CRC_TBL = new Uint32Array(256).map((_, i) => {
	let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c;
});
const crc32 = bin => { let c = -1; for (const b of bin) c = (c >>> 8) ^ CRC_TBL[(c ^ b) & 255]; return (c ^ -1) >>> 0; };

async function deflateRaw(bytes) {
	if (typeof CompressionStream === 'undefined') return null;   // 無ければ無圧縮で格納
	try {
		const cs = new CompressionStream('deflate-raw');
		const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
		return new Uint8Array(buf);
	} catch { return null; }
}

async function zip(entries, name) {
	const enc = new TextEncoder(), parts = [], cd = [];
	const d = new Date();
	const ts = (d.getHours() << 11 | d.getMinutes() << 5 | d.getSeconds() >> 1);
	const ds = (Math.max(0, d.getFullYear() - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate());
	let off = 0;
	for (const [path, text] of entries) {
		const raw = enc.encode(text), fn = enc.encode(path), crc = crc32(raw);
		const def = await deflateRaw(raw);
		const body = def && def.length < raw.length ? def : raw;
		const method = body === def ? 8 : 0;
		const lfh = new Uint8Array(30 + fn.length), v = new DataView(lfh.buffer);
		v.setUint32(0, 0x04034B50, true);
		v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, method, true);
		v.setUint16(10, ts, true); v.setUint16(12, ds, true);
		v.setUint32(14, crc, true); v.setUint32(18, body.length, true); v.setUint32(22, raw.length, true);
		v.setUint16(26, fn.length, true);
		lfh.set(fn, 30);
		parts.push(lfh, body);
		cd.push({ fn, crc, cSiz: body.length, uSiz: raw.length, off, method });
		off += lfh.length + body.length;
	}
	const cdStart = off;
	for (const f of cd) {
		const h = new Uint8Array(46 + f.fn.length), v = new DataView(h.buffer);
		v.setUint32(0, 0x02014B50, true);
		v.setUint16(4, 20, true); v.setUint16(6, 20, true);
		v.setUint16(8, 0x0800, true); v.setUint16(10, f.method, true);
		v.setUint16(12, ts, true); v.setUint16(14, ds, true);
		v.setUint32(16, f.crc, true); v.setUint32(20, f.cSiz, true); v.setUint32(24, f.uSiz, true);
		v.setUint16(28, f.fn.length, true);
		v.setUint32(42, f.off, true); h.set(f.fn, 46);
		parts.push(h); off += h.length;
	}
	const eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
	ev.setUint32(0, 0x06054B50, true);
	ev.setUint16(8, cd.length, true); ev.setUint16(10, cd.length, true);
	ev.setUint32(12, off - cdStart, true); ev.setUint32(16, cdStart, true);
	parts.push(eocd);
	return name ? new File(parts, name, { type: XLSX_MIME }) : new Blob(parts, { type: XLSX_MIME });
}

/* ---------- 本体 ---------- */
export async function encodeXLSX(src, name = null, { sheetName = 'Sheet1' } = {}) {
	let rows = typeof src === 'string' ? csvToRows(src) : (src || []);
	if (rows.length > MAX_ROWS) { console.warn(`[encodeXLSX] ${rows.length} 行 → Excel 上限 ${MAX_ROWS} 行で打ち切り`); rows = rows.slice(0, MAX_ROWS); }
	let nCols = rows.reduce((m, r) => Math.max(m, r.length), 0);
	if (nCols > MAX_COLS) { console.warn(`[encodeXLSX] ${nCols} 列 → Excel 上限 ${MAX_COLS} 列で打ち切り`); rows = rows.map(r => r.slice(0, MAX_COLS)); nCols = MAX_COLS; }
	// シート名の禁則: : \ / ? * [ ] と 31 文字上限
	const sn = esc((String(sheetName).replace(/[:\\\/?*\[\]]/g, '_') || 'Sheet1').slice(0, 31));
	return zip([
		['[Content_Types].xml', XD +
			'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
			'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
			'<Default Extension="xml" ContentType="application/xml"/>' +
			`<Override PartName="/xl/workbook.xml" ContentType="${XLSX_MIME}.main+xml"/>` +
			'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
			'</Types>'],
		['_rels/.rels', XD +
			`<Relationships xmlns="${NS_PKG}">` +
			`<Relationship Id="rId1" Type="${NS_OD}/officeDocument" Target="xl/workbook.xml"/>` +
			'</Relationships>'],
		['xl/workbook.xml', XD +
			'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
			`xmlns:r="${NS_OD}">` +
			`<sheets><sheet name="${sn}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
		['xl/_rels/workbook.xml.rels', XD +
			`<Relationships xmlns="${NS_PKG}">` +
			`<Relationship Id="rId1" Type="${NS_OD}/worksheet" Target="worksheets/sheet1.xml"/>` +
			'</Relationships>'],
		['xl/worksheets/sheet1.xml', sheetXML(rows, nCols)],
	], name);
}
export default encodeXLSX;
