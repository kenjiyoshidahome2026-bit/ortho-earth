// COG の range ソース抽象＝「静的ファイルの部分読み」を url | Blob/File | {read,size} で統一する。
// 設計（modules/decodeZIP.js の梯子を1往復ぶん高速化）:
//   ・HEAD を撃たない。初回から `GET bytes=0-(headerBytes-1)` を送り、
//     206 → Content-Range の総長を控えて range 運転
//     200 → Range 非対応 host（実測: Cloudflare Workers Assets 2026-09-01）。その応答ストリームを
//           そのまま Blob 化して全量モードへ＝probe の応答を捨てない
//   ・Blob/File は slice で常に range 同等。{read,size} 注入はテスト/特殊経路用。
//   ・readMany() が COG の肝＝タイル群の byte range をオフセット順に整列し、gap < gapBytes を
//     1 リクエストへ合体（HTTP/1 host とリクエスト単価の高い CDN で効く）。1本の上限 maxReq。
// fetch は注入可（CORS 無し配信を proxy 越しに読む口・maplibre.js の options.fetch と同じ流儀）。

// headerBytes 64 KB：16 KB だと IFD 連鎖が先頭に収まらない COG（Tellus AVNIR-2 webcog＝4 バンド×8 段）で
// ヘッダ読みが 32 リクエスト/1.6 s に化けた（64 KB なら 1 本/0.1 s・2026-09-16 実測）。+48 KB は 1 タイル未満
const DEF = { headerBytes: 65536, gapBytes: 65536, maxReq: 4 << 20, concurrency: 6 };

// opts.tailBytes（2026-09-20・parquet 用）＝先頭でなく**末尾**を最初に取る。footer が末尾にある形式（parquet の PAR1 trailer）は head が無駄になるため。
// tail 指定時は戻りの .tail に末尾バイト列が入り .head は空。⚠ suffix range（`bytes=-N`）は CORS の safelist 外＝preflight が飛び、
// OPTIONS に答えない host（GitHub raw 等）で「Failed to fetch」になる（2026-09-20 実測）。よって `bytes=0-0` で総長を取ってから
// `bytes=(size-N)-(size-1)` の 2 本（どちらも safelist の形＝preflight なし）。
export async function openSource(src, opts = {}) {
	const { headerBytes, gapBytes, maxReq, concurrency } = { ...DEF, ...opts };
	const tailBytes = opts.tailBytes > 0 ? opts.tailBytes : 0;
	const f = opts.fetch || fetch;
	const signal = opts.signal;
	const metrics = { rangeRequests: 0, coalescedFrom: 0, bytesFetched: 0 };
	const probe = async (read, size) => tailBytes   // 最初に手元へ置く断片＝head か tail
		? { head: new Uint8Array(0), tail: await read(Math.max(0, size - tailBytes), Math.min(tailBytes, size)) }
		: { head: await read(0, Math.min(headerBytes, size)) };

	// ---- Blob / File ----------------------------------------------------------
	if (typeof Blob !== "undefined" && src instanceof Blob) {
		const read = async (from, len) => new Uint8Array(await src.slice(from, from + len).arrayBuffer());
		return withMany({ read, size: src.size, ...(await probe(read, src.size)), etag: null, metrics }, gapBytes, maxReq, concurrency);
	}

	// ---- {read,size} 注入 ------------------------------------------------------
	if (src && typeof src.read === "function") {
		if (tailBytes && !(src.size > 0)) throw new Error("source: tailBytes needs a known size");
		return withMany({ read: src.read, size: src.size ?? null, ...(await probe(src.read, src.size ?? headerBytes)), etag: null, metrics }, gapBytes, maxReq, concurrency);
	}

	// ---- URL ------------------------------------------------------------------
	if (typeof src !== "string") throw new Error("cog: unsupported source");
	const first = await f(src, { headers: { Range: tailBytes ? "bytes=0-0" : `bytes=0-${headerBytes - 1}` }, signal });   // tail 時の 0-0＝総長を知るための 1 バイト
	if (!first.ok && first.status !== 206) throw new Error(`cog: HTTP ${first.status}`);
	metrics.rangeRequests++;
	const etag = first.headers.get("etag");

	if (first.status !== 206) {
		// Range 非対応 → この応答を最後まで飲んで全量モード（応答を無駄にしない）
		const blob = await first.blob();
		metrics.bytesFetched += blob.size;
		const read = async (from, len) => new Uint8Array(await blob.slice(from, from + len).arrayBuffer());
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
		const t = await f(src, { headers: { Range: `bytes=${from}-${size - 1}` }, signal });
		if (!t.ok && t.status !== 206) throw new Error(`source: HTTP ${t.status}`);
		metrics.rangeRequests++;
		got = new Uint8Array(await t.arrayBuffer());
		metrics.bytesFetched += got.length;
	}
	const head = tailBytes ? new Uint8Array(0) : got, tail = tailBytes ? got : undefined;

	const read = async (from, len, sig) => {
		const res = await f(src, { headers: { Range: `bytes=${from}-${from + len - 1}` }, signal: sig || signal });
		if (!res.ok && res.status !== 206) throw new Error(`cog: HTTP ${res.status}`);
		metrics.rangeRequests++;
		const bin = new Uint8Array(await res.arrayBuffer());
		metrics.bytesFetched += bin.length;
		if (bin.length < len && size !== null && from + len <= size) throw new Error(`cog: truncated ${bin.length}/${len}`);
		return bin.length > len ? bin.subarray(0, len) : bin;   // 行儀の悪い host の過剰応答も許容
	};
	return withMany({ read, size, head, tail, etag, metrics }, gapBytes, maxReq, concurrency);
}

// readMany: ranges=[{from,len}] → Uint8Array[]（入力順）。オフセット順に整列 → gap<gapBytes を合体 →
// 合体塊を concurrency 本で並行取得 → 各要求へ切り出し。ネット読みの発注はここに一元化する。
function withMany(s, gapBytes, maxReq, concurrency) {
	s.readMany = async (ranges, signal) => {
		if (!ranges.length) return [];
		const idx = ranges.map((r, i) => ({ ...r, i })).sort((a, b) => a.from - b.from);
		const groups = [];
		for (const r of idx) {
			const g = groups[groups.length - 1];
			if (g && r.from - (g.from + g.len) < gapBytes && (r.from + r.len) - g.from <= maxReq) {
				g.len = Math.max(g.len, r.from + r.len - g.from);
				g.items.push(r);
			} else groups.push({ from: r.from, len: r.len, items: [r] });
		}
		s.metrics.coalescedFrom += ranges.length;
		const out = new Array(ranges.length);
		let cursor = 0;
		const lane = async () => {
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
