// convert/clip.js ── タイル空間（ズーム z の整数格子・y は下向き）での切り出し。
// 環は Sutherland–Hodgman（環ごとに独立＝穴も外環と同じ矩形で切れば MVT の巻き方向規則で正しく合成される）、
// 線は線分単位（矩形を出入りするたびに分割）、点はフィルタ。タイル範囲が 2×2 以上なら中央で二分して再帰＝
// 「環の全頂点 × 触れるタイル数」を「頂点 × log(タイル数)」へ（geojson-vt と同じ手）。
//
// 交点は 2 端点を辞書順に並べてから計算する＝同じ辺を逆向きに辿る隣のポリゴンでも bit 同一の交点になり、
// 共有境界がタイル縁で 1 単位ずれて隙間になることがない（gint の「共有 arc は 1 本」をタイル縁まで貫く）。
// 形式: 環/線 = number[]（x0,y0,x1,y1,…・環は閉じ点なし）。ポリゴン = 環の配列（[0] が外環）。点列 = number[]。

const ix = (ax, ay, bx, by, axis, val) => {   // 線分 a-b と axis=val の交点（辞書順に正規化）
	if (ax > bx || (ax === bx && ay > by)) { [ax, ay, bx, by] = [bx, by, ax, ay]; }
	const t = axis === 0 ? (val - ax) / (bx - ax) : (val - ay) / (by - ay);
	return axis === 0 ? [val, ay + t * (by - ay)] : [ax + t * (bx - ax), val];
};

// 環を半平面（axis の座標が val 以下＝less、以上＝!less）で切る。3 点未満なら null。出力は Float64Array（最大 2n+2 点）。
// 切断線上に連続する 3 点は中央を落とす：SH は環が線を出入りするたびに線上へ 2 点置くので、外側で往復する環は線上に
// 「行って戻る」幅ゼロの棘や重なり辺を残す。線上の 3 点は共線＝中央を抜いても面は不変で、棘だけが消える
//（バッファ縁の全面塗り判定が 4 頂点で決まり、タイルの無駄な頂点も減る）。
export function clipRingHalf(ring, axis, val, less) {
	const n = ring.length >> 1;
	if (n < 3) return null;
	const out = new Float64Array((n + 1) * 4);
	let m = 0;
	const on = (i) => out[i + axis] === val;   // 出力 i 番目（要素添字）の点が切断線上か
	const emit = (x, y) => {
		if (m >= 4 && (axis === 0 ? x : y) === val && on(m - 2) && on(m - 4)) m -= 2;
		out[m++] = x; out[m++] = y;
	};
	let px = ring[(n - 1) * 2], py = ring[(n - 1) * 2 + 1];
	let pin = less ? (axis === 0 ? px : py) <= val : (axis === 0 ? px : py) >= val;
	for (let i = 0; i < n; i++) {
		const x = ring[i * 2], y = ring[i * 2 + 1];
		const cin = less ? (axis === 0 ? x : y) <= val : (axis === 0 ? x : y) >= val;
		if (cin) {
			if (!pin) { const p = ix(px, py, x, y, axis, val); emit(p[0], p[1]); }
			emit(x, y);
		} else if (pin) { const p = ix(px, py, x, y, axis, val); emit(p[0], p[1]); }
		px = x; py = y; pin = cin;
	}
	// 継ぎ目（末尾→先頭→2 番目）も同じ規則で
	for (let changed = true; changed && m >= 8;) {
		changed = false;
		if (on(m - 2) && on(0) && on(2)) { out.copyWithin(0, 2, m); m -= 2; changed = true; }
		if (m >= 8 && on(m - 4) && on(m - 2) && on(0)) { m -= 2; changed = true; }
	}
	return m >= 6 ? out.subarray(0, m) : null;
}

