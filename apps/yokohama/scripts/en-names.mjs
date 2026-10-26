// 施設の名前・住所の英語（日本語以外の UI に出す・本人「施設の名称・住所は、日本語以外は英語に」2026-10-26）。焼く時だけ使う（bake-yokohama.mjs の en）。
// 読み＝①郵便番号データ（KEN_ALL）の町名の読み（正確）②区の名 ③読みの辞書（kuromoji・固有名を読み違える＝最後の手）。種類の語（小学校・交番…）は下の表で英訳。
// ローマ字＝駅の案内と同じ流儀（長音は書かない：コウホク→Kohoku・トウキョウ→Tokyo、オオ はそのまま：カミオオオカ→Kamiooka）

const K = {
	ア: "a", イ: "i", ウ: "u", エ: "e", オ: "o", カ: "ka", キ: "ki", ク: "ku", ケ: "ke", コ: "ko", サ: "sa", シ: "shi", ス: "su", セ: "se", ソ: "so",
	タ: "ta", チ: "chi", ツ: "tsu", テ: "te", ト: "to", ナ: "na", ニ: "ni", ヌ: "nu", ネ: "ne", ノ: "no", ハ: "ha", ヒ: "hi", フ: "fu", ヘ: "he", ホ: "ho",
	マ: "ma", ミ: "mi", ム: "mu", メ: "me", モ: "mo", ヤ: "ya", ユ: "yu", ヨ: "yo", ラ: "ra", リ: "ri", ル: "ru", レ: "re", ロ: "ro", ワ: "wa", ヲ: "o", ン: "n",
	ガ: "ga", ギ: "gi", グ: "gu", ゲ: "ge", ゴ: "go", ザ: "za", ジ: "ji", ズ: "zu", ゼ: "ze", ゾ: "zo", ダ: "da", ヂ: "ji", ヅ: "zu", デ: "de", ド: "do",
	バ: "ba", ビ: "bi", ブ: "bu", ベ: "be", ボ: "bo", パ: "pa", ピ: "pi", プ: "pu", ペ: "pe", ポ: "po", ヴ: "vu",
	ァ: "a", ィ: "i", ゥ: "u", ェ: "e", ォ: "o",
};
const Y = { ャ: "a", ュ: "u", ョ: "o" };
/** 表記ゆれを揃える（半角カナ・ヶ／ケ・保土ヶ谷） */
export const normJp = s => s.normalize("NFKC").replace(/ヶ/g, "ケ");
const toKata = s => normJp(s).replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
/** カタカナ（ひらがな可）→ ローマ字（小文字） */
export function romaji(kana) {
	const s = toKata(kana);
	let out = "";
	for (let i = 0; i < s.length; i++) {
		const c = s[i], n = s[i + 1];
		if (c === "ッ") { const r = K[n] ?? ""; out += r.startsWith("ch") ? "t" : r[0] ?? ""; continue; }
		if (c === "ー") continue;
		if (n && Y[n] && K[c]) { const r = K[c]; out += (/^(shi|chi|ji)$/.test(r) ? r.slice(0, -1) : r.slice(0, -1) + "y") + Y[n]; i++; continue; }
		out += K[c] ?? c;
	}
	// 長音を書かない（ou・uu → o・u）。オオ（oo）は残す
	return out.replace(/ou/g, "o").replace(/uu/g, "u").replace(/ooo/g, "oo");
}
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

