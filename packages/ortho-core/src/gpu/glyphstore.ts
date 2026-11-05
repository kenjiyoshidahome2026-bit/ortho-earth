// 焼いた字（SDF）の保存＝IndexedDB（GIS/glyph）。字は 1 度焼けば版に貼るだけだが、起動のたびにゼロから焼き直していた
//（Galaxy/Mali-G615 の実測 2026-11-05＝関東の画面の数百の漢字で最初のフレームが 1.4 秒）。焼いた字（1 字 ≈ 2 KB）を
// 塊（≤ CHUNK 字）で保存し、次の起動は読むだけ＝焼かない。
// - 鍵＝基準の書体 + "\u0001" + 字（gpu/text.ts の glyphs と同じ）。版の中の位置は保存しない（起動ごとに棚へ置き直す）。
// - 版＝ver（SDF の定数 + UA）。違えば全部捨てる（OS の書体の更新＝UA が変わる、が主）。
// - 実行中に載せた Web フォント（addFontFace）の家族は保存しない・読んだ分も捨てる（同じ家族名で別のファイル＝形が違う）。
// - 塊は追記（起動ごとに新しい塊）。塊が COMPACT を超えたら読み込み時に詰め直す。字が MAX を超えたら新しく保存しない。
// 純関数（pack/unpack）は node で検定（tests/glyphstore.mjs）。IDB の口は native-bucket の Cache（d(key)／d(key,val)／d(key,null)＝消す）。
import type { CacheFn } from "native-bucket";
import { SDF_BASE, SDF_PAD, SDF_R, SDF_CUTOFF } from "../sdf.ts";

export interface GlyphRec { w: number; h: number; ox: number; oy: number; sdf: Uint8Array }
export interface GlyphChunk { keys: string[]; meta: Int32Array; sdf: Uint8Array }
export interface GlyphStore {
	/** 保存してあった字（無ければ undefined）＝焼かずに版へ写す */
	get(key: string): GlyphRec | undefined;
	/** 焼いた字を覚える（保存は後でまとめて） */
	put(key: string, rec: GlyphRec): void;
	/** 実行中に載せた Web フォントの家族＝保存しない・読んだ分も捨てる */
	excludeFamily(family: string): void;
	/** 読み込みが済んだ（失敗しても resolve＝保存なしで続く） */
	readonly ready: Promise<void>;
	/** 覚えている分を今すぐ書く（検定・終了時） */
	flush(): Promise<void>;
	stats(): { loaded: number; saved: number; pending: number; chunks: number };
}

export const CHUNK = 1024;     // 1 塊の字数
export const COMPACT = 24;     // 塊がこれを超えたら読み込み時に詰め直す
export const MAX = 12000;      // 覚える上限（超えた分は保存しない）
/** 版の素＝SDF の定数（変われば保存した字は全部捨てる）。呼び手は UA を足す */
export const SDF_VER = `${SDF_BASE}/${SDF_PAD}/${SDF_R}/${SDF_CUTOFF}`;

export function packChunk(entries: Iterable<[string, GlyphRec]>): GlyphChunk {
	const keys: string[] = [], metas: number[] = [], parts: Uint8Array[] = [];
	let total = 0;
	for (const [k, r] of entries) { keys.push(k); metas.push(r.w, r.h, r.ox, r.oy); parts.push(r.sdf); total += r.sdf.length; }
	const sdf = new Uint8Array(total); let o = 0;
	for (const p of parts) { sdf.set(p, o); o += p.length; }
	return { keys, meta: Int32Array.from(metas), sdf };
}
export function unpackChunk(c: GlyphChunk, into: Map<string, GlyphRec>, skip?: (key: string) => boolean): number {
	let o = 0, n = 0;
	for (let i = 0; i < c.keys.length; i++) {
		const w = c.meta[i * 4], h = c.meta[i * 4 + 1], ox = c.meta[i * 4 + 2], oy = c.meta[i * 4 + 3], len = w * h;
		if (o + len > c.sdf.length) break;   // 壊れた塊＝ここまで
		const k = c.keys[i];
		if (!(skip && skip(k)) && !into.has(k)) { into.set(k, { w, h, ox, oy, sdf: c.sdf.subarray(o, o + len) }); n++; }
		o += len;
	}
	return n;
}

