// スナップ索引 v2（純粋モジュール＝Node試験可）＝100万頂点級のメモリ根治（8/20「根性で全部」裁定）。
//
// v1（頂点1個=JSオブジェクト1個・Map入れ子）は136万頂点で数百MB。v2は gint と同じ思想：
//   基底＝セルコード (hi,lo) の Uint32 対（辞書順ソート済）＋参照（Int32Array×2）＝1頂点16B・不変（BigInt 撤廃 9/15）
//   ジャーナル＝編集で動いた/増えた分だけの追記（Map<code, refs[]>・小さい）
// 座標は索引に持たない＝問い合わせ時に deref(a,b) で**モデルの現在値**を引く。これにより：
//   ・頂点移動＝新セルへ追記1件のみ（基底の旧掲載は「実座標が遠い」ので距離判定が自然に落とす）
//   ・頂点削除/フィーチャ削除＝何もしない（deref が null/短縮で自動失効）
//   ・挿入＝挿入点と末尾の2件追記（ずれた中間は「別の実在頂点」を指すだけ＝スナップ先として依然正しい）
// 墓標・汚染集合が不要になる＝「楽観追記＋実測（deref）で確定」の家風。閾値で compact（全再構築）。
//
// 参照の符号化：arc頂点=(a=arcId≥0, b=idx)／ポイント=(a=-1-eid, b=ptIdx)。
// セルコード＝floor(coord×e) を +2^31 して 32bit×2＝(hi=y, lo=x)。±180は正規化＋周回。

export const normLon = x => ((x + 180) % 360 + 360) % 360 - 180;

// セルコード＝(hi=qy+2^31, lo=qx+2^31) の Uint32 対（辞書順）。旧＝64bit Morton を BigInt でボックス保持＋BigInt 比較ソート＝1M 頂点で数百MBの
// 一時確保と数秒（効率レビュー M-3）。3×3 近傍はセル個別ルックアップなので Morton 局所性は不要＝行優先の (hi,lo) で十分。
// 1e-7 格子の全球セル数は 2^63 級＝Number 1 個には収まらない（2^53）ため 2 語で持つ。
const SHIFT = 2147483648;
const cellHi = qy => (qy + SHIFT) >>> 0, cellLo = qx => (qx + SHIFT) >>> 0;
const jkey = (hi, lo) => hi * 4294967296 + lo;   // ジャーナル鍵＝Map の数値鍵（2^64 級＝厳密ではないが、同一セルは同一値・衝突は近傍セル同士で deref の距離判定が落とす）

// 基底の構築（Worker/ローカル共用）：iter は [a, b, x, y] を吐く。(hi,lo) 辞書順にソート済みの typed 4 本を返す。
export function buildBase(iter, gridExp) {
	const e = Math.pow(10, gridExp);
	const hiA = [], loA = [], refA = [], refB = [];
	for (const [a, b, x, y] of iter) {
		hiA.push(cellHi(Math.floor(y * e))); loA.push(cellLo(Math.floor(normLon(x) * e)));
		refA.push(a); refB.push(b);
	}
	const n = hiA.length;
	const idx = new Uint32Array(n);
	for (let i = 0; i < n; i++) idx[i] = i;
	idx.sort((p, q) => (hiA[p] - hiA[q]) || (loA[p] - loA[q]));
	const hi = new Uint32Array(n), lo = new Uint32Array(n), oa = new Int32Array(n), ob = new Int32Array(n);
	for (let i = 0; i < n; i++) { const j = idx[i]; hi[i] = hiA[j]; lo[i] = loA[j]; oa[i] = refA[j]; ob[i] = refB[j]; }
	return { hi, lo, refA: oa, refB: ob };
}

const COMPACT_AT = 65536;   // ジャーナルがこの件数を超えたら基底へ焼き直す（編集セッションでまず届かない）

export function createSnapIndex(gridExp, deref) {   // deref(a,b) → [x,y] | null（モデルの現在値）
	let e = Math.pow(10, gridExp);
	let base = null;              // {hi, lo, refA, refB}
	let journal = new Map();      // jkey(hi,lo) → number[]（a,b の平坦列）
	let journalN = 0, compactQueued = false;
	let refSource = null;         // compact/setGrid 用＝モデルの全参照イテレータ工場

	const lower = (h, l) => {   // (hi,lo) の先頭位置（無ければ挿入位置）＝辞書順の二分探索
		const H = base.hi, L = base.lo;
		let a = 0, b = H.length;
		while (a < b) { const mid = (a + b) >>> 1; if (H[mid] < h || (H[mid] === h && L[mid] < l)) a = mid + 1; else b = mid; }
		return a;
	};
	const materialize = (a, b, p) => a >= 0 ? { arcId: a, idx: b, x: p[0], y: p[1] } : { eid: -1 - a, ptIdx: b, x: p[0], y: p[1] };   // x,y＝deref済み現在値（吸着先座標として呼び出し側が使う）

	const api = {
		get gridExp() { return Math.log10(e); },
		setRefSource(fn) { refSource = fn; },
		setBase(b) { base = b; journal = new Map(); journalN = 0; },
		rebuild() { if (refSource) api.setBase(buildBase(refSource(), Math.log10(e))); },
		addRef(a, b, x, y) {
			const k = jkey(cellHi(Math.floor(y * e)), cellLo(Math.floor(normLon(x) * e)));
			let arr = journal.get(k);
			if (!arr) journal.set(k, (arr = []));
			arr.push(a, b);
			// 閾値超えの焼き直しはマイクロタスクへ＝reindexFeature（ドラッグ終端の一括追記）の途中で同期フル再構築が走らない（効率レビュー M-4）。
			// 追記過多でも nearest は正しく動く（deref で実測）＝遅らせて安全
			if (++journalN > COMPACT_AT && !compactQueued) { compactQueued = true; queueMicrotask(() => { compactQueued = false; if (journalN > COMPACT_AT) api.rebuild(); }); }
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
				const h = cellHi(qy + iy), l = cellLo(((qx + ix) % qn + qn) % qn);
				if (base) { const H = base.hi, L = base.lo; for (let i = lower(h, l); i < H.length && H[i] === h && L[i] === l; i++) consider(base.refA[i], base.refB[i]); }
				const arr = journal.get(jkey(h, l));
				if (arr) for (let i = 0; i < arr.length; i += 2) consider(arr[i], arr[i + 1]);
			}
			return best;
		},
		setGrid(gridExp2) { e = Math.pow(10, gridExp2); api.rebuild(); },
		stats: () => ({ base: base ? base.hi.length : 0, journal: journalN }),
	};
	return api;
}
