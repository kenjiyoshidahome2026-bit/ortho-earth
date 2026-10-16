import { GeoPBF } from "../pbf.js";   // pbf-base ではなく pbf.js＝bbox / getBbox の prototype が要る（pbf-base 直 import だと shapeFile() が永久 hang・2026-09-14 根治）
import { encodeZIP } from "../modules/encodeZIP.ts";
import { encodeSJIS } from "../modules/sjis.ts";
import { isImageData } from "../modules/utility.ts";
import type { Geometry } from "../../types/geopbf.js";
import type { EncodeRequest } from "../worker-msg.ts";

type Encoder = (str: string) => Uint8Array;
/** 地物の指名＝添字か、GeometryCollection の [添字, 部品番号] */
type FeatureRef = number | [number, number];

const getEncoder = async (encoding: string): Promise<Encoder> => {
	if (encoding === "sjis") return encodeSJIS;   // 依存ゼロの自前表（旧＝実行時に esm.sh から encoding-japanese・B8）
	const utf8Encoder = new TextEncoder();
	return str => utf8Encoder.encode(str);
};
const sum = (a: number[]): number => { let s = 0; a.forEach(t=>s+=t); return s; };
class WBUF {
	buff: ArrayBuffer;
	pos: number;
	growable: boolean;
	bytes: Uint8Array<ArrayBuffer>;
	view: DataView;
	constructor(len: number, growable = false) {
		this.buff = new ArrayBuffer(len); this.pos = 0; this.growable = growable;
		this.bytes = new Uint8Array(this.buff);
		this.view = new DataView(this.buff);
	}
	buffer(): ArrayBuffer | Uint8Array<ArrayBuffer> { return this.growable ? this.bytes.subarray(0, this.pos) : this.buff; }   // growable は書いた分だけのビュー（File/Blob がコピーするので slice 不要）
	ensure(n: number): void {   // growable のみ：足りなければ倍々で伸ばす
		if (this.pos + n <= this.bytes.byteLength) return;
		const nb = new ArrayBuffer(Math.max(this.pos + n, this.bytes.byteLength * 2));
		new Uint8Array(nb).set(this.bytes.subarray(0, this.pos));
		this.buff = nb; this.bytes = new Uint8Array(nb); this.view = new DataView(nb);
	}
	position(): number;
	position(i: number): this;
	position(i?: number): this | number { if (i != null) { this.pos = i; return this; } return this.pos; }
	skip(bytes: number): this { this.pos += (bytes + 0); return this; }
	writeUint8(val: number): this { if (this.growable) this.ensure(1); this.bytes[this.pos++] = val; return this; }
	writeInt8(val: number): this { if (this.growable) this.ensure(1); this.view.setInt8(this.pos++, val); return this; }
	writeUint16(val: number, le?: boolean): this { if (this.growable) this.ensure(2); this.view.setUint16(this.pos, val, le); this.pos += 2; return this; }
	writeInt16(val: number, le?: boolean): this { if (this.growable) this.ensure(2); this.view.setInt16(this.pos, val, le); this.pos += 2; return this; }
	writeUint32(val: number, le?: boolean): this { if (this.growable) this.ensure(4); this.view.setUint32(this.pos, val, le); this.pos += 4; return this; }
	writeInt32(val: number, le?: boolean): this { if (this.growable) this.ensure(4); this.view.setInt32(this.pos, val, le); this.pos += 4; return this; }
	writeFloat64(val: number, le?: boolean): this { if (this.growable) this.ensure(8); this.view.setFloat64(this.pos, val, le); this.pos += 8; return this; }
	writeBuffer(buf: ArrayBuffer | Uint8Array, bytes?: number, spos = 0): this {
		const src = buf instanceof Uint8Array ? buf : new Uint8Array(buf);   // Uint8Array はコピーせずそのまま
		if (this.growable) this.ensure(bytes || src.byteLength - spos);
		const len = Math.min(bytes || src.byteLength - spos, this.bytes.byteLength - this.pos);
		this.bytes.set(src.subarray(spos, spos + len), this.pos);
		this.pos += len;
		return this;
	}
}
type XY = number[];
type RecordWriter = (bin: WBUF, g: Geometry, bbox: number[]) => void;
function writeShp(pbf: GeoPBF, name: string, farray: FeatureRef[], type: number): File[] {
	const bbox = pbf.bbox;
	const shxBytes = 100 + farray.length * 8;
	const SHX = new WBUF(shxBytes).position(100); // jump to record section
	let id = 1;
	const func: RecordWriter = type == 1? point: type == 8? multipoint :poly;
	// レコードは伸長バッファへ直書き（旧＝レコードごとに WBUF を作って後で SHP へ複写＝2 倍ピーク＋地物数だけの小バッファ）
	const SHP = new WBUF(100 + farray.length * (type == 1 ? 28 : 256), true)
	.writeInt32(9994).skip(5 * 4).writeInt32(0)   // file length は最後に埋める
	.writeInt32(1000, true).writeInt32(type, true);
	bbox? bbox.forEach(t=>SHP.writeFloat64(t, true)):SHP.skip(4 * 8);
	SHP.skip(4 * 8); // skip Z & M type bbox;
	farray.forEach(n=> {
		const geom = Array.isArray(n)? pbf.getGeometry(n[0], n[1]): pbf.getGeometry(n);
		const bb = pbf.getBbox(Array.isArray(n)? n[0]: n);
		const start = SHP.position();
		func(SHP, geom!, bb);   // 幾何なし（null）は旧来どおり g.coordinates で TypeError＝呼び手の catch が null を返す
		SHX.writeInt32(start / 2).writeInt32((SHP.position() - start) / 2 - 4);
	});
	const fileBytes = SHP.position();
	SHP.position(24).writeInt32(fileBytes / 2).position(fileBytes);
	SHX.position(0).writeBuffer(SHP.buffer(), 100).position(24).writeInt32(shxBytes/2);
	return [new File([SHP.buffer()], name + '.shp', {type:"application/octet-stream"}),
			new File([SHX.buffer()], name + '.shx', {type:"application/octet-stream"})];
	function point(bin: WBUF, g: Geometry): void { const c = (g as { coordinates: XY }).coordinates;
		bin.writeInt32(id++).writeInt32(10)
		.writeInt32(type,true)
		.writeFloat64(c[0],true).writeFloat64(c[1],true);
	}
	function multipoint(bin: WBUF, g: Geometry, bbox: number[]): void { const c = (g as { coordinates: XY[] }).coordinates;
		bin.writeInt32(id++).writeInt32(20 + c.length*8)
		.writeInt32(type, true)
		.writeFloat64(bbox[0],true).writeFloat64(bbox[1],true).writeFloat64(bbox[2],true).writeFloat64(bbox[3],true)
		.writeInt32(c.length, true);
		c.forEach(t=>bin.writeFloat64(t[0],true).writeFloat64(t[1],true));
	}
	function poly(bin: WBUF, g: Geometry, bbox: number[]): void {
		const p0 = (c: unknown): unknown[] => [c], p1 = (c: unknown): unknown[] => c as unknown[], p2 = (c: unknown): unknown[] => (c as unknown[][]).flat();
		const coords = (g.type.match(/Polygon/)? g.type.match(/Multi/)? p2:p1:g.type.match(/Multi/)? p1:p0)((g as { coordinates: unknown }).coordinates) as XY[][];
		const lengths = coords.map(t=>t.length);
		const coordsCount = sum(lengths);
		const pathCount = lengths.length;
		const pos: number[] = []; let i = 0; lengths.forEach(t=>{pos.push(i); i += t});
		bin.ensure(52 + 4 * pathCount + 16 * coordsCount);   // 1 レコード分をまとめて確保（以降の書き込みは伸長判定だけ）
		bin.writeInt32(id++).writeInt32(22 + 2 * pathCount + 8 * coordsCount)
		.writeInt32(type, true)
		.writeFloat64(bbox[0], true).writeFloat64(bbox[1], true).writeFloat64(bbox[2], true).writeFloat64(bbox[3], true)
		.writeInt32(pathCount, true).writeInt32(coordsCount, true);
			pos.forEach(t=>bin.writeInt32(t, true));
			coords.forEach(t=>t.forEach(u=>u&&bin.writeFloat64(u[0], true).writeFloat64(u[1], true)));
	}
}
/** DBF の列（型は C／N／L／D・precision は N の小数桁） */
interface DbfField { name: string; type: string; length: number; precision?: number }
function writeDbf(pbf: GeoPBF, name: string, farray: FeatureRef[], encoding: string, encoder: Encoder): File {
	const parray = farray.map(t=>Array.isArray(t)?t[0]:t), recordSize = farray.length;
	const props = parray.map(i=>pbf.getProperties(i) as Record<string, unknown>);   // 属性なし（null）は旧来どおり rec[name] で TypeError
	 const stringify = (q: Record<string, unknown>): string => {
		return "{"+Object.entries(q).map(([k,v])=>`"${k}":${JSON.stringify(isImageData(v)?{}:v)}`).join(",")+"}";
	}
	const strlen = (s: unknown): number => encoder(typeof s == "object"?stringify(s as Record<string, unknown>):String(s)).length;
	const schema: Record<string, DbfField> = {};
	props.forEach(q=>{
		const update = (q: DbfField, v: unknown): void => { const p = schema[q.name];
			if (!p) { schema[q.name] = q; return; }
			if (p.type == q.type) {
				if (p.type == "C"||p.type == "N") p.length = Math.max(p.length, q.length);
				if (p.type == "N") p.precision = Math.max(p.precision!, q.precision!);
			} else {
				p.type = "C"; p.length = Math.max(p.length, strlen(v));
			}
		};
		const numberProp = (n: number): [number, number] => {
			let num = n.toString(); if (num.match(/e/)) num = "0";
			const parts = num.split('.');
			return [parts[0].length, (parts[1] || '').length];
		};
		for (const name in q) {  const value = q[name];
			if (isImageData(value)||value instanceof Blob) {
				update({name, type: 'C', length:2}, "{}");
			} else if (value instanceof Date) {
				update({name, type: 'D', length:8}, value);
			} else if (typeof value === 'number') {
				const [length, precision] = numberProp(value)
				update({name, type: 'N', length, precision}, value);
			} else if (typeof value === 'boolean') {
				update({name, type: 'L', length:1}, value);
			} else {
				update({name, type: 'C', length:strlen(value)}, value);
			}
		}
	});
	const fields = Object.values(schema).sort((p,q)=>p.name>q.name?1:-1);
	const fieldCount = fields.length;
	fields.forEach(field=>{ field.precision = field.precision || 0;
		if (field.type == "N" && field.precision) field.length += (field.precision + 1);
		if (strlen(field.name) > 11) { console.warn("too long field name:", field.name); field.name = field.name.slice(0, 11); }
		if (field.length > 254) { console.warn("too long data in:", field.name); field.length = 254; }
	});
	const [Y,M,D] = (() => { const t = new Date(); return [t.getFullYear(), t.getMonth() + 1, t.getDate()]; })();
	const headerBytes = 32 + fields.length * 32 +1;
	const recordBytes = sum(fields.map(t=>t.length))+1;
	const fileBytes = headerBytes + recordSize * recordBytes + 1;
 //   const LDID = encoding == "sjis"? 0x13:0;
	const LDID = encoding == "sjis" ? 0x13 : 0x4B; // 0x4B is the conventional code for UTF-8
	const yyyymmdd = (d: Date): string => { const L2 = (d: number): string =>(d > 9? "":"0")+d;
		return d.getFullYear() + L2(d.getMonth() + 1) + L2(d.getDate());   // getMonth は 0 始まり（旧＝+1 が無く 1 か月ずれ・1 月は "00" で読めなかった・B8）
	};
	const sizes = Object.entries({fieldCount, recordSize, fileBytes, headerBytes, recordBytes}).map(t=>t.join(":")).join(", ");
	console.log(`DBF (${name + '.dbf'}) : ${sizes}\n => Fields : ${fields.map(t=>t.name).join(", ")}`);

	const DBF = new WBUF(fileBytes).writeUint8(3).writeUint8(Y - 1900).writeUint8(M).writeUint8(D)
		.writeUint32(recordSize, true).writeUint16(headerBytes, true).writeUint16(recordBytes, true).skip(17)
		.writeUint8(LDID).skip(2)
	fields.reduce((dataOffset, { name, type, length, precision }) => {
		DBF.writeBuffer(encoder(name), 11).writeUint8(type.charCodeAt(0)).writeUint32(dataOffset, true)
		   .writeUint8(length).writeUint8(precision!).skip(14);   // precision は上で 0 を埋めた
		return dataOffset + length;
	}, 1); // offset starts at 1 to account for the deletion-flag byte
	DBF.writeUint8(0x0d);
	const badname: Record<string, boolean> = {};
	props.forEach(rec => { DBF.writeUint8(0x20);
		fields.forEach(({name, type, length, precision}) =>{
			let value = rec[name];
			// 値なし（undefined/null・日付として無効）は空白で埋める＝DBF の空欄（旧＝undefined は 0x00 のまま、null は toFixed/getMonth で落ちた・B8）
			if (value == null || (type === 'D' && !(value instanceof Date && !isNaN(+value))) || (type === 'N' && !Number.isFinite(+(value as number)))) return DBF.writeBuffer(encoder(" ".repeat(length)), length);
			switch (type) {
			case 'L': DBF.writeUint8(!!value ? 84 : 70); break;
			case 'N': { const numStr = (+(value as number)).toFixed(precision).padStart(length, " ");
				DBF.writeBuffer(encoder(numStr)); break; }
			case 'D': DBF.writeBuffer(encoder(yyyymmdd(value as Date)), length); break;
			case 'C':
				if (isImageData(value)||value instanceof Blob) {
					badname[name] = true;
					value = {};
				}
				DBF.writeBuffer(encoder(value == null? "":
				typeof value == "object"?stringify(value as Record<string, unknown>):String(value)), length); break;
			}
		});
	});
	Object.keys(badname).length && console.warn("illegal binary data in ", Object.keys(badname).join(", "));
	DBF.writeUint8(0x1a);
	return new File([DBF.buffer()], name + '.dbf', {type:"application/octet-stream"});
}
onmessage = async (e: MessageEvent<EncodeRequest>) => {
	try {
	const {buf, name, opts} = e.data, encoding = opts && opts.encoding || "utf8";
	const encoder = await getEncoder(encoding);
	const prj  = `GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]`;
	console.log(`--------------------------\n    PBF => Shape File\n--------------------------`)
	const shpTypes: [string, number][] = [["point", 1],["multipoint", 8],["polyline", 3],["polygon", 5]];
	const types: FeatureRef[][] = [[],[],[],[],[]];
	const pbf = await new GeoPBF().name(name).set(buf); //console.log(pbf);
	pbf.fmap.forEach((t,i)=>{
		if (t[2] < 6) types[[0,1,2,2,3,3][t[2]]].push(i);
		else t[4]!.forEach((u,j)=>types[[0,1,2,2,3,3][u]].push([i,j]));   // GeometryCollection（type 6）は tarray を持つ
	});
	pbf.bufs.length && console.warn("Binary(file/images) data will be lost in shape.")
	const single = sum(types.map(t=>t.length? 1:0))==1;
	const zipFiles: File[] = [];
	shpTypes.forEach(([shpType, shpCode], i)=>{ if (!types[i].length) return;
		const fname = name + (single?"":"_"+shpType);
		zipFiles.push(...writeShp(pbf, fname, types[i], shpCode));
		zipFiles.push(writeDbf(pbf, fname, types[i], encoding, encoder));
		zipFiles.push(new File([prj], fname + '.prj', {type:"application/octet-stream"}));
		zipFiles.push(new File([encoding], fname + '.cpg', {type:"text/plain"}));
	});
	console.log(`preparing deflation...`);
	const file = await encodeZIP(zipFiles, name+".zip");
	console.log(" => Done : ", file.name, "size: " + file.size.toLocaleString("en-US") + " bytes");
	postMessage(file);
	} catch (err) {
		console.error("Shape encode Worker Error:", err);   // 失敗は必ず null で返す＝呼び手の Promise を hang させない
		postMessage(null);
	}
};
