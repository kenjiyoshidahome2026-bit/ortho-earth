// デコード済みMVT + style.json → 描画op列（style層の順＝厳密な painter順）。
// 各 style層が1つの op（fill or line）になり、renderer はこの順にそのまま描く。
// 投影非依存の部分だけ担当：幾何を経緯度に戻し、シーン原点からの delta(float32) と地物ごとの色/線幅を確定。
// 線幅はスクリーン空間の定px（fat-line/capsule 展開は頂点シェーダ側）。
import earcut from "earcut";
import { evalExpr, truthy } from "./expr.js";
import { parseRGBA } from "./color.js";
import { tileLocalToLonLat } from "./tile.js";

// origin: [lon,lat] シーン原点（精度確保のため頂点は原点からの差分で持つ）
// pale: 色文字列→色文字列 の変換（無ければ恒等）
export function buildTileDrawList({ layers, z, x, y }, style, origin, pale = c => c) {
	const [ox, oy] = origin;
	const ops = [];   // { kind:'fill'|'line', li, ... } を style層順に（li=style層index、跨ぎバッチ結合用）
	// タイルローカル(0..extent) → 経緯度(原点相対) を out[oi],out[oi+1] へ直書き。x,y,n はタイル内で不変なので
	// ここで一度だけ捕獲し、毎頂点の一時配列 [lon,lat] 生成を廃す（＝GC削減）。extent は層毎に渡す。
	const nTiles = 1 << z, R2D = 180 / Math.PI, HALF_PI = Math.PI / 2;
	const llInto = (px, py, extent, out, oi) => {
		const wx = (x + px / extent) / nTiles, wy = (y + py / extent) / nTiles;
		out[oi] = (wx * 360 - 180) - ox;
		out[oi + 1] = R2D * (2 * Math.atan(Math.exp(Math.PI * (1 - 2 * wy))) - HALF_PI) - oy;
	};
	const sc = new Float64Array(2);    // line 用スクラッチ（1頂点）＝毎回の一時配列を作らない
	let llBuf = new Float64Array(0);   // fill 用：ポリゴン頂点の経緯度を貯める再利用バッファ（最大サイズまで成長）
	// 線分細分の閾値（タイル単位）：地形にドレープする際、長い直線が尾根で折れないよう ~700m 毎に分割。
	const [, cLat] = tileLocalToLonLat(x, y, z, 2048, 2048, 4096);
	const mPerUnit = 40075016.686 * Math.cos(cLat * Math.PI / 180) / (Math.pow(2, z) * 4096);
	const subLen = Math.max(1, 700 / mPerUnit);   // 700m 相当のタイル単位

	for (let li = 0; li < style.layers.length; li++) {
		const L = style.layers[li];
		if (L.type !== "fill" && L.type !== "line") continue;
		if (L.layout && L.layout.visibility === "none") continue;
		if (L.minzoom != null && z < L.minzoom) continue;
		if (L.maxzoom != null && z >= L.maxzoom) continue;
		const src = layers[L["source-layer"]]; if (!src) continue;
		const extent = src.extent;
		// line-sort-key/fill-sort-key: 層内で昇順に並べ替え（高い値ほど後＝上に描く）。std は道路を vt_drworder で並べる。
		const feats = sortFeatures(src.features, L.layout?.["line-sort-key"] ?? L.layout?.["fill-sort-key"], z);

		if (L.type === "fill") {
			const pos = [], col = [];
			const ctx = { zoom: z, props: null, geom: null, vars: {} };   // feature 間で使い回す（compile 済み evalExpr は ctx を保持しない＝安全）
			for (const f of feats) {
				ctx.props = f.props; ctx.geom = f.type;
				if (L.filter && !truthy(evalExpr(L.filter, ctx))) continue;
				const c = parseRGBA(pale(evalExpr(L.paint?.["fill-color"] ?? "#000", ctx)));
				const op = L.paint?.["fill-opacity"]; const a = c[3] * (op != null ? evalExpr(op, ctx) : 1);
				for (const [flat, holes] of polygons(f.geom)) {
					const tris = earcut(flat, holes, 2);
					if (!tris.length) continue;
					// ユニーク頂点を一度だけ経緯度化（原点相対）→ 三角形は共有頂点をインデックスで引く。
					// 旧版は earcut インデックス毎に toLL していた＝共有頂点を三角形の枚数だけ再変換していた。
					if (llBuf.length < flat.length) llBuf = new Float64Array(flat.length);
					for (let i = 0; i < flat.length; i += 2) llInto(flat[i], flat[i + 1], extent, llBuf, i);
					for (const idx of tris) {
						pos.push(llBuf[idx * 2], llBuf[idx * 2 + 1]); col.push(c[0], c[1], c[2], a);
					}
				}
			}
			if (pos.length) ops.push({ kind: "fill", li, id: L.id, pos: new Float32Array(pos), col: new Float32Array(col) });
		} else { // line
			const P1 = [], P2 = [], col = [], half = [];
			// line-dasharray [線, 間隔]（px・タイル基準ズームでの見かけ）：走行距離の位相を保って線分を刻む。
			// renderer の capsule は丸端なので、刻んだ破片がそのままピル状のダッシュになる（トンネル破線等）。
			const dashArr = L.paint?.["line-dasharray"];
			const du = dashArr ? dashArr[0] * extent / 256 : 0, gu = dashArr ? dashArr[1] * extent / 256 : 0, period = du + gu;
			const ctx = { zoom: z, props: null, geom: null, vars: {} };   // feature 間で使い回す（compile 済み evalExpr は ctx を保持しない＝安全）
			for (const f of feats) {
				ctx.props = f.props; ctx.geom = f.type;
				if (L.filter && !truthy(evalExpr(L.filter, ctx))) continue;
				const c = parseRGBA(pale(evalExpr(L.paint?.["line-color"] ?? "#000", ctx)));
				const op = L.paint?.["line-opacity"]; const a = c[3] * (op != null ? evalExpr(op, ctx) : 1);
				let w = evalExpr(L.paint?.["line-width"] ?? 1, ctx);
				if (typeof w !== "number" || isNaN(w) || w <= 0) w = 1;
				const hw = w * 0.5;
				const emit = (ax, ay, bx, by) => {
					llInto(ax, ay, extent, sc, 0); const alon = sc[0], alat = sc[1];
					llInto(bx, by, extent, sc, 0);
					P1.push(alon, alat); P2.push(sc[0], sc[1]);
					col.push(c[0], c[1], c[2], a); half.push(hw);
				};
				for (const linePts of f.geom) {
					if (dashArr) {
						let phase = 0;   // 頂点をまたいで位相を継続＝角でダッシュが割れない
						for (let i = 0; i + 1 < linePts.length; i++) {
							const A = linePts[i], B = linePts[i + 1];
							const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
							if (!len) continue;
							let pos = 0;
							while (pos < len - 1e-9) {
								const inDash = phase < du;
								const take = Math.min(inDash ? du - phase : period - phase, len - pos);
								if (inDash) emit(A.x + dx * (pos / len), A.y + dy * (pos / len), A.x + dx * ((pos + take) / len), A.y + dy * ((pos + take) / len));
								pos += take; phase += take; if (phase >= period - 1e-9) phase = 0;
							}
						}
						continue;
					}
					// 細分点を含む頂点を一度だけ経緯度化し、連続ペアで emit（隣接サブ線分＝隣接線分が端点を共有＝
					// 旧版の「サブ線分ごとに両端を変換」の重複を排除。長い道路の line 頂点変換がほぼ半減）。
					if (linePts.length < 2) continue;
					llInto(linePts[0].x, linePts[0].y, extent, sc, 0);
					let pLon = sc[0], pLat = sc[1];
					for (let i = 1; i < linePts.length; i++) {
						const A = linePts[i - 1], B = linePts[i];
						const dx = B.x - A.x, dy = B.y - A.y;
						const steps = Math.min(24, Math.max(1, Math.ceil(Math.hypot(dx, dy) / subLen)));  // 地形ドレープ用に細分
						for (let s = 1; s <= steps; s++) {
							const t = s / steps;
							llInto(A.x + dx * t, A.y + dy * t, extent, sc, 0);
							P1.push(pLon, pLat); P2.push(sc[0], sc[1]);
							col.push(c[0], c[1], c[2], a); half.push(hw);
							pLon = sc[0]; pLat = sc[1];
						}
					}
				}
			}
			if (half.length) ops.push({ kind: "line", li, id: L.id, P1: new Float32Array(P1), P2: new Float32Array(P2), col: new Float32Array(col), half: new Float32Array(half) });
		}
	}
	return { ops };
}

