// glb の中の画像を Unity（glTFast）が読める形式へ焼き直す（docs/notes/unity-roundtrip.md §3.2）。
//   なぜ：PLATEAU のテクスチャ付き 3D Tiles は webp（EXT_texture_webp・または素の source に image/webp）。glTFast は webp を解かない＝
//   建物が白くなる。jpeg（既定）か png に変えて mimeType を書き換え、EXT_texture_webp を外す。
//   変換器は注入口（convert）。省略時は手元にある物を順に探す：sharp（npm）→ sips（macOS 標準）→ dwebp（libwebp）→ ffmpeg → magick。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseGlb, buildGlb } from "glbconv";

/** Unity（glTFast）が素で読む画像の形式 */
export const UNITY_IMAGE_MIMES = ["image/jpeg", "image/png"];
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

const has = cmd => spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
/** 一時ファイルを挟んで外部コマンドで変換する（args＝(入力, 出力) → 引数列） */
const viaCommand = (name, cmd, args) => ({
	name,
	convert(bytes, from, to, { quality = 85, maxSize = 0 } = {}) {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ortho-export-img-"));
		try {
			const i = path.join(dir, `in.${EXT[from] || "bin"}`), o = path.join(dir, `out.${EXT[to]}`);
			fs.writeFileSync(i, bytes);
			const r = spawnSync(cmd, args(i, o, to, quality, maxSize, bytes), { stdio: ["ignore", "ignore", "pipe"] });
			if (r.status !== 0 || !fs.existsSync(o)) throw new Error(`${name} failed: ${String(r.stderr || "").trim().slice(0, 200) || `exit ${r.status}`}`);
			return new Uint8Array(fs.readFileSync(o));
		} finally { fs.rmSync(dir, { recursive: true, force: true }); }
	},
});

/**
 * 手元で使える画像変換器を探す。戻り＝{ name, convert(bytes, fromMime, toMime, { quality }) → Uint8Array|Promise } か null。
 * @param {string} [prefer]  "sharp"|"sips"|"dwebp"|"ffmpeg"|"magick"（その 1 つだけを試す）
 */
export async function findImageConverter(prefer = null) {
	const tries = {
		sharp: async () => {
			const sharp = (await import("sharp")).default;
			return { name: "sharp", convert: async (bytes, from, to, { quality = 85, maxSize = 0 } = {}) => {
				let s = sharp(bytes);
				if (maxSize) s = s.resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true });
				return new Uint8Array(await (to === "image/png" ? s.png() : s.jpeg({ quality, mozjpeg: true })).toBuffer());
			} };
		},
		sips: async () => process.platform === "darwin" && has("sips")
			? viaCommand("sips", "sips", (i, o, to, q, max) => ["-s", "format", to === "image/png" ? "png" : "jpeg", ...(to === "image/png" ? [] : ["-s", "formatOptions", String(q)]), ...(max ? ["-Z", String(max)] : []), i, "--out", o]) : null,
		// dwebp は png しか出さない（jpeg が欲しくても png で返す＝呼び手は戻りの mime を使う）
		dwebp: async () => has("dwebp") ? { ...viaCommand("dwebp", "dwebp", (i, o, to, q, max, bytes) => {
			const d = max && imageSize(bytes), k = d ? Math.min(1, max / Math.max(d.w, d.h)) : 1;
			return [i, ...(k < 1 ? ["-resize", String(Math.round(d.w * k)), String(Math.round(d.h * k))] : []), "-o", o];
		}), only: "image/png" } : null,
		ffmpeg: async () => has("ffmpeg")
			? viaCommand("ffmpeg", "ffmpeg", (i, o, to, q, max) => ["-y", "-loglevel", "error", "-i", i,
				...(max ? ["-vf", `scale='min(iw,${max})':'min(ih,${max})':force_original_aspect_ratio=decrease`] : []),
				...(to === "image/png" ? [] : ["-q:v", String(Math.max(2, Math.round((100 - q) / 8)))]), "-frames:v", "1", o]) : null,
		magick: async () => {
			const cmd = has("magick") ? "magick" : has("convert") && process.platform !== "win32" ? "convert" : null;
			return cmd ? viaCommand("magick", cmd, (i, o, to, q, max) => [i, ...(max ? ["-resize", `${max}x${max}>`] : []), "-quality", String(q), o]) : null;
		},
	};
	for (const k of prefer ? [prefer] : Object.keys(tries)) {
		const f = tries[k];
		if (!f) throw new Error(`unknown image converter: ${k} (${Object.keys(tries).join("|")})`);
		try { const c = await f(); if (c) return c; } catch { /* 無い＝次へ */ }
	}
	return null;
}

/** glb の画像のうち keep に無い形式の数（0＝変換は要らない） */
export function foreignImages(glb, keep = UNITY_IMAGE_MIMES) {
	const { json } = parseGlb(glb);
	return (json.images || []).filter(im => im.bufferView != null && !keep.includes(im.mimeType || "image/png")).length;
}

/**
 * glb の画像のうち Unity が読めない物（webp など）を jpeg/png へ焼き直す。中身の他は触らない（bufferView の並びを詰め直すだけ）。
 * @param {Uint8Array} glb
 * @param {object} o
 * @param {{name:string, convert:Function, only?:string}} o.converter  findImageConverter の戻り（か同じ形の注入）
 * @param {"image/jpeg"|"image/png"} [o.to]  既定 jpeg
 * @param {number} [o.quality]  jpeg の品質（既定 85）
 * @param {number} [o.maxSize]  長辺の上限（px・0＝そのまま）。PLATEAU の atlas は 4096×2048＝Unity では 1 枚 32 MB（非圧縮）
 * @returns {Promise<{ glb: Uint8Array, converted: number, failed: number, before: number, after: number }>}
 */
