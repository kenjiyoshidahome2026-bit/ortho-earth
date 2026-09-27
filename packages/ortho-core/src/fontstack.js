// MapLibre の text-font（フォントスタック名の列＝"Noto Sans Bold"・"Open Sans Semibold"・"Noto Sans Italic"…）を CSS の書体へ写す（段 2・2026-09-28）。
// 本人裁定 (b)＝glyph PBF は描かず、Canvas2D の font に family／weight／style で据える。名前の末尾の語（Bold/Italic/Semibold/Light…）を weight/style に、残りを family に。
// 複数の名前＝family の列（先に書いた物が勝つ＝CSS のフォールバックと同じ）。weight/style は最初の名前から。無い書体はブラウザが落とす＝末尾にエンジンの既定の束（CJK の質）を足す。
const WEIGHTS = { thin: 100, hairline: 100, extralight: 200, ultralight: 200, light: 300, regular: 400, normal: 400, book: 400, medium: 500, semibold: 600, demibold: 600, bold: 700, extrabold: 800, ultrabold: 800, black: 900, heavy: 900 };
const STYLES = { italic: "italic", oblique: "oblique" };
export function parseFontStack(names) {
	const list = Array.isArray(names) ? names.filter(x => typeof x === "string" && x.trim()) : typeof names === "string" && names.trim() ? [names] : [];
	if (!list.length) return null;
	const fam = [], seen = new Set(); let w = null, st = null;
	for (const raw of list) {
		const words = raw.trim().split(/[\s_-]+/);
		let f = words.slice();
		// 末尾から weight/style の語を剥ぐ（"Noto Sans Bold Italic"・"Open Sans Semibold"・"Metropolis Regular"）。"Sans"/"Serif" は family の一部
		while (f.length > 1) {
			const k = f[f.length - 1].toLowerCase();
			if (k in WEIGHTS) { if (w == null) w = WEIGHTS[k]; f.pop(); continue; }
			if (k in STYLES) { if (st == null) st = STYLES[k]; f.pop(); continue; }
			if (k === "condensed" || k === "narrow" || k === "expanded") { f.pop(); continue; }   // 幅の語＝CSS の font-stretch は Canvas2D の font 文字列に置けない＝捨てる
			break;
		}
		const family = f.join(" ");
		if (!seen.has(family)) { seen.add(family); fam.push(family); }
	}
	return { fam, w: w ?? 400, st: st ?? "normal" };
}
// Canvas2D の ctx.font（"italic 700 14px "Noto Sans","Open Sans",<既定の束>"）
export const fontCss = (f, size, fallback) => `${f?.st && f.st !== "normal" ? f.st + " " : ""}${f?.w && f.w !== 400 ? f.w + " " : ""}${size}px ${f?.fam?.length ? f.fam.map(x => `"${x.replace(/"/g, "")}"`).join(",") + "," : ""}${fallback}`;
