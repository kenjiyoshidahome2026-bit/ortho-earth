#!/usr/bin/env node
// 星座名・メシエ天体名の正本（names.json）を Wikidata から組み直す道具（2026-09-19 初版で使用・2026-10-18 に names-from-wikidata.py から移植）。
// 普段は使わない＝names.json が正本（手で直してよい）。言語を足す・見出しを取り直す時だけ走らせる。
//   node scripts/names-from-wikidata.mjs <dir>   ＝<dir> に下の 3 本を置いてから
//   wd-const.json   : SELECT ?c ?abbr ?lang ?label WHERE { ?c wdt:P31 wd:Q8928; wdt:P1813 ?abbr . ?c rdfs:label ?label .
//                     BIND(LANG(?label) AS ?lang) FILTER(?lang IN (<26 言語>)) }            （星座＝Q8928・短縮名＝IAU 略号）
//   wd-const2.json  : おひつじ座 Q10584・かに座 Q8849（短縮名の登録が無く上で漏れる）の rdfs:label
//   wd-messier.json : SELECT ?c ?code ?lang ?label WHERE { ?c p:P528 ?st . ?st ps:P528 ?code; pq:P972 wd:Q14530 .
//                     ?c rdfs:label ?label . BIND(LANG(?label) AS ?lang) FILTER(...) }       （メシエ・カタログ Q14530）
//   取得＝https://query.wikidata.org/sparql（Accept: application/sparql-results+json）
// 規則：ja/en/zh/pl と メシエの en/ja/zh は手当て（下の表）・他は Wikidata の見出しから百科事典の曖昧さ回避
// （「(…)」・hu の「csillagkép」）とカタログ番号型（Messier 13 など）を除去・同言語の星座名と同じメシエ見出しは捨てる。
// 取り違えの当て直しは下の「当て直す」行（抜き取り検査で見つけたもの）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const D = process.argv[2];
if (!D) { console.error("使い方: node scripts/names-from-wikidata.mjs <dir>"); process.exit(1); }
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "names.json");
const read = f => JSON.parse(fs.readFileSync(f, "utf8"));
const assert = (c, m) => { if (!c) throw new Error(m); };
const L = "en ja zh ko fr de es pt it nl pl ru uk hu sv tr el id vi th bn hi ar fa ur he".split(" ");
// 正（ja＝日本天文学会の標準和名・en＝IAU 名）＝names.json 自身（ortho-japan skynames.js の表から写したもの）
const T = Object.entries(read(OUT).constellations).map(([a, v]) => [a, v.en.replace("Boötes", "Bootes"), v.ja]);
assert(T.length === 88, T.length);
const IAU = Object.fromEntries(T.map(([a, la]) => [a, la])); IAU.Boo = "Boötes";
const JA = Object.fromEntries(T.map(([a, , ja]) => [a, ja]));
const zip = vs => { assert(vs.length === 88, vs.length); return Object.fromEntries(T.map(([a], i) => [a, vs[i]])); };
const ZH = zip("仙女座 唧筒座 天燕座 宝瓶座 天鹰座 天坛座 白羊座 御夫座 牧夫座 雕具座 鹿豹座 巨蟹座 猎犬座 大犬座 小犬座 摩羯座 船底座 仙后座 半人马座 仙王座 鲸鱼座 蝘蜓座 圆规座 天鸽座 后发座 南冕座 北冕座 乌鸦座 巨爵座 南十字座 天鹅座 海豚座 剑鱼座 天龙座 小马座 波江座 天炉座 双子座 天鹤座 武仙座 时钟座 长蛇座 水蛇座 印第安座 蝎虎座 狮子座 小狮座 天兔座 天秤座 豺狼座 天猫座 天琴座 山案座 显微镜座 麒麟座 苍蝇座 矩尺座 南极座 蛇夫座 猎户座 孔雀座 飞马座 英仙座 凤凰座 绘架座 双鱼座 南鱼座 船尾座 罗盘座 网罟座 天箭座 人马座 天蝎座 玉夫座 盾牌座 巨蛇座 六分仪座 金牛座 望远镜座 三角座 南三角座 杜鹃座 大熊座 小熊座 船帆座 室女座 飞鱼座 狐狸座".split(" "));
const PL = zip(["Andromeda", "Pompa", "Ptak Rajski", "Wodnik", "Orzeł", "Ołtarz", "Baran", "Woźnica", "Wolarz", "Rylec", "Żyrafa", "Rak", "Psy Gończe", "Wielki Pies", "Mały Pies", "Koziorożec", "Kil", "Kasjopeja", "Centaur", "Cefeusz", "Wieloryb", "Kameleon", "Cyrkiel", "Gołąb", "Warkocz Bereniki", "Korona Południowa", "Korona Północna", "Kruk", "Puchar", "Krzyż Południa", "Łabędź", "Delfin", "Złota Ryba", "Smok", "Źrebię", "Erydan", "Piec", "Bliźnięta", "Żuraw", "Herkules", "Zegar", "Hydra", "Wąż Wodny", "Indianin", "Jaszczurka", "Lew", "Mały Lew", "Zając", "Waga", "Wilk", "Ryś", "Lutnia", "Góra Stołowa", "Mikroskop", "Jednorożec", "Mucha", "Węgielnica", "Oktant", "Wężownik", "Orion", "Paw", "Pegaz", "Perseusz", "Feniks", "Malarz", "Ryby", "Ryba Południowa", "Rufa", "Kompas", "Sieć", "Strzała", "Strzelec", "Skorpion", "Rzeźbiarz", "Tarcza", "Wąż", "Sekstant", "Byk", "Luneta", "Trójkąt", "Trójkąt Południowy", "Tukan", "Wielka Niedźwiedzica", "Mała Niedźwiedzica", "Żagiel", "Panna", "Ryba Latająca", "Lisek"]);
const wd = {};
const put = (o, k, l, v) => { (o[k] ??= {})[l] = v; };
for (const x of read(`${D}/wd-const.json`).results.bindings) {
	const a = x.abbr.value;
	if (a !== "Pomum") put(wd, a, x.lang.value, x.label.value);
}
for (const x of read(`${D}/wd-const2.json`).results.bindings) {
	const a = { Q10584: "Ari", Q8849: "Cnc" }[x.c.value.split("/").pop()];
	put(wd, a, x.lang.value, x.label.value);
}
// 先頭が小文字なら大文字に（python の str.isalpha かつ Ll と同じ判定）
const cap = s => { const [c, ...r] = [...s]; return c && /^\p{Ll}$/u.test(c) ? c.toUpperCase() + r.join("") : s; };
const noParen = s => s.replace(/\s*\([^)]*\)/g, "").trim();
const cleanConst = (l, s) => { s = noParen(s); if (l === "hu") s = s.replace(/\s+csillagkép$/, ""); return cap(s); };
const pick = row => Object.fromEntries(L.filter(l => l in row).map(l => [l, row[l]]));
const C = {}, fb = {};
for (const [a] of T) {
	const row = { en: IAU[a], ja: JA[a], zh: ZH[a], pl: PL[a] };
	for (const l of L) {
		if (l in row) continue;
		const v = wd[a]?.[l];
		if (v) row[l] = cleanConst(l, v);
		else (fb[l] ??= []).push(a);   // 無い＝IAU 名で埋める（loader 側の既定）
	}
	C[a] = pick(row);
}
// Wikidata の取り違えを当て直す（抜き取り検査で発見 2026-09-19）
C.CMa.bn = "বৃহৎ কুকুর মণ্ডল";   // Wikidata は「যুগল মণ্ডল」（別物）。こいぬ座（ক্ষুদ্র কুকুর মণ্ডল）と対の形
// メシエ：広く知られた通称だけ。en/ja/zh＝手当て・他＝Wikidata（カタログ番号型の見出しは捨てる）
const MESS = {
	"M1": ["Crab Nebula", "かに星雲", "蟹状星云"], "M6": ["Butterfly Cluster", "バタフライ星団", "蝴蝶星团"],
	"M7": ["Ptolemy Cluster", "トレミー星団", "托勒密星团"], "M8": ["Lagoon Nebula", "干潟星雲", "礁湖星云"],
	"M11": ["Wild Duck Cluster", "野鴨星団", "野鸭星团"], "M13": ["Great Hercules Cluster", "ヘルクレス座球状星団", "武仙座球状星团"],
	"M16": ["Eagle Nebula", "わし星雲", "鹰状星云"], "M17": ["Omega Nebula", "オメガ星雲", "欧米茄星云"],
	"M20": ["Trifid Nebula", "三裂星雲", "三叶星云"], "M27": ["Dumbbell Nebula", "亜鈴状星雲", "哑铃星云"],
	"M31": ["Andromeda Galaxy", "アンドロメダ銀河", "仙女座星系"], "M33": ["Triangulum Galaxy", "さんかく座銀河", "三角座星系"],
	"M42": ["Orion Nebula", "オリオン大星雲", "猎户座大星云"], "M44": ["Beehive Cluster", "プレセペ星団", "蜂巢星团"],
	"M45": ["Pleiades", "プレアデス星団", "昴星团"], "M51": ["Whirlpool Galaxy", "子持ち銀河", "涡状星系"],
	"M57": ["Ring Nebula", "環状星雲", "环状星云"], "M63": ["Sunflower Galaxy", "ひまわり銀河", "向日葵星系"],
	"M64": ["Black Eye Galaxy", "黒眼銀河", "黑眼睛星系"], "M76": ["Little Dumbbell Nebula", "小亜鈴状星雲", "小哑铃星云"],
	"M81": ["Bode's Galaxy", "ボーデの銀河", "波德星系"], "M82": ["Cigar Galaxy", "葉巻銀河", "雪茄星系"],
	"M83": ["Southern Pinwheel Galaxy", "南の回転花火銀河", "南风车星系"], "M87": ["Virgo A", "おとめ座A", "室女座A"],
	"M97": ["Owl Nebula", "ふくろう星雲", "猫头鹰星云"], "M101": ["Pinwheel Galaxy", "回転花火銀河", "风车星系"],
	"M104": ["Sombrero Galaxy", "ソンブレロ銀河", "草帽星系"],
};
const wm = {};
for (const x of read(`${D}/wd-messier.json`).results.bindings) put(wm, x.code.value.replace(/ /g, ""), x.lang.value, x.label.value);
// python の re（Unicode の \d と \b）と同じ意味にする＝\p{Nd}・語の境は文字/数字/_ の否定先読み
const bad = /messier|mesier|مسي|مسیه|मेसियर|เมซีเย|মেসিয়ার|ngc|^m\s?\p{Nd}|^hd(?![\p{L}\p{N}_])|\p{Nd}/iu;
const M = {}, mrej = {};
for (const [m, [en, ja, zh]] of Object.entries(MESS)) {
	const row = { en, ja, zh };
	for (const l of L) {
		if (l in row) continue;
		const v = wm[m]?.[l];
		if (v && !bad.test(v)) row[l] = cap(noParen(v));
		else if (v) (mrej[l] ??= []).push(`${m}:${v}`);
	}
	for (const l of Object.keys(row)) {   // 同じ言語の星座名と同じ見出し＝星座の項目を指している（ar の M31 など）＝捨てる
		if (!["en", "ja", "zh"].includes(l) && Object.values(C).some(c => c[l] === row[l])) { (mrej[l] ??= []).push(`${m}:${row[l]}(=constellation)`); delete row[l]; }
	}
	M[m] = pick(row);
}
M.M31.ar = "مجرة المرأة المسلسلة"; M.M31.ur = "اینڈرومیڈا کہکشاں"; M.M42.es = "Nebulosa de Orión"; M.M31.pt = "Galáxia de Andrômeda";
const prev = read(OUT);   // 天体（bodies）は Wikidata 由来でない＝そのまま持ち越す
const out = { source: "ja=日本天文学会の標準和名（ortho-japan skynames.js の表から写した）・en=IAU 名・zh/pl=標準名を手当て・メシエの en/ja/zh=手当て・他言語=Wikidata の見出し（2026-09-19 取得・百科事典の曖昧さ回避と カタログ番号型の見出しを除去）。天体（bodies＝太陽・惑星・月・冥王星・衛星 20）＝ortho-solar の UI 辞書（i18n/ui.json・26 言語）から写した。欠けた言語は loader が英語（星座＝IAU 名・メシエ＝英語の通称）に落とす",
	constellations: C, messier: M, bodies: prev.bodies ?? {} };
fs.writeFileSync(OUT, JSON.stringify(out, null, "\t") + "\n");
console.log("const fallback:", Object.fromEntries(Object.entries(fb).map(([l, v]) => [l, v.length])));
for (const l of L) {
	const seen = {};
	for (const a in C) { const v = C[a][l]; if (v) (seen[v] ??= []).push(a); }
	const d = Object.fromEntries(Object.entries(seen).filter(([, a]) => a.length > 1));
	if (Object.keys(d).length) console.log("DUP", l, d);
}
console.log("messier coverage:", Object.fromEntries(L.map(l => [l, Object.values(M).filter(r => l in r).length])));
console.log("messier rejected sample:", Object.fromEntries(Object.entries(mrej).map(([l, v]) => [l, v.slice(0, 3)])));