export async function transcodeGlbImages(glb, { converter, to = "image/jpeg", quality = 85, maxSize = 0, keep = UNITY_IMAGE_MIMES, log = () => {} } = {}) {
	const { json: j, bin } = parseGlb(glb);
	const targets = (j.images || []).map((im, i) => ({ im, i })).filter(({ im }) => im.bufferView != null && !keep.includes(im.mimeType || "image/png"));
	const none = { glb, converted: 0, failed: 0, before: 0, after: 0 };
	if (!targets.length) { stripWebpExt(j); return j.__changed ? { ...none, glb: buildGlb(cleanJson(j), bin) } : none; }
	if (!converter) throw new Error(`${targets.length} image(s) are ${[...new Set(targets.map(t => t.im.mimeType))].join("/")}; Unity cannot read them. Install one of: sharp (npm i sharp), dwebp (libwebp), ffmpeg, ImageMagick — macOS has sips built in`);
	const repl = new Map();   // bufferView → 新しいバイト列
	let failed = 0, before = 0, after = 0;
	for (const { im, i } of targets) {
		const bv = j.bufferViews[im.bufferView], off = bv.byteOffset || 0, src = bin.subarray(off, off + bv.byteLength);
		const want = converter.only || to;
		try {
			const out = await converter.convert(src, im.mimeType, want, { quality, maxSize });
			if (!out?.length) throw new Error("empty output");
			repl.set(im.bufferView, out);
			im.mimeType = want;
			before += src.length; after += out.length;
		} catch (e) { failed++; log(`image ${i}: ${e?.message ?? e}`); }
	}
	stripWebpExt(j);
	if (!repl.size) return { glb: j.__changed ? buildGlb(cleanJson(j), bin) : glb, converted: 0, failed, before, after };
	return { glb: repack(cleanJson(j), bin, repl), converted: repl.size, failed, before, after };
}

// EXT_texture_webp を外す（source が webp だった画像はもう jpeg/png＝素の source で辿る）。webp のまま残った画像がある時は拡張を残す
function stripWebpExt(j) {
	const stillWebp = (j.images || []).some(im => im.mimeType === "image/webp");
	if (stillWebp) return;
	for (const t of j.textures || []) {
		const e = t.extensions?.EXT_texture_webp;
		if (!e) continue;
		if (t.source == null && e.source != null) t.source = e.source;
		delete t.extensions.EXT_texture_webp;
		if (!Object.keys(t.extensions).length) delete t.extensions;
		j.__changed = true;
	}
	for (const k of ["extensionsUsed", "extensionsRequired"]) if (j[k]?.includes("EXT_texture_webp")) {
		j[k] = j[k].filter(e => e !== "EXT_texture_webp"); if (!j[k].length) delete j[k]; j.__changed = true;
	}
}
const cleanJson = j => { delete j.__changed; return j; };

// BIN を組み直す（差し替えた画像は長さが変わる＝全 bufferView の byteOffset を振り直す）
function repack(j, bin, repl) {
	const chunks = []; let len = 0;
	for (let i = 0; i < (j.bufferViews || []).length; i++) {
		const bv = j.bufferViews[i], pad = (4 - (len % 4)) % 4;
		if (pad) { chunks.push(new Uint8Array(pad)); len += pad; }
		const body = repl.get(i) ?? bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength);
		bv.byteOffset = len; bv.byteLength = body.length; bv.buffer = 0;
		chunks.push(body); len += body.length;
	}
	const out = new Uint8Array(len); { let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } }
	j.buffers = [{ byteLength: len }];
	return buildGlb(j, out);
}

/** 画像の幅と高さ（webp の VP8/VP8L/VP8X・png・jpeg）。分からない＝null */
export function imageSize(b) {
	const s = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
	if (b.length > 30 && s(0, 4) === "RIFF" && s(8, 4) === "WEBP") {
		const c = s(12, 4);
		if (c === "VP8X") return { w: 1 + (b[24] | b[25] << 8 | b[26] << 16), h: 1 + (b[27] | b[28] << 8 | b[29] << 16) };
		if (c === "VP8 ") return { w: (b[26] | b[27] << 8) & 0x3fff, h: (b[28] | b[29] << 8) & 0x3fff };
		if (c === "VP8L") { const v = b[21] | b[22] << 8 | b[23] << 16 | b[24] << 24; return { w: 1 + (v & 0x3fff), h: 1 + ((v >>> 14) & 0x3fff) }; }
		return null;
	}
	if (b.length > 24 && b[0] === 0x89 && s(1, 3) === "PNG") { const dv = new DataView(b.buffer, b.byteOffset); return { w: dv.getUint32(16), h: dv.getUint32(20) }; }
	if (b[0] === 0xff && b[1] === 0xd8) {
		for (let o = 2; o + 9 < b.length;) {
			if (b[o] !== 0xff) return null;
			const m = b[o + 1], L = b[o + 2] << 8 | b[o + 3];
			if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b[o + 5] << 8 | b[o + 6], w: b[o + 7] << 8 | b[o + 8] };
			o += 2 + L;
		}
	}
	return null;
}
