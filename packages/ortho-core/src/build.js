// デコード済みMVT + style.json → 描画op列（style層の順＝厳密な painter順）。
// 各 style層が1つの op（fill or line）になり、renderer はこの順にそのまま描く。
// 投影非依存の部分だけ担当：幾何を経緯度に戻し、シーン原点からの delta(float32) と地物ごとの色/線幅を確定。
// 線幅はスクリーン空間の定px（fat-line/capsule 展開は頂点シェーダ側）。
import earcut from "earcut";
import { evalExpr, truthy } from "./expr.js";
import { parseRGBA } from "./color.js";
import { tileLocalToLonLat } from "./tile.js";
import { polygons, signedArea } from "./decode.js";   // フラットgeom({coords,ends})→[flat, holes]（buildings と共用）
import { SEA_FB_BASE } from "./scene.js";

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
	// 頂点色は Uint8×4（正規化attribでGLへ）：float32×4 だと fill 頂点24Bの2/3が色＝実質8bit精度のデータに
	// バス幅の2/3を割いていた。バイト化で tess出力→transfer→常駐→merge→upload の全段が縮む。
	const b255 = v => v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
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
			// インデックス描画：ユニーク頂点(pos/col)＋三角形index。スープ展開（3頂点/三角形）をやめ、
			// 頂点は一度だけ持つ＝典型ポリゴン(tris≈verts)でバイト2/3・GPUのpost-transform cacheも効く。
			const pos = [], col = [], idx = [];
			const ctx = { zoom: z, props: null, geom: null, vars: {} };   // feature 間で使い回す（compile 済み evalExpr は ctx を保持しない＝安全）
			for (const f of feats) {
				ctx.props = f.props; ctx.geom = f.type;
				if (L.filter && !truthy(evalExpr(L.filter, ctx))) continue;
				const c = parseRGBA(pale(evalExpr(L.paint?.["fill-color"] ?? "#000", ctx)));
				const op = L.paint?.["fill-opacity"]; const a = c[3] * (op != null ? evalExpr(op, ctx) : 1);
				const cr = b255(c[0]), cg = b255(c[1]), cb = b255(c[2]), ca = b255(a);
				for (const [flat, holes] of polygons(f.geom)) {
					const tris = earcut(flat, holes, 2);
					if (!tris.length) continue;
					// ユニーク頂点を一度だけ経緯度化（原点相対）→ 三角形は共有頂点をインデックスで引く。
					if (llBuf.length < flat.length) llBuf = new Float64Array(flat.length);
					for (let i = 0; i < flat.length; i += 2) llInto(flat[i], flat[i + 1], extent, llBuf, i);
					const base = pos.length >> 1;
					for (let i = 0; i < flat.length; i += 2) { pos.push(llBuf[i], llBuf[i + 1]); col.push(cr, cg, cb, ca); }
					for (const t of tris) idx.push(base + t);
				}
			}
			// index はタイル単体なら大抵 Uint16 で足りる（65536頂点超の層だけ Uint32）＝transfer/常駐がさらに半減。
			// merge 側は結合時に常に Uint32 へ広げる（結合後は頂点数が容易に 65k を超える）。
			if (pos.length) ops.push({ kind: "fill", li, id: L.id, pos: new Float32Array(pos), col: new Uint8Array(col), idx: pos.length >> 1 <= 65535 ? new Uint16Array(idx) : new Uint32Array(idx) });
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
				const cr = b255(c[0]), cg = b255(c[1]), cb = b255(c[2]), ca = b255(a);
				let w = evalExpr(L.paint?.["line-width"] ?? 1, ctx);
				if (typeof w !== "number" || isNaN(w) || w <= 0) w = 1;
				const hw = w * 0.5;
				const emit = (ax, ay, bx, by) => {
					llInto(ax, ay, extent, sc, 0); const alon = sc[0], alat = sc[1];
					llInto(bx, by, extent, sc, 0);
					P1.push(alon, alat); P2.push(sc[0], sc[1]);
					col.push(cr, cg, cb, ca); half.push(hw);
				};
				// フラットgeom：coords([x,y,…]) を ends の区切りで線/リング毎に走査（添字直読み＝Point中間なし）
				const { coords, ends } = f.geom;
				let ls = 0;
				for (let r = 0; r < ends.length; r++) {
					const le = ends[r];
					if (dashArr) {
						let phase = 0;   // 頂点をまたいで位相を継続＝角でダッシュが割れない
						for (let i = ls; i + 3 < le; i += 2) {   // 線分＝点(i)→点(i+2)
							const Ax = coords[i], Ay = coords[i + 1];
							const dx = coords[i + 2] - Ax, dy = coords[i + 3] - Ay, len = Math.hypot(dx, dy);
							if (!len) continue;
							let pos = 0;
							while (pos < len - 1e-9) {
								const inDash = phase < du;
								const take = Math.min(inDash ? du - phase : period - phase, len - pos);
								if (inDash) emit(Ax + dx * (pos / len), Ay + dy * (pos / len), Ax + dx * ((pos + take) / len), Ay + dy * ((pos + take) / len));
								pos += take; phase += take; if (phase >= period - 1e-9) phase = 0;
							}
						}
						ls = le; continue;
					}
					// 細分点を含む頂点を一度だけ経緯度化し、連続ペアで emit（隣接サブ線分＝隣接線分が端点を共有＝
					// 旧版の「サブ線分ごとに両端を変換」の重複を排除。長い道路の line 頂点変換がほぼ半減）。
					if (le - ls < 4) { ls = le; continue; }   // 2点未満
					llInto(coords[ls], coords[ls + 1], extent, sc, 0);
					let pLon = sc[0], pLat = sc[1];
					for (let i = ls + 2; i < le; i += 2) {
						const Ax = coords[i - 2], Ay = coords[i - 1];
						const dx = coords[i] - Ax, dy = coords[i + 1] - Ay;
						const steps = Math.min(24, Math.max(1, Math.ceil(Math.hypot(dx, dy) / subLen)));  // 地形ドレープ用に細分
						for (let s = 1; s <= steps; s++) {
							const t = s / steps;
							llInto(Ax + dx * t, Ay + dy * t, extent, sc, 0);
							P1.push(pLon, pLat); P2.push(sc[0], sc[1]);
							col.push(cr, cg, cb, ca); half.push(hw);
							pLon = sc[0]; pLat = sc[1];
						}
					}
					ls = le;
				}
			}
			if (half.length) ops.push({ kind: "line", li, id: L.id, P1: new Float32Array(P1), P2: new Float32Array(P2), col: new Uint8Array(col), half: new Float32Array(half) });
		}
	}
	return { ops };
}

