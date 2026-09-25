// Unicode → Shift_JIS（WHATWG の shift_jis＝Windows-31J）の書き手。依存ゼロ（2026-09-25・B8）。
// 旧＝実行時に esm.sh から encoding-japanese を取っていた（オフライン・CSP・供給網の穴）。
// TextDecoder("shift_jis") は読めても書けない → 2 バイト符号の全域を初回に一度だけ読んで逆引き表を作る（約 7,900 字）。
// 規則は WHATWG の Shift_JIS encoder と同じ：
//  ・同じ字に符号が 2 つある所は NEC 選定 IBM 拡張（0xED/0xEE 行）を除外し、残りは先に出た方を取る
//  ・外字（0xF0–0xF9 行＝私用領域）は書かない
//  ・U+00A5 → 0x5C、U+203E → 0x7E、半角カナ U+FF61–FF9F → 0xA1–0xDF
//  ・JIS 系／MS 系で字が割れる 8 組（〜／～、−／－、¢／￠ など）はどちらも同じ符号（build() 末尾）
// 表に無い字（絵文字・簡体字など）は "?"（0x3F）。TextDecoder("shift_jis") で読み戻すと上の置き換え以外は元に戻る。
// 表は実行環境の TextDecoder から作る＝ブラウザ（WHATWG）と Node（ICU）で同じ結果になることを t-sjis が突き合わせる。
let table = null;

const build = () => {
	const dec = new TextDecoder("shift_jis"), m = new Map(), b = new Uint8Array(2);
	for (let lead = 0x81; lead <= 0xFC; lead++) {
		if ((lead >= 0xA0 && lead <= 0xDF) || lead === 0xED || lead === 0xEE || (lead >= 0xF0 && lead <= 0xF9)) continue;
		for (let trail = 0x40; trail <= 0xFC; trail++) {
			if (trail === 0x7F) continue;
			b[0] = lead; b[1] = trail;
			const s = dec.decode(b);
			if (s.length !== 1 || s === "�") continue;
			const c = s.charCodeAt(0);
			if (!m.has(c)) m.set(c, (lead << 8) | trail);
		}
	}
	// JIS 系と MS 系で字が割れる所は両方を同じ符号へ＝どちらで書いても "?" にしない。
	// 読み手ごとに片方しか出さない（ブラウザ＝WHATWG は 0x8191 を ￠、Node＝ICU は ¢ と読む）ので、表の出自に依らず揃える。
	for (const [a, b] of [[0xA2, 0xFFE0], [0xA3, 0xFFE1], [0xAC, 0xFFE2], [0xA6, 0xFFE4],
		[0x2016, 0x2225], [0x2014, 0x2015], [0x301C, 0xFF5E], [0x2212, 0xFF0D]]) {
		if (m.has(a) && !m.has(b)) m.set(b, m.get(a));
		else if (m.has(b) && !m.has(a)) m.set(a, m.get(b));
	}
	return m;
};

export function encodeSJIS(str) {
	table ??= build();
	const out = new Uint8Array(str.length * 2);
	let n = 0;
	for (const ch of str) {
		let c = ch.codePointAt(0);
		if (c <= 0x80) { out[n++] = c; continue; }
		if (c === 0xA5) { out[n++] = 0x5C; continue; }
		if (c === 0x203E) { out[n++] = 0x7E; continue; }
		if (c >= 0xFF61 && c <= 0xFF9F) { out[n++] = c - 0xFF61 + 0xA1; continue; }
		const p = table.get(c);
		if (p === undefined) { out[n++] = 0x3F; continue; }
		out[n++] = p >> 8; out[n++] = p & 0xFF;
	}
	return out.slice(0, n);
}
