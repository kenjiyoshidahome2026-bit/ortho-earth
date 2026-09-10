// ── 国別DB の表示モデル（旧 draw.js 前半の移植）──
// 変更点: isox→key（データ側で焼き込み済）・capitalComment 表→データの capitalNote・言語=キー結合・通貨=キー配列・
// AU 加盟の名前特例→キー "B28" をリストへ（サハラ・アラブ民主共和国）
import { wiki } from "common/wiki.js";
import LANGS from "../../../packages/world/i18n/langs.json";   // 言語一覧（code/name/rtl）＝小さいので同梱。UI 文言と名前は i18n/<lang>.json をサーバーから

export const state = { display: "1", region: "0", filter: "", sort: "1", reg: "", lang: "en", i18n: null };
export const LANG_LIST = LANGS;
export const isRTL = lang => !!(LANGS.find(l => l.code == lang) || {}).rtl;
// 数値は選択言語の区切りで（数字そのものはラテン＝言語をまたいで比較しやすく）
const locale = () => ({ zh: "zh-CN", pt: "pt-BR", ar: "ar-EG", bn: "bn-BD" })[state.lang] || state.lang;
export const fmtInt = n => { try { return new Intl.NumberFormat(locale(), { numberingSystem: "latn", maximumFractionDigits: 0 }).format(n); } catch { return String(Math.round(n)); } };
export const fmtDate = s => { const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(s || ""); if (!m) return s || "";
	try { return new Intl.DateTimeFormat(locale(), { year: "numeric", month: "short", day: "numeric", numberingSystem: "latn" }).format(new Date(+m[1], +m[2] - 1, +m[3])); } catch { return s; } };
