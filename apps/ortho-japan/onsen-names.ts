// 温泉の名前を 26 言語に（台帳のよみ r＝ひらがな から各言語の文字へ音写する・外への依存なし）
//   onsenName("ru", "じょうざんけいおんせん") → "Дзёдзанкэй Онсэн"
// 決め事
//   ・ラテン文字の言語は台帳の en（ヘボン式・長音は書かない＝Jozankei Onsen）。中国語は漢字の名前のまま（呼ぶ側が n を使う）
//   ・ロシア語＝ポリワノフ式・ウクライナ語＝コヴァレンコ式・韓国語＝外来語表記法（語頭は平音・語中は激音・ん＝ㄴ・っ＝ㅅ）
//   ・ギリシア語・アラビア語・ペルシア語・ウルドゥー語・ヘブライ語・ヒンディー語・ベンガル語・タイ語は、その言語版 Wikipedia の日本の地名の書き方（東京・大阪・京都）に寄せた近似
//   ・長音は英語名と同じく書かない（おう・おお・うう・ああ を 1 音に）。「おんせん」「きょう」は語を分けて音写する（Onsen と同じ扱い）
const KANA: Record<string, string> = { あ: "a", い: "i", う: "u", え: "e", お: "o", か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko", さ: "sa", し: "si", す: "su", せ: "se", そ: "so", た: "ta", ち: "ti", つ: "tsu", て: "te", と: "to",
	な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no", は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho", ま: "ma", み: "mi", む: "mu", め: "me", も: "mo", や: "ya", ゆ: "yu", よ: "yo",
	ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro", わ: "wa", ゐ: "i", ゑ: "e", を: "o", が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go", ざ: "za", じ: "zi", ず: "zu", ぜ: "ze", ぞ: "zo",
	だ: "da", ぢ: "zi", づ: "zu", で: "de", ど: "do", ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo", ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po", ゔ: "bu" };
// 口蓋化する音（し・ち・じ＝s/t/z の i）。き＝k の i は口蓋化しない（ki）・きゃ＝k の口蓋化（kya）
const PALI = new Set(["s", "t", "z"]);
interface Mora { c: string; pal: boolean; v: string }   // c＝子音（"" は母音だけ・"N"＝ん・"Q"＝っ）・pal＝口蓋化・v＝母音

function moras(word: string): Mora[] {
	const s = word.replace(/[ァ-ヶ]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60)), out: Mora[] = [];
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (ch === "ん") { out.push({ c: "N", pal: false, v: "" }); continue; }
		if (ch === "っ") { out.push({ c: "Q", pal: false, v: "" }); continue; }
		const small = "ゃゅょ".indexOf(ch), sv = "ぁぃぅぇぉ".indexOf(ch);
		if (small >= 0 && out.length) { const p = out[out.length - 1]; if (p.v === "i" && p.c) { p.pal = true; p.v = "auo"[small]; } continue; }
		if (sv >= 0) { const p = out[out.length - 1]; if (p?.c && p.c !== "N" && p.c !== "Q") { p.v = "aiueo"[sv]; if (p.v !== "i") p.pal = false; } else out.push({ c: "", pal: false, v: "aiueo"[sv] }); continue; }
		const r = KANA[ch]; if (!r) continue;   // ー・記号は落とす
		const c = r.slice(0, -1), v = r.slice(-1);
		if (c === "y") { out.push({ c: "", pal: true, v }); continue; }
		out.push({ c, pal: v === "i" && PALI.has(c), v });
	}
	// 長音を落とす（おう・おお・うう・ああ）
	return out.filter((m, i) => { const p = out[i - 1]; return !(i && !m.c && !m.pal && p && p.c !== "N" && p.c !== "Q" && ((p.v === "o" && (m.v === "u" || m.v === "o")) || (p.v === "u" && m.v === "u") || (p.v === "a" && m.v === "a"))); });
}
const capFirst = (s: string) => s ? s[0].toUpperCase() + s.slice(1) : s;
const nextC = (ms: Mora[], i: number) => ms.slice(i + 1).find(m => m.c !== "Q")?.c || "";

