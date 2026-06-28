/**
 * HTTP Range リクエストで ZIP のセントラルディレクトリを読み取り、
 * 対応フォーマット（geojson, shp, tif）のファイル一覧を返す。
 */

const EOCD_SIG   = 0x06054b50;
const CD_SIG     = 0x02014b50;
const EOCD_SIZE  = 22;
// ZIP comment 最大 65535 バイト
const TAIL_SIZE  = 65535 + EOCD_SIZE;

async function fetchRange(url, start, end) {
	const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
	if (res.status !== 206 && !res.ok) throw new Error(`HTTP ${res.status}`);
	return Buffer.from(await res.arrayBuffer());
}

async function getFileSize(url) {
	const res = await fetch(url, { method: 'HEAD' });
	if (!res.ok) throw new Error(`HEAD ${res.status}`);
	const cl = res.headers.get('content-length');
	if (!cl) throw new Error('Content-Length なし');
	return parseInt(cl, 10);
}

/**
 * @returns {{ paths: string[], format: string }}
 *   format は 'geojson' | 'shp' | 'tif' | ''
 */
export async function listGeoFilesInZip(url) {
	const size     = await getFileSize(url);
	const tailSize = Math.min(TAIL_SIZE, size);
	const tail     = await fetchRange(url, size - tailSize, size - 1);

	// EOCD レコードをファイル末尾から探す
	let eocdOff = -1;
	for (let i = tail.length - EOCD_SIZE; i >= 0; i--) {
		if (tail.readUInt32LE(i) === EOCD_SIG) { eocdOff = i; break; }
	}
	if (eocdOff < 0) throw new Error('EOCD not found');

	const cdSize   = tail.readUInt32LE(eocdOff + 12);
	const cdOffset = tail.readUInt32LE(eocdOff + 16);

	const cd = await fetchRange(url, cdOffset, cdOffset + cdSize - 1);

	const paths = [];
	let format  = '';
	let pos     = 0;

	while (pos + 46 <= cd.length) {
		if (cd.readUInt32LE(pos) !== CD_SIG) break;
		const fnLen = cd.readUInt16LE(pos + 28);
		const exLen = cd.readUInt16LE(pos + 30);
		const cmLen = cd.readUInt16LE(pos + 32);
		const name  = cd.slice(pos + 46, pos + 46 + fnLen).toString('utf8');

		if (/\.geojson$/i.test(name)) {
			paths.push(name);
			format = 'geojson';
		} else if (/\.shp$/i.test(name)) {
			paths.push(name);
			if (format !== 'geojson') format = 'shp';
		} else if (/\.tiff?$/i.test(name)) {
			paths.push(name);
			if (!format) format = 'tif';
		}

		pos += 46 + fnLen + exLen + cmLen;
	}

	return { paths, format };
}
