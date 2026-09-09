// ── 国別DB の表示モデル（旧 draw.js 前半の移植）──
// 変更点: isox→key（データ側で焼き込み済）・capitalComment 表→データの capitalNote・言語=キー結合・通貨=キー配列・
// AU 加盟の名前特例→キー "B28" をリストへ（サハラ・アラブ民主共和国）
import { comma } from "common";
import { wiki } from "common/wiki.js";

export const state = { display: "1", region: "0", filter: "", sort: "1", reg: "", lang: "ja" };
const td = s => `<td>${s}</td>`, tr = a => `<tr>${a.join("")}</tr>`;
const Table = a => `<table>${a.map(t => tr(t.map(td))).join("")}</table>`;
const span = s => `<span>${s || ""}</span>`, p = s => `<p>${s}</p>`, th = s => `<th>${s}</th>`, table = s => `<table>${s || ""}</table>`;
const inlineFlag = src => `<img class="inline" src="${src}"/>`;
const wikiURL = (lang, id) => `https://${lang}.wikipedia.org/w/index.php?curid=${id}`;
////-------------------------------------------------------------------------------------------------------------
export const REGIONS = [["世界全体", "0"], ["アジア", "3"], ["ヨーロッパ", "1"], ["アフリカ", "2"], ["北アメリカ", "4"], ["南アメリカ", "5"], ["オセアニア・南極", "6"]];
REGIONS.name = {}; REGIONS.forEach(t => REGIONS.name[t[1]] = t[0]);
const I = n => comma("" + Math.round(n)), F = n => (+n).toFixed(3);
export const SORTS = [
	{ label: "名前", member: "name", dire: true, format: I },
	{ label: "面積", member: "area", dire: false, format: I, unit: "㎢" },
	{ label: "人口", member: "population", dire: false, format: I, show: 5, ref: "United Nations Population Division" },
	{ label: "GDP", member: "gdp", dire: false, format: I, show: 5, unit: "M US$", ref: "World Bank / IMF" },
	{ label: "GDP/C", member: "gdppc", dire: false, format: I, show: 5, unit: "US$", ref: "World Bank / IMF" },
	{ label: "GNI", member: "gni", dire: false, format: I, unit: "M US$", ref: "World Bank" },
	{ label: "GNI/C", member: "gnipc", dire: false, format: I, unit: "US$", ref: "World Bank" },
	{ label: "PPP", member: "ppp", dire: false, format: I, unit: "M US$", ref: "World Bank / IMF" },
	{ label: "PPP/C", member: "ppppc", dire: false, format: I, unit: "US$", ref: "World Bank / IMF" },
	{ label: "HDI", member: "hdi", dire: false, format: F, ref: "Human Development Report from UNDP" },
	{ label: "GPI", member: "gpi", dire: true, format: F, ref: "Institute for Economics and Peace" },
	{ label: "PSI", member: "psi", dire: true, format: F, ref: "Institute for Economics and Peace" },
];
const sort_names = {
	"GDP": { ja: "名目国内総生産", en: "Nominal Gross Domestic Product", zh: "名义国内生产总值", ko: "명목 국내총생산" },
	"GDP/C": { ja: "一人当たりの名目国内総生産", en: "Nominal Gross Domestic Product per Capita", zh: "名义人均国内生产总值", ko: "1인당 명목 국내총생산" },
	"GNI": { ja: "名目国民総所得", en: "Nominal Gross National Income", zh: "名义国民总收入", ko: "명목 국민총소득" },
	"GNI/C": { ja: "一人当たりの名目国民総所得", en: "Nominal Gross National Income per Capita", zh: "人均名义国民总收入", ko: "1인당 명목 국민총소득" },
	"PPP": { ja: "購買力平価GDP", en: "Purchasing Power Parity GDP", zh: "购买力平价 GDP", ko: "구매력평가 GDP" },
	"PPP/C": { ja: "一人当りの購買力平価GDP", en: "Purchasing Power Parity GDP per capita", zh: "购买力平价 人均GDP", ko: "1인당 구매력평가 GDP" },
	"HDI": { ja: "人間開発指数", en: "Human Development Index", zh: "人类发展指数", ko: "인간 개발 지수" },
	"GPI": { ja: "平和度指数", en: "Global Peace Index", zh: "和平指数", ko: "평화도 지수" },
	"PSI": { ja: "治安指数", en: "Public Safety Index", zh: "公共安全指数", ko: "치안지수" },
};
SORTS.tip = lang => Table(SORTS.map(t => [t.label, ":", sort_names[t.label] ? sort_names[t.label][lang] : null]).filter(t => t[2]).sort((p, q) => p[0] > q[0] ? 1 : -1));
SORTS.dataLabels = SORTS.filter(t => !["name", "area"].includes(t.member)).map(t => t.member);
SORTS.index = SORTS.map((t, i) => [t.label, i + 1]);
////-------------------------------------------------------------------------------------------------------------
export const FILTERS = [
	["フィルターなし", ""],
	["国際連合加盟国", "un"],
	["国際連合非自治地域", "NSGT", "EH|VI|AI|VG|KY|SH|TC|BM|FK|MS|GI|AS|GU|TK|NC|PN|PF"],
	["国際連合常任理事国", "UN5", "CN|FR|GB|RU|US"],
	["海外領土等", "territory"],
	["紛争国・未承認国家", "conflict"],
	["オリンピック参加国", "ioc"],
	["ISO-3166-1定義国", "iso"],
	["G7", "G7", "CA|DE|FR|GB|IT|JP|US"],
	["G20", "G20", "CA|DE|FR|GB|IT|JP|US|AR|AU|BR|CN|ID|IN|KR|MX|RU|SA|TR|ZA"],
	["G77", "G77", "AF|DZ|AR|BD|BJ|BO|BR|BF|BI|KH|CM|CF|TD|CL|CO|CG|CD|CR|DO|EC|EG|ER|SV|ET|GA|GH|GT|GN|HT|HN|IN|ID|IR|IQ|JM|JO|KE|KW|LA|LB|LR|LY|MG|MY|ML|MR|MX|MA|MM|NP|NI|NE|NG|PK|PA|PY|PE|PH|RW|SA|SN|SL|SO|LK|SD|SY|TZ|TH|TG|TT|TN|UG|UY|VE|VN|YE|AO|AG|AZ|BS|BH|BB|BZ|BT|BW|BN|CN|CV|KM|CI|CU|DJ|DM|GQ|SZ|FJ|GM|GD|GW|GY|KI|LS|MW|MV|MH|MU|FM|MN|MZ|NA|KP|NR|OM|PS|PG|QA|KN|LC|VC|WS|ST|SC|SG|SB|ZA|SS|SR|TJ|TL|TO|TM|AE|VU|ZM|ZW"],
	["EU", "EU", "AT|BE|BG|CY|CZ|DE|DK|EE|ES|FI|FR|GR|HR|HU|IE|IT|LT|LU|LV|MT|NL|PL|PT|RO|SE|SI|SK"],
	["CIS", "CIS", "RU|BY|MD|GE|AM|AZ|KZ|UZ|TM|TJ|KG"],
	["AU", "AU", "AO|BF|BI|BJ|BW|CD|CF|CG|CI|CM|CV|DJ|DZ|EG|ER|ET|GA|GH|GM|GN|GQ|GW|KE|KM|LR|LS|LY|MA|MG|ML|MR|MU|MW|MZ|NA|NE|NG|RW|SC|SD|SL|SN|SO|SS|ST|SZ|TD|TG|TN|TZ|UG|ZA|ZM|ZW|B28"],
	["ASEAN", "ASEAN", "BN|ID|KH|LA|MM|MY|PH|SG|TH|VN"],
	["NAFTA", "NAFTA", "CA|US|MX"],
	["BRICS", "BRICS", "BR|RU|IN|CN|ZA|IR|EG|AE|ET"],
	["MIKTA", "MIKTA", "MX|ID|KR|TR|AU"],
	["NEXT11", "NEXT11", "IR|ID|EG|TR|NG|PK|BD|PH|VN|MX|KR"],
	["CIVETS", "CIVETS", "CO|ID|VN|EG|TR|ZA"],
	["OECD", "OECD", "US|GB|FR|DE|IT|CA|ES|PT|NL|BE|LU|SE|DK|NO|IS|IE|CH|AT|GR|TR|JP|FI|AU|NZ|MX|CZ|HU|PL|KR|SK|CL|SI|IL|EE|LV|LT|CO|CR"],
	["PIF", "PIF", "AU|NZ|PG|FJ|WS|SB|VU|TO|NR|TV|FN|PW|MH|KI|CK|NU|PF|NC"],
	["NATO", "NATO", "AL|BE|BG|CA|CZ|DE|DK|EE|ES|FI|FR|GB|GR|HR|HU|IS|IT|LT|LU|LV|ME|MK|NL|NO|PL|PT|RO|SI|SK|TR|US"],
	["OPEC", "OPEC", "IQ|IR|KW|SA|VE|LY|AE|DZ|NG|GA|GQ|CG"],
	["TPP", "TPP", "BN|SG|NG|CL|CA|JP|MY|MX|PE|VN|AU|GB"],
	["SCO", "SCO", "CN|RU|KZ|KG|TJ|UZ|IN|PK|IR|BY"],
	["QUAD", "QUAD", "JP|US|AU|IN"],
];
const filter_names = {
	G7: { ja: "先進国首脳会議", en: "Group of Seven", zh: "七大工業國組織" },
	G20: { en: "Group of Twenty" }, G77: { en: "Group of Seventy-seven" },
	CIS: { ja: "独立国家共同体", en: "Commonwealth of Independent States", zh: "独立国家联合体", ko: "독립국가연합" },
	NAFTA: { ja: "北米自由貿易協定", en: "North American Free Trade Agreement", zh: "北美自由贸易协定", ko: "북미 자유 무역 협정" },
	BRICS: { zh: "金砖国家", ko: "브릭스" }, MIKTA: { zh: "中等强国合作体", ko: "믹타" }, NEXT11: { zh: "未来11国" }, CIVETS: { zh: "靈貓六國" },
	OECD: { ja: "経済協力開発機構", en: "Organization for Economic Co-operation and Development", zh: "经济合作与发展组织", ko: "경제협력개발기구" },
	EU: { ja: "欧州連合", en: "European Union", zh: "欧洲联盟", ko: "유럽연합" },
	AU: { ja: "アフリカ連合", en: "African Union", zh: "非洲联盟", ko: "아프리카연합" },
	ASEAN: { ja: "東南アジア諸国連合", en: "Association of Southeast Asian Nations", zh: "东南亚国家联盟", ko: "동 남아시아 국가 연합" },
	PIF: { ja: "太平洋諸島フォーラム", en: "Pacific Islands Forum", zh: "太平洋岛屿论坛", ko: "태평양 제도 포럼" },
	NATO: { ja: "北大西洋条約機構", en: "North Atlantic Treaty Organization", zh: "北大西洋公约组织", ko: "북대서양 조약기구" },
	OPEC: { ja: "石油輸出国機構", en: "Organization of the Petroleum Exporting Countries", zh: "石油输出国组织", ko: "석유 수출국기구" },
	TPP: { ja: "環太平洋パートナーシップ協定", en: "Trans-Pacific Partnership", zh: "跨太平洋伙伴关系协定", ko: "환태평양 파트너십 협정" },
	SCO: { ja: "上海協力機構", en: "Shanghai Cooperation Organization", zh: "上海合作组织", ko: "상하이 협력기구" },
	QUAD: { ja: "日米豪印戦略対話", en: "Japan-US-Australia-India Strategic Dialogue", zh: "日美澳印战略对话", ko: "일미 호인 전략 대화" },
};
FILTERS.tip = lang => Table(FILTERS.map(t => [t[0], ":", filter_names[t[0]] ? filter_names[t[0]][lang] : null]).filter(t => t[2]).sort((p, q) => p[0] > q[0] ? 1 : -1));
FILTERS.organizations = {}; FILTERS.filter(t => t[2]).map(t => FILTERS.organizations[t[1]] = t[2].split("|"));
export const LANGUAGES = [["日本語", "ja"], ["English", "en"], ["中文", "zh"], ["한국어", "ko"]];
////-------------------------------------------------------------------------------------------------------------
export const trans = (() => {
	const table = {};
	[["世界全体", "Whole World", "整个世界", "세계 전체"], ["ヨーロッパ", "Europe", "欧洲", "유럽"], ["アフリカ", "Africa", "非洲", "아프리카"],
	["アジア", "Asia", "亚洲", "아시아"], ["北アメリカ", "North America", "北美洲", "북미"], ["南アメリカ", "South America", "南美洲", "남아메리카"],
	["オセアニア・南極", "Oceania/Antarctica", "大洋洲/南极洲", "오세아니아·남극"],
	["名前", "Name", "名称", "이름"], ["面積", "Area", "面积", "면적"], ["人口", "Population", "人口", "인구"],
	["名目GDP", "Nominal GDP", "名义GDP", "명목GDP"], ["名目GNI", "Nominal GNI", "名义GNI", "명목GNI"], ["購買力平価GDP", "GDP(PPP)", "购买力平价 GDP", "구매력평가 GDP"],
	["名目GDP/人", "GDP per Capita", "名义人均国内生产总值", "1인당 명목 GDP"], ["名目GNI/人", "GNI per Capita", "名义国民总收入", "1인당 명목 GNI"],
	["購買力平価GDP/人", "GDP(PPP) per Capita", "购买力平价 人均GDP", "1인당 구매력평가 GDP"], ["人間開発指数", "HDI", "人类发展指数", "인간 개발 지수"],
	["平和度指数", "Global Peace Index", "和平指数", "평화도 지수"], ["治安指数", "Public safety index", "公共安全指数", "치안지수"],
	["フィルターなし", "- No filter -", "- 无过滤器 -", "필터 없음"], ["ISO-3166-1定義国", "ISO-3166-1 definition", "ISO-3166-1定义国", "ISO-3166-1정의국"],
	["オリンピック参加国", "Olympic member", "奥运会参赛国", "올림픽 참여국"], ["国際連合加盟国", "UN member states", "联合国成员国", "국제연합 회원국"],
	["国際連合非自治地域", "UN non-autonomous territories", "国际连合非自治地域", "국제 연합 비자치 지역"], ["国際連合常任理事国", "UN permanent member", "联合国常任理事国", "유엔 상임 이사국"],
	["海外領土等", "Overseas territories, etc.", "海外领土等", "해외 영토 등"], ["紛争国・未承認国家", "Disputed/unrecognized states", "有争议/未被承认的国家", "분쟁국·미승인 국가"],
	["司法", "Judiciary", "司法", "사법"], ["立法", "Legislation", "立法", "입법"], ["行政", "Administration", "行政", "행정"],
	["縦横比", "Aspect", "纵横比", "종횡비"], ["色", "colors", "颜色", "색상"], ["首都", "Capital", "首都", "수도"], ["首府", "Capital", "首都", "슈후"],
	["事実上の首都", "de facto capital", "事实上的首都", "사실상 수도"], ["常任理事国", "Permanent", "常任理事国", "상임이사국"],
	["未承認の加盟国", "Unrecognized member", "未被承认的成员国", "승인되지 않은 회원국"], ["$1の首都は、$2です", "The capital of $1 is $2", "$1的首都是$2", "$1의 수도는 $2입니다"],
	["国旗", "National flag", "国旗", "국기"], ["国名", "Country Name", "国名", "국명"], ["国際連合", "United Nations", "联合国", "국제연합"],
	["地域", "Region", "地区", "지역"], ["通貨", "Currency", "货币", "통화"], ["公用語", "Official Language", "官方语言", "공식언어"],
	["スヴァールバル諸島", "Svalbard", "斯瓦尔巴", "스발바르 제도"], ["a2", "a2", "a2", "a2"], ["a3", "a3", "a3", "a3"], ["num", "num", "num", "num"], ["code", "code", "code", "code"], ["from", "from", "from", "from"],
	].forEach(t => table[t[0]] = { ja: t[0], en: t[1], zh: t[2], ko: t[3] });
	const func = (s, t1, t2) => {
		var ans = (s in table) ? (table[s][state.lang] || table[s].en || s) : s;
		t1 && (ans = ans.replace(/\$1/g, t1)); t2 && (ans = ans.replace(/\$2/g, t2));
		return ans;
	};
	func.table = table;
	func.names = s => Object.values(table[s] || { s });
	func.extend = a => (Array.isArray(a) ? a : [a]).forEach(t => table[t.key || t.ja] = t);
	return func;
})();
trans.extend([
	{ key: "_explain_", ja: "「$1」の概略を説明します", en: "Explain the outline of '$1'", zh: "我来解释一下'$1'的概要", ko: "'$1'의 개요를 설명합니다." },
	{ key: "_open_wiki_", ja: "Wikipediaで「$1」を表示します", en: "Display '$1' on Wikipedia", zh: "在维基百科上显示'$1'", ko: "Wikipedia에서 '$1' 표시" },
	{ key: "_show_flag_", ja: "「$1」の国旗を表示します", en: "Displays the flag of '$1'", zh: "显示'$1'标志", ko: "'$1'의 국기를 표시합니다." },
	{ key: "_flag_svg_", ja: "$1の国旗のSVGをダウンロードします", en: "Download $1 flag SVG", zh: "下载 $1 国旗 SVG", ko: "$1 국기 SVG 다운로드" },
	{ key: "_anthem_", ja: "「$1」の国歌を演奏します", en: "Play the anthem of '$1'", zh: "奏'$1'的国歌", ko: "'$1'의 노래 연주" },
	{ key: "_show_", ja: "「$1」を表示します", en: "Display '$1'", zh: "显示 '$1'", ko: "'$1' 표시" },
	{ key: "_close_", ja: "一覧表示に戻ります", en: "Return to list view", zh: "返回列表视图", ko: "목록 표시로 돌아가기" },
]);
////-------------------------------------------------------------------------------------------------------------
let ctx = null;   // buildModel が設定: { flags, geoms, nation_hash, uiFlags }
class MultiLanguageWiki {
	constructor(obj) { Object.assign(this, obj); }
	get Name() { return this.name[state.lang] || this.name.en || this.name.ja || ""; }
	get Wiki() { return this.wiki && this.wiki[state.lang] || 0; }
	OpenWikipedia() { const id = this.Wiki || (this.wiki && this.wiki.en); id && open(this.Wiki ? wikiURL(state.lang, this.Wiki) : wikiURL("en", id), "_wiki_"); }
}
export class Nation extends MultiLanguageWiki {
	get officialName() { const ext = this.extend ? this.extend[state.lang] : ""; return ext ? ext.replace("_", this.Name) : this.Name; }
	get capitalName() { return this.capital ? this.capital.Name : this.territory ? "(" + this.territory.capitalName + ")" : ""; }
	get capitalInfo() { const cap = this.capitalName; return cap ? trans(this.territory ? "首府" : "首都") + ":" + span(cap) : ""; }
	// 首都の注記＝データ側 capitalNote（defacto/changed/multi/text）。旧 draw.js のハードコード表を撤去
	get capitalComment() {
		const n = this.capitalNote; if (!n) return "";
		if (n.defacto) return span(trans("事実上の首都") + ":") + span(trans(n.defacto));
		if (n.changed) return span("⬅︎ ") + span(trans(n.changed[1])) + span("(" + n.changed[0] + ")");
		if (n.multi) return Table(Object.entries(n.multi).map(([k, v]) => [trans(k), ":", trans(v)]));
		if (n.text) return ctx.nation_hash[n.text] ? ctx.nation_hash[n.text].Name : trans(n.text);
		return "";
	}
	get iso2() { return this.iso ? this.iso[0] : ""; }
	get regionNames() { return trans.names(REGIONS.name[this.region]); }
	get regionName() { return trans(REGIONS.name[this.region]); }
	get Currency() { return this.currency ? this.currency.map(t => `<currency>${t.key}</currency>`).join("") : ""; }
	get Language() { return this.languages ? this.languages.map(t => `<language>${t.key}</language>`).join("") : ""; }
	get nationalFlag() { const f = ctx.flags; return f[this.key] || (this.territory && f[this.territory.key]) || null; }   // flags.zip は <key>.svg（2026-09-09）
	get flagURL() { const f = this.nationalFlag; return f ? f.url() : ""; }
	get inlineFlag() { return inlineFlag(this.flagURL); }
	get geopngurl() { return ctx.geoms[this.name.ja] || ""; }
	get anthemPlayer() { return this.anthem ? `<audio src="${this.anthem}" controls></audio>` : ""; }
	async flagInfo() {
		const flag = this.nationalFlag; if (!flag) return "";
		const ratio = await flag.ratio(), color = await flag.colors();
		const clist = span("(") + color.slice(0, 9).map(t => `<span class="color" style="background:${t}"></span>`).join("") + (color.length > 9 ? span("…") : "") + span(")");
		return span(trans("縦横比")) + span("=") + span(ratio) + span("/") + span(color.length) + span(trans("色")) + clist;
	}
	get nameInfo() { return this.iso ? span("ISO 3166-1:") + this.iso.map(span).join(span("/")) : ""; }
	get areaInfo() { return this.area ? span(trans("面積") + ":") + span(comma(this.area) + "㎢") : ""; }
	get populationInfo() { return this.population ? span(trans("人口") + ":") + span(comma(this.population.value)) : ""; }
	get gdpInfo() { return this.gdp ? span(trans("名目GDP") + ":") + span("$" + comma(this.gdp.value) + "M") : ""; }
	get gdppcInfo() { return this.gdppc ? span(trans("名目GDP/人") + ":") + span("$" + comma(this.gdppc.value)) : ""; }
	get gniInfo() { return this.gni ? span(trans("名目GNI") + ":") + span("$" + comma(this.gni.value) + "M") : ""; }
	get gnipcInfo() { return this.gnipc ? span(trans("名目GNI/人") + ":") + span("$" + comma(this.gnipc.value)) : ""; }
	get pppInfo() { return this.ppp ? span(trans("購買力平価GDP") + ":") + span("$" + comma(this.ppp.value) + "M") : ""; }
	get ppppcInfo() { return this.ppppc ? span(trans("購買力平価GDP/人") + ":") + span("$" + comma(this.ppppc.value)) : ""; }
	get hdiInfo() { return this.hdi ? span(trans("人間開発指数") + ":") + span(F(this.hdi.value)) : ""; }
	get gpiInfo() { return this.gpi ? span(trans("平和度指数") + ":") + span(F(this.gpi.value)) : ""; }
	get psiInfo() { return this.psi ? span(trans("治安指数") + ":") + span(F(this.psi.value)) : ""; }
	get info() {
		const m = SORTS[Math.abs(state.sort) - 1].member;
		return this[m + "Info"] || "";
	}
	is(_) {
		if (!FILTERS.organizations[_]) return !!this[_];
		return FILTERS.organizations[_].includes(this.key);   // key＝iso2 か台帳キー（B28 等）
	}
	get unFlag() { return this.is("un") ? inlineFlag(ctx.uiFlags.国際連合) : ""; }
	get euFlag() { return this.is("EU") ? inlineFlag(ctx.uiFlags.欧州連合) : ""; }
	get natoFlag() { return this.is("NATO") ? inlineFlag(ctx.uiFlags.NATO) : ""; }
	get group() { return this.is("G7") ? `<span class="G7"></span>` : this.is("G20") ? `<span class="G20"></span>` : ""; }
	get flagTitle() { return span(`【 ${this.regionName} 】`) + span(this.officialName) + span("(") + this.capitalInfo + ")"; }
	get summary() { return [this.areaInfo, this.populationInfo, this.gdpInfo].filter(t => t).join("<span>/</span> "); }
	get unJoin() { const perm = this.is("UN5") ? `<span class="permanent">${trans("常任理事国")}</span>` : ""; return this.un ? this.unFlag + span(this.un[0]) + perm : ""; }
	get unapproved() {
		return !(this.un && this.un[1]) ? null :
			p(inlineFlag(ctx.uiFlags.係争中) + trans("未承認の加盟国")) + table(this.un[1].map(t => tr([th(t.inlineFlag) + td(t.Name)])).join(""));
	}
	get relation() {
		if (this.name.ja == "西サハラ") {
			const a = ctx.nation_hash["モロッコ"], b = ctx.nation_hash["サハラ・アラブ民主共和国"];
			return (a ? inlineFlag(a.flagURL) : "") + inlineFlag(ctx.uiFlags.係争中) + (b ? inlineFlag(b.flagURL) : "");
		}
		const status = this.is("conflict") ? inlineFlag(ctx.uiFlags.係争中) : this.is("territory") ? span("⊂ ") : "";
		const target = this.conflict || this.territory;
		return target ? status + inlineFlag(target.flagURL) + span(target.Name) : "";
	}
	get sortName() { return state.lang == "ja" ? (this.yomi || this.name.ja) : state.lang == "ko" ? (this.name.ko || this.name.en) : this.name.en; }
	get sortCapital() { return this.capital ? this.capital.sortName : this.territory && this.territory.capital ? this.territory.capital.sortName : ""; }
	async abstracts() {
		const id = this.wiki[state.lang] || this.wiki.en, lang = this.wiki[state.lang] ? state.lang : "en";
		const s = (await wiki.extract(id, lang)) || "";
		return s.split(/(?<=[。．.!?！？])\s*/).map(t => t.trim()).filter(t => t);
	}
}
export class City extends MultiLanguageWiki { get sortName() { return state.lang == "ja" ? this.yomi || this.name.ja : state.lang == "ko" ? (this.name.ko || this.name.en) : this.name.en; } }
export class Currency extends MultiLanguageWiki { }
export class Language extends MultiLanguageWiki { }
// 統計系列 [年, 最新値, 前年値, …]（欠測は null）。value=最新の有効値・at=その年・data=欠測を前年値で埋めた配列
export class yearData {
	constructor(a) {
		this.year = a[0]; const d = a.slice(1), len = d.length;
		let n = 0; this.at = this.year; this.value = d[n];
		while (!this.value && n < len - 1) { this.value = d[++n]; this.at--; }
		if (!this.value) this.value = 0;
		const c = [].concat(d).reverse(); for (let i = 1; i < len; i++) c[i] = c[i] || c[i - 1];
		this.data = c.reverse(); this.length = len;
	}
}
////-------------------------------------------------------------------------------------------------------------
export function buildModel(data) {
	const { nations: N, cities: C, languages: LG, currencies: CU, flags, geoms } = data;
	const nation_hash = {}; N.forEach(t => nation_hash[t.name.ja] = new Nation(t));
	const city_hash = {}; C.forEach(t => city_hash[t.wiki.ja] = new City(t));
	const currency_hash = {}; CU.forEach(t => currency_hash[t.key] = new Currency(t));
	const language_hash = {}; LG.forEach(t => language_hash[t.key] = new Language(t));
	const uiFlags = {}; Object.entries({ 国際連合: "UN", 欧州連合: "EU", NATO: "NATO", 係争中: "DISPUTED" }).forEach(([t, id]) => uiFlags[t] = flags[id] ? flags[id].url() : "");
	ctx = { flags, geoms, nation_hash, uiFlags };
	const nations = Object.values(nation_hash), cities = Object.values(city_hash);
	nations.forEach(t => {
		trans.table[t.name.ja] = t.name;
		t.territory && (t.territory = nation_hash[t.territory] || null);
		t.conflict && (t.conflict = nation_hash[t.conflict] || null);
		t.capital && (t.capital = city_hash[t.capital.wiki && t.capital.wiki.ja] || new City(t.capital));   // CityDB 未収蔵の首都は素の City
		t.currency && (t.currency = (Array.isArray(t.currency) ? t.currency : String(t.currency).split("|")).map(k => currency_hash[k] || new Currency({ key: k, name: { ja: k } })));
		t.languages && (t.languages = t.languages.map(k => language_hash[k] || new Language({ key: k, name: { ja: k } })));
		SORTS.dataLabels.forEach(s => t[s] && (t[s] = new yearData(t[s])));
		t.un && Array.isArray(t.un[1]) && (t.un[1] = t.un[1].map(n => nation_hash[n]).filter(x => x));
		const target = t.territory || t.conflict;
		t.search = [Object.values(t.name), t.yomi || "", Object.values((t.capital || {}).name || {}), t.regionNames, (t.iso || []).slice(0, 2), t.key, target ? Object.values(target.name) : []].flat().join("|");
	});
	cities.forEach(t => {
		trans.table[t.name.ja] = t.name;
		t.nation = (Array.isArray(t.nation) ? t.nation : [t.nation]).map(n => nation_hash[n]).filter(x => x);
	});
	// 統計の年と長さはデータから（旧 SORTS のハードコード年を撤去）
	SORTS.forEach(s => {
		if (!SORTS.dataLabels.includes(s.member)) return;
		const have = nations.filter(t => t[s.member]);
		s.year = have.length ? Math.max(...have.map(t => t[s.member].year)) : 0;
		s.length = have.length ? Math.max(...have.map(t => t[s.member].length)) : 0;
		s.show = Math.min(s.show || s.length, s.length);
	});
	const key_hash = {}; nations.forEach(t => key_hash[t.key] = t);
	return { nations, cities, nation_hash, key_hash, searchByKey: k => key_hash[k] };
}
