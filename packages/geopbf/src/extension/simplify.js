import { gint } from "./gint.js";

// GintBUF の VW ランク（GPU LOD が使うのと同じ重み）でデータそのものを間引いた
// FeatureCollection を返す。描画用ではなく「答えるための専用データ」（identify・突合・
// 座標→市区町村の逆引き等）を焼く用途＝ minRank を上げるほど粗く・小さくなる。
// 接合点・arc端点（L1=TERMINAL_BIT）は常に保持されるため隣接位相は壊れない。
// 目安: minRank ≈ 1.5×log2(許容面積) + 61.5 → 21≈z14(誤差~10m) / 24≈z13(~20m) / 27≈z12(~40m)
export function simplified(self, minRank = 0) {
	const d = self.unPackGint;
	if (!d?.arcBuffer || !d.arcMeta) return null;
	const { arcBuffer, arcMeta, polyStream, lineStream } = d;
	const INV = gint.INV_SCALE_E;
	const r7 = v => Math.round(v * 1e7) / 1e7;
	const cache = new Map(), cacheFull = new Map();
	const arcPts = (aid, rank, tub) => {
		let pts = tub.get(aid);
		if (pts) return pts;
		const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
		pts = [];
		for (let k = 0; k < len; k++) {
			const m = arcBuffer[off + k];
			if (k !== 0 && k !== len - 1) {
				const w = (m & gint.TERMINAL_BIT) ? 63 : Number(m & gint.WEIGHT_MASK);
				if (w < rank) continue;
			}
			const [ix, iy] = gint.unpackToInt(m);
			pts.push([r7(ix * INV - 180), r7(iy * INV - 90)]);
		}
		tub.set(aid, pts);
		return pts;
	};
	const chain = (arcIdxs, rank, tub) => {
		const out = [];
		for (const ai of arcIdxs) {
			let seg = arcPts(ai < 0 ? ~ai : ai, rank, tub);
			if (ai < 0) seg = seg.slice().reverse();
			if (out.length) out.pop();   // 連結点の重複を除く
			out.push(...seg);
		}
		if (out.length && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1]))
			out.push(out[0]);
		return out;
	};
	const features = [];
	if (polyStream?.length) {
		const byFid = new Map();
		let p = 0;
		while (p < polyStream.length) {
			const fid = polyStream[p++], nr = polyStream[p++], comp = [];
			for (let r = 0; r < nr; r++) {
				const na = polyStream[p++], arcs = [];
				for (let a = 0; a < na; a++) arcs.push(polyStream[p++]);
				let ring = chain(arcs, minRank, cache);
				// 間引きすぎて退化したリングは全点で再構成（小島の市区町村が消えるのを防ぐ）
				if (ring.length < 4) ring = chain(arcs, 0, cacheFull);
				if (ring.length >= 4) comp.push(ring);
			}
			if (comp.length) {
				let comps = byFid.get(fid);
				if (!comps) { comps = []; byFid.set(fid, comps); }
				comps.push(comp);
			}
		}
		for (const [fid, polys] of byFid) features.push({
			type: "Feature",
			properties: self.getProperties(fid) ?? {},
			geometry: polys.length === 1
				? { type: "Polygon", coordinates: polys[0] }
				: { type: "MultiPolygon", coordinates: polys },
		});
	}
	if (lineStream?.length) {
		let p = 0;
		const byFid = new Map();
		while (p < lineStream.length) {
			const fid = lineStream[p++], ns = lineStream[p++], sets = [];
			for (let s = 0; s < ns; s++) {
				const na = lineStream[p++], arcs = [];
				for (let a = 0; a < na; a++) arcs.push(lineStream[p++]);
				const line = [];
				for (const ai of arcs) {
					let seg = arcPts(ai < 0 ? ~ai : ai, minRank, cache);
					if (ai < 0) seg = seg.slice().reverse();
					if (line.length) line.pop();
					line.push(...seg);
				}
				if (line.length >= 2) sets.push(line);
			}
			if (sets.length) {
				let arr = byFid.get(fid);
				if (!arr) { arr = []; byFid.set(fid, arr); }
				arr.push(...sets);
			}
		}
		for (const [fid, lines] of byFid) features.push({
			type: "Feature",
			properties: self.getProperties(fid) ?? {},
			geometry: lines.length === 1
				? { type: "LineString", coordinates: lines[0] }
				: { type: "MultiLineString", coordinates: lines },
		});
	}
	return { type: "FeatureCollection", features };
}
