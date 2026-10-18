// ZIP に包まれた LAS/LAZ を開く（2026-10-18・静岡県 VIRTUAL SHIZUOKA の配布物＝図郭ごとの .zip に .las が 1 つ）。copc-worker.js の open が使う。
//   流れ＝項を見つける → その項の生のバイトだけを 8 MB ずつ範囲読みして DecompressionStream("deflate-raw") へ流す → Blob。
//     項の見つけ方＝先頭の局所ヘッダが .las／.laz で大きさを持っていればそれ（総長が要らない＝S3 は CORS で Content-Range を見せないので総長が分からない）、
//     でなければ末尾（EOCD・中央ディレクトリ）から（総長が要る）。
//   ZIP 全体を手元に持たない（解いた LAS だけ）＝URL は S3 などの範囲読みのまま。読みながら頭（LAS のヘッダ）を覗き、点の数が上限を超えていれば取り終える前に断る。
//   対応＝格納（0）と deflate（8）・ZIP64 の大きさ。暗号化・分割は断る。node で検定できる純関数（parse*）＝tests/t-pointcloud-zip.mjs。
import type { Source } from "geopbf/cog/source";

/** 中央ディレクトリの項（大きさは ZIP64 の拡張を当てた後） */
export interface ZipEntry { name: string; method: number; flags: number; csize: number; usize: number; localOffset: number }

const sig = (dv: DataView, o: number) => dv.getUint32(o, true);
/** ZIP の始まり（"PK\3\4"）か */
export const isZip = (head: Uint8Array) => head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4;

/** 末尾の断片（tailStart＝その断片がファイルのどこから始まるか）から中央ディレクトリの位置 → { offset, size }。見つからなければ null */
export function parseEOCD(tail: Uint8Array, tailStart: number): { offset: number; size: number } | null {
	const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
	for (let i = tail.length - 22; i >= 0; i--) {
		if (sig(dv, i) !== 0x06054b50) continue;
		let size = dv.getUint32(i + 12, true), offset = dv.getUint32(i + 16, true);
		if ((offset === 0xffffffff || size === 0xffffffff) && i >= 20 && sig(dv, i - 20) === 0x07064b50) {   // ZIP64 の所在 → ZIP64 の EOCD
			const at = Number(dv.getBigUint64(i - 20 + 8, true)) - tailStart;
			if (at < 0 || at + 56 > tail.length || sig(dv, at) !== 0x06064b50) return null;
			size = Number(dv.getBigUint64(at + 40, true)); offset = Number(dv.getBigUint64(at + 48, true));
		}
		return { offset, size };
	}
	return null;
}

/** 中央ディレクトリ → 項の並び */
export function parseCentralDirectory(cd: Uint8Array): ZipEntry[] {
	const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength), out: ZipEntry[] = [];
	for (let p = 0; p + 46 <= cd.length && sig(dv, p) === 0x02014b50;) {
		const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
		let csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true), localOffset = dv.getUint32(p + 42, true);
		const nameBytes = cd.subarray(p + 46, p + 46 + nl);
		const name = new TextDecoder(flags & 0x800 ? "utf-8" : "latin1").decode(nameBytes);   // 名前は拡張子を見るだけ（cp932 の日本語名でも .las は読める）
		for (let e = p + 46 + nl, end = e + el; e + 4 <= end;) {   // ZIP64 の拡張（0x0001）＝0xffffffff の欄だけが順に入る
			const id = dv.getUint16(e, true), len = dv.getUint16(e + 2, true);
			if (id === 1) {
				let q = e + 4;
				if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
				if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
				if (localOffset === 0xffffffff) localOffset = Number(dv.getBigUint64(q, true));
			}
			e += 4 + len;
		}
		out.push({ name, method, flags, csize, usize, localOffset });
		p += 46 + nl + el + cl;
	}
	return out;
}

