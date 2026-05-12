import { isBlob, isObject } from "common";
import { fname2mime } from "./fname2mime.js";

export async function decodeZIP(source, target = null, encoding = null) {
	let eventTarget = (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
	const event = (type, detail) => eventTarget && eventTarget.dispatchEvent(new CustomEvent(type, { detail }));

	if (isObject(target)) {
		encoding = target.encoding || encoding;
		eventTarget = target.eventTarget || eventTarget;
		target = target.target;
	}

	// 🚀 キャッシュバスター: Cloudflare等のエッジに古いエラーを即答させないための処置
	const getCleanUrl = (url) => {
		if (typeof url !== 'string') return url;
		const sep = url.includes('?') ? '&' : '?';
		return `${url}${sep}nocache=${Date.now()}`;
	};

	const safeFetch = async (url, opt) => {
		try { const r = await fetch(url, opt); return (!r.ok && r.status !== 206) ? null : r; } catch (e) { return null; }
	};
	const parseDosDate = (d, t) => new Date(((d >> 9) & 127) + 1980, ((d >> 5) & 15) - 1, d & 31, (t >> 11) & 31, (t >> 5) & 63, (t & 31) * 2).getTime();

	let isFile = isBlob(source), totalLength = 0;
	let supportRange = true;

	// 🏛️ フェーズ1: HEAD先行による事前問診と安全なバッファ構築
	if (isFile) {
		totalLength = source.size;
	} else {
		const cleanUrl = getCleanUrl(source);
		const headRes = await safeFetch(cleanUrl, { method: 'HEAD' });
		if (!headRes) throw new Error("CORS/Network Error");
		const cl = headRes.headers.get('content-length');
		const acceptRanges = headRes.headers.get('accept-ranges');
		totalLength = cl ? parseInt(cl) : 0;
		if (headRes.body) await headRes.body.cancel().catch(() => {});
		supportRange = (totalLength > 1 && acceptRanges !== 'none');
		if (!supportRange) {
            console.warn("Origin explicitly rejects Range. Initializing robust local memory stream...");
            event("FetchStart", { name: "Initializing Global Storage Buffer" });
            source = await fetch(cleanUrl).then(r => r.blob());
            totalLength = source.size;
            isFile = true; 
            event("FetchEnd", { name: "Initializing Global Storage Buffer", size: totalLength });
        }
	}

	// 🏛️ フェーズ2: ハイブリッド対応の強靭な read 関数
	const read = async (from, len, name) => {
		if (isFile) return new Uint8Array(await source.slice(from, from + len).arrayBuffer());
		const res = await fetch(getCleanUrl(source), { headers: { Range: `bytes=${from}-${from + len - 1}` } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		// 万が一の安全装置: 読み込み中の Range 無視バッファ溢れを防ぎ、その場で進化
		// if (res.status === 200) {
		// 	source = await res.blob();
		// 	isFile = true;
		// 	totalLength = source.size;
		// 	return new Uint8Array(await source.slice(from, from + len).arrayBuffer());
		// }
		const reader = res.body.getReader(), bin = new Uint8Array(len);
		let pos = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const copyLen = Math.min(value.length, len - pos);
			bin.set(value.subarray(0, copyLen), pos);
			pos += copyLen;
			name && event("FetchProgress", { name, loaded: pos, total: len });
			if (pos >= len) { reader.cancel(); break; }
		}
		if (pos < len) throw new Error(`Truncated: ${pos}/${len}`);
		return bin;
	};

	try {
		// 🏛️ フェーズ3: スマート EOCD（目次サイン）狙撃
		const findEOCD = async (searchSize) => {
			const size = Math.min(totalLength, searchSize);
			const buf = await read(totalLength - size, size);
			const ev = new DataView(buf.buffer);
			for (let i = size - 22; i >= 0; i--) {
				if (ev.getUint32(i, true) === 0x06054b50) return { p: i, buf, size };
			}
			return null;
		};

		// まずは超軽量バッファ(512B)で一瞬で探索
		let eocd = await findEOCD(512);
		if (!eocd) eocd = await findEOCD(65558); // コメント付きZIPのフェイルセーフ
		if (!eocd) throw new Error("Invalid ZIP: EOCD Signature missing");

		const { p, buf } = eocd;
		const ev = new DataView(buf.buffer);
		const count = ev.getUint16(p + 10, true);
		const cdSize = ev.getUint32(p + 12, true);
		const cdOff = ev.getUint32(p + 16, true);

		// 目次リスト一括ロード
		const cd = await read(cdOff, cdSize);
		const cv = new DataView(cd.buffer);
		const entries = [];

		// 🏛️ フェーズ4: 目次解析と抽出ストリーム
		for (let i = 0, off = 0; i < count; i++) {
			const flags = cv.getUint16(off + 8, true), meth = cv.getUint16(off + 10, true);
			const time = cv.getUint16(off + 12, true), date = cv.getUint16(off + 14, true);
			const crc = cv.getUint32(off + 16, true), cSiz = cv.getUint32(off + 20, true), uSiz = cv.getUint32(off + 24, true);
			const nLen = cv.getUint16(off + 28, true), eLen = cv.getUint16(off + 30, true), cLen = cv.getUint16(off + 32, true);
			const loc = cv.getUint32(off + 42, true);
			const name = new TextDecoder(encoding || (flags & 0x0800) ? 'utf-8' : 'shift-jis').decode(cd.subarray(off + 46, off + 46 + nLen)).normalize("NFC");

			off += 46 + nLen + eLen + cLen;
			if (name.endsWith('/')) continue;

			const lastModified = parseDosDate(date, time);
			const type = fname2mime(name);

			if (target === false) {
				entries.push({ name, size: uSiz, cSize: cSiz, lastModified, type });
				continue;
			}
			if (typeof target === 'string' && target !== name) continue;

			// シンプルかつ最も安定した抽出パイプライン
			const extract = async () => {
				event("FetchStart", { name });
				const lfhBuf = await read(loc, 30, `${name} Header`);
				const hv = new DataView(lfhBuf.buffer);
				if (hv.getUint32(0, true) !== 0x04034b50) throw new Error(`Invalid Local Header for ${name}`);

				const nLen = hv.getUint16(26, true);
				const eLen = hv.getUint16(28, true);
				const dataOff = loc + 30 + nLen + eLen;

				const data = await read(dataOff, cSiz, name);

				let resBlob;
				if (meth) {
					const ds = new DecompressionStream("deflate-raw");
					const stream = new Response(data).body.pipeThrough(ds);
					resBlob = await new Response(stream).blob();
				} else {
					resBlob = new Blob([data]);
				}

				event("FetchEnd", { name, size: uSiz });
				return resBlob;
			};

			const filePromise = (async () => new File([await extract()], name, { type, lastModified }))();
			if (typeof target === 'string') return await filePromise;
			entries.push(filePromise);
		}
		return target === false ? entries : target ? null : await Promise.all(entries);
	} catch (e) { console.warn("ZIP Error:", e.message); return null; }
}