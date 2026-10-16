// 世界の地名検索（#175・maplibre-gl-geocoder 相当の既定の問い合わせ先）＝国・州・都市・地形を 26 言語で引く。サーバーを使わない。
// 索引＝GitHub Pages の ortho-data/globe/search/（packages/world/build/search.js が焼く・置く＝publish-pages.mjs。2026-10-13 まで bucket GIS/world/search/ を指していたが置かれていなかった）：base.json（英語名・座標・範囲・別名）＋ <lang>.json（その言語の名前）。
// 初めて問い合わせた時に base と今の言語の 1 本だけを読む＝起動の重さは 0（検索窓の搭載も索引を読まない）。
// 照合＝正規化した名前の 完全一致 → 前方一致（名前の頭か語の頭）→ 部分一致。同じ段は重み（国 ＞ 大都市 ＞ 州 ＞ 小都市）で並べる。
// 英語名と今の言語の名前・別名（ISO コード・略称・現地名・読み）を同時に引く＝「Paris」「パリ」「巴黎」が同じ所へ飛ぶ（巴黎は zh の窓で）。
// 返りは検索窓の供給元の形（search.js）＝{ title, note, lon, lat, bbox?, zoom?, tilt?, kind, id }。国と州は bbox＝範囲に寄る。
import { WORLD_DATA, fetchJsonMaybeGz } from "@ortho-earth/core/worldcontent";
import { getLang } from "./i18n.ts";
import type { SearchHit } from "../globe.d.ts";

/** 索引の base.json（build/search.js が焼く形・v＝FORMAT）。座標は 0.01° の差分の整数列 */
interface WorldIndexBase {
	v: number; n: number; lon: number[]; lat: number[]; en: string[];
	/** 別名 [添字, 名前…] */ alt?: Array<[number, ...string[]]>;
	kinds: string[]; kindNames?: string[]; kind: number[]; nation: number[]; parent: number[];
	/** 着地（数＝zoom・[zoom, tilt]・[w, s, e, n]） */ view: unknown[];
	/** 重み（大きいほど先） */ imp: number[];
	qid?: Array<number | string | null>;
}
/** 言語ごとの表 <lang>.json */
interface WorldIndexTable { names: Array<string | null>; alt?: Array<[number, ...string[]]>; kindNames?: string[] }
/** 読んだ索引（照合の鍵つき） */
interface WorldIndex { n: number; base: WorldIndexBase; lon: Float64Array; lat: Float64Array; names: string[]; keys: Array<[key: string, compact: string, i: number]>; kindNames: string[] }
/** 世界の既定の問い合わせ先（検索窓の供給元の形） */
export interface WorldSearchProvider { histKey: string; query(q: string, signal?: AbortSignal): Promise<SearchHit[]> }

const WORLD_SEARCH_URL = WORLD_DATA + "search/";
const FORMAT = 1;   // 索引の形の版（build/search.js の SEARCH_VERSION と対）

