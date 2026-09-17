// コロプレス（国単位＝world の key）：items（NationDB の国の並び）→ 国番号ごとの RGBA 塗り表（renderer.setPaint）＋凡例。
// 塗りは GPU の国 ID バッファで画素ごとに引く＝色を変えても再ベイクなし（表 1 枚の差し替えだけ）。
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// 連続量＝明→暗の単色相寄りランプ（紙の上で静かに読める側）。分類数に合わせて補間
export const RAMPS = {
	diverging: ["#2b5f93", "#6e9fc6", "#c9dcea", "#f3f1ee", "#eebf8a", "#d27838", "#8a3d17"],   // 負↔正（青↔橙・中央は紙）
	blue: ["#eef4f8", "#c9dcea", "#9dc0db", "#6e9fc6", "#467eaf", "#2b5f93", "#18426f"],
	green: ["#f2f6ec", "#d6e7c4", "#b2d49b", "#86bb72", "#5b9d52", "#3a7c3c", "#225c2b"],
	orange: ["#fbf3e8", "#f5dcbc", "#eebf8a", "#e39c5b", "#d27838", "#b35724", "#8a3d17"],
	purple: ["#f5f2f8", "#ded5ea", "#c2b1d8", "#a38bc3", "#8466ab", "#66478f", "#4a2e70"],
};
// 質的（大陸・所得帯など）＝彩度を落とした 10 色
export const CATEGORICAL = ["#7fa7c9", "#e0a96d", "#8fbf8a", "#d98c8c", "#b39ddb", "#c9b27c", "#80c4c0", "#e3a3c7", "#a3a3a3", "#c4d67a"];
// 政治地図＝隣国が同色にならない色番号（nations.js colorGraph）→ この色
export const POLITICAL = ["#f3d9b1", "#cfe0bf", "#f6c9c4", "#d7d0ea", "#f7ecb0", "#c6dde8", "#e9cfe0", "#dcd2bd", "#c9e5d6", "#f0d0b6", "#d5d9e8", "#e8e0c8", "#cfd8c4"];

function rampColors(ramp, n) {
	const stops = ramp.map(hex);
	return Array.from({ length: n }, (_, i) => {
		const t = n === 1 ? 1 : i / (n - 1), x = t * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), f = x - k;
		return stops[k].map((v, c) => Math.round(v + (stops[k + 1][c] - v) * f));
	});
}

// 属性名は大小無視で引く（bucket 版と shp 版で大文字/小文字が揺れる）
export function field(props, name) {
	if (name in props) return props[name];
	const lo = name.toLowerCase();
	for (const k in props) if (k.toLowerCase() === lo) return props[k];
	return undefined;
}

const fmt = v => {
	const a = Math.abs(v);
	if (a >= 1e9) return (v / 1e9).toFixed(a >= 1e10 ? 0 : 1) + "B";
	if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + "M";
	if (a >= 1e3) return (v / 1e3).toFixed(a >= 1e4 ? 0 : 1) + "k";
	return String(a >= 100 ? Math.round(v) : Math.round(v * 100) / 100);
};

