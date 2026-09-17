// GintBUF（geopbf の unPackGint）→ Equal Earth 描画用の型付き配列。純 JS・GL 非依存。
//
// 頂点：Morton u64 を一度だけ CPU で (ix, iy) の uint32 対へ展開（シェーダで compact しない＝頂点毎の分岐が消える）。
//   ix = (lon+180)·1e7, iy = (lat+90)·1e7。rank＝VW 重み（0..63・終端/arc 端点=63）。
// 辺：LOD 段（しきい値 thr 以上の rank の頂点だけを繋ぐ＝前方スナップを CPU で済ませた辺リスト）を
//   要求された段だけ遅延生成する。段は 3 rank ＝ ズーム 1 段刻み（rank ≈ 63−3z）。
//   ortho-core の lodSnap（シェーダ内ループ）と同じ意味の辺を、段ごとのインスタンス配列として持つ。
//
// インスタンスの詰め方（全て uint32）：
//   線  [a, b, cls | minZ10<<8]     a,b=頂点番号 / cls=スタイル番号 / minZ10=表示下限ズーム×10
//   塗り [a, b, p, fid | minZ10<<20] p=リングの扇の要（リング先頭頂点）・辺の向きは外環=反時計回りへ正規化済
//   点  [ix, iy, cls | minZ10<<8]
const IXMAX = 3600000000, IY90 = 1800000000;

function compact16(m) {
	m &= 0x55555555;
	m = (m | (m >>> 1)) & 0x33333333;
	m = (m | (m >>> 2)) & 0x0F0F0F0F;
	m = (m | (m >>> 4)) & 0x00FF00FF;
	m = (m | (m >>> 8)) & 0x0000FFFF;
	return m;
}

// 伸びる uint32 配列
class U32 {
	constructor(n = 1 << 16) { this.a = new Uint32Array(n); this.n = 0; }
	push3(x, y, z) { this.ensure(3); const a = this.a, n = this.n; a[n] = x; a[n + 1] = y; a[n + 2] = z; this.n = n + 3; }
	push4(x, y, z, w) { this.ensure(4); const a = this.a, n = this.n; a[n] = x; a[n + 1] = y; a[n + 2] = z; a[n + 3] = w; this.n = n + 4; }
	ensure(k) { if (this.n + k > this.a.length) { const b = new Uint32Array(this.a.length * 2); b.set(this.a); this.a = b; } }
	done() { return this.a.slice(0, this.n); }
}

// Morton u64 列 → xy(uint32×2) と rank
function decodeMorton(buf) {
	const n = buf.length, u = new Uint32Array(buf.buffer, buf.byteOffset, n * 2);
	const xy = new Uint32Array(n * 2), rank = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		const lo = u[i * 2], hi = u[i * 2 + 1], term = (hi & 0x80000000) !== 0;
		const loC = term ? lo : (lo & 0xFFFFFFC0), hiC = hi & 0x7FFFFFFF;
		xy[i * 2] = ((compact16(hiC) << 16) | compact16(loC)) >>> 0;
		xy[i * 2 + 1] = ((compact16(hiC >>> 1) << 16) | compact16(loC >>> 1)) >>> 0;
		rank[i] = term ? 63 : (lo & 0x3F);
	}
	return { xy, rank };
}

const minZ10 = z => Math.max(0, Math.min(0xFFFFFF, Math.round((z || 0) * 10)));

