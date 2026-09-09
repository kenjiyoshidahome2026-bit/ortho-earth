// convert/assemble.js ── 1 ズーム × タイル列範囲の「組立→クリップ→MVT→内容キー」。worker（tile-worker.js）と
// インライン経路（workers:0）の共通本体＝純関数。bare import 無し（worker がバンドラ無しで読める）。
//
// S（静的・worker 初期化時に 1 回）: { arcCount, nPts, point, polyStream, lineStream, extent, buffer, layerName,
//    tagTable（tagtable.js の表）か tags（fid → [[k,v]]）, featureCount, maxZoom, dropRate, tinyPolygon, tinyLine,
//    compArea（面成分の元解像度の面積×2・世界座標尺）, extentShift }
// J（job）: { z, txFrom, txTo, counts, bbox, offs, out }   … このズームの arc 別 件数/外接/先頭位置（out 内）/圧縮座標
// 戻り: { tiles: [{ id, key }], contents: [[key, Uint8Array(未圧縮 MVT)]] }
//
// 速さの要点：環の連結と局所化は型付き配列（Float64Array/Int32Array）・面被覆の内陸は二分の途中で「範囲全体が全面塗り」と
// 確定した時点で葉まで降りない（sinkRange）・1 feature のタイルは fid 毎に前計算した属性節を貼る（encodeSingle）・
// 内容ハッシュで重複を弾いてから複製する（複製は新規内容の時だけ）。
import { splitToTiles } from "./clip.js";
import { encodeTile, encodeSingle, encodeAttrs, signedArea2 } from "./mvt.js";
import { zxyToTileId, contentKey, sameBytes } from "./pmtiles.js";
import { tagReader } from "./tagtable.js";

