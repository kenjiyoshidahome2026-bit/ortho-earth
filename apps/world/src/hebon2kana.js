// ── ヘボン式ローマ字 → カタカナ（検索用・旧 #inline("RaLVLcna") の代替 2026-09-09）──
// 素打ち込み前提で寛容に: 長音は "-"/同母音重ね/"ou" を ー に、促音は子音重ね、撥音は n(+子音|末尾|')。
// kanaPattern() は変換結果から「ー」を任意にした正規表現片を作る＝osutoraria でも oosutoraria でも オーストラリア に当たる
const V = { a: "ア", i: "イ", u: "ウ", e: "エ", o: "オ" };
const T = {
	kya: "キャ", kyu: "キュ", kyo: "キョ", sha: "シャ", shu: "シュ", sho: "ショ", she: "シェ", cha: "チャ", chu: "チュ", cho: "チョ", che: "チェ",
	nya: "ニャ", nyu: "ニュ", nyo: "ニョ", hya: "ヒャ", hyu: "ヒュ", hyo: "ヒョ", mya: "ミャ", myu: "ミュ", myo: "ミョ",
	rya: "リャ", ryu: "リュ", ryo: "リョ", gya: "ギャ", gyu: "ギュ", gyo: "ギョ", bya: "ビャ", byu: "ビュ", byo: "ビョ", pya: "ピャ", pyu: "ピュ", pyo: "ピョ",
	shi: "シ", chi: "チ", tsu: "ツ", thi: "ティ", dhi: "ディ", tsa: "ツァ", tse: "ツェ", tso: "ツォ", kwa: "クァ", gwa: "グァ",
	ja: "ジャ", ju: "ジュ", jo: "ジョ", je: "ジェ", ji: "ジ", fa: "ファ", fi: "フィ", fu: "フ", fe: "フェ", fo: "フォ", va: "ヴァ", vi: "ヴィ", vu: "ヴ", ve: "ヴェ", vo: "ヴォ",
	wa: "ワ", wi: "ウィ", wu: "ウ", we: "ウェ", wo: "ウォ", ya: "ヤ", yu: "ユ", yo: "ヨ", ye: "イェ",
	ka: "カ", ki: "キ", ku: "ク", ke: "ケ", ko: "コ", sa: "サ", si: "シ", su: "ス", se: "セ", so: "ソ", ta: "タ", ti: "ティ", tu: "トゥ", te: "テ", to: "ト",
	na: "ナ", ni: "ニ", nu: "ヌ", ne: "ネ", no: "ノ", ha: "ハ", hi: "ヒ", hu: "フ", he: "ヘ", ho: "ホ", ma: "マ", mi: "ミ", mu: "ム", me: "メ", mo: "モ",
	ra: "ラ", ri: "リ", ru: "ル", re: "レ", ro: "ロ", la: "ラ", li: "リ", lu: "ル", le: "レ", lo: "ロ",
	ga: "ガ", gi: "ギ", gu: "グ", ge: "ゲ", go: "ゴ", za: "ザ", zi: "ジ", zu: "ズ", ze: "ゼ", zo: "ゾ", da: "ダ", di: "ディ", du: "ドゥ", de: "デ", do: "ド",
	ba: "バ", bi: "ビ", bu: "ブ", be: "ベ", bo: "ボ", pa: "パ", pi: "ピ", pu: "プ", pe: "ペ", po: "ポ", xa: "ァ", xi: "ィ", xu: "ゥ", xe: "ェ", xo: "ォ",
};
export function hebon2kana(input) {
	let s = String(input || "").toLowerCase().normalize("NFD").replace(/[̄̂]/g, "-")   // ā/â → a-（マクロン・曲折＝長音）
		.replace(/[^a-z'\- ]/g, "");
	if (!s) return "";
	s = s.replace(/([aiueo])\1/g, "$1-").replace(/ou/g, "o-");   // 同母音重ね・ou → 長音
	let out = "";
	for (let i = 0; i < s.length;) {
		const c = s[i];
		if (c == " ") { out += " "; i++; continue; }
		if (c == "-") { out += "ー"; i++; continue; }
		if (c == "'") { i++; continue; }
		if (V[c]) { out += V[c]; i++; continue; }
		if (c == "n" && (i + 1 >= s.length || !/[aiueoy]/.test(s[i + 1]) )) { out += "ン"; i += (s[i + 1] == "n" && !/[aiueoy]/.test(s[i + 2] || "")) ? 2 : 1; continue; }
		if (c == "m" && /[bmp]/.test(s[i + 1] || "")) { out += "ン"; i++; continue; }   // mb/mp の m（ヘボン式）
		if (/[kstpbdgzjfhrmnywcl]/.test(c) && s[i + 1] == c) { out += "ッ"; i++; continue; }   // 促音
		if (c == "t" && s.slice(i, i + 3) == "tch") { out += "ッ"; i++; continue; }
		const t3 = T[s.slice(i, i + 3)], t2 = T[s.slice(i, i + 2)];
		if (t3) { out += t3; i += 3; continue; }
		if (t2) { out += t2; i += 2; continue; }
		i++;   // 変換できない子音は読み飛ばす
	}
	return out;
}
// カタカナ→検索正規表現片: 各文字の後ろの長音を任意（ー?）にし、ヴ/ブ・ヂ/ジ等の揺れも吸収
export function kanaPattern(kana) {
	const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const chars = [...kana.replace(/ー/g, "")], out = [];
	for (let i = 0; i < chars.length; i++) {
		const ch = chars[i], nx = chars[i + 1];
		if (ch == "ヴ" && "ァィェォ".includes(nx || "")) { out.push(`(?:ヴ${nx}|${({ ァ: "バ", ィ: "ビ", ェ: "ベ", ォ: "ボ" })[nx]})ー?`); i++; continue; }   // ヴェネズエラ⇄ベネズエラ
		if (ch == "ッ") { out.push("ッ?"); continue; }   // 促音の打ち間違いに寛容
		const alt = ({ ヴ: "[ヴブ]", ジ: "[ジヂ]", ズ: "[ズヅ]", ィ: "[ィイ]", ェ: "[ェエ]", ォ: "[ォオ]", ァ: "[ァア]", ゥ: "[ゥウ]" })[ch];
		out.push((alt || esc(ch)) + "ー?");
	}
	return out.join("");
}