// ── キリル文字（ロシア語・ウクライナ語）──
function cyr(ms: Mora[], uk: boolean): string {
	const C: Record<string, string> = { "": "", k: "к", s: "с", t: "т", n: "н", h: "х", m: "м", r: "р", w: "в", g: "г", z: "дз", d: "д", b: "б", p: "п", f: "ф", ts: "ц" };
	const V = uk ? { a: "а", i: "і", u: "у", e: "е", o: "о" } : { a: "а", i: "и", u: "у", e: "э", o: "о" } as Record<string, string>;
	let o = "";
	ms.forEach((m, i) => {
		const prev = ms[i - 1], afterV = !!prev && !!prev.v;
		if (m.c === "N") { o += /^[bpm]$/.test(nextC(ms, i)) ? "м" : "н"; return; }
		if (m.c === "Q") { o += (C[nextC(ms, i)] || "")[0] || ""; return; }
		if (!m.c && !m.pal && m.v === "i" && afterV && ms[i + 1]?.c !== "N" && (!ms[i + 1] || ms[i + 1].c)) { o += "й"; return; }   // 二重母音の い＝й（ゆふいん＝Юфуин は и）
		if (m.pal) {
			const pv = uk ? { a: "я", u: "ю", o: m.c ? "ьо" : "йо", i: "і", e: "є" } : { a: "я", u: "ю", o: "ё", i: "и", e: "е" } as Record<string, string>;
			o += (m.c === "t" ? "т" : C[m.c]) + (m.v === "o" && uk && !m.c && afterV ? "йо" : pv[m.v]); return;
		}
		o += C[m.c] + V[m.v as keyof typeof V];
	});
	return capFirst(o);
}

// ── ギリシア文字 ──
function greek(ms: Mora[]): string {
	const C: Record<string, string> = { "": "", k: "κ", s: "σ", t: "τ", n: "ν", h: "χ", m: "μ", r: "ρ", w: "ου", g: "γκ", z: "ζ", d: "ντ", b: "μπ", p: "π", f: "φ", ts: "τσ" };
	const V: Record<string, string> = { a: "α", i: "ι", u: "ου", e: "ε", o: "ο" };
	let o = "";
	ms.forEach((m, i) => {
		if (m.c === "N") { o += /^[bpm]$/.test(nextC(ms, i)) ? "μ" : "ν"; return; }
		if (m.c === "Q") { o += (C[nextC(ms, i)] || "")[0] || ""; return; }
		const c = m.pal ? (m.c === "s" ? "σ" : m.c === "t" ? "τσ" : m.c === "z" ? "τζ" : m.c === "" ? "γι" : C[m.c] + "ι") : C[m.c];
		o += (m.pal && m.v === "i" && /ι$/.test(c) ? c.slice(0, -1) : c) + V[m.v];
	});
	return capFirst(o.replace(/σ$/, "ς"));
}

// ── ハングル ──
function hangul(ms: Mora[]): string {
	const L0: Record<string, [number, number]> = { "": [11, 11], k: [0, 15], s: [9, 9], t: [3, 16], n: [2, 2], h: [18, 18], f: [18, 18], m: [6, 6], r: [5, 5], w: [11, 11], g: [0, 0], z: [12, 12], d: [3, 3], b: [7, 7], p: [17, 17], ts: [10, 10] };
	const V: Record<string, number> = { a: 0, i: 20, u: 13, e: 5, o: 8 }, VP: Record<string, number> = { a: 2, i: 20, u: 17, e: 7, o: 12 };
	const syl: [number, number, number][] = [];
	ms.forEach(m => {
		if (m.c === "N" || m.c === "Q") { const p = syl[syl.length - 1]; if (p && !p[2]) p[2] = m.c === "N" ? 4 : 19; return; }
		const first = !syl.length;
		let l = L0[m.c][first ? 0 : 1], v = m.pal ? VP[m.v] : V[m.v];
		if (m.pal && m.c === "t") l = first ? 12 : 14;   // ち・ちゃ＝ㅈ/ㅊ
		if (m.pal && (m.c === "t" || m.c === "z")) v = V[m.v];   // じゃ＝자・ちゃ＝차（ㅈ・ㅊ の後は ㅑ を書かない）
		if (m.v === "u" && (m.c === "s" || m.c === "ts" || m.c === "z")) v = 18;   // す・つ・ず＝ㅡ
		if (m.c === "w") v = m.v === "a" ? 9 : V[m.v];
		syl.push([l, v, 0]);
	});
	return syl.map(([l, v, t]) => String.fromCharCode(0xac00 + (l * 21 + v) * 28 + t)).join("");
}

