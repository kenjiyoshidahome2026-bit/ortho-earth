// "geopbf/decodeZIP"＝zip（Blob か URL・Range で中央ディレクトリから引く）→ File の列。
//   target＝文字列：その 1 本だけ（無ければ null）・false：目録だけ（展開しない）・null／省略：全部。第 2 引数にまとめて渡す形（options）も同じ意味。
//   zip として読めなければ console.warn して null
import { isBlob, isObject } from "./utility.ts";
import { fname2mime } from "./fname2mime.ts";

// 展開の上限（2026-10-11・安全既定）: 1 エントリの伸長後サイズ。細工された zip（宣言 1 KB・実体 数 GB の「zip 爆弾」）が
// メモリを食い尽くす前に止める。展開は宣言サイズ（中央ディレクトリの uSiz）を越えた時点でも止める。{ maxEntrySize } で変更可
/** 1 エントリの伸長後サイズの上限（既定 4 GiB）＝{ maxEntrySize } で変える */
export const MAX_ENTRY_SIZE = 4 * 1024 * 1024 * 1024;   // 4 GiB（zip64 無しの上限と同じ・ブラウザの Blob は実質その手前で尽きる）

export interface DecodeZIPOptions {
	target?: string | false | null;
	/** エントリ名の文字コード（UTF-8 フラグが無い時・既定 shift-jis） */
	encoding?: string | null;
	/** FetchStart／FetchProgress／FetchEnd を投げる先（既定＝window か self） */
	eventTarget?: EventTarget | null;
	/** URL の時、HEAD を省くための既知の全長 */
	totalLength?: number;
	maxEntrySize?: number;
}
/** 目録（target＝false）の 1 行 */
export interface ZipEntryInfo { name: string; size: number; cSize: number; lastModified: number; type: string }