// spec:
//   kind: "poly" | "line" | "point"
//   fill:   (props) => minZoom | null（null＝塗らない）             … poly
//   outline:(props, refs, props2) => { cls, minZoom } | null       … poly（refs=その arc を参照する面の数＝1:海岸 2+:境界・props2＝もう一方の面）
//   unit:   (props, fid, lon) => 整数 | 省略                        … poly（ID 塗りに書く番号＝既定 fid。lon＝その部品の外環先頭の経度＝部品ごとの割替え用）
//           unit があれば out.neighbors＝境界 arc を挟む unit の組（隣接グラフ）
//   line:   (props) => { cls, minZoom } | null                      … line
//   point:  (props) => { cls, minZoom } | null                      … point
// 同じ pbf から複数の層を焼く（world の ne-cultural＝国/道路/鉄道/市街地が 1 本）ための共有部：
// 頂点の展開（xy・rank）と属性の復号を pbf ごとに 1 回だけ。xy は層をまたいで同じ配列＝GPU の頂点テクスチャも 1 枚で済む
function baseOf(pbf) {
	if (pbf.__eqBase) return pbf.__eqBase;
	const g = pbf.unPackGint;
	if (!g) throw new Error("no GintBUF");
	const propsCache = [];   // 属性の復号は fid ごとに 1 回（arc 走査で同じ面を何度も引く）
	const base = { g, props: fid => propsCache[fid] ??= (pbf.getProperties(fid) || {}) };
	if (g.arcBuffer?.length) {
		const { xy, rank } = decodeMorton(g.arcBuffer);
		const arcCount = g.arcMeta.length / 8;
		for (let a = 0; a < arcCount; a++) {   // arc の両端は必ず残す（リングの閉路・線のつながりの保証）
			const off = g.arcMeta[a * 8], len = g.arcMeta[a * 8 + 1];
			if (len) { rank[off] = 63; rank[off + len - 1] = 63; }
		}
		Object.assign(base, { xy, rank, arcCount });
	}
	return (pbf.__eqBase = base);
}