export function createGlyphStore(open: () => Promise<CacheFn>, ver: string, { flushMs = 3000, log = (s: string) => console.log(s) }: { flushMs?: number; log?: (s: string) => void } = {}): GlyphStore {
	const mem = new Map<string, GlyphRec>(), fresh = new Map<string, GlyphRec>(), excluded: string[] = [];
	let cache: CacheFn | null = null, chunks = 0, loaded = 0, saved = 0, timer: ReturnType<typeof setTimeout> | null = null, rewrite = false, writing: Promise<void> | null = null;
	const famOf = (key: string) => key.slice(0, key.indexOf("\u0001")).toLowerCase();
	const isExcluded = (key: string) => { if (!excluded.length) return false; const f = famOf(key); return excluded.some(x => f.includes(x)); };
	const del = async (k: string) => { try { await cache!(k, null); } catch { /* 無い・消せない＝放置 */ } };
	const writeAll = async () => {   // 詰め直し＝覚えている全部を CHUNK ずつ書き、余った塊を消す
		const all = [...mem.entries()].filter(([k]) => !isExcluded(k));
		let i = 0;
		for (; i * CHUNK < all.length; i++) await cache!("c" + i, packChunk(all.slice(i * CHUNK, (i + 1) * CHUNK)));
		for (let j = i; j < chunks; j++) await del("c" + j);
		chunks = i; await cache!("idx", { ver, chunks });
	};
	const ready = (async () => {
		const t0 = performance.now();
		try {
			cache = await open();
			const idx = await cache("idx") as { ver?: string; chunks?: number } | undefined;
			if (!idx || idx.ver !== ver) {   // 版が違う（初回・UA や SDF の定数の変更）＝全部捨てる
				for (const k of await cache()) if (typeof k === "string" && (k === "idx" || /^c\d+$/.test(k))) await del(k);
				chunks = 0; await cache("idx", { ver, chunks });
				log(`[text] glyph store: ${idx ? "version changed = cleared" : "empty"} in ${(performance.now() - t0) | 0} ms`);
				return;
			}
			chunks = idx.chunks || 0;
			for (let i = 0; i < chunks; i++) { const c = await cache("c" + i) as GlyphChunk | undefined; if (c && c.keys && c.meta && c.sdf) loaded += unpackChunk(c, mem, isExcluded); }
			log(`[text] glyph store: ${loaded} glyphs in ${chunks} chunks loaded in ${(performance.now() - t0) | 0} ms`);
			if (chunks > COMPACT) { await writeAll(); log(`[text] glyph store: compacted to ${chunks} chunks`); }
		} catch (e) { cache = null; log(`[text] glyph store unavailable (${(e as Error)?.message ?? e}) = baking as before`); }
	})();
	const flush = async () => {
		if (timer) { clearTimeout(timer); timer = null; }
		if (writing) await writing;
		if (!cache) { fresh.clear(); return; }
		writing = (async () => {
			try {
				if (rewrite) { rewrite = false; fresh.clear(); await writeAll(); return; }
				while (fresh.size) {
					const take = [...fresh.entries()].slice(0, CHUNK);
					for (const [k] of take) fresh.delete(k);
					await cache!("c" + chunks, packChunk(take)); chunks++; saved += take.length;
					await cache!("idx", { ver, chunks });
				}
			} catch (e) { log(`[text] glyph store: write failed (${(e as Error)?.message ?? e})`); fresh.clear(); cache = null; }
		})();
		await writing; writing = null;
	};
	const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, flushMs); };
	return {
		get: k => mem.get(k),
		put(k, r) {
			if (mem.has(k) || isExcluded(k)) return;
			mem.set(k, r);
			if (mem.size > MAX) return;   // 上限＝覚えるだけ（保存しない）
			fresh.set(k, r); schedule();
		},
		excludeFamily(family) {
			const f = family.toLowerCase(); if (excluded.includes(f)) return;
			excluded.push(f);
			let n = 0; for (const k of [...mem.keys()]) if (isExcluded(k)) { mem.delete(k); fresh.delete(k); n++; }
			if (n) { rewrite = true; schedule(); }   // 読んであった分＝保存からも消す（詰め直し）
		},
		ready, flush,
		stats: () => ({ loaded, saved, pending: fresh.size, chunks }),
	};
}