// 線を半平面で切る → 線の配列（出入りで分割）
export function clipLineHalf(line, axis, val, less) {
	const n = line.length >> 1, res = [];
	let cur = null;
	const inside = (x, y) => less ? (axis === 0 ? x : y) <= val : (axis === 0 ? x : y) >= val;
	let px = line[0], py = line[1], pin = inside(px, py);
	if (pin) cur = [px, py];
	for (let i = 1; i < n; i++) {
		const x = line[i * 2], y = line[i * 2 + 1], cin = inside(x, y);
		if (cin) {
			if (!pin) { const p = ix(px, py, x, y, axis, val); cur = [p[0], p[1]]; }
			cur.push(x, y);
		} else if (pin) { const p = ix(px, py, x, y, axis, val); cur.push(p[0], p[1]); res.push(cur); cur = null; }
		px = x; py = y; pin = cin;
	}
	if (cur && cur.length >= 4) res.push(cur);
	return res;
}

// kind: 0 点列 / 1 線の配列 / 2 環の配列（ポリゴン）。半平面で切った結果（空なら null）
export function clipHalf(parts, kind, axis, val, less) {
	if (kind === 0) {
		const out = [];
		for (let i = 0; i < parts.length; i += 2) { const v = axis === 0 ? parts[i] : parts[i + 1]; if (less ? v <= val : v >= val) out.push(parts[i], parts[i + 1]); }
		return out.length ? out : null;
	}
	if (kind === 1) {
		const out = [];
		for (const l of parts) for (const s of clipLineHalf(l, axis, val, less)) out.push(s);
		return out.length ? out : null;
	}
	const out = [];
	for (let r = 0; r < parts.length; r++) {
		const c = clipRingHalf(parts[r], axis, val, less);
		if (r === 0 && !c) return null;   // 外環が消えたらポリゴンごと消える
		if (c) out.push(c);
	}
	return out;
}

export function bboxOf(parts, kind) {
	let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
	const scan = (a) => { for (let i = 0; i < a.length; i += 2) { const x = a[i], y = a[i + 1]; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y; } };
	if (kind === 0) scan(parts); else for (const p of parts) scan(p);
	return [minx, miny, maxx, maxy];
}

// 環が矩形 [x0,x1]×[y0,y1] を丸ごと覆う（全頂点が矩形の縁上・面積が矩形と一致）か。SH の切片は縁上に余分な頂点を持ち得る
// ので「4 頂点」ではなくこの条件で見る。
function coversRect(ring, x0, y0, x1, y1) {
	const n = ring.length >> 1;
	if (n < 4) return false;
	for (let i = 0; i < n; i++) { const x = ring[i * 2], y = ring[i * 2 + 1]; if (!((x === x0 || x === x1) && y >= y0 && y <= y1) && !((y === y0 || y === y1) && x >= x0 && x <= x1)) return false; }
	let s = 0;
	for (let i = 0, j = n - 1; i < n; j = i++) s += ring[j * 2] * ring[i * 2 + 1] - ring[i * 2] * ring[j * 2 + 1];
	return Math.abs(s) === 2 * (x1 - x0) * (y1 - y0);
}