// ── アラビア文字（アラビア語・ペルシア語・ウルドゥー語）──
function arabic(ms: Mora[], lang: "ar" | "fa" | "ur"): string {
	const fa = lang !== "ar";
	const C: Record<string, string> = { "": "", k: fa ? "ک" : "ك", s: "س", t: lang === "ur" ? "ٹ" : "ت", n: "ن", h: lang === "ur" ? "ہ" : "ه", m: "م", r: "ر", w: "و", g: fa ? "گ" : "غ", z: "ز", d: lang === "ur" ? "ڈ" : "د", b: "ب", p: fa ? "پ" : "ب", f: "ف", ts: (lang === "ur" ? "ٹ" : "ت") + "س" };
	const Y = fa ? "ی" : "ي";
	const PAL: Record<string, string> = { s: "ش", t: fa ? "چ" : "تش", z: "ج" };
	let o = "";
	ms.forEach((m, i) => {
		const last = i === ms.length - 1;
		if (m.c === "N") { o += "ن"; return; }
		if (m.c === "Q") return;
		if (!o) {   // 語頭の母音
			const init: Record<string, string> = fa ? { a: "آ", i: "ای", u: "او", e: "ا", o: "او" } : { a: "أ", i: "إي", u: "أو", e: "إي", o: "أو" };
			if (!m.c && !m.pal) { o += init[m.v]; return; }
		}
		const c = m.pal ? (PAL[m.c] || (C[m.c] + Y)) : C[m.c];
		const v = m.pal && (PAL[m.c] || !m.c) && m.v === "i" ? Y : ({ a: "ا", i: Y, u: "و", o: "و", e: fa ? (last ? (lang === "ur" ? "ے" : "ه") : (lang === "ur" ? Y : "")) : Y } as Record<string, string>)[m.v];
		o += c + v;
	});
	return o;
}

// ── ヘブライ文字 ──
function hebrew(ms: Mora[]): string {
	const C: Record<string, string> = { "": "", k: "ק", s: "ס", t: "ט", n: "נ", h: "ה", m: "מ", r: "ר", w: "ו", g: "ג", z: "ז", d: "ד", b: "ב", p: "פ", f: "פ", ts: "צ" };
	const PAL: Record<string, string> = { s: "ש", t: "צ'", z: "ג'" };
	let o = "";
	ms.forEach((m, i) => {
		const last = i === ms.length - 1;
		if (m.c === "N") { o += "נ"; return; }
		if (m.c === "Q") return;
		if (!m.c && !m.pal) { o += ({ a: "א", i: "אי", u: "או", e: "א", o: "או" } as Record<string, string>)[m.v]; return; }
		const c = m.pal ? (PAL[m.c] || (C[m.c] + "י")) : C[m.c];
		o += c + ({ a: last ? "ה" : "", i: m.pal && PAL[m.c] ? "י" : "י", u: "ו", o: "ו", e: last ? "ה" : "" } as Record<string, string>)[m.v];
	});
	return o.replace(/נ$/, "ן").replace(/מ$/, "ם").replace(/פ$/, "ף").replace(/צ$/, "ץ");
}

