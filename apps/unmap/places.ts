// 回線なしの地名検索（M4）。端末に置いた地図（area-*.pmtiles・world.pmtiles）の places 層（Protomaps v4）から地名の索引を作り、端末の中だけで引く。
//   indexPlaces(src, zoom) … アーカイブのその zoom のタイルを全部読み、places 層の点を拾う（名前・6 言語の名・kind・人口の順位・経緯度）
//   searchPlaces(list, q)  … 前方一致を先に・含むを後に・人口の順位で並べる（大文字小文字・アクセントを無視）
// MVT は places 層の点だけを読む最小の読み手（依存なし・worker で動く）。DOM 不使用＝node で検定（tests/t-places.mjs）。
import { listEntries, readTileAt, decompressTile, tileZxy, zoomOfId } from "@ortho-earth/core/pmtiles-extract";
import type { ExtractSource } from "@ortho-earth/core/pmtiles-extract";

/** 索引の 1 件 */
export interface Place { name: string; names?: Record<string, string>; kind: string; rank: number; lon: number; lat: number }
/** 索引に入れる名前の鍵（UN の 6 公用語・style.ts の NAME_KEYS と同じ） */
const NAME_KEYS = ["name:en", "name:fr", "name:es", "name:ru", "name:zh-Hans", "name:zh", "name:ar"];
/** 索引を作るズーム：地図の上限と 12 の小さい方（v4 の places は z12 でほぼ出揃う・z14 まで全部読むと端末で重い） */
export const INDEX_ZOOM = 12;

// ── MVT（places 層の点だけ） ──
type Val = string | number | boolean;
/** MVT の 1 枚から、ある層の点（属性・タイル内の 0..1 の位置） */
export function mvtPoints(buf: Uint8Array, layerName: string): { props: Record<string, Val>; x: number; y: number }[] {
	let p = 0;
	const varint = (): number => { let n = 0, m = 1, c: number; do { c = buf[p++]; n += (c & 0x7f) * m; m *= 128; } while (c & 0x80); return n; };
	const out: { props: Record<string, Val>; x: number; y: number }[] = [];
	const end0 = buf.length;
	const skip = (wire: number) => { if (wire === 0) varint(); else if (wire === 1) p += 8; else if (wire === 2) p += varint(); else if (wire === 5) p += 4; else throw new Error(`mvt: wire type ${wire}`); };
	while (p < end0) {
		const tag = varint();
		if (tag >> 3 !== 3 || (tag & 7) !== 2) { skip(tag & 7); continue; }
		const len = varint(), lend = p + len;
		// 層：先に名前・鍵・値・extent を集め、地物は位置だけ覚えて後で読む
		let name = "", extent = 4096; const keys: string[] = [], vals: Val[] = [], feats: [number, number][] = [];
		while (p < lend) {
			const t = varint(), f = t >> 3, w = t & 7;
			if (f === 1 && w === 2) { const l = varint(); name = new TextDecoder().decode(buf.subarray(p, p + l)); p += l; }
			else if (f === 2 && w === 2) { const l = varint(); feats.push([p, p + l]); p += l; }
			else if (f === 3 && w === 2) { const l = varint(); keys.push(new TextDecoder().decode(buf.subarray(p, p + l))); p += l; }
			else if (f === 4 && w === 2) { const l = varint(), e = p + l; let v: Val = ""; while (p < e) { const vt = varint(), vf = vt >> 3; if (vf === 1) { const sl = varint(); v = new TextDecoder().decode(buf.subarray(p, p + sl)); p += sl; } else if (vf === 2) { v = new DataView(buf.buffer, buf.byteOffset + p, 4).getFloat32(0, true); p += 4; } else if (vf === 3) { v = new DataView(buf.buffer, buf.byteOffset + p, 8).getFloat64(0, true); p += 8; } else if (vf === 4 || vf === 5) v = varint(); else if (vf === 6) { const n = varint(); v = n % 2 ? -(n + 1) / 2 : n / 2; } else if (vf === 7) v = !!varint(); else skip(vt & 7); } vals.push(v); }
			else if (f === 5 && w === 0) extent = varint();
			else skip(w);
		}
		if (name === layerName) {
			const save = p;
			for (const [a, b] of feats) {
				p = a; const props: Record<string, Val> = {}; let type = 0, gx = NaN, gy = NaN;
				while (p < b) {
					const t = varint(), f = t >> 3, w = t & 7;
					if (f === 2 && w === 2) { const l = varint(), e = p + l; while (p < e) { const k = varint(), v = varint(); if (keys[k] != null && vals[v] != null) props[keys[k]] = vals[v]; } }
					else if (f === 3 && w === 0) type = varint();
					else if (f === 4 && w === 2) { const l = varint(), e = p + l; const cmd = varint(); if ((cmd & 7) === 1 && (cmd >> 3) >= 1) { const zz = (n: number) => (n >> 1) ^ -(n & 1); gx = zz(varint()); gy = zz(varint()); } p = e; }
					else skip(w);
				}
				if (type === 1 && Number.isFinite(gx)) out.push({ props, x: gx / extent, y: gy / extent });
			}
			p = save;
		}
		p = lend;
	}
	return out;
}