// 図郭外に敷く「標高ゲート付き全面水域」op列（フォールバック水域）。
// GSI 自身が z8+ の提供圏内の外洋・外国領土に配る全面WAダミー（57B・全面ポリゴン一枚）の自前版：
// style.emptySea（水層の id・app がオプトイン）と同じ source-layer を使う全 fill 層（water＋water-hi 等）の
// 色・式で全面ポリゴンを焼き、li を擬似帯 SEA_FB_BASE+実li へ付け替える（実層より下・チップ連動は merge が
// seaFbReal で還元）。renderer はこの帯で u_seaGate=1 を立て、FS が elev(v_ll)>0 の画素を discard
// ＝「水域は地理院・陸は標高(GEBCO/R10)」の管轄裁定を画素単位で行う（韓国等が偽の白い陸になる件の根治）。
// 敷く条件（z≥8。z<8 は GSI 自身も全面WAを配らない紙の海の領分。表示は renderer の sea.minzoom にも従う）:
//  (a) __empty＝404/204＝提供図郭の完全な外
//  (b) タイルの中身が「WA だけ・しかも全面を覆わない」＝図郭の縁のダミー（マスクで刈られた WA スライバが
//      1個だけ残る 51B 級タイル。日本の実タイルは陸があれば AdmArea/道路等を必ず伴うので誤爆しない。
//      純外洋で WA 全面のものは覆率≈1 で除外＝既に青いので敷く必要がない）
export function buildEmptySeaOps(layers, { z, x, y }, style, origin) {
	const id = style.emptySea; if (!id || z < 8) return null;
	const base = style.layers.find(L => L.id === id); if (!base) return null;
	const src = base["source-layer"];
	if (!layers.__empty && !waOnlyPartial(layers, src)) return null;
	const idxs = [];
	style.layers.forEach((L, i) => { if (L.type === "fill" && L["source-layer"] === src) idxs.push(i); });
	if (!idxs.length) return null;
	const sq = { [src]: { extent: 4096, features: [{ type: "Polygon", id: 0, props: { vt_code: 5101 },   // 5101＝海（色式が vt_code を見る style でも水色に転ぶ）
		geom: { coords: new Int32Array([0, 0, 4096, 0, 4096, 4096, 0, 4096, 0, 0]), ends: [10] } }] } };
	const dl = buildTileDrawList({ layers: sq, z, x, y }, { layers: idxs.map(i => style.layers[i]) }, origin);
	for (const op of dl.ops) { op.li = SEA_FB_BASE + idxs[op.li]; op.id = "empty-sea:" + op.id; }   // sub-style の li(0..)→実li→擬似帯
	return dl.ops.length ? dl.ops : null;
}
// 「WA しか無く、その WA が全面を覆っていない」＝図郭縁ダミーの判定（覆率 99.5% 未満）。穴は無い前提の |面積| 和。
function waOnlyPartial(layers, src) {
	const names = Object.keys(layers); if (names.length !== 1 || names[0] !== src) return false;
	const { extent, features } = layers[src];
	let area = 0;
	for (const f of features) {
		if (f.type !== "Polygon") continue;
		const { coords, ends } = f.geom; let p = 0;
		for (const e of ends) { area += Math.abs(signedArea(coords, p, e)); p = e; }
	}
	return area < extent * extent * 0.995;
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

