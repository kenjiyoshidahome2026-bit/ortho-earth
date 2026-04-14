import {fname2mime} from "./fname2mime.js";
export async function decodeZIP(source, target = null, encoding = null) {//基本的にencodingは自動判定
	const safeFetch = async (url, opt) => {
		try { const r = await fetch(url, opt); return (!r.ok && r.status !== 206) ? null : r; } catch (e) { return null; }
	};
	const parseDosDate = (d, t) => new Date(((d >> 9) & 127) + 1980, ((d >> 5) & 15) - 1, d & 31, (t >> 11) & 31, (t >> 5) & 63, (t & 31) * 2).getTime();
	const isBlob = (q) => q && typeof q.size === 'number' && typeof q.slice === 'function';
	let isFile = isBlob(source), totalLength = 0;
	if (isFile) {
		totalLength = source.size;
	} else {
		const res = await safeFetch(source, { headers: { Range: 'bytes=0-0' } });
		if (!res) throw new Error("CORS/Network Error");
		const cr = res.headers.get('content-range');
		totalLength = cr ? parseInt(cr.split('/').pop()) : parseInt(res.headers.get('content-length'));
		if (res.status !== 206) { source = await fetch(source).then(r => r.blob()); isFile = true; }
	}
	const read = async (from, len) => {
		if (isFile) return new Uint8Array(await source.slice(from, from + len).arrayBuffer());
		return new Uint8Array(await fetch(source, { headers: { Range: `bytes=${from}-${from + len - 1}` } }).then(r => r.arrayBuffer()));
	};
	try {
		const bufSize = Math.min(totalLength, 65558);
		const endBuf = await read(totalLength - bufSize, bufSize), ev = new DataView(endBuf.buffer);
		let p = -1;
		for (let i = bufSize - 22; i >= 0; i--) if (ev.getUint32(i, true) === 0x06054b50) { p = i; break; }
		if (p === -1) throw new Error("Invalid ZIP");
		const count = ev.getUint16(p + 10, true), cdSize = ev.getUint32(p + 12, true), cdOff = ev.getUint32(p + 16, true);
		const cd = await read(cdOff, cdSize), cv = new DataView(cd.buffer);
		const entries = [];
		for (let i = 0, off = 0; i < count; i++) {
			const flags = cv.getUint16(off + 8, true), meth = cv.getUint16(off + 10, true);
			const time = cv.getUint16(off + 12, true), date = cv.getUint16(off + 14, true);
			const crc = cv.getUint32(off + 16, true), cSiz = cv.getUint32(off + 20, true), uSiz = cv.getUint32(off + 24, true);
			const nLen = cv.getUint16(off + 28, true), eLen = cv.getUint16(off + 30, true), cLen = cv.getUint16(off + 32, true);
			const loc = cv.getUint32(off + 42, true);
			const name = new TextDecoder(encoding || (flags & 0x0800) ? 'utf-8' : 'shift-jis').decode(cd.subarray(off + 46, off + 46 + nLen)).normalize("NFC");
			const currentEntryOff = off;
			off += 46 + nLen + eLen + cLen; // 次のループのためにオフセットを更新
			if (name.endsWith('/')) continue;
			const lastModified = parseDosDate(date, time);
			const type = fname2mime(name);
			if (target === false) { // targetがfalseの場合はメタデータのみ収集
				entries.push({ name, size: uSiz, cSize: cSiz, lastModified, type });
				continue;
			}
			if (typeof target === 'string' && target !== name) continue;// 特定ファイル指定の場合、一致しなければスキップ
			const extract = async () => {
				const head = await read(loc, 30), hv = new DataView(head.buffer);
				const data = await read(loc + 30 + hv.getUint16(26, true) + hv.getUint16(28, true), cSiz);
				if (!meth) return new Blob([data]);
				const ds = new DecompressionStream("deflate-raw"), w = ds.writable.getWriter();
				w.write(data); w.close();
				return await new Response(ds.readable).blob();
			};
			const filePromise = (async () => new File([await extract()], name, { type, lastModified }))();
			if (typeof target === 'string') return await filePromise;
			entries.push(filePromise);
		}
		return target === false ? entries : target? null: await Promise.all(entries);
	} catch (e) { console.warn("ZIP Error:", e.message); return null; }
}