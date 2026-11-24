// COG の range ソース抽象＝「静的ファイルの部分読み」を url | Blob/File | {read,size} で統一する。
// 設計（modules/decodeZIP.js の梯子を1往復ぶん高速化）:
//   ・HEAD を撃たない。初回から `GET bytes=0-(headerBytes-1)` を送り、
//     206 → Content-Range の総長を控えて range 運転
//     200 → Range 非対応 host（実測: Cloudflare Workers Assets 2026-09-01）。その応答ストリームを
//           そのまま Blob 化して全量モードへ＝probe の応答を捨てない
//   ・Blob/File は slice で常に range 同等。{read,size} 注入はテスト/特殊経路用。
//   ・readMany() が COG の肝＝タイル群の byte range をオフセット順に整列し、gap < gapBytes を
//     1 リクエストへ合体（HTTP/1 host とリクエスト単価の高い CDN で効く）。1本の上限 maxReq。
// 端末キャッシュ（opts.cache・2026-11-24 共通化 段 2）＝範囲ごとに残す。COG のタイル・COPC の節・階層の頁が同じ口で残る。
// fetch は注入可（CORS 無し配信を proxy 越しに読む口・maplibre.js の options.fetch と同じ流儀）。

// headerBytes 64 KB：16 KB だと IFD 連鎖が先頭に収まらない COG（Tellus AVNIR-2 webcog＝4 バンド×8 段）で
// ヘッダ読みが 32 リクエスト/1.6 s に化けた（64 KB なら 1 本/0.1 s・2026-09-16 実測）。+48 KB は 1 タイル未満
import type { ByteCache } from "./cache.ts";
const DEF = { headerBytes: 65536, gapBytes: 65536, maxReq: 4 << 20, concurrency: 6 };

/** 部分読み（from, len）。sig は readMany から渡る */
export type RangeRead = (from: number, len: number, signal?: AbortSignal) => Promise<Uint8Array>;
/** {read,size} 注入の入力（テスト/特殊経路用） */
export interface ReadSource { read: RangeRead; size?: number | null }
/** openSource が受ける源: URL・Blob/File・{read,size} */
export type SourceInput = string | Blob | ReadSource;
export interface SourceOptions {
	/** 最初に取る先頭バイト数（既定 64 KB） */
	headerBytes?: number;
	/** これ未満の隙間は 1 リクエストへ合体（既定 64 KB） */
	gapBytes?: number;
	/** 合体 1 本の上限（既定 4 MB） */
	maxReq?: number;
	/** readMany の並行本数（既定 6） */
	concurrency?: number;
	/** 先頭でなく末尾を最初に取る（parquet の footer 用） */
	tailBytes?: number;
	fetch?: typeof fetch;
	signal?: AbortSignal;
	/** 読んだ範囲の端末キャッシュ（IDB 等・注入式・2026-11-24 共通化 段 2）＝COG・COPC・何でも同じ口。URL の range 運転の時だけ効く */
	cache?: ByteCache;
	/** キャッシュの版の鍵（署名 URL のように URL が毎回変わる読み口が渡す）。無ければ ETag、それも無ければ先頭の中身のハッシュ＋総長 */
	cacheKey?: string;
	/** これより大きい 1 回の読みは残さない（既定 8 MB＝ZIP を丸ごと解く読みでキャッシュを溢れさせない） */
	cacheMaxBytes?: number;
}
export interface SourceMetrics { rangeRequests: number; coalescedFrom: number; bytesFetched: number; cacheHits?: number }
export interface ByteRange { from: number; len: number }
const fnv = (u: Uint8Array): string => { let h = 0x811c9dc5; for (let i = 0; i < u.length; i++) h = Math.imul(h ^ u[i], 0x01000193); return (h >>> 0).toString(16); };
/** openSource の戻り */
export interface Source {
	read: RangeRead;
	/** 総長（不明なら null） */
	size: number | null;
	/** 先頭 headerBytes（tailBytes 指定時は空） */
	head: Uint8Array;
	/** 末尾 tailBytes（tailBytes 指定時のみ） */
	tail?: Uint8Array;
	etag: string | null;
	metrics: SourceMetrics;
	/** Range 非対応 host＝全量を Blob に持っている */
	wholeFile?: boolean;
	/** ranges=[{from,len}] → Uint8Array[]（入力順）。coalesce 発注の一元口 */
	readMany(ranges: ByteRange[], signal?: AbortSignal): Promise<Uint8Array[]>;
}
type SourceBase = Omit<Source, "readMany">;