export function bakeLayer(pbf, spec) {
	const base = baseOf(pbf), { g, props } = base;
	const include = spec.include || (() => true);   // poly：この層に入る面か（同じ polyStream に別の層の面が混ざる時の振り分け）
	const out = { kind: spec.kind, vertexCount: 0, xy: null, tiers: new Map() };

	if (spec.kind === "point") {
		const n = g.pointBuffer?.length || 0;
		const { xy } = n ? decodeMorton(g.pointBuffer) : { xy: new Uint32Array(0) };
		const pts = new U32(Math.max(3, n * 3));
		for (let i = 0; i < n; i++) {
			const fid = g.point ? g.point[i] : i;
			const s = spec.point(props(fid)); if (!s) continue;
			pts.push3(xy[i * 2], xy[i * 2 + 1], (s.cls & 255) | (minZ10(s.minZoom) << 8));
		}
		out.points = pts.done();
		return out;
	}

	const { arcBuffer, arcMeta, polyStream, lineStream } = g;
	const { xy, rank, arcCount } = base;
	out.xy = xy; out.vertexCount = arcBuffer.length;

	// 面の輪郭で描かない辺：antimeridian 切断の痕（両端が ±180 上）と極線（両端が ±90 上）＝球面上は境界でない
	const artificial = (i, j) => {
		const xi = xy[i * 2], xj = xy[j * 2], yi = xy[i * 2 + 1], yj = xy[j * 2 + 1];
		const seamI = xi <= 2 || xi >= IXMAX - 2, seamJ = xj <= 2 || xj >= IXMAX - 2;
		if (seamI && seamJ) return true;
		const poleI = yi <= 2 || yi >= IY90 - 2, poleJ = yj <= 2 || yj >= IY90 - 2;
		return poleI && poleJ;
	};

	// 事前計算：線の cls/minZ、面の塗り minZ、arc の参照数（輪郭の海岸/国境分け）
	let lineRecs = null, fillMinZ = null, arcRefs = null, arcFid = null, arcFid2 = null;
	if (spec.kind === "line" && lineStream) {
		lineRecs = [];
		for (let p = 0; p < lineStream.length;) {
			const fid = lineStream[p++], ns = lineStream[p++], s = spec.line(props(fid)), arcs = [];
			for (let k = 0; k < ns; k++) { const ac = lineStream[p++]; for (let a = 0; a < ac; a++) arcs.push(lineStream[p++]); }
			if (s) lineRecs.push([(s.cls & 255) | (minZ10(s.minZoom) << 8), arcs]);
		}
	}
	if (spec.kind === "poly" && polyStream) {
		fillMinZ = new Map(); arcRefs = new Uint8Array(arcCount); arcFid = new Int32Array(arcCount).fill(-1); arcFid2 = new Int32Array(arcCount).fill(-1);
		for (let p = 0; p < polyStream.length;) {
			const fid = polyStream[p++], nr = polyStream[p++], inc = include(props(fid));
			if (spec.fill && !fillMinZ.has(fid)) fillMinZ.set(fid, inc ? spec.fill(props(fid)) : null);
			for (let r = 0; r < nr; r++) {
				const ac = polyStream[p++];
				if (!inc) { p += ac; continue; }
				for (let a = 0; a < ac; a++) { const ai = polyStream[p++], aid = ai < 0 ? ~ai : ai; if (arcRefs[aid] < 255) arcRefs[aid]++; if (arcFid[aid] < 0) arcFid[aid] = fid; else if (arcFid2[aid] < 0 && arcFid[aid] !== fid) arcFid2[aid] = fid; }
			}
		}
	}

	// 隣接グラフ（unit 単位）：2 面が共有する arc の両側（政治地図の塗り分け用）
	if (spec.kind === "poly" && spec.unit && arcFid) {
		const nb = new Set();
		for (let aid = 0; aid < arcCount; aid++) {
			if (arcFid2[aid] < 0) continue;
			const u = spec.unit(props(arcFid[aid]), arcFid[aid]), v = spec.unit(props(arcFid2[aid]), arcFid2[aid]);
			if (u !== v) nb.add(u < v ? u * 1048576 + v : v * 1048576 + u);
		}
		out.neighbors = [...nb].map(k => [Math.floor(k / 1048576), k % 1048576]);
	}

	// リング向きの正規化（符号付き巻き数の ID 塗りの前提）：各面の第1リング＝外環＝反時計回り(+)、以降＝穴＝時計回り(−)。
	// 経緯度の向きは Equal Earth でも保たれる（x は経度・y は緯度に単調）＝画面上でも外環は表向きの三角形になる。
	// 面積は全解像度で一度だけ（リング先頭からの相対・経度差は 360e7 周期でラップ）
	let ringFlip = null;
	if (spec.kind === "poly" && polyStream && spec.fill) {
		const flips = [];
		for (let p = 0; p < polyStream.length;) {
			p++; const nr = polyStream[p++];
			for (let r = 0; r < nr; r++) {
				const ac = polyStream[p++];
				let area2 = 0, x0 = 0, y0 = 0, px = 0, py = 0, first = true;
				for (let a = 0; a < ac; a++) {
					const ai = polyStream[p++], aid = ai < 0 ? ~ai : ai, off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
					for (let k = 0; k < len; k++) {
						const i = ai < 0 ? off + len - 1 - k : off + k;
						if (first) { x0 = xy[i * 2]; y0 = xy[i * 2 + 1]; first = false; continue; }
						let dx = xy[i * 2] - x0; if (dx > 1.8e9) dx -= 3.6e9; else if (dx < -1.8e9) dx += 3.6e9;
						const dy = xy[i * 2 + 1] - y0;
						area2 += px * dy - dx * py; px = dx; py = dy;
					}
				}
				const want = r === 0 ? 1 : -1;
				flips.push(area2 !== 0 && Math.sign(area2) !== want ? 1 : 0);
			}
		}
		ringFlip = Uint8Array.from(flips);
	}

	// arc を rank≥thr の頂点で辿り、辺ごとに emit(i, j)
	const walk = (aid, reverse, thr, emit) => {
		const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
		if (len < 2) return;
		if (!reverse) {
			let prev = off;
			for (let k = 1; k < len; k++) { const i = off + k; if (rank[i] < thr) continue; emit(prev, i); prev = i; }
		} else {
			let prev = off + len - 1;
			for (let k = len - 2; k >= 0; k--) { const i = off + k; if (rank[i] < thr) continue; emit(prev, i); prev = i; }
		}
	};

	out.tier = thr => {
		let t = out.tiers.get(thr);
		if (t) return t;
		t = {};
		if (spec.kind === "line" && lineRecs) {
			const L = new U32();
			for (const [packed, arcs] of lineRecs) for (const ai of arcs) walk(ai < 0 ? ~ai : ai, false, thr, (i, j) => L.push3(i, j, packed));
			t.lines = L.done();
		}
		if (spec.kind === "poly" && polyStream) {
			if (spec.outline) {
				const L = new U32();
				for (let aid = 0; aid < arcCount; aid++) {
					if (!arcRefs[aid]) continue;
					const s = spec.outline(props(arcFid[aid]), arcRefs[aid], arcFid2[aid] >= 0 ? props(arcFid2[aid]) : null); if (!s) continue;
					const packed = (s.cls & 255) | (minZ10(s.minZoom) << 8);
					walk(aid, false, thr, (i, j) => { if (!artificial(i, j)) L.push3(i, j, packed); });
				}
				t.lines = L.done();
			}
			if (spec.fill) {
				const F = new U32();
				let ri = 0;   // リング通し番号（ringFlip の添字）
				for (let p = 0; p < polyStream.length;) {
					const fid = polyStream[p++], nr = polyStream[p++], mz = fillMinZ.get(fid);
					let unit = fid;
					if (spec.unit && nr) {   // 部品（レコード）ごとの番号＝外環先頭の経度を添えて聞く
						const a0 = polyStream[p + 1], id0 = a0 < 0 ? ~a0 : a0, v0 = a0 < 0 ? arcMeta[id0 * 8] + arcMeta[id0 * 8 + 1] - 1 : arcMeta[id0 * 8];
						unit = spec.unit(props(fid), fid, xy[v0 * 2] * 1e-7 - 180);
					}
					for (let r = 0; r < nr; r++, ri++) {
						const ac = polyStream[p++];
						if (mz == null) { p += ac; continue; }
						const packed = (unit & 0xFFFFF) | (minZ10(mz) << 20);
						const flip = ringFlip[ri] === 1;
						const a0 = polyStream[p], id0 = a0 < 0 ? ~a0 : a0;
						const pivot = a0 < 0 ? arcMeta[id0 * 8] + arcMeta[id0 * 8 + 1] - 1 : arcMeta[id0 * 8];
						const emit = flip ? (i, j) => F.push4(j, i, pivot, packed) : (i, j) => F.push4(i, j, pivot, packed);
						for (let a = 0; a < ac; a++) { const ai = polyStream[p++]; walk(ai < 0 ? ~ai : ai, ai < 0, thr, emit); }
					}
				}
				t.fills = F.done();
			}
		}
		out.tiers.set(thr, t);
		return t;
	};
	return out;
}