// ── ブラーフミー系（ヒンディー語・ベンガル語）──
function indic(ms: Mora[], bn: boolean): string {
	const C: Record<string, string> = bn ? { k: "ক", s: "স", t: "ট", n: "ন", h: "হ", m: "ম", r: "র", w: "ওয়", g: "গ", z: "জ", d: "ড", b: "ব", p: "প", f: "ফ", ts: "ৎস" }
		: { k: "क", s: "स", t: "ट", n: "न", h: "ह", m: "म", r: "र", w: "व", g: "ग", z: "ज़", d: "ड", b: "ब", p: "प", f: "फ़", ts: "त्स" };
	const PAL: Record<string, string> = bn ? { s: "শ", t: "চ", z: "জ" } : { s: "श", t: "च", z: "ज" };
	const H = bn ? "্" : "्", Y = bn ? "য়" : "य", YA = bn ? "্য" : "्य";
	const SIGN: Record<string, string> = bn ? { a: "া", i: "ি", u: "ু", e: "ে", o: "ো" } : { a: "ा", i: "ि", u: "ु", e: "े", o: "ो" };
	const IND: Record<string, string> = bn ? { a: "আ", i: "ই", u: "উ", e: "এ", o: "ও" } : { a: "अ", i: "इ", u: "उ", e: "ए", o: "ओ" };
	let o = "";
	ms.forEach((m, i) => {
		const last = i === ms.length - 1;
		if (m.c === "N") { o += C.n + (last ? "" : H); return; }
		if (m.c === "Q") { const n = nextC(ms, i); if (C[n]) o += [...C[n]][0] + H; return; }
		if (!m.c && !m.pal) { o += IND[m.v]; return; }
		if (!m.c && m.pal) { o += (bn && !o ? "ই" : "") + Y + SIGN[m.v]; return; }
		const c = m.pal ? (PAL[m.c] || (C[m.c] + YA)) : C[m.c];
		o += c + SIGN[m.v];
	});
	return o;
}

// ── タイ文字 ──
function thai(ms: Mora[]): string {
	const C: Record<string, string> = { "": "อ", k: "ค", s: "ซ", t: "ท", n: "น", h: "ฮ", m: "ม", r: "ร", w: "ว", g: "ก", z: "ซ", d: "ด", b: "บ", p: "พ", f: "ฟ", ts: "ซ" };
	const PAL: Record<string, string> = { s: "ช", t: "จ", z: "จ", "": "ย" };
	let o = "";
	ms.forEach((m, i) => {
		const last = i === ms.length - 1;
		if (m.c === "N") { o += "น"; return; }
		if (m.c === "Q") { const n = nextC(ms, i); o += /^[kg]$/.test(n) ? "ก" : /^[bp]$/.test(n) ? "ป" : "ต"; return; }
		if (m.pal && !PAL[m.c]) {   // きゃ・きゅ・きょ＝เคีย・คิว・เคียว
			const c = C[m.c]; o += m.v === "a" ? "เ" + c + "ีย" : m.v === "u" ? c + "ิว" : m.v === "o" ? "เ" + c + "ียว" : c + "ิ"; return;
		}
		const c = m.pal ? PAL[m.c] : C[m.c];
		o += m.v === "e" ? "เ" + c : m.v === "o" ? "โ" + c : c + (m.v === "a" ? (last ? "ะ" : "า") : m.v === "i" ? "ิ" : /^(s|ts|z)$/.test(m.c) && !m.pal ? "ึ" : "ุ");
	});
	return o;
}

const SCRIPT: Record<string, (ms: Mora[]) => string> = {
	ru: ms => cyr(ms, false), uk: ms => cyr(ms, true), el: greek, ko: hangul, ar: ms => arabic(ms, "ar"), fa: ms => arabic(ms, "fa"), ur: ms => arabic(ms, "ur"),
	he: hebrew, hi: ms => indic(ms, false), bn: ms => indic(ms, true), th: thai,
};
export const transliterates = (lang: string) => lang in SCRIPT;

// よみ → その言語の文字の名前。音写しない言語・よみが無い時は ""
export function onsenName(lang: string, reading: string | undefined): string {
	const f = SCRIPT[lang]; if (!f || !reading) return "";
	const m = reading.match(/^(.*?)(おんせん|こうせん)(きょう|ぐん|ごう)?$/);
	const words = m ? [m[1], m[2] + (m[3] || "")] : [reading];
	return words.flatMap(w => w.split(/([・.\s()（）]+)/)).map(w => /^[・.\s()（）]+$/.test(w) ? (/[()（）]/.test(w) ? w.replace(/（/g, "(").replace(/）/g, ")") : " ") : w ? f(moras(w)) : "").join(" ").replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}