/** 点群の項（最初の .las／.laz・"__MACOSX/" は除く） */
export const pickPointEntry = (entries: ZipEntry[]) => entries.find(e => /\.la[sz]$/i.test(e.name) && !/^__MACOSX\//.test(e.name)) || null;

/** 先頭の局所ヘッダの項（点群の項で・大きさが書いてある＝flags の bit 3 が無い時だけ）→ 項と生のバイトの始まり。使えなければ null */
export function parseLocalEntry(head: Uint8Array): { entry: ZipEntry; dataOffset: number } | null {
	if (head.length < 30 || !isZip(head)) return null;
	const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
	const flags = dv.getUint16(6, true), method = dv.getUint16(8, true), nl = dv.getUint16(26, true), el = dv.getUint16(28, true);
	if (flags & 8 || head.length < 30 + nl + el) return null;
	let csize = dv.getUint32(18, true), usize = dv.getUint32(22, true);
	const name = new TextDecoder(flags & 0x800 ? "utf-8" : "latin1").decode(head.subarray(30, 30 + nl));
	for (let e = 30 + nl, end = e + el; e + 4 <= end;) {   // ZIP64 の拡張（局所ヘッダでは usize・csize の順に両方）
		const id = dv.getUint16(e, true), len = dv.getUint16(e + 2, true);
		if (id === 1 && len >= 16) { if (usize === 0xffffffff) usize = Number(dv.getBigUint64(e + 4, true)); if (csize === 0xffffffff) csize = Number(dv.getBigUint64(e + 12, true)); }
		e += 4 + len;
	}
	if (csize === 0xffffffff || !pickPointEntry([{ name } as ZipEntry])) return null;
	return { entry: { name, method, flags, csize, usize, localOffset: 0 }, dataOffset: 30 + nl + el };
}

/** 局所ヘッダ（30 B＋名前＋拡張）の長さ＝生のバイトの始まりまで */
export function localDataOffset(local: Uint8Array): number {
	const dv = new DataView(local.buffer, local.byteOffset, local.byteLength);
	if (local.length < 30 || sig(dv, 0) !== 0x04034b50) throw new Error("pointcloud: broken ZIP (no local header)");
	return 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
}

/** LAS の頭から点の数（1.4 は 64bit の欄・それ前は 32bit）＝取り終える前の上限の判定に。読めなければ null */
export function lasPointCount(h: Uint8Array): number | null {
	if (h.length < 111 || h[0] !== 0x4c || h[1] !== 0x41 || h[2] !== 0x53 || h[3] !== 0x46) return null;
	const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
	const legacy = dv.getUint32(107, true);
	return h[25] >= 4 && h.length >= 255 ? Number(dv.getBigUint64(247, true)) || legacy : legacy;
}

/**
 * ZIP の中の最初の LAS/LAZ を解いて Blob にする。
 * @param src  ZIP（URL は範囲読み・Blob はそのまま）
 * @param o.onProgress  取った生のバイト／その項の生の総長
 * @param o.check  LAS の点の数を見て断る理由を返す（null＝続ける）＝取り終える前に止める
 */
export async function unzipPointCloud(src: Source, { onProgress, check, chunk = 8 << 20 }: { onProgress?: (loaded: number, total: number) => void; check?: (count: number) => string | null; chunk?: number } = {}): Promise<{ blob: Blob; name: string }> {
	let entry: ZipEntry | null, start: number;
	const local = parseLocalEntry(src.head);
	if (local) { entry = local.entry; start = local.dataOffset; }
	else {
		if (src.size == null) throw new Error("pointcloud: the server did not report the ZIP size, and the first file in the ZIP is not a .las/.laz with its size written");
		const tailLen = Math.min(src.size, 65557 + 20 + 56), tailStart = src.size - tailLen;
		const loc = parseEOCD(new Uint8Array(await src.read(tailStart, tailLen)), tailStart);
		if (!loc) throw new Error("pointcloud: broken ZIP (no end of central directory)");
		entry = pickPointEntry(parseCentralDirectory(new Uint8Array(await src.read(loc.offset, loc.size))));
		if (!entry) throw new Error("pointcloud: the ZIP has no .las or .laz file");
		start = entry.localOffset + localDataOffset(new Uint8Array(await src.read(entry.localOffset, 30 + 1024)));
	}
	if (entry.flags & 1) throw new Error("pointcloud: the ZIP is encrypted");
	if (entry.method !== 0 && entry.method !== 8) throw new Error(`pointcloud: ZIP compression method ${entry.method} is not supported (stored and deflate are)`);
	const total = entry.csize;
	// 生のバイト → （deflate なら）解く → Blob（一方）・頭を覗く（もう一方）
	const ts = entry.method === 8 ? new DecompressionStream("deflate-raw") : new TransformStream<Uint8Array, Uint8Array>();
	const writer = ts.writable.getWriter();
	const [toBlob, toPeek] = (ts.readable as ReadableStream<Uint8Array>).tee();
	const blobP = new Response(toBlob).blob();
	let stop: string | null = null;
	const peek = (async () => {   // 頭（375 B 以上）が揃ったら点の数を見る・済んだら片方を閉じる
		const rd = toPeek.getReader(), parts: Uint8Array[] = []; let n = 0;
		while (n < 375) { const { value, done } = await rd.read(); if (done || !value) break; parts.push(value); n += value.length; }
		const h = new Uint8Array(n); let o = 0; for (const p of parts) { h.set(p, o); o += p.length; }
		const count = lasPointCount(h);
		if (count != null && check) stop = check(count);
		rd.cancel().catch(() => {});
	})();
	try {
		let next: Promise<ArrayBuffer | Uint8Array> | null = total ? src.read(start, Math.min(chunk, total)) : null;
		for (let at = 0; next;) {
			const buf = new Uint8Array(await next), got = at + buf.length;
			next = got < total ? src.read(start + got, Math.min(chunk, total - got)) : null;   // 次の束を先に頼む（読みと解きを重ねる）
			await writer.write(buf);
			at = got; onProgress?.(at, total);
			if (stop) throw new Error(stop);
		}
		await writer.close();
		await peek;
		if (stop) throw new Error(stop);
		return { blob: await blobP, name: entry.name };
	} catch (e) {
		writer.abort(e).catch(() => {}); blobP.catch(() => {});
		throw e;
	}
}
