// 字の SDF（符号付き距離場）と字の版の棚詰め＝テキスト GPU 化 T-P1（`text gpu plan.md` §2）。純関数＝node で検定する（tests/sdf.mjs）。
// 元の絵は Canvas2D で焼いた字の不透明度（白黒・アンチエイリアス込み）。距離は Felzenszwalb の 1 次元 EDT を縦横 2 回（TinySDF と同じ手）。
// 符号化も TinySDF と同じ：v = 1 − (d / R + CUTOFF)（d＝縁からの距離・外が正・単位は版の px）＝縁は v = 1 − CUTOFF。
// 外へ R·(1−CUTOFF)、内へ R·CUTOFF まで表せる＝縁（halo）の太さの上限は外の幅（MapLibre と同じ制約）

/** 版の字の基準の大きさ（px）・字の周りの余白（px）・距離の幅 R・縁の位置 */
export const SDF_BASE = 32, SDF_PAD = 6, SDF_R = 8, SDF_CUTOFF = 0.25;
const INF = 1e20;

// 1 次元の二乗距離変換（f の下側包絡＝放物線の列）。f・d は長さ n 以上・v・z は作業用
function edt1d(f: Float64Array, d: Float64Array, v: Uint16Array, z: Float64Array, n: number) {
	v[0] = 0; z[0] = -INF; z[1] = INF;
	for (let q = 1, k = 0; q < n; q++) {
		let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
		while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
		k++; v[k] = q; z[k] = s; z[k + 1] = INF;
	}
	for (let q = 0, k = 0; q < n; q++) {
		while (z[k + 1] < q) k++;
		const r = q - v[k];
		d[q] = f[v[k]] + r * r;
	}
}
// 2 次元（行ごと→列ごと）。grid は 0（種）か INF・答えは二乗距離で上書き
function edt2d(grid: Float64Array, w: number, h: number) {
	const n = Math.max(w, h), f = new Float64Array(n), d = new Float64Array(n), v = new Uint16Array(n), z = new Float64Array(n + 1);
	for (let x = 0; x < w; x++) {
		for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
		edt1d(f, d, v, z, h);
		for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
	}
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
		edt1d(f, d, v, z, w);
		for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
	}
}

/** 不透明度（0〜255・w×h）から SDF（0〜255）。半端な画素（アンチエイリアスの縁）は TinySDF と同じく縁までの小数の距離として種にする */
export function sdfFromAlpha(alpha: ArrayLike<number>, w: number, h: number, R = SDF_R, cutoff = SDF_CUTOFF, out = new Uint8Array(w * h)): Uint8Array {
	const n = w * h, outer = new Float64Array(n), inner = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const a = alpha[i] / 255;
		if (a >= 1) { outer[i] = 0; inner[i] = INF; }
		else if (a <= 0) { outer[i] = INF; inner[i] = 0; }
		else { const d = 0.5 - a; outer[i] = d > 0 ? d * d : 0; inner[i] = d < 0 ? d * d : 0; }
	}
	edt2d(outer, w, h); edt2d(inner, w, h);
	for (let i = 0; i < n; i++) {
		const d = Math.sqrt(outer[i]) - Math.sqrt(inner[i]);   // 外が正
		out[i] = Math.max(0, Math.min(255, Math.round(255 - 255 * (d / R + cutoff))));
	}
	return out;
}
/** SDF の値（0〜255）→ 縁からの距離（版の px・外が正）＝シェーダと同じ式（検定用） */
export const sdfDist = (v: number, R = SDF_R, cutoff = SDF_CUTOFF) => (1 - cutoff - v / 255) * R;

/** 棚詰め（左から右・溢れたら次の段）。add＝置いた左上か null（入らない）・reset(size, y0)＝広さを変えて y0 の段から詰め直す */
export interface Shelf { readonly size: number; add(w: number, h: number): [number, number] | null; reset(size?: number, y0?: number): void }
export function shelfPacker(size: number, gap = 1): Shelf {
	let x = gap, y = gap, rowH = 0;
	return {
		get size() { return size; },
		add(w, h) {
			if (w + 2 * gap > size || h + 2 * gap > size) return null;
			if (x + w + gap > size) { x = gap; y += rowH + gap; rowH = 0; }
			if (y + h + gap > size) return null;
			const at: [number, number] = [x, y];
			x += w + gap; if (h > rowH) rowH = h;
			return at;
		},
		reset(s = size, y0 = gap) { size = s; x = gap; y = y0; rowH = 0; },
	};
}

/** 書体の文字列の大きさを基準へ（"bold 12.5px Noto" → "bold 32px Noto"）。返り＝[基準の書体, 元の px]（大きさが無ければ 16px とみなす） */
export function baseFont(font: string, pxOf: (s: string) => string | undefined, base = SDF_BASE): [string, number] {
	const n = pxOf(font);
	if (n === undefined) return [`${base}px ${font}`, 16];
	const i = font.indexOf(n + "px");
	return [font.slice(0, i) + base + "px" + font.slice(i + n.length + 2), parseFloat(n)];
}