export async function decodeZIP(source: Blob | string, target?: null, encoding?: string | null): Promise<File[] | null>;
export async function decodeZIP(source: Blob | string, target: string, encoding?: string | null): Promise<File | null>;
export async function decodeZIP(source: Blob | string, target: false, encoding?: string | null): Promise<ZipEntryInfo[] | null>;
export async function decodeZIP(source: Blob | string, target?: string | false | null | DecodeZIPOptions, encoding?: string | null): Promise<File[] | File | ZipEntryInfo[] | null>;
export async function decodeZIP(source: Blob | string, target: string | false | null | DecodeZIPOptions = null, encoding: string | null = null): Promise<File[] | File | ZipEntryInfo[] | null> {
	// window（main）か self（worker）＝どちらの lib でも通るよう globalThis から引く（値は従来と同じ）
	const g = globalThis as { window?: EventTarget; self?: EventTarget };
	let eventTarget: EventTarget | null = (typeof g.window !== 'undefined' ? g.window : (typeof g.self !== 'undefined' ? g.self : null));
	const event = (type: string, detail: unknown): boolean | null => eventTarget && eventTarget.dispatchEvent(new CustomEvent(type, { detail }));

	let passedTotalLength = 0, maxEntrySize = MAX_ENTRY_SIZE;
	if (isObject(target)) {
		const o = target as DecodeZIPOptions;
		encoding = o.encoding || encoding;
		eventTarget = o.eventTarget || eventTarget;
		if (o.totalLength) passedTotalLength = o.totalLength;
		if (o.maxEntrySize !== undefined && o.maxEntrySize > 0) maxEntrySize = o.maxEntrySize;
		target = o.target ?? null;   // 旧＝undefined もそのまま（下の判定は falsy 扱い＝同じ）
	}

	const getCleanUrl = (url: string): string => {
		if (typeof url !== 'string') return url;
		const sep = url.includes('?') ? '&' : '?';
		return `${url}${sep}nocache=${Date.now()}`;
	};

	const safeFetch = async (url: string, opt?: RequestInit): Promise<Response | null> => {
		try { const r = await fetch(url, opt); return (!r.ok && r.status !== 206) ? null : r; } catch (e) { return null; }
	};
	const parseDosDate = (d: number, t: number): number => new Date(((d >> 9) & 127) + 1980, ((d >> 5) & 15) - 1, d & 31, (t >> 11) & 31, (t >> 5) & 63, (t & 31) * 2).getTime();

	let isFile = isBlob(source), totalLength = 0;
	let supportRange = true;

	if (isFile) {
		totalLength = (source as Blob).size;
	} else if (passedTotalLength > 0) {
		totalLength = passedTotalLength;
		supportRange = true;
	} else {
		const cleanUrl = getCleanUrl(source as string);
		const headRes = await safeFetch(cleanUrl, { method: 'HEAD' });
		if (!headRes) throw new Error("CORS/Network Error");
		const cl = headRes.headers.get('content-length');
		const acceptRanges = headRes.headers.get('accept-ranges');
		totalLength = cl ? parseInt(cl) : 0;
		if (headRes.body) await headRes.body.cancel().catch(() => {});
		supportRange = (totalLength > 1 && acceptRanges !== 'none');
	}

	if (!isFile && (!supportRange || totalLength <= 0)) {
		console.warn("Origin explicitly rejects Range or size missing. Initializing robust local memory stream...");
		event("FetchStart", { name: "Initializing Global Storage Buffer" });
		source = await fetch(getCleanUrl(source as string)).then(r => r.blob());
		totalLength = (source as Blob).size;
		isFile = true;
		event("FetchEnd", { name: "Initializing Global Storage Buffer", size: totalLength });
	}

	const read = async (from: number, len: number, name?: string, uSiz?: number): Promise<Uint8Array> => {
		if (isFile) return new Uint8Array(await (source as Blob).slice(from, from + len).arrayBuffer());
		const res = await fetch(getCleanUrl(source as string), { headers: { Range: `bytes=${from}-${from + len - 1}` } });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		const reader = res.body!.getReader(), bin = new Uint8Array(len);
		let pos = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const copyLen = Math.min(value.length, len - pos);
			bin.set(value.subarray(0, copyLen), pos);
			pos += copyLen;
			name && uSiz && event("FetchProgress", { name, loaded: ~~(pos/len*uSiz), total: uSiz });
			if (pos >= len) { reader.cancel(); break; }
		}
		if (pos < len) throw new Error(`Truncated: ${pos}/${len}`);
		return bin;
	};

	try {
		const findEOCD = async (searchSize: number): Promise<{ p: number; buf: Uint8Array; size: number } | null> => {
			const size = Math.min(totalLength, searchSize);
			const buf = await read(totalLength - size, size);
			const ev = new DataView(buf.buffer);
			for (let i = size - 22; i >= 0; i--) {
				if (ev.getUint32(i, true) === 0x06054b50) return { p: i, buf, size };
			}
			return null;
		};

		let eocd = await findEOCD(512);
		if (!eocd) eocd = await findEOCD(65558);
		if (!eocd) throw new Error("Invalid ZIP: EOCD Signature missing");

		const { p, buf } = eocd;
		const ev = new DataView(buf.buffer);
		const count = ev.getUint16(p + 10, true);
		const cdSize = ev.getUint32(p + 12, true);
		const cdOff = ev.getUint32(p + 16, true);
		if (cdOff + cdSize > totalLength) throw new Error(`Invalid ZIP: central directory (${cdOff}+${cdSize}) runs past the end of the file (${totalLength})`);

		const cd = await read(cdOff, cdSize);
		const cv = new DataView(cd.buffer);
		const entries: (ZipEntryInfo | Promise<File>)[] = [];

		// 名前のデコーダは 2 本だけ用意（旧＝エントリごとに new TextDecoder、しかも `encoding || (flags & 0x0800) ? …` の優先順位で encoding 指定が常に utf-8 になっていた・2026-09-15）
		const decUtf8 = new TextDecoder("utf-8"), decOther = new TextDecoder(encoding || "shift-jis");   // bit 11（UTF-8 フラグ）> encoding 引数 > shift-jis
		for (let i = 0, off = 0; i < count; i++) {
			if (off + 46 > cd.length) throw new Error(`Invalid ZIP: central directory entry ${i} is truncated`);
			const flags = cv.getUint16(off + 8, true), meth = cv.getUint16(off + 10, true);
			const time = cv.getUint16(off + 12, true), date = cv.getUint16(off + 14, true);
			const cSiz = cv.getUint32(off + 20, true), uSiz = cv.getUint32(off + 24, true);   // off+16＝CRC32（読まない＝伸長後の照合はしない）
			const nLen = cv.getUint16(off + 28, true), eLen = cv.getUint16(off + 30, true), cLen = cv.getUint16(off + 32, true);
			const loc = cv.getUint32(off + 42, true);
			const name = ((flags & 0x0800) ? decUtf8 : decOther).decode(cd.subarray(off + 46, off + 46 + nLen)).normalize("NFC");

			off += 46 + nLen + eLen + cLen;
			if (name.endsWith('/')) continue;

			const lastModified = parseDosDate(date, time);
			const type = fname2mime(name);

			if (target === false) {
				entries.push({ name, size: uSiz, cSize: cSiz, lastModified, type });
				continue;
			}
			if (typeof target === 'string' && target !== name && !name.endsWith('/' + target)) continue;

			const extract = async (): Promise<Blob> => {
				event("FetchStart", { name });
				const lfhBuf = await read(loc, 30, `${name} Header`);
				const hv = new DataView(lfhBuf.buffer);
				if (hv.getUint32(0, true) !== 0x04034b50) throw new Error(`Invalid Local Header for ${name}`);

				const nLen = hv.getUint16(26, true);
				const eLen = hv.getUint16(28, true);
				const dataOff = loc + 30 + nLen + eLen;

				if (uSiz > maxEntrySize) throw new Error(`${name}: declared size ${uSiz} B exceeds the limit (${maxEntrySize} B)`);
				if (dataOff + cSiz > totalLength) throw new Error(`${name}: compressed data runs past the end of the file`);
				const data = await read(dataOff, cSiz, name, uSiz);

				let resBlob: Blob;
				if (meth) {
					const ds = new DecompressionStream("deflate-raw");
					// 伸長の上限＝宣言サイズ（zip64 の印 0xFFFFFFFF の時は maxEntrySize）。越えたら途中で止める＝zip 爆弾がメモリを食い尽くす前に落とす
					const limit = (uSiz && uSiz !== 0xFFFFFFFF) ? uSiz : maxEntrySize;
					let got = 0;
					const guard = new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, ctl) { got += chunk.byteLength; if (got > limit) throw new Error(`${name}: inflates past its declared size (${limit} B); refusing to continue`); ctl.enqueue(chunk); } });
					const stream = new Response(data as BodyInit).body!.pipeThrough(ds).pipeThrough(guard);
					resBlob = await new Response(stream).blob();
				} else {
					resBlob = new Blob([data as BlobPart]);
				}

				event("FetchEnd", { name, size: uSiz });
				return resBlob;
			};

			const filePromise = (async () => new File([await extract()], name, { type, lastModified }))();
			if (typeof target === 'string') return await filePromise;
			entries.push(filePromise);
		}
		return target === false ? entries as ZipEntryInfo[] : target ? null : await Promise.all(entries as Promise<File>[]);
	} catch (e) { console.warn("ZIP Error:", (e as Error).message); return null; }
}