// 経緯線（データでなく生成）：同じ線パスに流す＝中央経線の追従・antimeridian 切断もデータと同一の扱い。
// cls0＝30°毎（常時）・cls1＝10°毎（ズームで点灯）
export function bakeGraticule() {
	const pts = [], L = new U32();
	const vid = (lon, lat) => { pts.push(Math.round((lon + 180) * 1e7), Math.round((lat + 90) * 1e7)); return pts.length / 2 - 1; };
	const line = (coords, packed) => { let prev = -1; for (const [lon, lat] of coords) { const v = vid(lon, lat); if (prev >= 0) L.push3(prev, v, packed); prev = v; } };
	for (let lon = -180; lon < 180; lon += 10) {
		const cs = []; for (let lat = -90; lat <= 90; lat += 1) cs.push([lon, lat]);
		line(cs, lon % 30 === 0 ? 0 : 1 | (35 << 8));
	}
	for (let lat = -80; lat <= 80; lat += 10) {
		const cs = []; for (let lon = -180; lon <= 180; lon += 1) cs.push([lon === 180 ? 179.9999999 : lon, lat]);
		line(cs, lat % 30 === 0 ? 0 : 1 | (35 << 8));
	}
	const lines = L.done();
	return { kind: "line", xy: Uint32Array.from(pts), vertexCount: pts.length / 2, tiers: new Map(), tier: () => ({ lines }) };
}
