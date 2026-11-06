// 静岡県の点群の頁の図郭を並べる時の純関数（2026-11-07・node の検定 tests/t-pc-sheet.mjs）。
//   隣の図郭（neighborCodes）・隣の縁の点を借りる（borrowEdge＝継ぎ目を消す）・分類で落とす（filterClasses）・分類の組（CLASS_GROUPS）。
// 借りる考え方＝変換（@ortho-earth/splat の cloud）は図郭ごとに格子でまとめるので、縁のセルは片側の点だけになり中心が内側へ寄る（粗い段ほど大きい＝隣との間に隙間）。
//   隣の点のうち自分の範囲の外 margin m までを、自分の錨の東北上に置き直して末尾に足す（ghost＝その数）。splat の側が借りた点だけのセルを捨てる（dropGhostCells）。
//   置き直しは dumpEnu（エンジン）と同じ式＝東北上 ⇄ 経緯度は錨の所の線形・上は丸みの落ち込み (e²+n²)/(2R) を引く（図郭の 400 m で 1 mm 以下）。
import { sheetBox, sheetAt } from "./pointcloud-sheets.ts";

/** 頁が扱う点群の点（map.readPointCloud の PointCloudDump から使う欄だけ）。ghost＝末尾の借りた点の数 */
export interface EdgePoints { n: number; pts: Float32Array; elev: Float32Array; rgb: Uint8Array | null; intensity: Uint16Array; cls: Uint8Array }
export interface SheetPoints extends EdgePoints { anchor: [number, number, number]; bb: number[]; ghost?: number }

/** 分類の組（ASPRS の番号）＝頁の切り替え。other＝どの組にも入らない番号（0 未分類・1 未割当・7 低い点 など） */
export const CLASS_GROUPS: ReadonlyArray<{ id: string; label: string; classes: readonly number[] }> = [
	{ id: "ground", label: "Ground", classes: [2] },
	{ id: "vegetation", label: "Vegetation", classes: [3, 4, 5] },
	{ id: "building", label: "Buildings", classes: [6] },
	{ id: "water", label: "Water", classes: [9] },
	{ id: "road", label: "Roads, rails and bridges", classes: [10, 11, 17] },
	{ id: "other", label: "Other classes", classes: [] },
];
/** 選んだ組 → 残す分類の表（256 の印）。全部選んだ＝null（落とさない） */
export function classKeep(ids: readonly string[]): Uint8Array | null {
	if (CLASS_GROUPS.every(g => ids.includes(g.id))) return null;
	const keep = new Uint8Array(256), named = new Set(CLASS_GROUPS.flatMap(g => g.classes));
	for (const g of CLASS_GROUPS) if (ids.includes(g.id)) { if (g.id === "other") { for (let c = 0; c < 256; c++) if (!named.has(c)) keep[c] = 1; } else for (const c of g.classes) keep[c] = 1; }
	return keep;
}

/** 分類で落とす（keep＝classKeep・null＝そのまま返す）。借りた点（末尾 ghost）も同じ順で落とし、ghost の数を合わせる。bb は残った自分の点から */
export function filterClasses<T extends SheetPoints>(d: T, keep: Uint8Array | null): T {
	if (!keep) return d;
	const ghost = d.ghost ?? 0, own = d.n - ghost;
	let m = 0, mg = 0; for (let i = 0; i < d.n; i++) if (keep[d.cls[i]]) { m++; if (i >= own) mg++; }
	const pts = new Float32Array(m * 3), elev = new Float32Array(m), rgb = d.rgb ? new Uint8Array(m * 3) : null, intensity = new Uint16Array(m), cls = new Uint8Array(m);
	const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (let i = 0, j = 0; i < d.n; i++) {
		if (!keep[d.cls[i]]) continue;
		for (let k = 0; k < 3; k++) { const v = d.pts[i * 3 + k]; pts[j * 3 + k] = v; if (i < own) { if (v < bb[k]) bb[k] = v; if (v > bb[k + 3]) bb[k + 3] = v; } }
		elev[j] = d.elev[i]; intensity[j] = d.intensity[i]; cls[j] = d.cls[i];
		if (rgb) { rgb[j * 3] = d.rgb![i * 3]; rgb[j * 3 + 1] = d.rgb![i * 3 + 1]; rgb[j * 3 + 2] = d.rgb![i * 3 + 2]; }
		j++;
	}
	if (m - mg === 0) bb.fill(0);
	return { ...d, n: m, pts, elev, rgb, intensity, cls, bb, ghost: mg };
}

