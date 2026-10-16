// 3D LUT の読み込み（第 3 波 W1・2026-10-12）＝GL2（gl/depthout.js）と WebGPU（gpu/postfx.js）が同じ形で受ける。worker の中（fetch・createImageBitmap・OffscreenCanvas）で動く。
// 受ける形：
//   ① .cube（Adobe/Resolve の文章）＝"LUT_3D_SIZE n" と n³ 行の "r g b"（0〜1・DOMAIN_MIN/MAX を見る）。並びは R が最速・B が最遅（規格どおり）
//   ② 画像（png/webp など）＝横に size 枚の板を並べた size²×size の帯。x＝B の板番号×size＋R・y＝G（上の行が G=0）。size は呼ぶ側の指定（既定 32）＝幅が size² でなければ幅から推定（幅＝h²）
// 戻り＝{ size, data: Uint8Array（RGBA8・幅 size²・高さ size・上の行から） }。シェーダは 2D の帯として読む（R・G は線形補間・B は隣の板との手計算の補間）
/** 3D LUT の帯（RGBA8・幅 size²・高さ size） */
export interface LUTStrip { size: number; data: Uint8Array }
const isCube = (url: string, text: string): boolean => /\.cube(\?|#|$)/i.test(url) || /^\s*(TITLE|LUT_3D_SIZE|DOMAIN_MIN)/m.test(text || "");
function parseCube(text: string): LUTStrip {
	let size = 0, lo = [0, 0, 0], hi = [1, 1, 1];
	const rows: number[][] = [];
	for (const raw of text.split(/\r?\n/)) {
		const s = raw.trim();
		if (!s || s[0] === "#") continue;
		if (/^TITLE/i.test(s)) continue;
		if (/^LUT_1D_SIZE/i.test(s)) throw new Error("lut: 1D .cube is not supported");
		if (/^LUT_3D_SIZE/i.test(s)) { size = +s.split(/\s+/)[1]; continue; }
		if (/^DOMAIN_MIN/i.test(s)) { lo = s.split(/\s+/).slice(1, 4).map(Number); continue; }
		if (/^DOMAIN_MAX/i.test(s)) { hi = s.split(/\s+/).slice(1, 4).map(Number); continue; }
		const v = s.split(/\s+/).map(Number);
		if (v.length >= 3 && v.every(Number.isFinite)) rows.push(v);
	}
	if (!(size >= 2) || rows.length < size * size * size) throw new Error(`lut: bad .cube (size ${size}, rows ${rows.length})`);
	const data = new Uint8Array(size * size * size * 4);
	for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
		const v = rows[r + g * size + b * size * size], o = ((g * size * size) + b * size + r) * 4;   // 帯の (x=b*size+r, y=g)
		for (let k = 0; k < 3; k++) { const d = hi[k] - lo[k] || 1; data[o + k] = Math.max(0, Math.min(255, Math.round((v[k] - lo[k]) / d * 255))); }
		data[o + 3] = 255;
	}
	return { size, data };
}
function imageToStrip(bitmap: ImageBitmap, sizeHint: number): LUTStrip {
	const w = bitmap.width, h = bitmap.height;
	const size = w === h * h ? h : (sizeHint && w === sizeHint * sizeHint && h === sizeHint ? sizeHint : 0);
	if (!size) throw new Error(`lut: image must be size²×size (got ${w}×${h})`);
	const cv = new OffscreenCanvas(w, h), cx = cv.getContext("2d", { willReadFrequently: true })!;
	cx.drawImage(bitmap, 0, 0);
	const img = cx.getImageData(0, 0, w, h);
	return { size, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
}
// url → { size, data }。data: URL も可（検定用）。失敗は reject
export async function loadLUT(url: string, sizeHint = 32): Promise<LUTStrip> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`lut: ${res.status} ${url}`);
	const ct = res.headers.get("content-type") || "";
	if (isCube(url, "") || /^text\//.test(ct) && !/image/.test(ct)) {
		const text = await res.text();
		if (isCube(url, text)) return parseCube(text);
		throw new Error("lut: text that is not a .cube");
	}
	const blob = await res.blob();
	if (/^text\//.test(blob.type)) return parseCube(await blob.text());
	const bm = await createImageBitmap(blob, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
	try { return imageToStrip(bm, sizeHint); } finally { bm.close(); }
}