// 種類の語（長い順に当てる）→ 英語。kind＝台帳の種別（出張所は消防か役所かで変える）
const SUFFIX = [
	["義務教育学校", "Compulsory Education School"], ["中等教育学校", "Secondary School"], ["特別支援学校", "Special Needs School"],
	["小学校コミュニティスクール", "Elementary School Community School"], ["小学校コミュニティハウス", "Elementary School Community House"], ["中学校コミュニティハウス", "Junior High School Community House"],
	["小学校", "Elementary School"], ["中学校", "Junior High School"], ["高等学校", "High School"], ["高校", "High School"], ["大学", "University"], ["短期大学", "Junior College"],
	["幼稚園", "Kindergarten"], ["保育園", "Nursery"], ["こども園", "Child Center"],
	["地区センター", "Community Center"], ["コミュニティハウス", "Community House"], ["地域ケアプラザ", "Community Care Plaza"], ["ケアプラザ", "Care Plaza"],
	["行政サービスコーナー", "Administrative Service Corner"], ["区民文化センター", "Ward Cultural Center"], ["市民プラザ", "Civic Plaza"], ["老人福祉センター", "Senior Welfare Center"],
	["老人憩いの家", "Senior Citizens' Rest House"], ["公会堂", "Public Hall"], ["記念館", "Memorial Hall"], ["会館", "Hall"], ["集会所", "Meeting Hall"], ["ホール", "Hall"],
	["図書館", "Library"], ["美術館", "Art Museum"], ["博物館", "Museum"], ["資料館", "Archives"], ["動物園", "Zoo"], ["水族館", "Aquarium"],
	["区役所", "Ward Office"], ["市役所", "City Hall"], ["保健所", "Public Health Center"], ["事務所", "Office"], ["センター", "Center"],
	["警察署", "Police Station"], ["交番", "Police Box"], ["駐在所", "Police Box"], ["派出所", "Police Box"],
	["地方裁判所", "District Court"], ["家庭裁判所", "Family Court"], ["簡易裁判所", "Summary Court"], ["裁判所", "Court"], ["税務署", "Tax Office"], ["法務局", "Legal Affairs Bureau"],
	["労働基準監督署", "Labour Standards Inspection Office"], ["公共職業安定所", "Hello Work"], ["ハローワーク", "Hello Work"], ["年金事務所", "Pension Office"],
	["消防署", "Fire Station"], ["消防出張所", "Fire Station Branch"], ["病院", "Hospital"], ["公園", "Park"],
];
// 固有の訳（短く・よく知られた名）。台帳の名がこの語を含めばこれを使う
export const EN_FIX = {
	"横浜市役所": "Yokohama City Hall", "横浜みなとみらいホール": "Yokohama Minato Mirai Hall", "横浜能楽堂": "Yokohama Noh Theater", "県民ホール": "Kanagawa Kenmin Hall",
	"大さん橋ホール": "Osanbashi Hall", "横浜市イギリス館": "British House Yokohama", "大倉山記念館": "Okurayama Memorial Hall", "横浜市立市民病院": "Yokohama Municipal Citizen's Hospital",
	"横浜市立みなと赤十字病院": "Yokohama City Minato Red Cross Hospital", "横浜市立脳卒中・神経脊椎センター": "Yokohama Brain and Spine Center",
	"横浜市立大学附属市民総合医療センター": "Yokohama City University Medical Center", "横浜市立大学附属病院": "Yokohama City University Hospital",
	"済生会横浜市東部病院": "Saiseikai Yokohamashi Tobu Hospital", "済生会横浜市南部病院": "Saiseikai Yokohamashi Nanbu Hospital",
	"聖マリアンナ医科大学横浜市西部病院": "St. Marianna University Yokohama Seibu Hospital", "横浜労災病院": "Yokohama Rosai Hospital",
	"横浜市北部病院": "Showa Medical University Northern Yokohama Hospital", "横浜医療センター": "NHO Yokohama Medical Center",
	"横浜市保健所": "Yokohama City Public Health Center",
};