export const collator = () => { try { return new Intl.Collator(locale()); } catch { return new Intl.Collator("en"); } };
const td = s => `<td>${s}</td>`, tr = a => `<tr>${a.join("")}</tr>`;
const Table = a => `<table>${a.map(t => tr(t.map(td))).join("")}</table>`;
const span = s => `<span>${s || ""}</span>`, p = s => `<p>${s}</p>`, th = s => `<th>${s}</th>`, table = s => `<table>${s || ""}</table>`;
const inlineFlag = src => `<img class="inline" src="${src}"/>`;
const wikiURL = (lang, id) => `https://${lang}.wikipedia.org/w/index.php?curid=${id}`;
////-------------------------------------------------------------------------------------------------------------
export const REGIONS = [["Whole World", "0"], ["Asia", "3"], ["Europe", "1"], ["Africa", "2"], ["North America", "4"], ["South America", "5"], ["Oceania/Antarctica", "6"]];
REGIONS.name = {}; REGIONS.forEach(t => REGIONS.name[t[1]] = t[0]);
const I = n => fmtInt(n), F = n => (+n).toFixed(3);
export const SORTS = [
	{ label: "Name", member: "name", dire: true, format: I },
	{ label: "Area", member: "area", dire: false, format: I, unit: "km²" },
	{ label: "Population", member: "population", dire: false, format: I, show: 5, ref: "United Nations Population Division" },
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
const SORT_UI = { "GDP": "Nominal GDP", "GDP/C": "GDP per Capita", "GNI": "Nominal GNI", "GNI/C": "GNI per Capita", "PPP": "GDP (PPP)", "PPP/C": "GDP (PPP) per Capita", "HDI": "Human Development Index", "GPI": "Global Peace Index", "PSI": "Public Safety Index" };
SORTS.tip = () => Table(SORTS.map(t => [t.label, ":", SORT_UI[t.label] ? trans(SORT_UI[t.label]) : null]).filter(t => t[2]).sort((p, q) => p[0] > q[0] ? 1 : -1));
SORTS.dataLabels = SORTS.filter(t => !["name", "area"].includes(t.member)).map(t => t.member);
SORTS.index = SORTS.map((t, i) => [t.label, i + 1]);
////-------------------------------------------------------------------------------------------------------------
export const FILTERS = [
	["No filter", ""],
	["UN member states", "un"],
	["UN non-self-governing territories", "NSGT", "EH|VI|AI|VG|KY|SH|TC|BM|FK|MS|GI|AS|GU|TK|NC|PN|PF"],
	["UN permanent members", "UN5", "CN|FR|GB|RU|US"],
	["Overseas territories", "territory"],
	["Disputed / unrecognized states", "conflict"],
	["Olympic members", "ioc"],
	["ISO 3166-1 countries", "iso"],
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
FILTERS.tip = lang => Table(FILTERS.map(t => [t[0], ":", filter_names[t[0]] ? (filter_names[t[0]][lang] || filter_names[t[0]].en) : null]).filter(t => t[2]).sort((p, q) => p[0] > q[0] ? 1 : -1));   // 組織の正式名は ja/en/zh/ko のみ＝他は英語
FILTERS.organizations = {}; FILTERS.filter(t => t[2]).map(t => FILTERS.organizations[t[1]] = t[2].split("|"));
export const LANGUAGES = LANGS.map(l => [l.name, l.code]);
////-------------------------------------------------------------------------------------------------------------
// UI 文言: 英語キー → 選択言語（state.i18n.ui）。en または未訳はキーそのもの（英語）＝英語基軸
export const trans = (key, t1, t2) => {
	const ui = state.i18n && state.i18n.ui;
	let ans = (ui && ui[key]) || key;
	t1 != null && (ans = ans.replace(/\$1/g, t1)); t2 != null && (ans = ans.replace(/\$2/g, t2));
	return ans;
};
trans.names = key => { const ui = state.i18n && state.i18n.ui; return [key, ui && ui[key]].filter(t => t); };   // 検索用（英語+選択言語）
////-------------------------------------------------------------------------------------------------------------
let ctx = null;   // buildModel が設定: { flags, geoms, nation_hash, uiFlags }
class MultiLanguageWiki {
	constructor(obj) { Object.assign(this, obj); }
	get i18n() { return null; }   // 派生クラスが i18n テーブルの自分の行を返す
	get Name() { const e = this.i18n; return (e && e.name) || this.name[state.lang] || this.name.en || this.name.ja || ""; }
	get Wiki() { return this.wiki && this.wiki[state.lang] || 0; }
	OpenWikipedia() {
		const e = this.i18n;
		if (e && e.wiki) return open(`https://${state.lang}.wikipedia.org/wiki/${encodeURIComponent(e.wiki.replace(/ /g, "_"))}`, "_wiki_");   // 選択言語の記事名
		const id = this.Wiki || (this.wiki && this.wiki.en); id && open(this.Wiki ? wikiURL(state.lang, this.Wiki) : wikiURL("en", id), "_wiki_");
	}
}
export class Nation extends MultiLanguageWiki {
	get i18n() { const t = state.i18n; return t && t.nations && t.nations[this.key] || null; }
	get officialName() { const ext = this.extend ? this.extend[state.lang] : ""; return ext ? ext.replace("_", this.Name) : this.Name; }
	get capitalName() { return this.capital ? this.capital.Name : this.territory ? "(" + this.territory.capitalName + ")" : ""; }
	get capitalInfo() { const cap = this.capitalName; return cap ? trans(this.territory ? "Seat of government" : "Capital") + ":" + span(cap) : ""; }
	// 首都の注記＝データ側 capitalNote（defacto/changed/multi/text）。旧 draw.js のハードコード表を撤去
	get capitalComment() {
		const n = this.capitalNote; if (!n) return "";
		const local = ja => (ctx.cityByJa[ja] && ctx.cityByJa[ja].Name) || (ctx.nation_hash[ja] && ctx.nation_hash[ja].Name) || trans(ja);   // 内部参照（name.ja）→ 選択言語
		const ROLE = { 立法: "Legislature", 司法: "Judiciary", 行政: "Executive" };
		if (n.defacto) return span(trans("de facto capital") + ":") + span(local(n.defacto));
		if (n.changed) return span("⬅︎ ") + span(local(n.changed[1])) + span("(" + n.changed[0] + ")");
		if (n.multi) return Table(Object.entries(n.multi).map(([k, v]) => [trans(ROLE[k] || k), ":", local(v)]));
		if (n.text) return ctx.nation_hash[n.text] ? ctx.nation_hash[n.text].Name : trans(({ "スヴァールバル諸島": "Svalbard" })[n.text] || n.text);
		return "";
	}
	get iso2() { return this.iso ? this.iso[0] : ""; }
	get regionNames() { return trans.names(REGIONS.name[this.region]); }
	get regionName() { return trans(REGIONS.name[this.region]); }
	get Currency() { return this.currency ? this.currency.map(t => `<currency>${t.key}</currency>`).join("") : ""; }
	get Language() { return this.languages ? this.languages.map(t => `<language>${t.key}</language>`).join("") : ""; }
	get nationalFlag() { return ctx.flag(this.flagKey); }
	get flagKey() { return ctx.hasFlag(this.key) ? this.key : (this.territory && ctx.hasFlag(this.territory.key)) ? this.territory.key : this.key; }   // 領有国の旗で代替（zip 時代と同じ規則）
	get flagURL() { const f = this.nationalFlag; return f ? f.url() : ""; }
	get inlineFlag() { return inlineFlag(this.flagURL); }
	get geopngurl() { return ctx.geom(this.key); }
	get anthemPlayer() { return this.anthem ? `<audio src="${this.anthem}" controls></audio>` : ""; }
	async flagInfo() {
		const flag = this.nationalFlag; if (!flag) return "";
		const ratio = await flag.ratio(), color = await flag.colors();
		const clist = span("(") + color.slice(0, 9).map(t => `<span class="color" style="background:${t}"></span>`).join("") + (color.length > 9 ? span("…") : "") + span(")");
		return span(trans("Aspect ratio")) + span("=") + span(ratio) + span("/") + span(color.length) + span(trans("colors")) + clist;
	}
	get nameInfo() { return this.iso ? span("ISO 3166-1:") + this.iso.map(span).join(span("/")) : ""; }
	get areaInfo() { return this.area ? span(trans("Area") + ":") + span(fmtInt(this.area) + "km²") : ""; }
	get populationInfo() { return this.population ? span(trans("Population") + ":") + span(fmtInt(this.population.value)) : ""; }
	get gdpInfo() { return this.gdp ? span(trans("Nominal GDP") + ":") + span("$" + fmtInt(this.gdp.value) + "M") : ""; }
	get gdppcInfo() { return this.gdppc ? span(trans("GDP per Capita") + ":") + span("$" + fmtInt(this.gdppc.value)) : ""; }
	get gniInfo() { return this.gni ? span(trans("Nominal GNI") + ":") + span("$" + fmtInt(this.gni.value) + "M") : ""; }
	get gnipcInfo() { return this.gnipc ? span(trans("GNI per Capita") + ":") + span("$" + fmtInt(this.gnipc.value)) : ""; }
	get pppInfo() { return this.ppp ? span(trans("GDP (PPP)") + ":") + span("$" + fmtInt(this.ppp.value) + "M") : ""; }
	get ppppcInfo() { return this.ppppc ? span(trans("GDP (PPP) per Capita") + ":") + span("$" + fmtInt(this.ppppc.value)) : ""; }
	get hdiInfo() { return this.hdi ? span(trans("Human Development Index") + ":") + span(F(this.hdi.value)) : ""; }
	get gpiInfo() { return this.gpi ? span(trans("Global Peace Index") + ":") + span(F(this.gpi.value)) : ""; }
	get psiInfo() { return this.psi ? span(trans("Public Safety Index") + ":") + span(F(this.psi.value)) : ""; }
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
	get unJoin() { const perm = this.is("UN5") ? `<span class="permanent">${trans("Permanent member")}</span>` : ""; return this.un ? this.unFlag + span(fmtDate(this.un[0])) + perm : ""; }
	get unapproved() {
		return !(this.un && this.un[1]) ? null :
			p(inlineFlag(ctx.uiFlags.係争中) + trans("Unrecognized by")) + table(this.un[1].map(t => tr([th(t.inlineFlag) + td(t.Name)])).join(""));
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
	// ja: 先頭がカナなら名前そのもの（「アフガニスタン・イスラム共和国」も丸ごと比較＝seed の5文字読みでは「アフガニ」に潰れて順が狂う）・先頭が漢字（日本/中華…/南アフリカ）だけ読み。他言語は選択言語の名前を Collator で
	get sortName() { return state.lang == "ja" ? (/^[ァ-ヶー]/.test(this.name.ja) ? this.name.ja : (this.yomi || this.name.ja)) : this.Name; }
	get sortCapital() { return this.capital ? this.capital.sortName : this.territory && this.territory.capital ? this.territory.capital.sortName : ""; }
	async abstracts() {
		const id = this.wiki[state.lang] || this.wiki.en, lang = this.wiki[state.lang] ? state.lang : "en";
		const s = (await wiki.extract(id, lang)) || "";
		return s.split(/(?<=[。．.!?！？])\s*/).map(t => t.trim()).filter(t => t);
	}
}
export class City extends MultiLanguageWiki {
	get i18n() { const t = state.i18n; return t && t.cities && t.cities[String(this.wiki && this.wiki.ja)] || null; }
	get sortName() { return state.lang == "ja" ? (/^[ァ-ヶー]/.test(this.name.ja) ? this.name.ja : (this.yomi || this.name.ja)) : this.Name; }
}
export class Currency extends MultiLanguageWiki { get i18n() { const t = state.i18n; return t && t.currencies && t.currencies[this.key] || null; } }
export class Language extends MultiLanguageWiki { get i18n() { const t = state.i18n; return t && t.languages && t.languages[this.key] || null; } }
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
export function buildModel(data, assets) {
	const { nations: N, cities: C, languages: LG, currencies: CU } = data;
	const nation_hash = {}; N.forEach(t => nation_hash[t.name.ja] = new Nation(t));
	const city_hash = {}; C.forEach(t => city_hash[t.wiki.ja] = new City(t));
	const currency_hash = {}; CU.forEach(t => currency_hash[t.key] = new Currency(t));
	const language_hash = {}; LG.forEach(t => language_hash[t.key] = new Language(t));
	const uiFlags = {}; Object.entries({ 国際連合: "UN", 欧州連合: "EU", NATO: "NATO", 係争中: "DISPUTED" }).forEach(([t, id]) => uiFlags[t] = assets.flagURL(id));
	const cityByJa = {}; C.forEach(t => cityByJa[t.name.ja] = city_hash[t.wiki.ja]);
	ctx = { nation_hash, uiFlags, cityByJa, flag: assets.flag, hasFlag: assets.hasFlag, geom: assets.geomURL };
	const nations = Object.values(nation_hash), cities = Object.values(city_hash);
	nations.forEach(t => {
		t.territory && (t.territory = nation_hash[t.territory] || null);
		t.conflict && (t.conflict = nation_hash[t.conflict] || null);
		t.capital && (t.capital = city_hash[t.capital.wiki && t.capital.wiki.ja] || new City(t.capital));   // CityDB 未収蔵の首都は素の City
		t.currency && (t.currency = (Array.isArray(t.currency) ? t.currency : String(t.currency).split("|")).map(k => currency_hash[k] || new Currency({ key: k, name: { ja: k } })));
		t.languages && (t.languages = t.languages.map(k => language_hash[k] || new Language({ key: k, name: { ja: k } })));
		SORTS.dataLabels.forEach(s => t[s] && (t[s] = new yearData(t[s])));
		t.un && Array.isArray(t.un[1]) && (t.un[1] = t.un[1].map(n => nation_hash[n]).filter(x => x));
	});
	const rebuildSearch = () => nations.forEach(t => {
		const target = t.territory || t.conflict;
		t.search = [Object.values(t.name), t.Name, t.yomi || "", Object.values((t.capital || {}).name || {}), t.capital ? t.capital.Name : "", t.regionNames,
			(t.iso || []).slice(0, 2), t.key, target ? [...Object.values(target.name), target.Name] : []].flat().filter(x => x).join("|");
	});
	cities.forEach(t => {
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
	rebuildSearch();
	const key_hash = {}; nations.forEach(t => key_hash[t.key] = t);
	return { nations, cities, nation_hash, key_hash, searchByKey: k => key_hash[k], rebuildSearch };
}
