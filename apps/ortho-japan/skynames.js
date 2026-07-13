// 星座名の日本語化（88星座・日本天文学会の標準和名）。
// データ側のキーが IAU 3文字略号（"Ori"）でもラテン名（"Orion" / "Canis Major"）でも引ける両対応。
// 未知のキーは原文のまま返す＝データが変わっても壊れない。
const T = [
	["And", "Andromeda", "アンドロメダ座"], ["Ant", "Antlia", "ポンプ座"], ["Aps", "Apus", "ふうちょう座"],
	["Aqr", "Aquarius", "みずがめ座"], ["Aql", "Aquila", "わし座"], ["Ara", "Ara", "さいだん座"],
	["Ari", "Aries", "おひつじ座"], ["Aur", "Auriga", "ぎょしゃ座"], ["Boo", "Bootes", "うしかい座"],
	["Cae", "Caelum", "ちょうこくぐ座"], ["Cam", "Camelopardalis", "きりん座"], ["Cnc", "Cancer", "かに座"],
	["CVn", "Canes Venatici", "りょうけん座"], ["CMa", "Canis Major", "おおいぬ座"], ["CMi", "Canis Minor", "こいぬ座"],
	["Cap", "Capricornus", "やぎ座"], ["Car", "Carina", "りゅうこつ座"], ["Cas", "Cassiopeia", "カシオペヤ座"],
	["Cen", "Centaurus", "ケンタウルス座"], ["Cep", "Cepheus", "ケフェウス座"], ["Cet", "Cetus", "くじら座"],
	["Cha", "Chamaeleon", "カメレオン座"], ["Cir", "Circinus", "コンパス座"], ["Col", "Columba", "はと座"],
	["Com", "Coma Berenices", "かみのけ座"], ["CrA", "Corona Australis", "みなみのかんむり座"], ["CrB", "Corona Borealis", "かんむり座"],
	["Crv", "Corvus", "からす座"], ["Crt", "Crater", "コップ座"], ["Cru", "Crux", "みなみじゅうじ座"],
	["Cyg", "Cygnus", "はくちょう座"], ["Del", "Delphinus", "いるか座"], ["Dor", "Dorado", "かじき座"],
	["Dra", "Draco", "りゅう座"], ["Equ", "Equuleus", "こうま座"], ["Eri", "Eridanus", "エリダヌス座"],
	["For", "Fornax", "ろ座"], ["Gem", "Gemini", "ふたご座"], ["Gru", "Grus", "つる座"],
	["Her", "Hercules", "ヘルクレス座"], ["Hor", "Horologium", "とけい座"], ["Hya", "Hydra", "うみへび座"],
	["Hyi", "Hydrus", "みずへび座"], ["Ind", "Indus", "インディアン座"], ["Lac", "Lacerta", "とかげ座"],
	["Leo", "Leo", "しし座"], ["LMi", "Leo Minor", "こじし座"], ["Lep", "Lepus", "うさぎ座"],
	["Lib", "Libra", "てんびん座"], ["Lup", "Lupus", "おおかみ座"], ["Lyn", "Lynx", "やまねこ座"],
	["Lyr", "Lyra", "こと座"], ["Men", "Mensa", "テーブルさん座"], ["Mic", "Microscopium", "けんびきょう座"],
	["Mon", "Monoceros", "いっかくじゅう座"], ["Mus", "Musca", "はえ座"], ["Nor", "Norma", "じょうぎ座"],
	["Oct", "Octans", "はちぶんぎ座"], ["Oph", "Ophiuchus", "へびつかい座"], ["Ori", "Orion", "オリオン座"],
	["Pav", "Pavo", "くじゃく座"], ["Peg", "Pegasus", "ペガスス座"], ["Per", "Perseus", "ペルセウス座"],
	["Phe", "Phoenix", "ほうおう座"], ["Pic", "Pictor", "がか座"], ["Psc", "Pisces", "うお座"],
	["PsA", "Piscis Austrinus", "みなみのうお座"], ["Pup", "Puppis", "とも座"], ["Pyx", "Pyxis", "らしんばん座"],
	["Ret", "Reticulum", "レチクル座"], ["Sge", "Sagitta", "や座"], ["Sgr", "Sagittarius", "いて座"],
	["Sco", "Scorpius", "さそり座"], ["Scl", "Sculptor", "ちょうこくしつ座"], ["Sct", "Scutum", "たて座"],
	["Ser", "Serpens", "へび座"], ["Sex", "Sextans", "ろくぶんぎ座"], ["Tau", "Taurus", "おうし座"],
	["Tel", "Telescopium", "ぼうえんきょう座"], ["Tri", "Triangulum", "さんかく座"], ["TrA", "Triangulum Australe", "みなみのさんかく座"],
	["Tuc", "Tucana", "きょしちょう座"], ["UMa", "Ursa Major", "おおぐま座"], ["UMi", "Ursa Minor", "こぐま座"],
	["Vel", "Vela", "ほ座"], ["Vir", "Virgo", "おとめ座"], ["Vol", "Volans", "とびうお座"], ["Vul", "Vulpecula", "こぎつね座"],
];
const BY_KEY = new Map();
for (const [id, latin, ja] of T) {
	BY_KEY.set(id.toLowerCase(), ja);
	BY_KEY.set(latin.toLowerCase(), ja);
}
// "Boötes" のダイアクリティカル・空白ゆれを畳んでから引く
export function constellationJa(raw) {
	if (!raw) return "";
	const k = String(raw).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
	return BY_KEY.get(k) || String(raw);
}