/** 読みの道具：towns＝[漢字, 読み] の表（KEN_ALL・長い順）、wards＝[区の名（区なし）, ローマ字]、tokenize＝kuromoji（無ければ漢字のまま） */
export function makeEn({ towns, wards, tokenize }) {
	const W = [["横浜", "Yokohama"], ...wards];
	// 町名は「町」抜きでも引く（施設の名は「菅田消防出張所」＝菅田町の菅田）
	const T0 = towns.map(([k, r]) => [normJp(k), toKata(r)]);
	for (const [k, r] of [...T0]) { const m = k.endsWith("町") && r.match(/(チョウ|マチ)$/); if (m && k.length > 1 && !T0.some(([x]) => x === k.slice(0, -1))) T0.push([k.slice(0, -1), r.slice(0, -m[1].length)]); }
	const T = T0.sort((a, b) => b[0].length - a[0].length);
	let guessed = 0;
	/** 固有名の部分（「日吉台」など）→ ローマ字 1 語 */
	const proper = s => {
		if (!s) return "";
		let out = "", i = 0;
		while (i < s.length) {
			const w = W.find(([k]) => s.startsWith(k, i));
			if (w) { out += ` ${w[1]} `; i += w[0].length; continue; }   // 区の名・「横浜」は 1 語に分ける（Yokohama Kosei Hospital）
			const t = T.find(([k]) => s.startsWith(k, i));
			if (t) { out += romaji(t[1]); i += t[0].length; continue; }
			// 辞書へ（町名に当たるまでの一続き）
			let j = i + 1; while (j < s.length && !T.some(([k]) => s.startsWith(k, j)) && !W.some(([k]) => s.startsWith(k, j))) j++;
			const part = s.slice(i, j);
			if (/^[\x20-\x7e]+$/.test(part.normalize("NFKC"))) out += part.normalize("NFKC");
			else { guessed++; out += tokenize ? tokenize(part).map(x => romaji(x.reading || x.surface_form)).join("") : part; }
			i = j;
		}
		return out.trim().split(/\s+/).map(cap).join(" ");
	};
	/** 施設の名 → 英語。cat＝区分の番号（4＝消防） */
	const name = (ja, cat) => {
		for (const [k, v] of Object.entries(EN_FIX)) if (ja.includes(k)) return v;
		let s = normJp(ja);
		const sp = s.lastIndexOf(" "); if (sp > 0 && /法人/.test(s.slice(0, sp))) s = s.slice(sp + 1);   // 「医療法人社団◯◯会 金沢病院」＝法人の名は落とす
		s = s.replace(/^(横浜市立|横浜市|神奈川県立|神奈川県|市立|県立)/, "").replace(/^消防局/, "").replace(/\s+/g, "");
		const fs = s.indexOf("消防署"); if (fs > 0 && s.endsWith("出張所") && s.length > fs + 6) s = s.slice(fs + 3);   // 「神奈川消防署菅田消防出張所」→ 菅田
		// 警察署の中の交番＝「港北警察署下田交番」→ Shimoda Police Box
		const ps = s.indexOf("警察署"); if (ps > 0 && ["交番", "駐在所", "派出所"].some(k => s.endsWith(k)) && s.length > ps + 5) s = s.slice(ps + 3);
		const parts = [];
		// 後ろの種類の語を 1 つ剥がす（「◯◯小学校コミュニティハウス」も表の 1 語で当てる）
		const hit = SUFFIX.find(([k]) => s.endsWith(k) && s.length > k.length);
		if (hit) { parts.push(hit[1]); s = s.slice(0, -hit[0].length); }
		else if (s.endsWith("出張所")) { parts.push(cat === 4 ? "Fire Station Branch" : "Branch Office"); s = s.slice(0, -3); }
		if (s.endsWith("駅前") || s.endsWith("駅")) { parts.unshift("Station"); s = s.slice(0, s.endsWith("駅前") ? -2 : -1); }   // 「たまプラーザ駅前交番」→ Tama Plaza Station Police Box
		const head = proper(s.replace(/区$/, ""));
		return [head, ...parts].filter(Boolean).join(" ");
	};
	/** 住所（「横浜市港北区菊名7-8-27」）→「7-8-27 Kikuna, Kohoku-ku」（横浜市は書かない） */
	const addr = (ja, wardEn) => {
		let s = normJp(ja).replace(/^神奈川県/, "").replace(/^横浜市/, "").replace(/^\S+?区/, "");
		s = s.replace(/([一二三四五六七八九十]+)丁目/, (_, n) => kanjiNum(n) + "-").replace(/番地?の?/g, "-").replace(/号/g, "").replace(/-+$/, "").replace(/-{2,}/g, "-");
		const m = s.match(/^(\D*?)(\d[\d-]*)(.*)$/);
		const town = proper(m ? m[1] : s), nums = m ? m[2] : "", rest = m ? m[3].trim() : "";
		const bld = rest && /^[\x20-\x7e]*$/.test(rest) ? ` ${rest}` : "";   // 建物名（日本語）は落とす
		return `${nums ? nums + " " : ""}${town}${bld}${wardEn ? `, ${wardEn}` : ""}`.trim();
	};
	return { name, addr, proper, guessed: () => guessed };
}
const KN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanjiNum(s) { if (s === "十") return 10; if (s.startsWith("十")) return 10 + KN[s[1]]; if (s.endsWith("十")) return KN[s[0]] * 10; if (s.includes("十")) return KN[s[0]] * 10 + KN[s[2]]; return KN[s] ?? s; }
