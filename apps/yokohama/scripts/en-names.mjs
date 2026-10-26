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
const SMALL = new Set(["of", "and", "for"]);   // 英語の小さい語は頭でなければ小文字

// 種類の語（長い順に当てる）→ 英語。kind＝台帳の種別（出張所は消防か役所かで変える）
const SUFFIX = [
	["高等特別支援学校", "Special Needs High School"],
	["盲特別支援学校", "School for the Blind"], ["ろう特別支援学校", "School for the Deaf"], ["区検察庁", "Public Prosecutors Office"], ["地方検察庁", "District Public Prosecutors Office"],
	["埋蔵文化財センター", "Archaeological Center"], ["分校", "Branch School"],
	["小コミュニティハウス", "Elementary School Community House"], ["中コミュニティハウス", "Junior High School Community House"],
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
// 名の中の決まった語（読みの辞書が読み違える・外来語）。[語, 出す字, 別の語にするか]。別の語＝英訳（Sports）、続ける＝読み（中央→chuo）
// 焼いた見本で見つけた誤り（2026-10-26）：スポーツ→Supotsu・中央→Naka Hisashi・開港→Hirakuminato・国立→Kunitate・西谷→Nishi Tani
const WORDS = [
	["スポーツ", "Sports", 1], ["センター", "Center", 1], ["プラザ", "Plaza", 1], ["ホール", "Hall", 1], ["ハウス", "House", 1], ["コミュニティ", "Community", 1], ["ケア", "Care", 1],
	["パーク", "Park", 1], ["ポート", "Port", 1], ["ヒル", "Hill", 1], ["スポット", "Spot", 1], ["サイエンス", "Science", 1], ["フロンティア", "Frontier", 1], ["アート", "Art", 1],
	["シアター", "Theater", 1], ["ギャラリー", "Gallery", 1], ["クリニック", "Clinic", 1], ["メディカル", "Medical", 1], ["ステーション", "Station", 1], ["ガーデン", "Garden", 1],
	["タワー", "Tower", 1], ["プール", "Pool", 1], ["アリーナ", "Arena", 1], ["スタジアム", "Stadium", 1], ["フォーラム", "Forum", 1], ["ワールド", "World", 1], ["ランド", "Land", 1],
	["ハート", "Heart", 1], ["ホーム", "Home", 1], ["ラウンジ", "Lounge", 1], ["ワークピア", "Workpia", 1], ["シンポジア", "Symposia", 1], ["ユートピア", "Utopia", 1], ["フィリア", "Philia", 1],
	["サンハート", "Sun Heart", 1], ["リリス", "Lilis", 1], ["みなくる", "Minakuru", 1], ["イソカツ", "Isokatsu", 1], ["たまプラーザ", "Tama Plaza", 1], ["みなとみらい", "Minato Mirai", 1],
	["かながわ", "Kanagawa", 1], ["よこはま", "Yokohama", 1], ["ほどがや", "Hodogaya", 1], ["いそご", "Isogo", 1], ["かなざわ", "Kanazawa", 1], ["なか", "Naka", 1],
	["劇場", "Theater", 1], ["能楽堂", "Noh Theater", 1], ["国際", "International", 1], ["交流", "Exchange", 1], ["会議", "Conference", 1], ["市民", "Civic", 1], ["区民", "Ward", 1], ["県民", "Kenmin", 1],
	["社会福祉", "Social Welfare", 1], ["福祉保健", "Health and Welfare", 1], ["老人福祉", "Senior Welfare", 1], ["福祉", "Welfare", 1], ["活動", "Activity", 1], ["支援", "Support", 1], ["青少年", "Youth", 1],
	["男女共同参画", "Gender Equality", 1], ["男女参画", "Gender Equality", 1], ["労働", "Labor", 1], ["文化", "Cultural", 1], ["記念", "Memorial", 1], ["総合", "General", 1], ["医療", "Medical", 1],
	["国立", "National", 1], ["育成", "Development", 1], ["研修", "Training", 1], ["産業振興", "Industrial Promotion", 1], ["職能開発", "Vocational Training", 1],
	["中央", "chuo", 0], ["開港", "kaiko", 0], ["西谷", "nishiya", 0], ["泉町", "izumicho", 0], ["南太田", "minamiota", 0], ["六角橋", "rokkakubashi", 0], ["中村", "nakamura", 0],
	["上中里", "kaminakazato", 0], ["元町", "motomachi", 0], ["鶴寿", "kakuju", 0], ["荘", "so", 0], ["清風", "seifu", 0], ["緑風", "ryokufu", 0], ["晴嵐", "seiran", 0],
	["養護学校", "Special Needs School", 1], ["分教室", "Branch Classroom", 1], ["専門学校", "Vocational School", 1], ["看護", "Nursing", 1], ["学校", "School", 1], ["附属", "Affiliated", 1],
	["教育学部", "Faculty of Education", 1], ["株式会社", "", 1], ["研究所", "Research Institute", 1], ["研究", "Research", 1], ["支店", "Branch", 1], ["支社", "Branch", 1], ["本館", "Main Building", 1],
	["科学館", "Science Museum", 1], ["植物園", "Botanical Garden", 1], ["展示室", "Exhibition Room", 1], ["宝物殿", "Treasure Hall", 1], ["領事館", "Consulate", 1], ["機構", "Agency", 1],
	["事務所", "Office", 1], ["本部", "Headquarters", 1], ["地方整備局", "Regional Development Bureau", 1], ["関東", "Kanto", 1], ["技術", "Technology", 1], ["調査", "Survey", 1], ["相談所", "Consultation Office", 1],
	["キャンパス", "Campus", 1], ["ライブラリー", "Library", 1], ["ミュージアム", "Museum", 1], ["サテライト", "Satellite", 1], ["歴史", "History", 1], ["宇宙", "Space", 1], ["郷土", "Local History", 1],
	["湘南", "shonan", 0], ["聖隷", "seirei", 0], ["掖済会", "ekisaikai", 0], ["嶮山", "kenzan", 0], ["十慈堂", "jujido", 0], ["寿楽荘", "jurakuso", 0], ["一丁目", " 1-chome", 0],
	["リハビリテーション", "Rehabilitation", 1], ["ホスピタル", "Hospital", 1], ["女子短期大学部", "Women's Junior College", 1], ["短期大学", "Junior College", 1], ["大学", "University", 1], ["女学院", "Jogakuin", 1],
	// 2 回目の焼き（2026-10-26）の見直し：読み違え・訳の抜け・組織の語
	["日下", "kusaka", 0], ["下郷", "shimogo", 0], ["城郷", "shirosato", 0], ["大綱", "otsuna", 0], ["阿久和", "akuwa", 0], ["新田", "nitta", 0], ["千秀", "senshu", 0],
	["福寿荘", "fukujuso", 0], ["柏桜荘", "hakuoso", 0], ["東希", "higashikibo", 0], ["東部", "tobu", 0], ["西部", "seibu", 0], ["南部", "nanbu", 0], ["北部", "hokubu", 0], ["中部", "chubu", 0],
	["高等学校", "High School", 1], ["中学校", "Junior High School", 1], ["小学校", "Elementary School", 1], ["公園", "Park", 1], ["駅", "Station", 1], ["西口", "West Exit", 1], ["東口", "East Exit", 1],
	["南口", "South Exit", 1], ["北口", "North Exit", 1], ["通", "dori", 0], ["局", "Bureau", 1], ["部", "Division", 1], ["県民局", "Citizens Bureau", 1], ["女性相談所", "Women's Consultation Office", 1],
	["コーナー", "Corner", 1], ["システム", "System", 1], ["ニュース", "News", 1], ["マリタイム", "Maritime", 1], ["情報", "Information", 1], ["共同", "Joint", 1], ["事業", "Business", 1], ["組合", "Association", 1],
	["教育", "Education", 1], ["社会教育", "Social Education", 1], ["技能", "Skills", 1], ["振興", "Promotion", 1], ["青年館", "Youth Hall", 1], ["医科学", "Medical Science", 1], ["薬業", "Pharmaceutical", 1],
	["地域", "Community", 1], ["拠点", "Base", 1], ["町村", "Towns and Villages", 1],
	// 3 回目の焼きの見直し。2＝前の語に続ける（「南が丘」→ Minamigaoka）
	["が丘", "gaoka", 2], ["ケ丘", "gaoka", 2], ["の丘", "nooka", 2], ["ケ峯", "gamine", 2], ["ケ谷", "gaya", 2], ["井土ケ谷", "idogaya", 0], ["谷本", "tanimoto", 0], ["一本松", "ippommatsu", 0],
	["本陣", "honjin", 0], ["元町橋", "motomachibashi", 0], ["共立", "kyoritsu", 0], ["第1", "No.1", 1], ["第2", "No.2", 1], ["東京", "Tokyo", 1], ["日本", "Japan", 1], ["相鉄口", "Sotetsu Exit", 1], ["吉田口", "Yoshida Exit", 1],
	["海上保安", "Coast Guard", 1], ["歯学部", "School of Dental Medicine", 1], ["文化館", "Cultural Museum", 1], ["館", "kan", 2], ["ガス", "Gas", 1], ["エネルギー", "Energy", 1], ["シルク", "Silk", 1],
	["ユーラシア", "Eurasian", 1], ["フェリス", "Ferris", 1], ["ハローワーク", "Hello Work", 1], ["ポートサイド", "Portside", 1], ["ニュータウン", "New Town", 1], ["イムス", "IMS", 1], ["ウィメンズ", "Women's", 1],
	["カメリア", "Camellia", 1], ["ズーラシア", "Zoorasia", 1], ["環境", "Environmental", 1],
	// 4 回目の焼きの見直し
	["海上", "Maritime", 1], ["水上", "Marine", 1], ["立場", "tateba", 0], ["細谷戸", "hosoyado", 0], ["向谷", "mukaiya", 0], ["旭陵", "kyokuryo", 0], ["橋", "bashi", 2], ["丘の上", "okanoue", 0],
	["地方法務局", "District Legal Affairs Bureau", 1], ["埠頭", "Pier", 1], ["税関", "Customs", 1], ["サポート", "Support", 1], ["多文化", "Multicultural", 1],
	// 駅・停留所（2026-10-26）
	["京急", "Keikyu", 1], ["相鉄", "Sotetsu", 1], ["入口", "Entrance", 1], ["営業所", "Depot", 1], ["車庫", "Depot", 1], ["折返場", "Turnaround", 1], ["ターミナル", "Terminal", 1], ["団地", "Danchi", 1],
	["うらしま", "urashima", 0], ["横浜市", "Yokohama", 1], ["スポーツ会館", "Sports Hall", 1], ["万国橋", "bankokubashi", 0], ["六ッ川", "mutsukawa", 0], ["野毛山", "nogeyama", 0],
];
// 名そのものの訳（台帳の名と同じ時だけ）
const EN_EXACT = { "横浜市消防局": "Yokohama City Fire Bureau", "横浜市役所": "Yokohama City Hall", "横浜市保健所": "Yokohama City Public Health Center" };
// 固有の訳（短く・よく知られた名）。台帳の名がこの語を含めばこれを使う
export const EN_FIX = {
	"横浜市役所": "Yokohama City Hall", "横浜みなとみらいホール": "Yokohama Minato Mirai Hall", "横浜能楽堂": "Yokohama Noh Theater", "県民ホール": "Kanagawa Kenmin Hall",
	"大さん橋ホール": "Osanbashi Hall", "横浜市イギリス館": "British House Yokohama", "大倉山記念館": "Okurayama Memorial Hall", "横浜市立市民病院": "Yokohama Municipal Citizen's Hospital",
	"横浜市立みなと赤十字病院": "Yokohama City Minato Red Cross Hospital", "横浜市立脳卒中・神経脊椎センター": "Yokohama Brain and Spine Center",
	"横浜市立大学附属市民総合医療センター": "Yokohama City University Medical Center", "横浜市立大学附属病院": "Yokohama City University Hospital",
	"済生会横浜市東部病院": "Saiseikai Yokohamashi Tobu Hospital", "済生会横浜市南部病院": "Saiseikai Yokohamashi Nanbu Hospital",
	"聖マリアンナ医科大学横浜市西部病院": "St. Marianna University Yokohama Seibu Hospital", "横浜労災病院": "Yokohama Rosai Hospital",
	"横浜市北部病院": "Showa Medical University Northern Yokohama Hospital", "横浜医療センター": "NHO Yokohama Medical Center",
	"横浜市保健所": "Yokohama City Public Health Center", "八景島シーパラダイス": "Yokohama Hakkeijima Sea Paradise", "總持寺": "Sojiji Temple Treasure Hall",
	"カップヌードルミュージアム": "Cup Noodles Museum", "盲特別支援学校": "Yokohama School for the Blind", "ろう特別支援学校": "Yokohama School for the Deaf", "第三管区海上保安本部": "Japan Coast Guard 3rd Regional Headquarters", "ブリキのおもちゃ": "Tin Toy Museum", "東洋英和女学院大学": "Toyo Eiwa University Library", "つづきMYプラザ": "Tsuzuki Multicultural and Youth Plaza (Tsuzuki MY Plaza)",
	"かながわ県民活動サポートセンター": "Kanagawa Citizens' Activity Support Center", "横浜地方気象台": "Yokohama Local Meteorological Office", "三殿台考古館": "Sandonodai Archaeological Museum",
	"海上災害防止センター": "Maritime Disaster Prevention Center", "海難審判所": "Japan Marine Accident Tribunal", "国税不服審判所": "National Tax Tribunal", "京浜港湾事務所": "Keihin Port Office",
	"東京工業大学": "Tokyo Institute of Technology", "東京都市大学": "Tokyo City University", "日本体育大学": "Nippon Sport Science University", "東京ガス": "Tokyo Gas Environmental Energy Museum", "日本新聞博物館": "Japan Newspaper Museum (Newspark)", "関東学院大学図書館本館": "Kanto Gakuin University Main Library",
	"配偶者暴力相談支援センター": "Kanagawa Spousal Violence Counseling and Support Center", "地球市民かながわプラザ": "Kanagawa Plaza for Global Citizenship", "日本郵船歴史博物館": "NYK Maritime Museum", "はまぎんこども宇宙科学館": "Yokohama Science Center",
};

// 領事館＝「◯◯共和国名誉領事館」→ Honorary Consulate of Bulgaria in Yokohama
const COUNTRY = [["大韓民国", "the Republic of Korea"], ["韓国", "the Republic of Korea"], ["ブルガリア", "Bulgaria"], ["エルサルバドル", "El Salvador"], ["ベネズエラ", "Venezuela"], ["ルーマニア", "Romania"], ["フィジー", "Fiji"],
	["中華人民共和国", "the People's Republic of China"], ["アメリカ", "the United States"], ["イギリス", "the United Kingdom"], ["フランス", "France"], ["ドイツ", "Germany"], ["イタリア", "Italy"], ["スペイン", "Spain"]];
function consulate(s) {
	if (!s.includes("領事館")) return null;
	const c = COUNTRY.find(([k]) => s.includes(k)); if (!c) return null;
	return `${s.includes("名誉") ? "Honorary " : ""}Consulate${s.includes("総領事館") ? " General" : ""} of ${c[1]} in Yokohama`;
}
// 駅の名で読みの決まりから外れる物（公式のローマ字）
const STATION_EN = { "新横浜": "Shin-Yokohama", "元町・中華街": "Motomachi-Chukagai", "日本大通り": "Nihon-odori", "みなとみらい": "Minatomirai", "センター南": "Center Minami", "センター北": "Center Kita",
	"北新横浜": "Kita Shin-Yokohama", "羽沢横浜国大": "Hazawa Yokohama-Kokudai", "新高島": "Shin-Takashima", "馬車道": "Bashamichi", "関内": "Kannai", "桜木町": "Sakuragicho", "石川町": "Ishikawacho",
	"三ツ沢上町": "Mitsuzawa-kamicho", "三ツ沢下町": "Mitsuzawa-shimocho", "伊勢佐木長者町": "Isezakichojamachi", "弘明寺": "Gumyoji", "蒔田": "Maita", "八景島": "Hakkeijima", "金沢八景": "Kanazawa-hakkei" };
/** 読みの道具：towns＝[漢字, 読み] の表（KEN_ALL・長い順）、wards＝[区の名（区なし）, ローマ字]、tokenize＝kuromoji（無ければ漢字のまま） */
export function makeEn({ towns, wards, tokenize }) {
	const W = [["横浜", "Yokohama"], ...wards, ...wards.map(([k, r]) => [k + "区", r + " Ward"])];   // 名の中の「旭区」＝Asahi Ward
	// 町名は「町」抜きでも引く（施設の名は「菅田消防出張所」＝菅田町の菅田）
	const T0 = towns.map(([k, r]) => [normJp(k), toKata(r)]);
	for (const [k, r] of [...T0]) { const m = k.endsWith("町") && r.match(/(チョウ|マチ)$/); if (m && k.length > 1 && !T0.some(([x]) => x === k.slice(0, -1))) T0.push([k.slice(0, -1), r.slice(0, -m[1].length)]); }
	const T = T0.sort((a, b) => b[0].length - a[0].length);
	let guessed = 0;
	// 頭から一番長く当たる物：区の名・「横浜」（別の語）／決まった語／町名（読み）
	const WD = WORDS.map(([k, o, sep]) => [normJp(k), o, sep]);
	const longest = (s, i) => {
		let best = null;
		for (const [k, r] of W) if (s.startsWith(k, i) && (!best || k.length > best.n)) best = { n: k.length, out: ` ${r} ` };
		for (const [k, o, sep] of WD) if (s.startsWith(k, i) && (!best || k.length > best.n)) best = { n: k.length, out: sep === 1 ? ` ${o} ` : o, glue: sep === 2 };
		for (const [k, r] of T) if (s.startsWith(k, i) && (!best || k.length > best.n)) best = { n: k.length, out: romaji(r) };
		return best;
	};
	/** 固有名の部分（「日吉台」など）→ ローマ字（決まった語は英訳の別の語） */
	const proper = s => {
		if (!s) return "";
		let out = "", i = 0;
		while (i < s.length) {
			const b = longest(s, i);
			if (b) { out = (b.glue ? out.trimEnd() : out) + b.out; i += b.n; continue; }
			let j = i + 1; while (j < s.length && !longest(s, j)) j++;   // 辞書へ（次に当たる所までの一続き）
			const part = s.slice(i, j);
			if (/^[\x20-\x7e]+$/.test(part.normalize("NFKC"))) out += ` ${part.normalize("NFKC")} `;
			else {   // 読みの辞書：固有名詞と接尾（「台」「町」）は前に続け、普通の名詞は別の語にする
				guessed++;
				if (!tokenize) out += part;
				else for (const x of tokenize(part)) {
					const f = x.surface_form;
					if (f === "の" && / $/.test(out)) continue;   // 「青少年の地域」＝英語の語の後の「の」は落とす
					const r = /^[・「」『』（）()、。]$/.test(f) ? " " : romaji(x.reading || f);
					const glue = x.pos_detail_1 === "固有名詞" || x.pos_detail_1 === "接尾" || x.pos_detail_1 === "数" || /^[ぁ-ゖ]+$/.test(f) || !/[a-z]$/.test(out);   // ひらがなは前に続ける（くぬぎ台・初音が丘）
					out += glue ? r : ` ${r}`;
				}
			}
			i = j;
		}
		return out.trim().split(/\s+/).filter(Boolean).map((w, i) => i && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : cap(w)).join(" ");
	};
	/** 施設の名 → 英語。cat＝区分の番号（4＝消防） */
	const name = (ja, cat) => name0(ja, cat).replace(/[^\x20-\x7e]/g, "").replace(/\s+/g, " ").trim();   // 読めずに残った字は出さない
	const name0 = (ja, cat) => {
		if (EN_EXACT[ja]) return EN_EXACT[ja];
		for (const [k, v] of Object.entries(EN_FIX)) if (ja.includes(k)) return v;
		const cons = consulate(normJp(ja)); if (cons) return cons;
		let s = normJp(ja).replace(/\([^)]*\)/g, "");   // 括弧の中（愛称）は落とす
		const sp = s.lastIndexOf(" "); if (sp > 0 && /法人/.test(s.slice(0, sp))) s = s.slice(sp + 1);   // 「医療法人社団◯◯会 金沢病院」＝法人の名は落とす
		// 空きの無い法人の名（「医療法人社団恵生会竹山病院」）＝法人の種類の後の最初の「会」「団」まで落とす
		const corp = ["医療法人社団", "医療法人財団", "医療法人", "社会福祉法人", "公益財団法人", "一般財団法人", "一般社団法人", "公益社団法人", "社会医療法人", "宗教法人", "学校法人"].find(k => s.startsWith(k));
		const coop = s.indexOf("生活協同組合"); if (coop > 0 && coop + 6 < s.length) s = s.slice(coop + 6);   // 「医療生協かながわ生活協同組合戸塚病院」→ 戸塚病院
		if (corp) { const rest = s.slice(corp.length), e = [...rest.slice(0, 9)].findIndex(c => c === "会" || c === "団"); s = e >= 0 && e + 1 < rest.length ? rest.slice(e + 1) : rest; }
		const kai = s.indexOf("会"); if (kai > 0 && kai <= 4 && s.endsWith("病院") && s.length - kai > 4) s = s.slice(kai + 1);   // 「康心会汐見台病院」＝医療法人の名（〜会）は落とす
		s = s.replace(/^東京国税局/, "").replace(/^横浜地方検察庁(?=.)/, "").replace(/^東京管区気象台(?=.)/, "").replace(/^神奈川県(?!立)/, "神奈川").replace(/^(横浜市立|横浜市|神奈川県立|市立|県立)/, "").replace(/^消防局/, "").replace(/\s+/g, "");
		const fs = s.indexOf("消防署"); if (fs > 0 && s.endsWith("出張所") && s.length > fs + 6) s = s.slice(fs + 3);   // 「神奈川消防署菅田消防出張所」→ 菅田
		// 警察署の中の交番＝「港北警察署下田交番」→ Shimoda Police Box
		const ps = s.indexOf("警察署"); if (ps > 0 && ["交番", "駐在所", "派出所"].some(k => s.endsWith(k)) && s.length > ps + 5) s = s.slice(ps + 3);
		const hw = s.indexOf("ハローワーク"); if (hw >= 0) return `Hello Work ${proper(s.slice(hw + 6))}`.trim();   // 「ハローワーク戸塚」→ Hello Work Totsuka
		const parts = [];
		// 後ろの種類の語を 1 つ剥がす（「◯◯小学校コミュニティハウス」も表の 1 語で当てる）
		const hit = SUFFIX.find(([k]) => s.endsWith(k) && s.length > k.length);
		if (hit) { parts.push(hit[1]); s = s.slice(0, -hit[0].length); }
		else if (s.endsWith("出張所")) { parts.push(cat === 4 ? "Fire Station Branch" : "Branch Office"); s = s.slice(0, -3); }
		else {   // 種類の語が中ほど＝「老人福祉センター鶴寿荘」→ Kakujuso (Senior Welfare Center)・「磯子区民文化センター杉田劇場」→ Sugita Theater (Isogo Ward Cultural Center)
			let m = null;
			for (const [k, v] of SUFFIX) { const at = s.indexOf(k); if (at >= 0 && at + k.length < s.length && (!m || k.length > m.k.length)) m = { k, v, at }; }
			if (m) { const before = proper(s.slice(0, m.at).replace(/区$/, "")), after = proper(s.slice(m.at + m.k.length)); return `${after} (${[before, m.v].filter(Boolean).join(" ")})`; }
		}
		if (s.endsWith("駅前") || s.endsWith("駅")) { parts.unshift("Station"); s = s.slice(0, s.endsWith("駅前") ? -2 : -1); }   // 「たまプラーザ駅前交番」→ Tama Plaza Station Police Box
		const head = proper(s.replace(/区$/, ""));
		return [head, ...parts].filter(Boolean).join(" ") || proper(normJp(ja));
	};
	/** 住所（「横浜市港北区菊名7-8-27」）→「7-8-27 Kikuna, Kohoku-ku」（横浜市は書かない） */
	const addr = (ja, wardEn) => {
		let s = normJp(ja).replace(/^神奈川県/, "").replace(/^横浜市/, "").replace(/^\S+?区/, "");
		s = s.replace(/([一二三四五六七八九十]+)丁目/, (_, n) => kanjiNum(n) + "-").replace(/番地?の?/g, "-").replace(/号/g, "").replace(/-+$/, "").replace(/-{2,}/g, "-");
		const m = s.match(/^(\D*?)(\d[\d-]*)(.*)$/);
		const town = proper(m ? m[1] : s).replace(/oodoori$/, "odori").replace(/doori$/, "dori"), nums = m ? m[2] : "", rest = m ? m[3].trim() : "";
		const bld = rest && /^[\x20-\x7e]*$/.test(rest) ? ` ${rest}` : "";   // 建物名（日本語）は落とす
		return `${nums ? nums + " " : ""}${town}${bld}${wardEn ? `, ${wardEn}` : ""}`.trim();
	};
	/** 駅の名（「京急鶴見」）→ Keikyu Tsurumi（「駅」は付けない＝画面が "$1 Station" で付ける） */
	const station = ja => STATION_EN[ja] || proper(normJp(ja).replace(/駅$/, ""));
	/** バス停の名：「鶴見駅西口」→ Tsurumi Station West Exit・「奈良小学校前」→ Nara Elementary School・「最乗寺前」→ Saijoji-mae */
	const stop = ja => {
		let s = normJp(ja).replace(/\([^)]*\)/g, "").trim();
		const mae = s.length > 1 && s.endsWith("前"); if (mae) s = s.slice(0, -1);
		if (s.endsWith("駅")) return `${station(s.slice(0, -1))} Station`;
		if (mae && SUFFIX.some(([k]) => s.endsWith(k))) return name(s);
		const r = proper(s);
		return mae && !/(Station|Exit|Center|Park|Hall|Plaza|School|Office|Hospital|Library|House|Entrance|Depot)$/.test(r) ? `${r}-mae` : r;
	};
	return { name, addr, proper, station, stop, guessed: () => guessed };
}
const KN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanjiNum(s) { if (s === "十") return 10; if (s.startsWith("十")) return 10 + KN[s[1]]; if (s.endsWith("十")) return KN[s[0]] * 10; if (s.includes("十")) return KN[s[0]] * 10 + KN[s[2]]; return KN[s] ?? s; }
