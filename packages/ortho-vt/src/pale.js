// pale（淡色）生成：地理院は optimal_bvmap 用の pale スタイルを配布していないため、
// std.json の色を「彩度↓＋白寄せ」変換して淡色を作る。色は全て rgba/hex 文字列なので描画時に一律変換する。
// パラメータは PoC で公式淡色ラスタと突き合わせて調整する（既定値は暫定）。

export function makePale({ sat = 0.35, lite = 0.45 } = {}) {
	return color => transform(color, sat, lite);
}

function parseColor(s) {
	if (typeof s !== "string") return null;
	let m = s.match(/rgba?\(([^)]+)\)/i);
	if (m) { const p = m[1].split(",").map(x => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p[3] == null ? 1 : p[3] }; }
	m = s.match(/^#([0-9a-f]{3,8})$/i);
	if (m) {
		let h = m[1]; if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join("");
		return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
	}
	return null;
}

function transform(color, sat, lite) {
	const c = parseColor(color); if (!c) return color;
	let { r, g, b, a } = c; r /= 255; g /= 255; b /= 255;
	const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
	let h = 0, s = 0;
	if (d) {
		s = d / (1 - Math.abs(2 * l - 1));
		h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
		h *= 60; if (h < 0) h += 360;
	}
	s *= sat; const L = l + (1 - l) * lite;
	const C = (1 - Math.abs(2 * L - 1)) * s, X = C * (1 - Math.abs((h / 60) % 2 - 1)), mM = L - C / 2;
	let R, G, B; const hh = h / 60;
	if (hh < 1) [R, G, B] = [C, X, 0]; else if (hh < 2) [R, G, B] = [X, C, 0]; else if (hh < 3) [R, G, B] = [0, C, X];
	else if (hh < 4) [R, G, B] = [0, X, C]; else if (hh < 5) [R, G, B] = [X, 0, C]; else [R, G, B] = [C, 0, X];
	return `rgba(${Math.round((R + mM) * 255)},${Math.round((G + mM) * 255)},${Math.round((B + mM) * 255)},${a})`;
}