// ── 正規化（照合の両側に掛ける）──
// NFKD＋アクセントを落として NFC に戻す（é→e・ü→u・全角→半角）・小文字・ひらがな→カタカナ・ß→ss・記号→空白・略語を寄せる（saint→st・mount→mt）。
// 落とすのはラテン/ギリシャ/キリルのアクセント・アラビア文字の母音記号・ヘブライ文字の点だけ＝かなの濁点（ぱ≠は）・ハングル・インド系の母音記号は残す
const ABBR: Record<string, string> = { saint: "st", sainte: "ste", mount: "mt", mountain: "mt", fort: "ft" };
export function normalizeName(s: unknown): string {
	const t = String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f\u064b-\u065f\u0670\u0591-\u05c7]/g, "").normalize("NFC").toLowerCase()
		.replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60))
		.replace(/\u00df/g, "ss").replace(/[\u02bc\u2019'`\u00b4]/g, "")
		.replace(/[\s.,;:!?()[\]{}"\u201c\u201d\u00ab\u00bb<>/\\|_\-\u2010-\u2015\u30fb\u00b7\u2022\u3001\u3002\uff0c\uff0e\uff08\uff09\u300c\u300d\u300e\u300f]+/g, " ").trim();
	return t ? t.split(" ").map(w => ABBR[w] ?? w).join(" ") : "";
}
const compact = (s: string): string => s.replace(/ /g, "");
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

// ── 索引の読み（base＋言語の表）＝検定からも呼ぶ ──
function decodeIndex(base: WorldIndexBase | null | undefined, table: WorldIndexTable | null = null): WorldIndex {
	if (!base || base.v !== FORMAT) throw new Error(`world search index: format v${base?.v} (expected v${FORMAT})`);
	const n = base.n, lon = new Float64Array(n), lat = new Float64Array(n);
	let x = 0, y = 0;
	for (let i = 0; i < n; i++) { x += base.lon[i]; y += base.lat[i]; lon[i] = x / 100; lat[i] = y / 100; }
	const names = base.en.map((e, i) => (table?.names?.[i]) || e);
	// 照合の鍵：[正規化, 詰めた形, 添字]（英語名・英語の別名・今の言語の名前・その別名）
	const keys: WorldIndex["keys"] = [];
	const add = (s: string, i: number): void => { const k = normalizeName(s); if (k) keys.push([k, compact(k), i]); };
	base.en.forEach((s, i) => add(s, i));
	for (const [i, ...v] of base.alt || []) for (const s of v) add(s, i);
	if (table) {
		table.names.forEach((s, i) => { if (s) add(s, i); });
		for (const [i, ...v] of table.alt || []) for (const s of v) add(s, i);
	}
	const kindNames = base.kinds.map((_, k) => table?.kindNames?.[k] || base.kindNames?.[k] || "");
	return { n, base, lon, lat, names, keys, kindNames };
}

// 着地：数＝zoom・[zoom, tilt]・[w, s, e, n]（代表点からの 0.01° の整数）→ bbox（±180 に畳む・w>e＝日付変更線を跨ぐ）
const wrap = (x: number): number => ((x + 540) % 360 + 360) % 360 - 180;
function viewOf(v: unknown, lon: number, lat: number): { zoom?: number; tilt?: number; bbox?: [number, number, number, number] } {
	if (typeof v === "number") return { zoom: v };
	if (Array.isArray(v) && v.length === 2) return { zoom: v[0], tilt: v[1] };
	if (Array.isArray(v) && v.length === 4) {
		const w = lon + v[0] / 100, e = lon + v[2] / 100;
		return { bbox: e - w >= 360 ? [-180, lat + v[1] / 100, 180, lat + v[3] / 100] : [wrap(w), lat + v[1] / 100, wrap(e), lat + v[3] / 100] };
	}
	return {};
}

/** 照合：q→[{ i, tier }]（tier 0＝完全一致・1＝前方一致（名前の頭か語の頭＝「Fuji」→ Fujian と Mount Fuji を重みで）・2＝部分）を重みで並べて上位 limit 件 */
function searchIndex(idx: WorldIndex, q: string, limit = 8): Array<{ i: number; tier: number }> {
	const nq = normalizeName(q), cq = compact(nq);
	if (!cq) return [];
	const sub = cq.length >= 2 || CJK.test(cq);   // 1 文字の部分一致は拾わない（ラテン文字 1 字で全件になる）
	const best = new Map<number, number>();
	for (const [k, c, i] of idx.keys) {
		const tier = c === cq ? 0 : c.startsWith(cq) || (" " + k).includes(" " + nq) ? 1 : sub && c.includes(cq) ? 2 : -1;
		if (tier < 0) continue;
		const b = best.get(i);
		if (b === undefined || tier < b) best.set(i, tier);
	}
	const imp = idx.base.imp;
	return [...best].sort((a, b) => a[1] - b[1] || imp[b[0]] - imp[a[0]] || a[0] - b[0]).slice(0, limit).map(([i, tier]) => ({ i, tier }));
}

/** 添字 → 検索窓の候補（title・note は今の言語） */
function hitOf(idx: WorldIndex, i: number): SearchHit {
	const b = idx.base, kind = b.kinds[b.kind[i]];
	const ni = b.nation[i], pi = b.parent[i];
	const note = kind === "country" ? "" : kind === "state" ? (ni >= 0 ? idx.names[ni] : "")
		: kind === "city" ? [pi >= 0 ? idx.names[pi] : "", ni >= 0 ? idx.names[ni] : ""].filter(Boolean).join(", ")
		: idx.kindNames[b.kind[i]];
	const hit: SearchHit = { title: idx.names[i], note, lon: idx.lon[i], lat: idx.lat[i], kind, ...viewOf(b.view[i], idx.lon[i], idx.lat[i]) };
	if (b.qid?.[i]) hit.id = "Q" + b.qid[i];
	return hit;
}

const loaded = new Map<string, Promise<WorldIndex>>();   // url＋言語 → Promise<索引>（1 頁 1 回・失敗したら次の問い合わせで取り直す）
function loadWorldIndex(url: string = WORLD_SEARCH_URL, lang: string = getLang()): Promise<WorldIndex> {
	const key = url + "|" + lang;
	if (!loaded.has(key)) {
		const p = Promise.all([fetchJsonMaybeGz(url + "base.json"), lang === "en" ? null : fetchJsonMaybeGz(`${url}${lang}.json`).catch((e: Error) => { console.warn(`[search] world names ${lang}: ${e.message ?? e} (English names only)`); return null; })])
			.then(([base, table]) => decodeIndex(base as WorldIndexBase, table as WorldIndexTable | null));
		p.catch(() => loaded.delete(key));
		loaded.set(key, p);
	}
	return loaded.get(key)!;
}

/**
 * 世界の既定の問い合わせ先（検索窓の供給元の形）。
 * @param {{ url?: string, lang?: string, limit?: number }} [o]  url＝索引の置き場（末尾 /）・lang＝名前の言語（既定＝UI の言語）
 */
export function createWorldSearch({ url = WORLD_SEARCH_URL, lang, limit = 8 }: { url?: string; lang?: string; limit?: number } = {}): WorldSearchProvider {
	return {
		histKey: "ortho.searches",
		async query(q: string, signal?: AbortSignal): Promise<SearchHit[]> {
			const idx = await loadWorldIndex(url, lang ?? getLang());
			if (signal?.aborted) throw new DOMException("aborted", "AbortError");
			return searchIndex(idx, q, limit).map(({ i }) => hitOf(idx, i));
		},
	};
}