/** 隣の図郭（500＝400 m × 300 m の 8 近傍・県の範囲の外は除く） */
export function neighborCodes(code: string): string[] {
	const b = sheetBox(code); if (!b) return [];
	const w = b[2] - b[0], h = b[3] - b[1], cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, out: string[] = [];
	for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) { if (!dx && !dy) continue; const c = sheetAt(cx + dx * w, cy + dy * h, "500"); if (c && c !== code) out.push(c); }
	return out;
}

/** 借りる幅（m）＝最も粗い段のセルの目安（範囲の 1/16）＝4〜40 m */
export const edgeMargin = (bb: readonly number[]): number => Math.max(4, Math.min(40, Math.max(bb[3] - bb[0], bb[4] - bb[1]) / 16));

const R = 6371000, D2R = Math.PI / 180;
/** 隣（from）の点のうち、自分（own）の範囲（東北の bb）の外で margin m 以内の物を自分の錨の東北上に置き直す → 借りた点の列（ghost 用） */
export function edgePoints(own: Pick<SheetPoints, "anchor" | "bb">, from: SheetPoints, margin: number): EdgePoints {
	const [lon0, lat0, h0] = own.anchor, ce = Math.cos(lat0 * D2R) * D2R * R, cn = D2R * R;
	const [lonB, latB] = from.anchor, ceB = Math.cos(latB * D2R) * D2R * R;
	const x0 = own.bb[0], y0 = own.bb[1], x1 = own.bb[3], y1 = own.bb[4];
	const idx: number[] = [], P: number[] = [];
	const fn = from.n - (from.ghost ?? 0);   // 隣が借りていた点は借りない
	for (let i = 0; i < fn; i++) {
		const lon = lonB + from.pts[i * 3] / ceB, lat = latB + from.pts[i * 3 + 1] / cn, e = (lon - lon0) * ce, nn = (lat - lat0) * cn;
		if (e < x0 - margin || e > x1 + margin || nn < y0 - margin || nn > y1 + margin) continue;
		if (e >= x0 && e <= x1 && nn >= y0 && nn <= y1) continue;   // 重なり（自分の範囲の内）は自分の点だけ
		idx.push(i); P.push(e, nn, from.elev[i] - h0 - (e * e + nn * nn) / (2 * R));
	}
	const m = idx.length, rgb = from.rgb ? new Uint8Array(m * 3) : null, elev = new Float32Array(m), intensity = new Uint16Array(m), cls = new Uint8Array(m);
	for (let j = 0; j < m; j++) { const i = idx[j]; elev[j] = from.elev[i]; intensity[j] = from.intensity[i]; cls[j] = from.cls[i]; if (rgb) { rgb[j * 3] = from.rgb![i * 3]; rgb[j * 3 + 1] = from.rgb![i * 3 + 1]; rgb[j * 3 + 2] = from.rgb![i * 3 + 2]; } }
	return { n: m, pts: new Float32Array(P), elev, rgb, intensity, cls };
}

/** 自分の点の末尾に借りた点を足す（ghost＝その数）。RGB の有る無しが違う時は RGB を落とす（色は標高などで塗る） */
export function withGhosts<T extends SheetPoints>(own: T, edges: ReadonlyArray<EdgePoints>): T {
	const parts = edges.filter(e => e.n > 0);
	if (!parts.length) return { ...own, ghost: 0 };
	const g = parts.reduce((a, e) => a + e.n, 0), n = own.n + g, hasRgb = !!own.rgb && parts.every(e => e.rgb);
	const pts = new Float32Array(n * 3), elev = new Float32Array(n), rgb = hasRgb ? new Uint8Array(n * 3) : null, intensity = new Uint16Array(n), cls = new Uint8Array(n);
	let at = 0;
	for (const e of [own as EdgePoints, ...parts]) {
		pts.set(e.pts.subarray(0, e.n * 3), at * 3); elev.set(e.elev.subarray(0, e.n), at); intensity.set(e.intensity.subarray(0, e.n), at); cls.set(e.cls.subarray(0, e.n), at);
		if (rgb) rgb.set(e.rgb!.subarray(0, e.n * 3), at * 3);
		at += e.n;
	}
	return { ...own, n, pts, elev, rgb, intensity, cls, ghost: g };
}
