// CSS色文字列 → [r,g,b,a] (0..1 float)。style の rgba()/rgb()/#hex を GL uniform 用に変換。
const NAMED = { transparent: [0, 0, 0, 0], white: [1, 1, 1, 1], black: [0, 0, 0, 1] };

// メモ化：style の色は少数の文字列に猛烈に重複する（feature 毎に同じ trim/regex/parseInt を繰り返していた）。
// 戻り値は共有・凍結配列＝呼び出し側は非破壊で読むだけ（NAMED も従来から共有配列を返している前提と同じ）。
// 凍結で万一の破壊代入を早期顕在化。distinct 色文字列は style 由来で有界＝上限不要。
const memo = new Map();
export function parseRGBA(s) {
	if (Array.isArray(s)) return s;
	if (typeof s !== "string") return [0, 0, 0, 1];
	let hit = memo.get(s);
	if (hit !== undefined) return hit;
	hit = Object.freeze(compute(s));
	memo.set(s, hit);
	return hit;
}

function compute(s) {
	const key = s.trim().toLowerCase();
	if (NAMED[key]) return NAMED[key];
	let m = key.match(/rgba?\(([^)]+)\)/);
	if (m) { const p = m[1].split(",").map(x => parseFloat(x)); return [p[0] / 255, p[1] / 255, p[2] / 255, p[3] == null ? 1 : p[3]]; }
	m = key.match(/^#([0-9a-f]{3,8})$/);
	if (m) {
		let h = m[1]; if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join("");
		return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255, h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
	}
	return [0, 0, 0, 1];
}