export function assembleZoom(S, J) {
	const { arcCount, nPts, point, polyStream: ps, lineStream: ls, extent, buffer, layerName } = S;
	const tagsOf = S._tagsOf ??= S.tagTable ? tagReader(S.tagTable) : (fid) => S.tags[fid];
	const { z, counts, bbox, offs, out } = J;
	const tinyA2 = 2 * (S.tinyPolygon ?? 0), tinyL = S.tinyLine ?? 0;   // 面積 ×2 で比べる（signedArea2 と同じ尺度）
	const compArea = tinyA2 ? S.compArea : null, areaScale = Math.pow(4, z + (S.extentShift ?? 12) - 32);   // 世界座標尺 → このズームのタイル座標尺
	const txRange = [J.txFrom, J.txTo];
	const attrCache = S._attr ??= new Array(S.featureCount ?? S.tags?.length ?? 0);   // fid → encodeAttrs（worker 内で永続）
	const attrOf = (fid) => attrCache[fid] ??= encodeAttrs(tagsOf(fid));
	const tileMap = new Map();
	const tileOf = (tx, ty) => { const key = tx * 4294967296 + ty; let t = tileMap.get(key); if (!t) { t = { tx, ty, polys: new Map(), lines: new Map(), points: new Map() }; tileMap.set(key, t); } return t; };
	const fullRanges = [];   // [fid, tx0, tx1, ty0, ty1] … 全面塗りが確定した範囲
	// arc 列 → 連結線（Float64Array・接合点の重複除去・環は閉じ点も落とす）と bbox
	const concat = (arcIdxs, ring) => {
		let total = 0, bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
		for (const ai of arcIdxs) {
			const aid = ai < 0 ? ~ai : ai, n = counts[aid];
			if (!n) continue;
			total += n;
			const b = aid * 4;
			if (bbox[b] < bx0) bx0 = bbox[b]; if (bbox[b + 1] < by0) by0 = bbox[b + 1]; if (bbox[b + 2] > bx1) bx1 = bbox[b + 2]; if (bbox[b + 3] > by1) by1 = bbox[b + 3];
		}
		const line = new Float64Array(total * 2);
		let m = 0;
		for (const ai of arcIdxs) {
			const aid = ai < 0 ? ~ai : ai, n = counts[aid];
			if (!n) continue;
			const o = offs[aid];
			for (let j = 0; j < n; j++) {
				const i = ai < 0 ? n - 1 - j : j, x = out[(o + i) * 2], y = out[(o + i) * 2 + 1];
				if (m && line[m - 2] === x && line[m - 1] === y) continue;
				line[m++] = x; line[m++] = y;
			}
		}
		if (ring && m >= 4 && line[0] === line[m - 2] && line[1] === line[m - 1]) m -= 2;
		return { line: line.subarray(0, m), bbox: [bx0, by0, bx1, by1] };
	};
	const reversed = (a) => { const r = new Float64Array(a.length); for (let i = 0, j = a.length - 2; j >= 0; i += 2, j -= 2) { r[i] = a[j]; r[i + 1] = a[j + 1]; } return r; };
	// 極小ポリゴン（tippecanoe の --tiny-polygon-size と同じ考え方）：このズームで元解像度の面積が閾値未満の成分は落とし、落とした
	// 面積を fid 毎に積む。積算が閾値に達したら、そこに閾値面積の正方形を 1 つ置く＝点在する小島の群れが「何も無い」にならず密度として残る。
	// 判定は簡略化前の面積（compArea）＝LOD で環が潰れた成分も積算に入る。
	const tinyAcc = new Map();
	const tinySquare = (fid, rb, a2full) => {
		const acc = (tinyAcc.get(fid) ?? 0) + Math.abs(a2full) / 2;
		if (acc < tinyA2 / 2) { tinyAcc.set(fid, acc); return null; }
		tinyAcc.set(fid, acc - tinyA2 / 2);
		const h = Math.sqrt(tinyA2 / 2) / 2, cx = (rb[0] + rb[2]) / 2, cy = (rb[1] + rb[3]) / 2;
		return { line: new Float64Array([cx - h, cy - h, cx - h, cy + h, cx + h, cy + h, cx + h, cy - h]), bbox: [cx - h, cy - h, cx + h, cy + h] };   // 外環＝y 下向きで面積正
	};
	// クリップ後の切片：外環が閾値未満なら捨てる（隣のタイルへ続く縁の欠片・バッファ帯だけに掛かる欠片）
	const sinkPoly = (fid, rings0) => (tx, ty, parts) => {
		if (tinyA2 && parts[0] !== rings0 && Math.abs(signedArea2(parts[0])) < tinyA2) return;
		const t = tileOf(tx, ty); let l = t.polys.get(fid); if (!l) t.polys.set(fid, l = []); l.push(parts);
	};
	// ポリゴン（外環→穴。向きは MVT 規則へ。全体 bbox で列範囲外なら組立すら省く）
	let comp = -1;
	if (ps) for (let p = 0; p < ps.length;) {
		const fid = ps[p++], nr = ps[p++], rings = [];
		comp++;
		let bb = null;
		for (let r = 0; r < nr; r++) {
			const ac = ps[p++], idx = ps.subarray(p, p + ac); p += ac;
			const skipRest = () => { for (let q = r + 1; q < nr; q++) p += ps[p] + 1; };   // 外環が消えたら残りの環（穴）を読み飛ばす
			if (r === 0) {   // 外環の arc bbox だけ先に見て列範囲外なら残りを読み飛ばす
				let x0 = Infinity, x1 = -Infinity;
				for (const ai of idx) { const aid = ai < 0 ? ~ai : ai; if (!counts[aid]) continue; if (bbox[aid * 4] < x0) x0 = bbox[aid * 4]; if (bbox[aid * 4 + 2] > x1) x1 = bbox[aid * 4 + 2]; }
				if (x1 < 0 || (x1 + buffer) / extent < txRange[0] || (x0 - buffer) / extent >= txRange[1] + 1) { skipRest(); break; }
			}
			let { line, bbox: rb } = concat(idx, true);
			let a2 = line.length < 6 ? 0 : signedArea2(line);
			const a2full = r === 0 && compArea ? compArea[comp] * areaScale : a2;
			if (r === 0 && compArea && Math.abs(a2full) < tinyA2) {   // 極小（元解像度で）：積算して代わりの正方形か無し
				const sq = tinySquare(fid, rb, a2full);
				if (!sq) { skipRest(); break; }
				line = sq.line; rb = sq.bbox; a2 = signedArea2(line);
			} else if (a2 === 0) { if (r === 0) { skipRest(); break; } continue; }   // 潰れた環（穴なら穴だけ消える）
			else if (r > 0 && tinyA2 && Math.abs(a2) < tinyA2) continue;   // 極小の穴は捨てる
			rings.push((r === 0) !== (a2 > 0) ? reversed(line) : line);
			if (r === 0) bb = rb; else { if (rb[0] < bb[0]) bb[0] = rb[0]; if (rb[1] < bb[1]) bb[1] = rb[1]; if (rb[2] > bb[2]) bb[2] = rb[2]; if (rb[3] > bb[3]) bb[3] = rb[3]; }
		}
		if (!rings.length) continue;
		splitToTiles(rings, 2, bb, z, extent, buffer, sinkPoly(fid, rings[0]), txRange, (tx0, tx1, ty0, ty1) => fullRanges.push(fid, tx0, tx1, ty0, ty1));
	}
	// 線
	if (ls) for (let p = 0; p < ls.length;) {
		const fid = ls[p++], ns = ls[p++];
		for (let s = 0; s < ns; s++) {
			const ac = ls[p++], idx = ls.subarray(p, p + ac); p += ac;
			const { line, bbox: lb } = concat(idx, false);
			if (line.length < 4) continue;
			if (tinyL && lb[2] - lb[0] < tinyL && lb[3] - lb[1] < tinyL) continue;   // このズームで閾値未満の短い線は落とす
			splitToTiles([line], 1, lb, z, extent, buffer, (tx, ty, parts) => { const t = tileOf(tx, ty); let l = t.lines.get(fid); if (!l) t.lines.set(fid, l = []); for (const q of parts) l.push(q); }, txRange);
		}
	}
	// 点：クリップ木を通さず、タイル座標のシフトで直接タイルへ振り分ける（バッファ帯は隣接タイルにも複製）。
	// 低ズームの間引き＝tippecanoe の -r と同じ考え方：z < maxZoom では fid のハッシュで dropRate^-(maxZoom-z) の割合だけ残す
	//（閾値がズームで単調＝残る点はズームを上げても消えない入れ子集合）。dropRate 1 で全点保持。
	const pointTiles = new Map();   // tile key → Map(fid → [x,y,…]) （fid 毎に束ねて MultiPoint）
	if (nPts) {
		const maxZoom = S.maxZoom ?? z, rate = S.dropRate ?? 1;
		const keepFrac = rate > 1 && z < maxZoom ? Math.pow(rate, -(maxZoom - z)) : 1;
		const keepMax = Math.floor(keepFrac * 4294967296);
		const nmaxT = (1 << z) - 1;
		const put = (tx, ty, fid, x, y) => {
			if (tx < txRange[0] || tx > txRange[1] || tx < 0 || tx > nmaxT || ty < 0 || ty > nmaxT) return;
			const key = tx * 4294967296 + ty;
			let m = pointTiles.get(key); if (!m) pointTiles.set(key, m = new Map());
			const l = m.get(fid); if (l) l.push(x, y); else m.set(fid, [x, y]);
		};
		for (let i = 0; i < nPts; i++) {
			const a = arcCount + i;
			if (!counts[a]) continue;
			const fid = point[i];
			if (keepFrac < 1 && (Math.imul(fid + 1, 0x9E3779B1) >>> 0) >= keepMax) continue;
			const o = offs[a], x = out[o * 2], y = out[o * 2 + 1];
			const tx = Math.floor(x / extent), ty = Math.floor(y / extent), lx = x - tx * extent, ly = y - ty * extent;
			put(tx, ty, fid, x, y);
			const dx = lx < buffer ? -1 : lx >= extent - buffer ? 1 : 0, dy = ly < buffer ? -1 : ly >= extent - buffer ? 1 : 0;
			if (dx) put(tx + dx, ty, fid, x, y);
			if (dy) put(tx, ty + dy, fid, x, y);
			if (dx && dy) put(tx + dx, ty + dy, fid, x, y);
		}
		for (const [key, m] of pointTiles) { const t = tileOf(Math.floor(key / 4294967296), key % 4294967296); for (const [fid, pts] of m) t.points.set(fid, pts); }
		pointTiles.clear();
	}
	// ── 全面塗り範囲：他の geometry が無いタイルは fid 毎の正準タイル（後段で 1 回だけ符号化）、あるタイルは矩形として合流
	const lo = -buffer, hi = extent + buffer, square = [lo, lo, hi, lo, hi, hi, lo, hi];
	const fullOnly = new Map();   // tile key → fid（このタイルは全面塗りだけ）
	for (let i = 0; i < fullRanges.length; i += 5) {
		const fid = fullRanges[i];
		for (let tx = fullRanges[i + 1]; tx <= fullRanges[i + 2]; tx++) for (let ty = fullRanges[i + 3]; ty <= fullRanges[i + 4]; ty++) {
			const key = tx * 4294967296 + ty, t = tileMap.get(key);
			if (t) { let l = t.polys.get(fid); if (!l) t.polys.set(fid, l = []); l.push([square.map((v, k) => v + (k & 1 ? ty : tx) * extent)]); }
			else if (fullOnly.has(key) && fullOnly.get(key) !== fid) { const t2 = tileOf(tx, ty); for (const f of [fullOnly.get(key), fid]) t2.polys.set(f, [[square.map((v, k) => v + (k & 1 ? ty : tx) * extent)]]); fullOnly.delete(key); }
			else fullOnly.set(key, fid);
		}
	}
	// ── タイル → MVT → 内容キー（同一内容は 1 回だけ持つ）
	const tiles = [], contents = new Map(), fullCache = new Map();
	const keyOf = (view) => {   // view は作業バッファ＝新規内容の時だけ複製
		let key = contentKey(view), n = 0, rec = contents.get(key);
		while (rec && !sameBytes(rec, view)) { key = key + "#" + (++n); rec = contents.get(key); }
		if (!rec) contents.set(key, view.slice());
		return key;
	};
	const isFullSquare = (r) => {
		if (r.length !== 8) return false;
		let mask = 0;
		for (let i = 0; i < 8; i += 2) { const x = r[i], y = r[i + 1]; if (x === lo && y === lo) mask |= 1; else if (x === hi && y === lo) mask |= 2; else if (x === hi && y === hi) mask |= 4; else if (x === lo && y === hi) mask |= 8; else return false; }
		return mask === 15 && Math.abs(signedArea2(r)) === 2 * (hi - lo) * (hi - lo);
	};
	const fullKey = (fid) => { let key = fullCache.get(fid); if (!key) { const v = encodeSingle(layerName, extent, fid, 3, [[square]], attrOf(fid)); key = keyOf(v); fullCache.set(fid, key); } return key; };
	for (const [key, fid] of fullOnly) tiles.push({ id: zxyToTileId(z, Math.floor(key / 4294967296), key % 4294967296), key: fullKey(fid) });
	for (const t of tileMap.values()) {
		const ox = t.tx * extent, oy = t.ty * extent;
		const local = (a) => { const o = new Int32Array(a.length); for (let i = 0; i < a.length; i += 2) { o[i] = Math.round(a[i] - ox); o[i + 1] = Math.round(a[i + 1] - oy); } return o; };
		const id = zxyToTileId(z, t.tx, t.ty);
		const nf = t.polys.size + t.lines.size + t.points.size;
		if (nf === 1) {   // 1 feature（大半）＝属性節は fid キャッシュ
			let view;
			if (t.polys.size) {
				const [fid, polys] = t.polys.entries().next().value;
				if (polys.length === 1 && polys[0].length === 1) { const r = local(polys[0][0]); if (isFullSquare(r)) { tiles.push({ id, key: fullKey(fid) }); continue; } }
				view = encodeSingle(layerName, extent, fid, 3, polys.map(rings => rings.map(local)), attrOf(fid));
			} else if (t.lines.size) { const [fid, lines] = t.lines.entries().next().value; view = encodeSingle(layerName, extent, fid, 2, lines.map(local), attrOf(fid)); }
			else { const [fid, pts] = t.points.entries().next().value; view = encodeSingle(layerName, extent, fid, 1, local(pts), attrOf(fid)); }
			if (view) tiles.push({ id, key: keyOf(view) });
			continue;
		}
		const features = [];
		for (const [fid, polys] of t.polys) features.push({ id: fid, type: 3, tags: tagsOf(fid), geometry: polys.map(rings => rings.map(local)) });
		for (const [fid, lines] of t.lines) features.push({ id: fid, type: 2, tags: tagsOf(fid), geometry: lines.map(local) });
		for (const [fid, pts] of t.points) features.push({ id: fid, type: 1, tags: tagsOf(fid), geometry: local(pts) });
		const view = encodeTile({ name: layerName, extent, features });
		if (!view) continue;   // 退化して feature が残らないタイルは書かない
		tiles.push({ id, key: keyOf(view) });
	}
	return { tiles, contents: [...contents] };
}