// タイル範囲 → 各タイルへ切り出して sink(tx, ty, parts) へ。extent=タイル一辺、buffer=はみ出し幅（同単位）。
// bbox は parts の外接（既知なら渡す）。z はタイル数の上限（2^z）に使う。txRange=[from,to] で列範囲を絞る（worker 分担）。
// sinkRange(tx0, tx1, ty0, ty1) を渡すと、ポリゴン（穴なし）の切片が範囲矩形（バッファ込み）を丸ごと覆う時点で
// 「この範囲の全タイルは全面塗り」として葉まで降りずに 1 回で通知する（内陸のタイル群＝面被覆データの大半）。
export function splitToTiles(parts, kind, bbox, z, extent, buffer, sink, txRange = null, sinkRange = null) {
	const nmax = 2 ** z - 1, txLo = txRange ? txRange[0] : 0, txHi = txRange ? txRange[1] : nmax;
	const clampi = (v) => v < 0 ? 0 : v > nmax ? nmax : v;
	// ⚠ 列範囲は「二分の木を枝刈りする」だけで、範囲の計算や分割点は変えない＝分担の有無で葉の結果が bit 同一
	//（範囲を先に絞ると分割点がずれ、同じタイルの切片が変わって分担境界で別物になる）
	const range = (bb) => [clampi(Math.ceil((bb[0] - buffer) / extent) - 1), clampi(Math.floor((bb[2] + buffer) / extent)),
		clampi(Math.ceil((bb[1] - buffer) / extent) - 1), clampi(Math.floor((bb[3] + buffer) / extent))];
	const rec = (pts, bb, tx0, tx1, ty0, ty1) => {
		if (tx0 > tx1 || ty0 > ty1 || tx1 < txLo || tx0 > txHi) return;
		if (sinkRange && kind === 2 && pts.length === 1 && coversRect(pts[0], tx0 * extent - buffer, ty0 * extent - buffer, (tx1 + 1) * extent + buffer, (ty1 + 1) * extent + buffer)) {
			sinkRange(Math.max(tx0, txLo), Math.min(tx1, txHi), ty0, ty1);
			return;
		}
		if (tx0 === tx1 && ty0 === ty1) {
			const x0 = tx0 * extent - buffer, x1 = (tx0 + 1) * extent + buffer, y0 = ty0 * extent - buffer, y1 = (ty0 + 1) * extent + buffer;
			let c = pts;
			if (bb[0] < x0) c = c && clipHalf(c, kind, 0, x0, false);
			if (bb[2] > x1) c = c && clipHalf(c, kind, 0, x1, true);
			if (bb[1] < y0) c = c && clipHalf(c, kind, 1, y0, false);
			if (bb[3] > y1) c = c && clipHalf(c, kind, 1, y1, true);
			if (c) sink(tx0, ty0, c);
			return;
		}
		const ax = (tx1 - tx0) >= (ty1 - ty0) ? 0 : 1;
		const lo = ax === 0 ? tx0 : ty0, hi = ax === 0 ? tx1 : ty1, m = (lo + hi) >> 1, edge = (m + 1) * extent;
		const bmax = ax === 0 ? bb[2] : bb[3], bmin = ax === 0 ? bb[0] : bb[1];
		// 左（下）半分が列範囲の外なら切片も作らない（枝刈り＝分割点は不変）
		const wantL = ax === 0 ? lo <= txHi && m >= txLo : true, wantR = ax === 0 ? m + 1 <= txHi && hi >= txLo : true;
		const left = !wantL ? null : bmax <= edge + buffer ? pts : clipHalf(pts, kind, ax, edge + buffer, true);
		const right = !wantR ? null : bmin >= edge - buffer ? pts : clipHalf(pts, kind, ax, edge - buffer, false);
		if (left) {
			const lb = left === pts ? bb : bboxOf(left, kind), r = range(lb);
			ax === 0 ? rec(left, lb, Math.max(tx0, r[0]), Math.min(m, r[1]), Math.max(ty0, r[2]), Math.min(ty1, r[3]))
				: rec(left, lb, Math.max(tx0, r[0]), Math.min(tx1, r[1]), Math.max(ty0, r[2]), Math.min(m, r[3]));
		}
		if (right) {
			const rb = right === pts ? bb : bboxOf(right, kind), r = range(rb);
			ax === 0 ? rec(right, rb, Math.max(m + 1, r[0]), Math.min(tx1, r[1]), Math.max(ty0, r[2]), Math.min(ty1, r[3]))
				: rec(right, rb, Math.max(tx0, r[0]), Math.min(tx1, r[1]), Math.max(m + 1, r[2]), Math.min(ty1, r[3]));
		}
	};
	const r = range(bbox);
	rec(parts, bbox, r[0], r[1], r[2], r[3]);
}
