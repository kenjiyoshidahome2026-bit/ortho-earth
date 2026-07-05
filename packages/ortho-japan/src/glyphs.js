// SDFグリフ・パイプライン：地理院 optimal_bvmap のグリフPBF（MapLibre標準SDF）を取得・デコードし、
// CPU上のアトラス画像（Uint8Array, ALPHA8相当）にシェルフ梱包する。GLアップロードは呼び出し側（text renderer）。
// glyphs.proto: glyphs{ stacks:fontstack[1] }, fontstack{ name[1], range[2], glyphs:glyph[3] },
//   glyph{ id[1] uint32, bitmap[2] bytes(SDF, (w+2*buf)×(h+2*buf), buf=3), width[3], height[4], left[5] sint, top[6] sint, advance[7] }
import Pbf from "pbf";

export const SDF_BUFFER = 3;   // グリフSDFの周囲バッファ（px）
const GLYPH_URL = (base, font, range) => `${base}/${encodeURIComponent(font)}/${range}.pbf`;

export function decodeGlyphPBF(buf) {
	const pbf = new Pbf(buf);
	const glyphs = [];
	pbf.readFields((tag, _, p) => {
		if (tag === 1) p.readMessage((t2, __, p2) => {
			if (t2 === 3) glyphs.push(readGlyph(p2));
		}, {});
	}, {});
	return glyphs;
}

function readGlyph(p) {
	const g = { id: 0, bitmap: null, w: 0, h: 0, left: 0, top: 0, advance: 0 };
	p.readMessage((tag, _, pp) => {
		if (tag === 1) g.id = pp.readVarint();
		else if (tag === 2) g.bitmap = pp.readBytes();
		else if (tag === 3) g.w = pp.readVarint();
		else if (tag === 4) g.h = pp.readVarint();
		else if (tag === 5) g.left = pp.readSVarint();
		else if (tag === 6) g.top = pp.readSVarint();
		else if (tag === 7) g.advance = pp.readVarint();
	}, {});
	return g;
}

export function rangeOf(cp) { const b = Math.floor(cp / 256) * 256; return `${b}-${b + 255}`; }

// CPUグリフアトラス（シェルフ梱包）。version が上がったら GL テクスチャを貼り直す。
export class GlyphAtlas {
	constructor(base, { size = 1024 } = {}) {
		this.base = base;                 // 例: https://gsi-cyberjapan.github.io/optimal_bvmap/glyphs
		this.size = size;
		this.data = new Uint8Array(size * size);   // ALPHA8
		this.glyphs = new Map();          // key "font cp" → { advance,w,h,left,top,u0,v0,u1,v1 } (u,v は px)
		this.version = 0;                 // テクスチャ再アップロード判定
		this._shelfX = 0; this._shelfY = 0; this._shelfH = 0;
		this._rangeCache = new Map();     // "font range" → Map(id→glyph)（取得済みレンジのデコード結果）
		this._inflight = new Map();
	}

	key(font, cp) { return font + " " + cp; }
	get(font, cp) { return this.glyphs.get(this.key(font, cp)); }

	// 必要な codepoint 群を（未梱包のみ）アトラスへ。レンジ取得はキャッシュし、梱包は必要字のみ。
	async load(font, codepoints) {
		const needByRange = new Map();
		for (const cp of codepoints) {
			if (this.glyphs.has(this.key(font, cp))) continue;
			const r = rangeOf(cp);
			if (!needByRange.has(r)) needByRange.set(r, []);
			needByRange.get(r).push(cp);
		}
		let changed = false;
		await Promise.all([...needByRange].map(async ([r, cps]) => {
			const rk = font + " " + r;
			if (!this._rangeCache.has(rk)) {
				if (!this._inflight.has(rk)) this._inflight.set(rk, this._fetchRange(font, r));
				this._rangeCache.set(rk, await this._inflight.get(rk));
				this._inflight.delete(rk);
			}
			const gm = this._rangeCache.get(rk);
			for (const cp of cps) {
				const g = gm.get(cp);
				if (g) { if (this._pack(font, g)) changed = true; }
				else this.glyphs.set(this.key(font, cp), { advance: 0, w: 0, h: 0, left: 0, top: 0, u0: 0, v0: 0, u1: 0, v1: 0 });
			}
		}));
		if (changed) this.version++;
		return changed;
	}

	async _fetchRange(font, range) {
		const res = await fetch(GLYPH_URL(this.base, font, range));
		const m = new Map();
		if (!res.ok) return m;
		for (const g of decodeGlyphPBF(new Uint8Array(await res.arrayBuffer()))) m.set(g.id, g);
		return m;
	}

	_pack(font, g) {
		const key = this.key(font, g.id);
		if (this.glyphs.has(key)) return false;
		const bw = g.w + 2 * SDF_BUFFER, bh = g.h + 2 * SDF_BUFFER;   // ビットマップ実寸
		if (!g.bitmap || g.bitmap.length === 0 || g.w === 0) {         // 字形なし（空白等）
			this.glyphs.set(key, { advance: g.advance, w: 0, h: 0, left: g.left, top: g.top, u0: 0, v0: 0, u1: 0, v1: 0 });
			return true;
		}
		const pad = 1;
		if (this._shelfX + bw + pad > this.size) { this._shelfX = 0; this._shelfY += this._shelfH + pad; this._shelfH = 0; }
		if (this._shelfY + bh + pad > this.size) { console.warn("GlyphAtlas full"); return false; }
		const ox = this._shelfX, oy = this._shelfY;
		for (let row = 0; row < bh; row++) this.data.set(g.bitmap.subarray(row * bw, row * bw + bw), (oy + row) * this.size + ox);
		this._shelfX += bw + pad; this._shelfH = Math.max(this._shelfH, bh);
		this.glyphs.set(key, { advance: g.advance, w: bw, h: bh, left: g.left, top: g.top, u0: ox, v0: oy, u1: ox + bw, v1: oy + bh });
		return true;
	}
}