// sort-key 式があれば層内の地物を昇順に並べ替える（安定ソート）。無ければ元順のまま。
function sortFeatures(features, sortExpr, z) {
	if (!sortExpr) return features;
	// {f,i,k} を feature 毎に作らず、キー配列＋インデックス配列で安定ソート（GC削減）。ctx も1個使い回す。
	const n = features.length, keys = new Array(n), idx = new Array(n);
	const ctx = { zoom: z, props: null, geom: null, vars: {} };
	for (let i = 0; i < n; i++) { const f = features[i]; ctx.props = f.props; ctx.geom = f.type; keys[i] = evalExpr(sortExpr, ctx); idx[i] = i; }
	idx.sort((a, b) => (keys[a] - keys[b]) || (a - b));
	const out = new Array(n);
	for (let i = 0; i < n; i++) out[i] = features[idx[i]];
	return out;
}

// MVT のリング群を [flatCoords, holeIndices] のポリゴン単位に分割。
// 外周リング(正の面積)が新しいポリゴンを開始し、続く負の面積リングは穴。
function polygons(rings) {
	const out = [];
	let flat = null, holes = null, base = 0;
	for (const ring of rings) {
		const area = signedArea(ring);
		if (area >= 0 || !flat) {                 // 外周（または最初）
			if (flat && flat.length) out.push([flat, holes]);
			flat = []; holes = []; base = 0;
			for (const p of ring) flat.push(p.x, p.y);
			base = ring.length;
		} else {                                   // 穴
			holes.push(base);
			for (const p of ring) flat.push(p.x, p.y);
			base += ring.length;
		}
	}
	if (flat && flat.length) out.push([flat, holes]);
	return out;
}

function signedArea(ring) {
	let s = 0;
	for (let i = 0, n = ring.length; i < n; i++) {
		const a = ring[i], b = ring[(i + 1) % n];
		s += a.x * b.y - b.x * a.y;
	}
	return s / 2;
}