// opts:
//   value: (item, index, year) => number | string | null
//   type: "quantile" | "equal" | "diverging" | "categorical" | "political"（political＝値そのものを 1..13 の色番号として使う）
//   scale: "log"（equal の区切りを対数で＝桁が広い値）・classes: 分類数（連続量）・ramp: RAMPS のキー or 色配列・colors: 質的の色配列
//   format: 凡例の数値書式・year: value に渡す年（DB の統計）
//   戻り .nodata＝値の無い件数（凡例の「No data」行）
export function buildChoropleth(items, opts) {
	const n = items.length, rgba = new Uint8Array(n * 4), values = new Array(n);
	for (let i = 0; i < n; i++) { const v = opts.value(items[i] || {}, i, opts.year); values[i] = v; }
	const legend = [];
	const put = (i, c) => { rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = 255; };

	if (opts.type === "categorical" || opts.type === "political") {
		const pal = (opts.colors || (opts.type === "political" ? POLITICAL : CATEGORICAL)).map(c => typeof c === "string" ? hex(c) : c);
		const cats = [...new Set(values.filter(v => v != null && v !== ""))].sort((a, b) => String(a).localeCompare(String(b), "en", { numeric: true }));
		const idx = new Map(cats.map((c, k) => [c, opts.type === "political" ? (Math.max(1, +c) - 1) % pal.length : k % pal.length]));
		values.forEach((v, i) => { if (idx.has(v)) put(i, pal[idx.get(v)]); });
		if (opts.type === "categorical") for (const c of cats) legend.push({ color: pal[idx.get(c)], label: String(c).replace(/^\d+\.\s*/, "") });
		return { rgba, legend, values, nodata: values.filter(v => v == null || v === "").length };
	}

	const nums = values.map((v, i) => [typeof v === "number" && Number.isFinite(v) ? v : NaN, i]).filter(([v]) => !Number.isNaN(v));
	const nodata = n - nums.length;
	if (!nums.length) return { rgba, legend, values, nodata };
	const sorted = nums.map(([v]) => v).sort((a, b) => a - b);
	// 発散：0 を中央に左右対称の等間隔（段数は奇数）＝増減率・偏差など正負をまたぐ値
	if (opts.type === "diverging") {
		let k = Math.max(3, Math.min(9, opts.classes || 7)); if (k % 2 === 0) k++;
		const amp = Math.max(Math.abs(sorted[0]), Math.abs(sorted[sorted.length - 1])) || 1, step = 2 * amp / k;
		const cols = rampColors(RAMPS.diverging, k), f = opts.format || fmt;
		const classOf = v => Math.min(k - 1, Math.max(0, Math.floor((v + amp) / step)));
		for (const [v, i] of nums) put(i, cols[classOf(v)]);
		for (let c = 0; c < k; c++) legend.push({ color: cols[c], label: `${f(-amp + c * step)} – ${f(-amp + (c + 1) * step)}` });
		return { rgba, legend, values, nodata };
	}
	const distinct = new Set(sorted).size;   // 値の種類より多い分類は作らない（少数行の CSV で「2.7k – 2.7k」が並ぶのを防ぐ）
	let k = Math.max(1, Math.min(9, opts.classes || 7, distinct <= (opts.classes || 7) ? Math.max(1, distinct - 1) : distinct));   // 値の種類が段数以下なら 1 段減らす＝末尾の「50 – 50」を作らない
	let breaks;   // k-1 個の上限
	if (opts.type === "equal") {
		const lo = sorted[0], hi = sorted[sorted.length - 1];
		if (opts.scale === "log" && lo > 0) { const a = Math.log10(lo), b = Math.log10(hi); breaks = Array.from({ length: k - 1 }, (_, j) => Math.pow(10, a + (b - a) * (j + 1) / k)); }   // 対数の等間隔＝桁が広い値（GDP・人口）
		else breaks = Array.from({ length: k - 1 }, (_, j) => lo + (hi - lo) * (j + 1) / k);
	} else {
		breaks = Array.from({ length: k - 1 }, (_, j) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * (j + 1) / k))]);
		breaks = [...new Set(breaks)].filter(b => b > sorted[0]);   // 同値の区切りを畳む（分位が同じ値に落ちた時）
		k = breaks.length + 1;
	}
	const cols = Array.isArray(opts.ramp) ? opts.ramp.map(c => typeof c === "string" ? hex(c) : c) : rampColors(RAMPS[opts.ramp || "blue"], Math.max(2, k));
	const classOf = v => { let c = 0; while (c < breaks.length && v >= breaks[c]) c++; return c; };
	for (const [v, i] of nums) put(i, cols[Math.min(cols.length - 1, classOf(v))]);
	const f = opts.format || fmt;
	for (let c = 0; c < k; c++) {
		const lo = c === 0 ? sorted[0] : breaks[c - 1], hi = c === k - 1 ? sorted[sorted.length - 1] : breaks[c];
		legend.push({ color: cols[Math.min(cols.length - 1, c)], label: `${f(lo)} – ${f(hi)}` });
	}
	return { rgba, legend, values, nodata };
}
