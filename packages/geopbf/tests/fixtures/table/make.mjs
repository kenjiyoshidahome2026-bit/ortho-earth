#!/usr/bin/env node
// tests/fixtures/table/make.mjs ── t-table.mjs の固定資料（Node 標準のみ・2026-10-18 に make.py から移植）。再生成: node tests/fixtures/table/make.mjs
//   sjis.csv   Shift_JIS（cp932）・BOM 無し・経度/緯度列・CRLF
//   book.xlsx  手組みの Excel ブック: sharedStrings（重複文字列の共有・ふりがな rPh）・inlineStr・数値・論理値・数式（キャッシュ値）・空セル・2 シート
// Shift_JIS の符号化と ZIP の書き出しは、検定される側（src の encodeSJIS・encodeZIP）を使わずここで組む＝答えが独立。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));

// cp932 の符号化＝WHATWG の shift_jis 復号表（ICU）を逆引きする。1 バイト（ASCII・半角カナ）と 2 バイトの全域を引く
function cp932(str) {
	const dec = new TextDecoder("shift_jis", { fatal: true }), map = new Map();
	for (let b = 0; b < 0x100; b++) { try { const s = dec.decode(Uint8Array.of(b)); if (!map.has(s)) map.set(s, [b]); } catch {} }
	for (let a = 0x81; a < 0xfd; a++) for (let b = 0x40; b < 0xfd; b++) {
		try { const s = dec.decode(Uint8Array.of(a, b)); if (s.length === 1 && !map.has(s)) map.set(s, [a, b]); } catch {}
	}
	return Buffer.from([...str].flatMap(ch => { const v = map.get(ch); if (!v) throw new Error(`cp932 に無い字: ${ch}`); return v; }));
}
fs.writeFileSync(path.join(HERE, "sjis.csv"), cp932("名前,経度,緯度,備考\r\n東京駅,139.767125,35.681236,丸の内\r\n大阪駅,135.4959,34.7024,\"梅田,北区\"\r\n"));

// 最小の ZIP 書き出し（deflate・時刻は固定 2026-09-12 00:00:00＝python の zipfile.ZipInfo と同じ DOS 時刻）
function zip(entries) {
	const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (9 << 5) | 12;
	const locals = [], centrals = []; let off = 0;
	for (const [name, text] of entries) {
		const n = Buffer.from(name), raw = Buffer.from(text), data = zlib.deflateRawSync(raw), crc = zlib.crc32(raw);
		const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(8, 8);
		lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
		lh.writeUInt16LE(n.length, 26); lh.writeUInt16LE(0, 28);
		const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0, 8); ch.writeUInt16LE(8, 10);
		ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
		ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(0o600 << 16, 38); ch.writeUInt32LE(off, 42);
		locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length;
	}
	const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
	return Buffer.concat([...locals, cd, end]);
}

function xlsx() {
	const ss = ["名前", "lon", "lat", "flag", "memo", "東京", "大阪", "重複"];   // sharedStrings（index で参照）
	const sheet1 =
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
		'<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>' +
		'<row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2"><v>139.767125</v></c><c r="C2"><v>35.681236</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="inlineStr"><is><t xml:space="preserve">inline &amp; text</t></is></c></row>' +
		'<row r="3"><c r="A3" t="s"><v>6</v></c><c r="B3"><f>B2-4.27</f><v>135.497125</v></c><c r="C3"><v>34.7024</v></c><c r="D3" t="b"><v>0</v></c></row>' +
		'<row r="4"><c r="A4" t="s"><v>7</v></c><c r="B4"/><c r="C4"/><c r="E4" t="s"><v>7</v></c></row>' +
		'<row r="5"><c r="A5" t="str"><v>nolat</v></c><c r="B5"><v>1</v></c></row>' +
		'</sheetData></worksheet>';
	const sheet2 = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
		'<row r="1"><c r="A1" t="inlineStr"><is><t>wkt</t></is></c><c r="B1" t="inlineStr"><is><t>n</t></is></c></row>' +
		'<row r="2"><c r="A2" t="inlineStr"><is><t>LINESTRING(0 0, 1 1)</t></is></c><c r="B2"><v>7</v></c></row></sheetData></worksheet>';
	const sst = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="8" uniqueCount="8">' +
		ss.map(s => s === "東京" ? `<si><t>${s}</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh><phoneticPr fontId="1"/></si>` : `<si><t>${s}</t></si>`).join("") + "</sst>";   // 東京＝日本語版 Excel が付けるふりがな（rPh）入り
	const wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
		'<sheets><sheet name="地点" sheetId="1" r:id="rId1"/><sheet name="Lines" sheetId="2" r:id="rId2"/></sheets></workbook>';
	const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
		'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
		'<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>' +
		'<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>';
	const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
		'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
		'<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
		'<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
		'<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>';
	const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
		'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
	const p = path.join(HERE, "book.xlsx");
	fs.writeFileSync(p, zip([["[Content_Types].xml", ct], ["_rels/.rels", rootRels], ["xl/workbook.xml", wb], ["xl/_rels/workbook.xml.rels", rels], ["xl/sharedStrings.xml", sst], ["xl/worksheets/sheet1.xml", sheet1], ["xl/worksheets/sheet2.xml", sheet2]]));
	console.log(p, fs.statSync(p).size, "bytes");
}
xlsx();