// opts.tailBytes（2026-09-20・parquet 用）＝先頭でなく**末尾**を最初に取る。footer が末尾にある形式（parquet の PAR1 trailer）は head が無駄になるため。
// tail 指定時は戻りの .tail に末尾バイト列が入り .head は空。⚠ suffix range（`bytes=-N`）は CORS の safelist 外＝preflight が飛び、
// OPTIONS に答えない host（GitHub raw 等）で「Failed to fetch」になる（2026-09-20 実測）。よって `bytes=0-0` で総長を取ってから
// `bytes=(size-N)-(size-1)` の 2 本（どちらも safelist の形＝preflight なし）。
export async function openSource(src: SourceInput, opts: SourceOptions = {}): Promise<Source> {
	const { headerBytes, gapBytes, maxReq, concurrency } = { ...DEF, ...opts };
	const tailBytes = opts.tailBytes !== undefined && opts.tailBytes > 0 ? opts.tailBytes : 0;
	const f = opts.fetch || fetch;
	const signal = opts.signal;
	const metrics: SourceMetrics = { rangeRequests: 0, coalescedFrom: 0, bytesFetched: 0 };
	const probe = async (read: RangeRead, size: number): Promise<{ head: Uint8Array; tail?: Uint8Array }> => tailBytes   // 最初に手元へ置く断片＝head か tail
		? { head: new Uint8Array(0), tail: await read(Math.max(0, size - tailBytes), Math.min(tailBytes, size)) }
		: { head: await read(0, Math.min(headerBytes, size)) };

	// ---- Blob / File ----------------------------------------------------------
	if (typeof Blob !== "undefined" && src instanceof Blob) {
		const blob = src;
		const read: RangeRead = async (from, len) => new Uint8Array(await blob.slice(from, from + len).arrayBuffer());
		return withMany({ read, size: blob.size, ...(await probe(read, blob.size)), etag: null, metrics }, gapBytes, maxReq, concurrency);
	}

	// ---- {read,size} 注入 ------------------------------------------------------
	if (src && typeof src === "object" && "read" in src && typeof src.read === "function") {
		if (tailBytes && !((src.size ?? 0) > 0)) throw new Error("source: tailBytes needs a known size");
		return withMany({ read: src.read, size: src.size ?? null, ...(await probe(src.read, src.size ?? headerBytes)), etag: null, metrics }, gapBytes, maxReq, concurrency);
	}

	// ---- URL ------------------------------------------------------------------
	if (typeof src !== "string") throw new Error("cog: unsupported source");
	const url = src;
	const first = await f(url, { headers: { Range: tailBytes ? "bytes=0-0" : `bytes=0-${headerBytes - 1}` }, signal });   // tail 時の 0-0＝総長を知るための 1 バイト
	if (!first.ok && first.status !== 206) throw new Error(`cog: HTTP ${first.status}`);
	metrics.rangeRequests++;
	const etag = first.headers.get("etag");

	if (first.status !== 206) {
		// Range 非対応 → この応答を最後まで飲んで全量モード（応答を無駄にしない）
		const blob = await first.blob();
		metrics.bytesFetched += blob.size;
		const read: RangeRead = async (from, len) => new Uint8Array(await blob.slice(from, from + len).arrayBuffer());
		return withMany({ read, size: blob.size, ...(await probe(read, blob.size)), etag, metrics, wholeFile: true }, gapBytes, maxReq, concurrency);
	}

	// 206: Content-Range "bytes 0-16383/12345678" から総長
	const cr = first.headers.get("content-range");
	const size = cr ? parseInt(cr.split("/")[1]) || null : null;
	let got = new Uint8Array(await first.arrayBuffer());
	metrics.bytesFetched += got.length;
	if (tailBytes) {   // 2 本目＝末尾（先頭位置つきの range＝safelist）
		if (!size) throw new Error("source: Content-Range has no total length (tail read needs it)");
		const from = Math.max(0, size - tailBytes);
		const t = await f(url, { headers: { Range: `bytes=${from}-${size - 1}` }, signal });
		if (!t.ok && t.status !== 206) throw new Error(`source: HTTP ${t.status}`);
		metrics.rangeRequests++;
		got = new Uint8Array(await t.arrayBuffer());
		metrics.bytesFetched += got.length;
	}
	const head = tailBytes ? new Uint8Array(0) : got, tail = tailBytes ? got : undefined;

	const net: RangeRead = async (from, len, sig) => {
		const res = await f(url, { headers: { Range: `bytes=${from}-${from + len - 1}` }, signal: sig || signal });
		if (!res.ok && res.status !== 206) throw new Error(`cog: HTTP ${res.status}`);
		metrics.rangeRequests++;
		const bin = new Uint8Array(await res.arrayBuffer());
		metrics.bytesFetched += bin.length;
		if (bin.length < len && size !== null && from + len <= size) throw new Error(`cog: truncated ${bin.length}/${len}`);
		return bin.length > len ? bin.subarray(0, len) : bin;   // 行儀の悪い host の過剰応答も許容
	};
	// 端末キャッシュ（段 2）＝鍵は「版＋範囲」。版＝cacheKey か ETag、無ければ先頭の中身のハッシュ＋総長（別オリジンは ETag を JS に見せないことがある＝PMTiles の端末キャッシュと同じ考え）。
	// 先頭は毎回回線から取る（上の 1 本）＝ファイルが差し替わると版が変わり、古い範囲は当たらない（予算で古い順に消える）
	const cache = opts.cache, ver = cache ? (opts.cacheKey ? `k:${opts.cacheKey}` : etag ? `e:${etag}` : `h:${fnv(tail || head)}:${size}`) : "";
	const ck = (from: number, len: number): string => `r:${ver}:${from}-${len}`;
	const maxC = opts.cacheMaxBytes ?? 8 << 20;
	const read: RangeRead = !cache ? net : async (from, len, sig) => {
		if (len > maxC) return net(from, len, sig);
		const hit = await cache.get(ck(from, len)).catch(() => null);
		if (hit && hit.length === len) { metrics.cacheHits = (metrics.cacheHits || 0) + 1; return hit; }
		const b = await net(from, len, sig);
		cache.set(ck(from, len), b.slice()).catch(() => {});   // 写して持つ（合体塊の subarray が親を抱えない）
		return b;
	};
	const src2 = withMany({ read, size, head, tail, etag, metrics }, gapBytes, maxReq, concurrency);
	if (cache) {   // readMany＝当たった範囲は回線に出さず、外れだけを合体して取り、範囲ごとに残す
		const many = withMany({ read: net, size, head, tail, etag, metrics }, gapBytes, maxReq, concurrency).readMany;
		src2.readMany = async (ranges, sig) => {
			const hits = await Promise.all(ranges.map(r => r.len > maxC ? null : cache.get(ck(r.from, r.len)).catch(() => null)));
			const miss = ranges.map((r, i) => ({ r, i })).filter(({ r, i }) => !(hits[i] && hits[i]!.length === r.len));
			metrics.cacheHits = (metrics.cacheHits || 0) + ranges.length - miss.length;
			const got = await many(miss.map(m => m.r), sig);
			const out = hits.slice() as Uint8Array[];
			miss.forEach((m, j) => { out[m.i] = got[j]; if (m.r.len <= maxC) cache.set(ck(m.r.from, m.r.len), got[j].slice()).catch(() => {}); });
			return out;
		};
	}
	return src2;
}

