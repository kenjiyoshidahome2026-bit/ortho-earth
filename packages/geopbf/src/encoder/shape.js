import {GeoPBF} from "../pbf-base.js";
import {encodeZIP} from "native-bucket";
const getEncoder = async (encoding) => {
    if (encoding === "sjis") {
        const Encoding = (await import('https://esm.sh/encoding-japanese@2.1.0')).default;
        return str => new Uint8Array(Encoding.convert(str, {from: 'UNICODE', to: 'SJIS', type: 'array' }));
    }
    const utf8Encoder = new TextEncoder();
    return str => utf8Encoder.encode(str);
};
const sum = a => { let s = 0; a.forEach(t=>s+=t); return s; };
class WBUF {
    constructor(len) {
        this.buff = new ArrayBuffer(len); this.pos = 0;
        this.bytes = new Uint8Array(this.buff);
        this.view = new DataView(this.buff);
    }
    buffer() { return this.buff; }
    position(i) { if (i != null) { this.pos = i; return this; } return this.pos; }
    skip(bytes) { this.pos += (bytes + 0); return this; }
    writeUint8(val) { this.bytes[this.pos++] = val; return this; }
    writeInt8(val) { this.view.setInt8(this.pos++, val); return this; }
    writeUint16(val, le) { this.view.setUint16(this.pos, val, le); this.pos += 2; return this; }
    writeInt16(val, le) { this.view.setInt16(this.pos, val, le); this.pos += 2; return this; }
    writeUint32(val, le) { this.view.setUint32(this.pos, val, le); this.pos += 4; return this; }
    writeInt32(val, le) { this.view.setInt32(this.pos, val, le); this.pos += 4; return this; }
    writeFloat64(val, le) { this.view.setFloat64(this.pos, val, le); this.pos += 8; return this; }
    writeBuffer(buf, bytes, spos = 0) {
        const src = new Uint8Array(buf);
        const len = Math.min(bytes || src.byteLength - spos, this.bytes.byteLength - this.pos);
        this.bytes.set(src.subarray(spos, spos + len), this.pos);
        this.pos += len;
        return this;
    }
}
////=======================================================================================================================
function writeShp(pbf, name, farray, type) {
    var bbox = pbf.bbox;
    var shxBytes = 100 + farray.length * 8;
    var SHX = new WBUF(shxBytes).position(100); // jump to record section
    var fileBytes = 100;
    var id = 1;
    var func = type == 1? point: type == 8? multipoint :poly;
    var shapeBuffers = farray.map(n=> {
        const geom = Array.isArray(n)? pbf.getGeometry(...n): pbf.getGeometry(n);
        const bb = pbf.getBbox(Array.isArray(n)? n[0]: n);
        var rec = func(geom, bb).buffer();
        var recBytes = rec.byteLength;
        SHX.writeInt32(fileBytes / 2).writeInt32(recBytes / 2 - 4);
        fileBytes += recBytes;
        return rec;
    });
    var SHP = new WBUF(fileBytes)
    .writeInt32(9994).skip(5 * 4).writeInt32(fileBytes / 2)
    .writeInt32(1000, true).writeInt32(type, true);
    bbox? bbox.forEach(t=>SHP.writeFloat64(t, true)):SHP.skip(4 * 8);
    SHP.skip(4 * 8); // skip Z & M type bbox;
    shapeBuffers.forEach(t=>SHP.writeBuffer(t));
    SHX.position(0).writeBuffer(SHP.buffer(), 100).position(24).writeInt32(shxBytes/2);
    return [new File([SHP.buffer()], name + '.shp', {type:"application/octet-stream"}),
            new File([SHX.buffer()], name + '.shx', {type:"application/octet-stream"})];
    function point(g) { const c = g.coordinates;
        return new WBUF(28)
        .writeInt32(id++).writeInt32(10)
        .writeInt32(type,true)
        .writeFloat64(c[0],true).writeFloat64(c[1],true);
    }
    function multipoint(g, bbox) { const c = g.coordinates;
        const bin = new WBUF(48 + c.length*16)
        .writeInt32(id++).writeInt32(20 + c.length*8)
        .writeInt32(type, true)
        .writeFloat64(bbox[0],true).writeFloat64(bbox[1],true).writeFloat64(bbox[2],true).writeFloat64(bbox[3],true)
        .writeInt32(c.length, true);
        c.forEach(t=>bin.writeFloat64(t[0],true).writeFloat64(t[1],true));
        return bin;
    }
    function poly(g, bbox) { 
        const p0 = c => [c], p1 = c => c, p2 = c => c.flat();
        const coords = (g.type.match(/Polygon/)? g.type.match(/Multi/)? p2:p1:g.type.match(/Multi/)? p1:p0)(g.coordinates);
        const lengths = coords.map(t=>t.length);
        const coordsCount = sum(lengths);
        const pathCount = lengths.length;
        const pos = []; let i = 0; lengths.forEach(t=>{pos.push(i); i += t});
        const bin = new WBUF(52 + 4 * pathCount + 16 * coordsCount)
        .writeInt32(id++).writeInt32(22 + 2 * pathCount + 8 * coordsCount)
        .writeInt32(type, true)
        .writeFloat64(bbox[0], true).writeFloat64(bbox[1], true).writeFloat64(bbox[2], true).writeFloat64(bbox[3], true)
        .writeInt32(pathCount, true).writeInt32(coordsCount, true);
            pos.forEach(t=>bin.writeInt32(t, true));
            coords.forEach(t=>t.forEach(u=>u&&bin.writeFloat64(u[0], true).writeFloat64(u[1], true)));
            return bin;
    }
}
////--------------------------------------------------------------------------------------------------------------------------	
function writeDbf(pbf, name, farray, encoding, encoder) {
    const parray = farray.map(t=>Array.isArray(t)?t[0]:t), recordSize = farray.length;
    const props = parray.map(i=>pbf.getProperties(i));
     const stringify = q => {
        return "{"+Object.entries(q).map(([k,v])=>`"${k}":${JSON.stringify(v instanceof ImageData?{}:v)}`).join(",")+"}";
    }
    const strlen = s => encoder(typeof s == "object"?stringify(s):String(s)).length;
    const schema = {};
    props.forEach(q=>{
        const update = (q,v) => { const p = schema[q.name];
            if (!p) return (schema[q.name] = q);
            if (p.type == q.type) {
                if (p.type == "C"||p.type == "N") p.length = Math.max(p.length, q.length);
                if (p.type == "N") p.precision = Math.max(p.precision, q.precision);
            } else {
                p.type = "C"; p.length = Math.max(p.length, strlen(v));
            }
        };
        const numberProp = num => {
            num = num.toString(); if (num.match(/e/)) num = "0";
            num = num.split('.');
            return [num[0].length, (num[1] || '').length];
        };
        for (let name in q) {  const value = q[name];
            if (value instanceof ImageData||value instanceof Blob) {
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
        if (strlen(field.name) > 11) console.warn("too long field name:", field.name);
        if (field.length > 254) { console.warn("too long data in:", field.name); field.length = 254; }
    });
    const [Y,M,D] = (() => { var t = new Date(); return [t.getFullYear(), t.getMonth() + 1, t.getDate()]; })();
    const headerBytes = 32 + fields.length * 32 +1;
    const recordBytes = sum(fields.map(t=>t.length))+1;
    const fileBytes = headerBytes + recordSize * recordBytes + 1;
 //   const LDID = encoding == "sjis"? 0x13:0;
    const LDID = encoding == "sjis" ? 0x13 : 0x4B; // UTF-8なら0x4Bが一般的
    const yyyymmdd = d => { const L2 = d=>(d > 9? "":"0")+d;
        return d.getFullYear() + L2(d.getMonth()) + L2(d.getDate());
    };
    const sizes = Object.entries({fieldCount, recordSize, fileBytes, headerBytes, recordBytes}).map(t=>t.join(":")).join(", ");
    console.log(`DBF (${name + '.dbf'}) : ${sizes}\n => Fields : ${fields.map(t=>t.name).join(", ")}`);
    
    var DBF = new WBUF(fileBytes).writeUint8(3).writeUint8(Y - 1900).writeUint8(M).writeUint8(D)
        .writeUint32(recordSize, true).writeUint16(headerBytes, true).writeUint16(recordBytes, true).skip(17)
        .writeUint8(LDID).skip(2)
    fields.reduce((dataOffset, { name, type, length, precision }) => {
        DBF.writeBuffer(encoder(name), 11).writeUint8(type.charCodeAt(0)).writeUint32(dataOffset, true)
           .writeUint8(length).writeUint8(precision).skip(14);
        return dataOffset + length;
    }, 1); // 削除フラグ分の 1 バイトから開始
    DBF.writeUint8(0x0d);
    const badname = {};
    props.forEach(rec => { DBF.writeUint8(0x20);
        fields.forEach(({name, type, length, precision}) =>{
            const fill = (s,length) => { while(s.length < length) s += " "; return s; };
            let value = rec[name]; if (value===undefined) return DBF.skip(length);
            switch (type) {
            case 'L': DBF.writeUint8(!!value ? 84 : 70); break;
            case 'N': const numStr = value.toFixed(precision).padStart(length, " ");
                DBF.writeBuffer(encoder(numStr)); break;
            case 'D': DBF.writeBuffer(encoder(yyyymmdd(value)), length); break;
            case 'C': 
                if (value instanceof ImageData||value instanceof Blob) {
                    badname[name] = true;
                    value = {};
                }
                DBF.writeBuffer(encoder(value == null? "": 
                typeof value == "object"?stringify(value):String(value)), length); break;
            }
        });
    });
    Object.keys(badname).length && console.warn("illegal binary data in ", Object.keys(badname).join(", "));
    DBF.writeUint8(0x1a);
    return new File([DBF.buffer()], name + '.dbf', {type:"application/octet-stream"});
}
////=======================================================================================================================
onmessage = async (e) => {
    const {buf, name, encoding} = e.data;
    const encoder = await getEncoder(encoding);
	const prj  = `GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]`;
	console.log(`--------------------------\n    PBF => Shape File\n--------------------------`)
	const shpTypes = [["point", 1],["multipoint", 8],["polyline", 3],["polygon", 5]];
	const types = [[],[],[],[],[]];
	const pbf = await new GeoPBF().name(name).set(buf); //console.log(pbf);
	pbf.fmap.forEach((t,i)=>{
		if (t[2] < 6) types[[0,1,2,2,3,3][t[2]]].push(i);
		else t[4].forEach((u,j)=>types[[0,1,2,2,3,3][u]].push([i,j]));
	});
	pbf.bufs.length && console.warn("Binary(file/images) data will be lost in shape.")
	const single = sum(types.map(t=>t.length? 1:0))==1;
	const zipFiles = [];
	shpTypes.forEach(([shpType, shpCode], i)=>{ if (!types[i].length) return;
		const fname = name + (single?"":"_"+shpType);
		zipFiles.push(...writeShp(pbf, fname, types[i], shpCode));
		zipFiles.push(writeDbf(pbf, fname, types[i], encoding, encoder));
        zipFiles.push(new File([prj], fname + '.prj', {type:"application/octet-stream"}));
        zipFiles.push(new File([encoding], fname + '.cpg', {type:"text/plain"}));
	});
	console.log(`preparing deflation...`);
	const file = await encodeZIP(zipFiles, name+".zip");
	console.log(" => Done : ", file.name, "size: " + file.size.toLocaleString() + " bytes");
	postMessage(file);
};