const lonOf = (x: number, z: number) => x / 2 ** z * 360 - 180;
const latOf = (y: number, z: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI;

/** アーカイブの zoom（無ければその下で一番細かいズーム）のタイルの places 層から索引を作る */
export async function indexPlaces(src: ExtractSource, zoom = INDEX_ZOOM, { signal, onProgress }: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<Place[]> {
	const all = await listEntries(src, signal);
	const zs = new Set(all.map(e => zoomOfId(e.tileId)));
	let z = Math.min(zoom, src.header.maxZoom); while (z > 0 && !zs.has(z)) z--;
	const ents = all.filter(e => zoomOfId(e.tileId) === z);
	const seen = new Set<string>(), out: Place[] = [], blobs = new Map<number, { props: Record<string, Val>; x: number; y: number }[]>();
	let done = 0;
	for (const e of ents) {
		signal?.throwIfAborted();
		let pts = blobs.get(e.offset);   // 同じ中身（海など）は一度だけ解く
		if (!pts) { pts = mvtPoints(await decompressTile(await readTileAt(src, e, signal), src.header.tileCompression), "places"); blobs.set(e.offset, pts); }
		for (let i = 0; i < e.runLength; i++) {
			const [, tx, ty] = tileZxy(e.tileId + i);
			for (const pt of pts) {
				const name = String(pt.props.name ?? "").trim(); if (!name) continue;
				const lon = lonOf(tx + pt.x, z), lat = latOf(ty + pt.y, z);
				const key = `${name}|${lon.toFixed(2)}|${lat.toFixed(2)}`; if (seen.has(key)) continue; seen.add(key);   // 隣のタイルの余白に重なって出る同じ地名
				const names: Record<string, string> = {}; for (const k of NAME_KEYS) { const v = pt.props[k]; if (typeof v === "string" && v && v !== name) names[k.slice(5)] = v; }
				out.push({ name, ...(Object.keys(names).length ? { names } : {}), kind: String(pt.props.kind ?? ""), rank: +(pt.props.population_rank ?? 0) || 0, lon: +lon.toFixed(5), lat: +lat.toFixed(5) });
			}
		}
		if (++done % 32 === 0) onProgress?.(done, ents.length);
	}
	onProgress?.(ents.length, ents.length);
	return out;
}

/** 比べるための形（小文字・アクセントを落とす） */
export const fold = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
const KIND_W: Record<string, number> = { country: 30, region: 20, locality: 10 };
/** 引く：前方一致 → 語頭一致 → 含む。同じ段の中は国 > 地域 > 都市、人口の順位の大きい順。lang＝見せる名前の言語（無ければ現地語） */
export function searchPlaces(list: Place[], q: string, { limit = 20, lang = "local" }: { limit?: number; lang?: string } = {}): (Place & { label: string })[] {
	const f = fold(q.trim()); if (!f) return [];
	const scored: [number, Place][] = [];
	for (const p of list) {
		const cand = [p.name, ...Object.values(p.names || {})].map(fold);
		let s = -1;
		for (const c of cand) { const v = c.startsWith(f) ? 3 : c.includes(" " + f) || c.includes("-" + f) ? 2 : c.includes(f) ? 1 : 0; if (v > s) s = v; }
		if (s > 0) scored.push([s * 1000 + (KIND_W[p.kind] ?? 0) + p.rank, p]);
	}
	scored.sort((a, b) => b[0] - a[0]);
	// 同じ名前・ほぼ同じ場所（地図と世界の土台の両方に在る）は 1 件に
	const seen = new Set<string>(), out: (Place & { label: string })[] = [];
	const key = lang === "zh" ? "zh-Hans" : lang;
	for (const [, p] of scored) {
		const k = `${p.name}|${Math.round(p.lon * 2)}|${Math.round(p.lat * 2)}`; if (seen.has(k)) continue; seen.add(k);
		out.push({ ...p, label: (lang !== "local" && (p.names?.[key] || (lang === "zh" ? p.names?.zh : undefined))) || p.name });
		if (out.length >= limit) break;
	}
	return out;
}
/** 種類から寄るズーム */
export const zoomForKind = (kind: string): number => kind === "country" ? 5 : kind === "region" ? 7 : kind === "locality" ? 11 : 14;
