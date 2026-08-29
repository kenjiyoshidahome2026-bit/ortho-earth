// スナップ索引 v2（純粋モジュール＝Node試験可）＝100万頂点級のメモリ根治（8/20「根性で全部」裁定）。
//
// v1（頂点1個=JSオブジェクト1個・Map入れ子）は136万頂点で数百MB。v2は gint と同じ思想：
//   基底＝セルMortonコード（BigUint64Array・ソート済）＋参照（Int32Array×2）＝1頂点16B・不変
//   ジャーナル＝編集で動いた/増えた分だけの追記（Map<code, refs[]>・小さい）
// 座標は索引に持たない＝問い合わせ時に deref(a,b) で**モデルの現在値**を引く。これにより：
//   ・頂点移動＝新セルへ追記1件のみ（基底の旧掲載は「実座標が遠い」ので距離判定が自然に落とす）
//   ・頂点削除/フィーチャ削除＝何もしない（deref が null/短縮で自動失効）
//   ・挿入＝挿入点と末尾の2件追記（ずれた中間は「別の実在頂点」を指すだけ＝スナップ先として依然正しい）
// 墓標・汚染集合が不要になる＝「楽観追記＋実測（deref）で確定」の家風。閾値で compact（全再構築）。
//
// 参照の符号化：arc頂点=(a=arcId≥0, b=idx)／ポイント=(a=-1-eid, b=ptIdx)。
// セルコード＝floor(coord×e) を +2^31 して 32bit×2 → 64bit Morton（BigInt）。±180は正規化＋周回。

export const normLon = x => ((x + 180) % 360 + 360) % 360 - 180;

const M32 = 0xFFFFFFFFn;
const spread = v => {   // 32bit → 偶数ビットへ拡散（BigInt）
	let x = BigInt(v >>> 0) & M32;
	x = (x | (x << 16n)) & 0x0000FFFF0000FFFFn;
	x = (x | (x << 8n)) & 0x00FF00FF00FF00FFn;
	x = (x | (x << 4n)) & 0x0F0F0F0F0F0F0F0Fn;
	x = (x | (x << 2n)) & 0x3333333333333333n;
	x = (x | (x << 1n)) & 0x5555555555555555n;
	return x;
};
const cellCode = (qx, qy) => spread(qx + 2147483648) | (spread(qy + 2147483648) << 1n);

// 基底の構築（Worker/ローカル共用）：iter は [a, b, x, y] を吐く。ソート済み typed 3本を返す。
export function buildBase(iter, gridExp) {
	const e = Math.pow(10, gridExp);
	const codes = [], refA = [], refB = [];
	for (const [a, b, x, y] of iter) {
		codes.push(cellCode(Math.floor(normLon(x) * e), Math.floor(y * e)));
		refA.push(a); refB.push(b);
	}
	const n = codes.length;
	const idx = new Uint32Array(n);
	for (let i = 0; i < n; i++) idx[i] = i;
	idx.sort((p, q) => (codes[p] < codes[q] ? -1 : codes[p] > codes[q] ? 1 : 0));
	const oc = new BigUint64Array(n), oa = new Int32Array(n), ob = new Int32Array(n);
	for (let i = 0; i < n; i++) { const j = idx[i]; oc[i] = codes[j]; oa[i] = refA[j]; ob[i] = refB[j]; }
	return { codes: oc, refA: oa, refB: ob };
}

const COMPACT_AT = 65536;   // ジャーナルがこの件数を超えたら基底へ焼き直す（編集セッションでまず届かない）

export function createSnapIndex(gridExp, deref) {   // deref(a,b) → [x,y] | null（モデルの現在値）
	let e = Math.pow(10, gridExp);
	let base = null;              // {codes, refA, refB}
	let journal = new Map();      // code(BigInt) → number[]（a,b の平坦列）
	let journalN = 0;
	let refSource = null;         // compact/setGrid 用＝モデルの全参照イテレータ工場

	const lower = code => {   // codes 内の code 先頭位置（無ければ挿入位置）
		const c = base.codes;
		let lo = 0, hi = c.length;
		while (lo < hi) { const mid = (lo + hi) >>> 1; if (c[mid] < code) lo = mid + 1; else hi = mid; }
		return lo;
	};
	const materialize = (a, b, p) => a >= 0 ? { arcId: a, idx: b, x: p[0], y: p[1] } : { eid: -1 - a, ptIdx: b, x: p[0], y: p[1] };   // x,y＝deref済み現在値（吸着先座標として呼び出し側が使う）

	const api = {
		get gridExp() { return Math.log10(e); },
		setRefSource(fn) { refSource = fn; },
		setBase(b) { base = b; journal = new Map(); journalN = 0; },
		rebuild() { if (refSource) api.setBase(buildBase(refSource(), Math.log10(e))); },
		addRef(a, b, x, y) {
			const code = cellCode(Math.floor(normLon(x) * e), Math.floor(y * e));
			let arr = journal.get(code);
			if (!arr) journal.set(code, (arr = []));
			arr.push(a, b);
			if (++journalN > COMPACT_AT) api.rebuild();
		},
		// 最近傍1点（tol=1セル寸）。skip(entry)=true は除外（ドラッグ中の自分自身など）
		nearest(x, y, skip) {
			const tol = 1 / e, tolSq = tol * tol;
			const qx = Math.floor(normLon(x) * e), qy = Math.floor(y * e);
			const qn = Math.round(360 * e);
			let best = null, bd = tolSq;
			const consider = (a, b) => {
				const p = deref(a, b);
				if (!p) return;
				let dx = normLon(p[0] - x);
				const d = dx * dx + (p[1] - y) * (p[1] - y);
				if (d >= bd) return;
				const en = materialize(a, b, p);
				if (skip && skip(en)) return;
				bd = d; best = en;
			};
			for (let ix = -1; ix <= 1; ix++) for (let iy = -1; iy <= 1; iy++) {
				const code = cellCode(((qx + ix) % qn + qn) % qn, qy + iy);
				if (base) { const c = base.codes; for (let i = lower(code); i < c.length && c[i] === code; i++) consider(base.refA[i], base.refB[i]); }
				const arr = journal.get(code);
				if (arr) for (let i = 0; i < arr.length; i += 2) consider(arr[i], arr[i + 1]);
			}
			return best;
		},
		setGrid(gridExp2) { e = Math.pow(10, gridExp2); api.rebuild(); },
		stats: () => ({ base: base ? base.codes.length : 0, journal: journalN }),
	};
	return api;
}