interface RangeGroup { from: number; len: number; items: (ByteRange & { i: number })[] }

// readMany: ranges=[{from,len}] → Uint8Array[]（入力順）。オフセット順に整列 → gap<gapBytes を合体 →
// 合体塊を concurrency 本で並行取得 → 各要求へ切り出し。ネット読みの発注はここに一元化する。
function withMany(base: SourceBase, gapBytes: number, maxReq: number, concurrency: number): Source {
	const s = base as Source;   // readMany をここで足す（オブジェクトは同一）
	s.readMany = async (ranges, signal) => {
		if (!ranges.length) return [];
		const idx = ranges.map((r, i) => ({ ...r, i })).sort((a, b) => a.from - b.from);
		const groups: RangeGroup[] = [];
		for (const r of idx) {
			const g = groups[groups.length - 1];
			if (g && r.from - (g.from + g.len) < gapBytes && (r.from + r.len) - g.from <= maxReq) {
				g.len = Math.max(g.len, r.from + r.len - g.from);
				g.items.push(r);
			} else groups.push({ from: r.from, len: r.len, items: [r] });
		}
		s.metrics.coalescedFrom += ranges.length;
		const out: Uint8Array[] = new Array(ranges.length);
		let cursor = 0;
		const lane = async (): Promise<void> => {
			while (cursor < groups.length) {
				const g = groups[cursor++];
				const buf = await s.read(g.from, g.len, signal);
				for (const it of g.items) out[it.i] = buf.subarray(it.from - g.from, it.from - g.from + it.len);
			}
		};
		await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, lane));
		return out;
	};
	return s;
}
