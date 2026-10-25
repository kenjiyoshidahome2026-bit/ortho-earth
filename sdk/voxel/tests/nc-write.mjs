// 検定用の NetCDF classic の書き手（CDF-1／2／5・big endian）＝t-sources.mjs が読み手を確かめるために手で組む。
//   writeNetCDF({ version, dims: [[name, len（0＝記録の次元）]], numrecs, gatts, vars: [{ name, dims: [名前], type: "byte"|"char"|"short"|"int"|"float"|"double", attrs, data }] }) → Uint8Array
const TYPE = { byte: [1, 1], char: [2, 1], short: [3, 2], int: [4, 4], float: [5, 4], double: [6, 8] };
export function writeNetCDF({ version = 1, dims, numrecs = 0, gatts = {}, vars }) {
	const big = version === 5, offW = version === 1 ? 4 : 8, sizeW = big ? 8 : 4;
	const parts = [];   // [kind, value]＝後で詰める
	let len = 0;
	const u32 = v => { parts.push(["u32", v]); len += 4; }, sz = v => { parts.push([big ? "u64" : "u32", v]); len += sizeW; }, off = i => { parts.push(["off", i]); len += offW; };
	const bytes = (b, pad = true) => { parts.push(["bytes", b]); len += pad ? (b.length + 3) & ~3 : b.length; if (pad && b.length % 4) parts.push(["pad", 4 - b.length % 4]); };
	const name = s => { const b = new TextEncoder().encode(s); sz(b.length); bytes(b); };
	const encVals = (type, vals) => {
		const [, w] = TYPE[type];
		if (type === "char") return new TextEncoder().encode(vals);
		const a = Array.isArray(vals) || ArrayBuffer.isView(vals) ? Array.from(vals) : [vals], b = new Uint8Array(a.length * w), dv = new DataView(b.buffer);
		a.forEach((v, i) => { const o = i * w; if (type === "byte") dv.setInt8(o, v); else if (type === "short") dv.setInt16(o, v); else if (type === "int") dv.setInt32(o, v); else if (type === "float") dv.setFloat32(o, v); else dv.setFloat64(o, v); });
		return b;
	};
	const attType = v => typeof v === "string" ? "char" : Number.isInteger(v) && Math.abs(v) < 2 ** 31 ? "int" : "double";
	const atts = a => {
		const ks = Object.keys(a); if (!ks.length) { u32(0); sz(0); return; }
		u32(12); sz(ks.length);
		for (const k of ks) { const v = a[k], t = attType(v), b = encVals(t, v); name(k); u32(TYPE[t][0]); sz(t === "char" ? b.length : Array.isArray(v) ? v.length : 1); bytes(b); }
	};
	parts.push(["bytes", new Uint8Array([0x43, 0x44, 0x46, version])]); len += 4;
	sz(numrecs);
	u32(10); sz(dims.length); for (const [n, l] of dims) { name(n); sz(l); }
	atts(gatts);
	const dimIdx = n => dims.findIndex(d => d[0] === n), recDim = dims.findIndex(d => d[1] === 0);
	u32(11); sz(vars.length);
	const meta = vars.map(v => { const ids = v.dims.map(dimIdx), rec = ids.length > 0 && ids[0] === recDim, inner = ids.filter((d, i) => !(rec && i === 0)).reduce((a, d) => a * dims[d][1], 1), w = TYPE[v.type][1]; return { rec, inner, w, vsize: (inner * w + 3) & ~3 }; });
	vars.forEach((v, i) => { name(v.name); sz(v.dims.length); for (const d of v.dims) sz(dimIdx(d)); atts(v.attrs ?? {}); u32(TYPE[v.type][0]); sz(meta[i].vsize); off(i); });
	// 置き場所＝固定の変数を順に・その後に記録（記録ごとに記録変数を順に）
	const recVars = meta.filter(m => m.rec).length, recSlab = m => recVars === 1 ? m.inner * m.w : m.vsize;
	let p = len; const begin = [];
	meta.forEach((m, i) => { if (!m.rec) { begin[i] = p; p += m.vsize; } });
	const recStart = p, recSize = meta.reduce((a, m) => a + (m.rec ? recSlab(m) : 0), 0);
	let q = recStart; meta.forEach((m, i) => { if (m.rec) { begin[i] = q; q += recSlab(m); } });
	const out = new Uint8Array(recStart + recSize * numrecs + 4), dv = new DataView(out.buffer);
	let o = 0;
	for (const [k, v] of parts) {
		if (k === "u32") { dv.setUint32(o, v); o += 4; }
		else if (k === "u64") { dv.setBigUint64(o, BigInt(v)); o += 8; }
		else if (k === "off") { if (offW === 4) dv.setUint32(o, begin[v]); else dv.setBigUint64(o, BigInt(begin[v])); o += offW; }
		else if (k === "pad") o += v;
		else { out.set(v, o); o += v.length; }
	}
	vars.forEach((v, i) => {
		const m = meta[i], b = encVals(v.type, v.data);
		if (!m.rec) { out.set(b, begin[i]); return; }
		const slab = m.inner * m.w;
		for (let r = 0; r < numrecs; r++) out.set(b.subarray(r * slab, (r + 1) * slab), begin[i] + r * recSize);
	});
	return out.subarray(0, recStart + recSize * numrecs);
}
