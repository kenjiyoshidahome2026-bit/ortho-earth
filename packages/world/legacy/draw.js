const SystemParameter = { display: "1", region: "0", filter: "", sort: "1", reg: "", lang: "ja" };
const SystemCacheIO = await d3.cache("nations.system");
Object.assign(SystemParameter, (await SystemCacheIO("SystemParameter")) || {});
window.Language = SystemParameter.lang;
{///-------------------------------------------------------------------------------------------------------------
	const td = s => `<td>${s}</td>`, tr = a => `<tr>${a.join("")}</tr>`;
	const Table = a => `<table>${a.map(t => tr(t.map(td))).join("")}</table>`;
	////-------------------------------------------------------------------------------------------------------------
	const REGIONS = [["世界全体", "0"], ["アジア", "3"], ["ヨーロッパ", "1"], ["アフリカ", "2"], ["北アメリカ", "4"], ["南アメリカ", "5"], ["オセアニア・南極", "6"]];
	REGIONS.name = {}; REGIONS.forEach(t => REGIONS.name[t[1]] = t[0]);
	////-------------------------------------------------------------------------------------------------------------
	const I = n => d3.comma("" + Math.round(n)), F = n => n.toFixed(3);
	const SORTS = [
		{ label: "名前", member: "name", dire: true, format: I },
		{ label: "面積", member: "area", dire: false, format: I, unit: "㎢" },
		{ label: "人口", member: "population", dire: false, format: I, year: 2024, length: 15, show: 5, ref: "United Nations Population Division" },
		{ label: "GDP", member: "gdp", dire: false, format: I, year: 2025, length: 13, show: 5, unit: "M US$", ref: "International Monetary Fund" },
		{ label: "GDP/C", member: "gdppc", dire: false, format: I, year: 2025, length: 9, show: 5, unit: "US$", ref: "International Monetary Fund" },
		{ label: "GNI", member: "gni", dire: false, format: I, year: 2023, length: 3, unit: "M US$", ref: "World Bank" },
		{ label: "GNI/C", member: "gnipc", dire: false, format: I, year: 2023, length: 3, unit: "US$", ref: "World Bank" },
		{ label: "PPP", member: "ppp", dire: false, format: I, year: 2024, length: 3, unit: "M US$", ref: "International Monetary Fund" },
		{ label: "PPP/C", member: "ppppc", dire: false, format: I, year: 2024, length: 3, unit: "US$", ref: "International Monetary Fund" },
		{ label: "HDI", member: "hdi", dire: false, format: F, year: 2022, length: 4, ref: "Human Development Report from UNDP" },
		{ label: "GPI", member: "gpi", dire: true, format: F, year: 2024, length: 4, ref: "Institute for Economics and Peace" },
		{ label: "PSI", member: "psi", dire: true, format: F, year: 2024, length: 4, ref: "Institute for Economics and Peace" },
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
	SORTS.dataLabels = SORTS.filter(t => t.length).map(t => t.member);
	SORTS.index = SORTS.map((t, i) => [t.label, i + 1]);
	////-------------------------------------------------------------------------------------------------------------
	const FILTERS = [
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
		["AU", "AU", "AO|BF|BI|BJ|BW|CD|CF|CG|CI|CM|CV|DJ|DZ|EG|ER|ET|GA|GH|GM|GN|GQ|GW|KE|KM|LR|LS|LY|MA|MG|ML|MR|MU|MW|MZ|NA|NE|NG|RW|SC|SD|SL|SN|SO|SS|ST|SZ|TD|TG|TN|TZ|UG|ZA|ZM|ZW"],
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
		G20: { en: "Group of Twenty" },
		G77: { en: "Group of Seventy-seven" },
		CIS: { ja: "独立国家共同体", en: "Commonwealth of Independent States", zh: "独立国家联合体", ko: "독립국가연합" },
		NAFTA: { ja: "北米自由貿易協定", en: "North American Free Trade Agreement", zh: "北美自由贸易协定", ko: "북미 자유 무역 협정" },
		BRICS: { zh: "金砖国家", ko: "브릭스" },
		MIKTA: { zh: "中等强国合作体", ko: "믹타" },
		NEXT11: { zh: "未来11国" },
		CIVETS: { zh: "靈貓六國" },
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
	////-------------------------------------------------------------------------------------------------------------
	const LANGUAGES = [["日本語", "ja"], ["English", "en"], ["中文", "zh"], ["한국어", "ko"]];
	////-------------------------------------------------------------------------------------------------------------
	const inline = '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" version="1.1"><g><path d="m431,135h-350c-9,0-16,7-16,16c0,9,7,16,16,16h350c9,0,16-7,16-16c0-9-7-16-16-16zm0,141h-350c-9,0-16,7-16,16c0,9,7,16,16,16h350c9,0,16-7,16-16c0-9-7-16-16-16zm0,141h-350c-9,0-16,7-16,16c0,9,7,16,16,16h350c9,0,16-7,16-16c0-9-7-16-16-16zm-350-321h350c9,0,16-7,16-16c0-8-7-16-16-16h-350c-9,0-16,8-16,16c0,9,7,16,16,16zm350,109h-350c-9,0-16,7-16,16s7,16,16,16h350c9,0,16-7,16-16s-7-16-16-16zm0,141h-350c-9,0-16,7-16,16c0,9,7,16,16,16h350c9,0,16-7,16-16c0-9-7-16-16-16z"/></g></svg>';
	const block = '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" version="1.1"><g><path d="m72,72h161v161h-161zm207,0h161v161h-161zm-207,207h161v161h-161zm207,0h161v161h-161z"/></g></svg>';
	const DISPLAY = [[block, "1"], [inline, "2"]];
	////-------------------------------------------------------------------------------------------------------------
	const trans = (() => {
		const table = {};
		[["世界全体", "Whole World", "整个世界", "세계 전체"],
		["ヨーロッパ", "Europe", "欧洲", "유럽"],
		["アフリカ", "Africa", "非洲", "아프리카"],
		["アジア", "Asia", "亚洲", "아시아"],
		["北アメリカ", "North America", "北美洲", "북미"],
		["南アメリカ", "South America", "南美洲", "남아메리카"],
		["オセアニア・南極", "Oceania/Antarctica", "大洋洲/南极洲", "오세아니아·남극"],
		////--------------------------------------------
		["名前", "Name", "名称", "이름"],
		["面積", "Area", "面积", "면적"],
		["人口", "Population", "人口", "인구"],
		["名目GDP", "Nominal GDP", "名义GDP", "명목GDP"],
		["名目GNI", "Nominal GNI", "名义GNI", "명목GNI"],
		["購買力平価GDP", "GDP(PPP)", "购买力平价 GDP", "구매력평가 GDP"],
		["名目GDP/人", "GDP per Capita", "名义人均国内生产总值", "1인당 명목 GDP"],
		["名目GNI/人", "GNI per Capita", "名义国民总收入", "1인당 명목 GNI"],
		["購買力平価GDP/人", "GDP(PPP) per Capita", "购买力平价 人均GDP", "1인당 구매력평가 GDP"],
		["人間開発指数", "HDI", "人类发展指数", "인간 개발 지수"],
		["平和度指数", "Global Peace Index", "和平指数", "평화도 지수"],
		["治安指数", "Public safety index", "公共安全指数", "치안지수"],
		////--------------------------------------------
		["フィルターなし", "- No filter -", "- 无过滤器 -", "필터 없음"],
		["ISO-3166-1定義国", "ISO-3166-1 definition", "ISO-3166-1定义国", "ISO-3166-1정의국"],
		["オリンピック参加国", "Olympic member", "奥运会参赛国", "올림픽 참여국"],
		["国際連合加盟国", "UN member states", "联合国成员国", "국제연합 회원국"],
		["国際連合非自治地域", "UN non-autonomous territories", "国际连合非自治地域", "국제 연합 비자치 지역"],
		["国際連合常任理事国", "UN permanent member", "联合国常任理事国", "유엔 상임 이사국"],
		["海外領土等", "Overseas territories, etc.", "海外领土等", "해외 영토 등"],
		["紛争国・未承認国家", "Disputed/unrecognized states", "有争议/未被承认的国家", "분쟁국·미승인 국가"],
		////--------------------------------------------
		["司法", "Judiciary", "司法", "사법"],
		["立法", "Legislation", "立法", "입법"],
		["行政", "Administration", "行政", "행정"],
		["縦横比", "Aspect", "纵横比", "종횡비"],
		["色", "colors", "颜色", "색상"],
		["首都", "Captal", "首都", "수도"],
		["首府", "Captal", "首都", "슈후"],
		["事実上の首都", "de facto capital", "事实上的首都", "사실상 수도"],
		["常任理事国", "Permanent", "常任理事国", "상임이사국"],
		["未承認の加盟国", "Unrecognized member", "未被承认的成员国", "승인되지 않은 회원국"],
		["$1の首都は、$2です", "The capital of $1 is $2", "$1的首都是$2", "$1의 수도는 $2입니다"],
		].forEach(t => table[t[0]] = { ja: t[0], en: t[1], zh: t[2], ko: t[3] });
		const func = (s, t1, t2) => {
			var ans = (s in table) ? table[s][SystemParameter.lang || "en"] : s;
			t1 && (ans = ans.replace(/\$1/g, t1));
			t2 && (ans = ans.replace(/\$2/g, t2));
			return ans;
		};
		func.table = table;
		func.names = s => Object.values(table[s]);
		func.extend = a => {
			(Array.isArray(a) ? a : [a]).forEach(t => table[t.key || t.ja] = t);
		}
		return func;
	})();
	Object.assign(window, { trans, DISPLAY, REGIONS, SORTS, LANGUAGES, FILTERS });
} {//------------------------------------------------------------------------------------------------------------------------	
	#inline("37xZk8wR");// file I/O definitions
	#inline("dypwCN2k");// class FlagSVG
	#inline("UEVbTZC1"); //new wiki api (d3.wiki)
	#inline("7SzWe6GP"); // geometries
	const nationalFlags = await makeFlags();
	const Flags = {};["国際連合", "欧州連合", "NATO", "係争中"].map(t => Flags[t] = nationalFlags[t].url());
	const wikiurl = (id, lang) => `http://${lang}.wikipedia.org/w/index.php?curid=${id}`;
	const span = s => `<span>${s || ""}</span>`, p = s => `<p>${s}</p>`;
	const td = s => `<td>${s}</td>`, th = s => `<th>${s}</th>`, tr = s => `<tr>${s || ""}</tr>`, table = s => `<table>${s || ""}</table>`;
	const Table = a => table(a.map(t => tr(t.map(td).join(""))).join(""))
	const inlineFlag = src => `<img class="inline" src="${src}"/>`;
	const wikiURL = (lang, id) => `http://${lang}.wikipedia.org/w/index.php?curid=${id}`;//.name
	////------------------------------
	const nvkelso = await setupMapGeometories();
	const border = await nvkelso.nation("iso");
	const disputed = await nvkelso.nation("disputed");
	const sovereignts = {}, claims = {};
	disputed.forEach(t => {
		const p = t.properties;
		if (p.sovereignt) {
			const s = p.iso || p.sovereignt;
			(sovereignts[s] = sovereignts[s] || []).push(p.id);
		}
		if (Array.isArray(p.claim)) p.claim.forEach(t => (claims[t] = claims[t] || []).push(p.id));
		if (p.area < 20) {
			p.grow = true;
			t.geometry = turf.convex(t).geometry;
			if (turf.area(t) / 1e+6 < 10) t.geometry = toClockwise(turf.circle(turf.centroid(t), 10)).geometry;
			p.bbox = turf.bbox(t);
		}
	});
	sovereignts["B89"] = ["B89"];//クリミア
	const geotub = {};
	border.forEach(t => geotub[t.properties.id] = t);
	disputed.forEach(t => geotub[t.properties.id] = t);
	const geoPNG = await makeGeoPNG();
	////---------------------------------------------
	class MultiLanguageWiki {
		constructor(obj) { Object.keys(obj).forEach(t => this[t] = obj[t]); }
		get Name() { return this.name[SystemParameter.lang] || this.name.en || ""; }
		get Wiki() { return this.wiki[SystemParameter.lang] || 0; }
		OpenWikipedia() { open(this.Wiki ? wikiURL(SystemParameter.lang, this.Wiki) : wikiURL("en", this.wiki.en), "_wiki_"); }
	}
	////---------------------------------------------iso
	class Nation extends MultiLanguageWiki {
		get officialName() {
			var extend = this.extend ? this.extend[SystemParameter.lang] : "";
			return extend ? extend.replace("_", this.Name) : this.Name;
		};
		get capitalName() { return this.capital ? this.capital.Name : this.territory ? "(" + this.territory.capitalName + ")" : ""; }
		get capitalInfo() {
			const cap = this.capitalName;
			return cap ? trans(this.territory ? "首府" : "首都") + ":" + span(cap) : "";
		}
		get capitalComment() {
			const defacto = (name) => span(trans("事実上の首都") + ":") + span(trans(name));
			const changed = (year, name) => span("⬅︎ ") + span(trans(name)) + span("(" + year + ")");
			const func = ({
				"南アフリカ": () => Table([[trans("立法"), ":", trans("ケープタウン")], [trans("司法"), ":", trans("ブルームフォンテーン")], [trans("行政"), ":", trans("プレトリア")]]),
				"ベナン": () => defacto("コトヌー"),
				"ボリビア": () => defacto("ラパス"),
				"コートジボアール": () => defacto("アビジャン"),
				"スリランカ": () => changed(1985, "コロンボ"),
				"ブルンジ": () => changed(2019, "ブジュンブラ"),
				"タンザニア": () => changed(1996, "ダルエスサラーム"),
				"ミャンマー": () => changed(2006, "ヤンゴン"),
				"スヴァールバル諸島およびヤンマイエン島": () => trans("スヴァールバル諸島"),
				"イギリス領インド洋地域": () => nation_hash["セーシェル"].Name,
			})[this.name.ja];
			return func ? func() : "";
		}
		get iso2() { return this.iso ? this.iso[0] : ""; }
		get regionNames() { return trans.names(REGIONS.name[this.region]); }
		get regionName() { return trans(REGIONS.name[this.region]); }
		get Currency() { return this.currency ? this.currency.map(t => `<currency>${t.key}</currency>`).join("") : ""; }
		get Language() { return this.languages ? this.languages.map(t => `<language>${t.key}</language>`).join("") : ""; }
		get nationalFlag() { return (nationalFlags[this.name.ja] || nationalFlags[this.territory.name.ja]); }
		get flagURL() { return this.nationalFlag.url(); }
		get inlineFlag() { return inlineFlag(this.flagURL); }
		get geopngurl() { return geoPNG[this.name.ja]; }
		get anthemPlayer() { return this.anthem ? `<audio src="${this.anthem}" controls></audio>` : "" }
		async flagInfo() {
			const flag = this.nationalFlag, ratio = await flag.ratio(), color = await flag.colors();
			const clist = (span("(") + color.slice(0, 9).map(t => `<span class="color" style="background:${t}"></span>`).join("") + (color.length > 9 ? span("…") : "") + span(")"));
			return span(trans("縦横比")) + span("=") + span(ratio) + span("/") + span(color.length) + span(trans("色")) + clist;
		}
		////-------------------------------------------------------------------------------
		get nameInfo() { return this.iso ? span("ISO 3166-1:") + this.iso.map(span).join(span("/")) : ""; };
		get areaInfo() { return span(trans("面積") + ":") + span(d3.comma(this.area) + "㎢"); }
		get populationInfo() { return this.population ? span(trans("人口") + ":") + span(d3.comma(this.population.value)) : ""; }
		get gdpInfo() { return this.gdp ? span(trans("名目GDP") + ":") + span("$" + d3.comma(this.gdp.value) + "M") : ""; }
		get gdppcInfo() { return this.gdppc ? span(trans("名目GDP/人") + ":") + span("$" + d3.comma(this.gdppc.value)) : ""; }
		get gniInfo() { return this.gni ? span(trans("名目GNI") + ":") + span("$" + d3.comma(this.gni.value) + "M") : ""; }
		get gnipcInfo() { return this.gnipc ? span(trans("名目GNI/人") + ":") + span("$" + d3.comma(this.gnipc.value)) : ""; }
		get pppInfo() { return this.gni ? span(trans("購買力平価GDP") + ":") + span("$" + d3.comma(this.ppp.value) + "M") : ""; }
		get ppppcInfo() { return this.gnipc ? span(trans("購買力平価GDP/人") + ":") + span("$" + d3.comma(this.ppppc.value)) : ""; }
		get hdiInfo() { return this.hdi ? span(trans("人間開発指数") + ":") + span(this.hdi.value.toFixed(3)) : ""; }
		get gpiInfo() { return this.gpi ? span(trans("平和度指数") + ":") + span(this.gpi.value.toFixed(3)) : ""; }
		get psiInfo() { return this.psi ? span(trans("治安指数") + ":") + span(this.psi.value.toFixed(3)) : ""; }
		////-------------------------------------------------------------------------------
		get info() {
			switch (Math.abs(SystemParameter.sort)) {
				case 1: return this.nameInfo; case 2: return this.areaInfo; case 3: return this.populationInfo;
				case 4: return this.gdpInfo; case 5: return this.gdppcInfo;
				case 6: return this.gniInfo; case 7: return this.gnipcInfo;
				case 8: return this.pppInfo; case 9: return this.ppppcInfo;
				case 10: return this.hdiInfo; case 11: return this.gpiInfo; case 12: return this.psiInfo;
			}
		}
		//			return this[SORTS.map(t=>t.member)[Math.abs(SystemParameter.sort)-1]+"Info"](); }
		////-------------------------------------------------------------------------------
		is(_) {
			if (!FILTERS.organizations[_]) return this[_];
			if (_ == "AU" && this.name.ja == "サハラ・アラブ民主共和国") return true;// no iso!!!
			return FILTERS.organizations[_].includes(this.iso2);
		}
		////-------------------------------------------------------------------------------
		get unFlag() { return this.is("un") ? inlineFlag(Flags.国際連合) : ""; }
		get euFlag() { return this.is("EU") ? inlineFlag(Flags.欧州連合) : ""; }
		get natoFlag() { return this.is("NATO") ? inlineFlag(Flags.NATO) : ""; }
		get group() { return this.is("G7") ? `<span class="G7"/>` : this.is("G20") ? `<span class="G20"/>` : ""; }
		get flagTitle() { return span(`【 ${this.regionName} 】`) + span(this.officialName) + span("(") + this.capitalInfo + ")" }
		get mapTitle() { return `<table><tr><td>${this.inlineFlag}</td><td><title>${this.officialName}</title>${this.capitalInfo}</td></tr></table>` }
		get summary() { return [this.areaInfo, this.populationInfo, this.gdpInfo].filter(t => t).join("<span>/</span> "); }
		get unJoin() {
			const perm = this.is("UN5") ? `<span class="permanent">${trans("常任理事国")}</span>` : "";
			return this.un ? this.unFlag + span(this.un[0]) + perm : "";
		}
		get unapproved() {
			return !(this.un && this.un[1]) ? null :
				p(inlineFlag(Flags.係争中) + trans("未承認の加盟国")) + table(this.un[1].map(t => tr(th(t.inlineFlag) + td(t.Name))).join(""));
		}
		get relation() {
			if (this.name.ja == "西サハラ") {
				var a = nation_hash["モロッコ"], b = nation_hash["サハラ・アラブ民主共和国"];
				return inlineFlag(a.flagURL) + inlineFlag(Flags.係争中) + inlineFlag(b.flagURL);
			}
			var status = this.is("conflict") ? inlineFlag(Flags.係争中) : this.is("territory") ? span("⊂ ") : "";
			var target = this.conflict || this.territory;
			return target ? status + inlineFlag(target.flagURL) + span(target.Name) : "";
		}
		get sortName() { return SystemParameter.lang == "ja" ? this.yomi : SystemParameter.lang == "ko" ? this.name.ko : this.name.en; }
		get sortCapital() { return this.capital ? this.capital.sortName : this.territory ? this.territory.capital.sortName : ""; }
		////-------------------------------------------------------------------------------
		async abstracts() {
			#inline("Souh3JWy"); // divideSentence 文章を細かい文節に変換する。
			var s = await d3.wiki.extract(this.wiki[SystemParameter.lang], SystemParameter.lang);
			return (divideSentence[SystemParameter.lang] || divideSentence.en)(s);
		}
		async downloadFlag() {
			bucket.download(this.Name + ".svg", await this.nationalFlag.format());
		}
		////-------------------------------------------------------------------------------
		get isox() {
			return this.iso2 || {
				"アフガニスタン・イスラム共和国": "AFX",
				"北キプロス・トルコ共和国": "B20",
				"ソマリランド": "B30",
				"アブハジア": "B35",
				"沿ドニエストル共和国": "B36",
				"南オセチア": "B37",
				"アルツァフ共和国": "B38",
				"クリミア共和国": "B89",
				"ドネツク人民共和国": "C02",
				"ルガンスク人民共和国": "C03",
				"西サハラ": "EHX",
				"クリッパートン島": "FR-CP",
			}[this.name.ja];
		}
		get geometry() { return geotub[this.isox]; }
		get sovereignts() { return (sovereignts[this.isox] || []).map(t => geotub[t]); }
		get claims() { return (claims[this.isox] || []).map(t => geotub[t]); }
		async states() {
			if (this._state) return this._state;
			const cmp = (a, b) => a.length == b.length ? a > b ? 1 : -1 : a.length > b.length ? 1 : -1;
			const state = (await nvkelso.state(this.iso2) || []).sort((p, q) => cmp(p.properties.id, q.properties.id));
			state.forEach((t, i) => t.properties.order = i);
			return (this._state = state);
		};
		async city() {
			if (this._city) return this._city;
			var city = (await nvkelso.city(this.isox) || []).sort((p, q) => p.pop[0] > q.pop[0] ? -1 : 1)
				.map((t, i) => [t.coords, t.name, t.level, t.capital, t.qid, i]);
			//			if (this.capital && !city.filter(t=>t[3]).length) {//cityデータベースに首都がない場合。
			//				city.push([this.capital.coords, this.capital.name[SystemParameter.lang], 0, true, city.length ]);
			//			}
			return (this._city = city);
		}
		async lake() {
			const B = turf.bbox(this.geometry);
			return lake.filter(t => {
				if (t.properties.area < 600) return false;
				const b = t.properties.bbox;
				return !(b[0] > B[2] || b[1] > B[3] || b[2] < B[0] || b[3] < B[1]);
			});
		}
		async urbun() { return this._urbun || (this._urbun = await nvkelso.urbun(this.iso2) || []); }
		async road() { return this._road || (this._road = await nvkelso.road(this.iso2) || []); }
		async rail() { return this._rail || (this._rail = await nvkelso.rail(this.iso2) || []); }
		async china() { return (this.iso2 == "CN") ? await nvkelso.nation("china") : null; }
		async antarctic() { return (this.iso2 == "AQ") ? await nvkelso.nation("antarctic") : null; }
	}
	////---------------------------------------------
	class City extends MultiLanguageWiki {
		get sortName() { return SystemParameter.lang == "ja" ? this.yomi || this.name.ja : SystemParameter.lang == "ko" ? this.name.ko : this.name.en; }
	}
	class Currency extends MultiLanguageWiki { }
	class Language extends MultiLanguageWiki { }
	class yearData {
		constructor(a) {
			this.year = a[0]; var d = a.slice(1), len = d.length;
			var n = 0; this.at = this.year; this.value = d[n]; if (len == 1) return;
			while (!this.value && n < len) this.value = d[++n], this.at--;
			if (!this.value) this.value = 0;
			var c = [].concat(d).reverse(); for (let i = 1; i < len; i++) c[i] = c[i] || c[i - 1];
			this.data = c.reverse(); this.length = len;
		}
	}
	class yearDataNew {
		constructor(a) { this.year = a[0]; this.dataArray = a.slice(1); }
		get length() { this.dataArray.length; }
		get value() {
			var n = 0, v = this.dataArray[n];
			while (!v && n < this.length) v = this.dataArray[++n];
			return v || 0;
		}
		get at() {
			var y = this.year;
			for (let i = 0; !this.dataArray[i] && i < this.length; i++) y--;
			return y;
		}
		get data() {
			var c = [].concat(this.dataArray).reverse(); for (let i = 1; i < c.length; i++) c[i] = c[i] || c[i - 1];
			return c.reverse();
		}
	}
	////-------------------------------------------------------------------------------------------------------------
	const nation_hash = {}; (await loadNationDB()).forEach(t => nation_hash[t.name.ja] = new Nation(t));
	const city_hash = {}; (await loadCityDB()).forEach(t => city_hash[t.wiki.ja] = new City(t));
	const currency_hash = {}; (await loadCurrencyDB()).forEach(t => currency_hash[t.key] = new Currency(t));
	const language_hash = {}; (await loadLanguageDB()).forEach(t => language_hash[t.name.ja] = new Language(t));
	const nations = Object.values(nation_hash);
	const cities = Object.values(city_hash);
	nations.forEach(t => {
		trans.table[t.name.ja] = t.name;
		t.territory && (t.territory = nation_hash[t.territory]);
		t.conflict && (t.conflict = nation_hash[t.conflict]);
		t.capital && (t.capital = city_hash[t.capital.wiki.ja]);
		t.currency && (t.currency = t.currency.split("|").map(t => currency_hash[t]));
		t.languages && (t.languages = t.languages.map(t => language_hash[t]));
		SORTS.dataLabels.forEach(s => t[s] && (t[s] = new yearData(t[s])));
		var target = t.territory || t.conflict;
		target = target ? Object.values(target.name) : [];
		t.un && Array.isArray(t.un[1]) && (t.un[1] = t.un[1].map(t => nation_hash[t]));
		t.search = [Object.values(t.name), Object.values((t.capital || {}).name || {}), t.regionNames, (t.iso || []).slice(0, 2), target].flat().join("|");
	});
	cities.forEach(t => {
		trans.table[t.name.ja] = t.name;
		t.nation = (Array.isArray(t.nation) ? t.nation : [t.nation]).map(t => nation_hash[t]);
	});
	nations.borders = reductFeatures(border, 1e4);
	nations.smallNations = (() => {
		const a = [];
		border.filter(t => t.properties.area < 1000).forEach(t => {
			const g = t.geometry, p = t.properties;
			const c = g.type == "MultiPolygon" ? g.coordinates : g.type == "Polygon" ? [g.coordinates] : [];
			c.forEach(t => a.push([turf.centroid(turf.polygon(t)).geometry.coordinates, p.id]));
		});
		return a;
	})();
	nations.disputeFlag = inlineFlag(Flags.係争中);
	const iso_hash = {}; nations.forEach(t => iso_hash[t.isox] = t);
	disputed.filter(t => t.properties.id == t.properties.sovereignt).forEach(t => {
		iso_hash[t.properties.id] = nation_hash[t.properties.name.ja];
	});
	nations.searchByISO = iso => iso_hash[iso];
	Object.assign(window, { nations, nvkelso });
}
function nameJA(s) {
	return {
		"オランダ領カリブ": "ボネール、シント・ユースタティウスおよびサバ",
		"コートジボアール": "コートジボワール",
		"パプア・ニューギニア": "パプアニューギニア",
		"マラウィ": "マラウイ",
		"南ジョージア島・南サンドイッチ諸島": "サウスジョージア・サウスサンドウィッチ諸島",
		"米領サモア": "アメリカ領サモア",
		"米領バージン諸島": "アメリカ領ヴァージン諸島",
		"英領バージン諸島": "イギリス領ヴァージン諸島",
	}[s] || s;

}
////=================================================================================================================================
const Sound = await(async () => {
	const sounds = (s, v = 1) => { sounds.src[s].currentTime = 0; sounds.src[s].volume = v; sounds.src[s].play(); };
	sounds.src = {};
	(await bucket.loadFiles("音源", { project: "b1qEpPlw" })).forEach(t => sounds.src[t.name.replace(/\.mp3$/, "")] = new Audio(URL.createObjectURL(t)));
	sounds.list = Object.keys(sounds.src);
	return sounds;
})();
////-------------------------------------------------------------------
const Speech = await(async () => {
	#inline("83gIBlJO"); // makeSpeach API
	const sp = await makeSpeach();
	let _lang_ = "";
	const voices = {
		ja: ["Google 日本語", "Hattori", "Kyoto", "O-Ren"],
		en: ['Google US English', 'Aaron', 'Albert', 'Bad News', 'Bahh', 'Boing', 'Bubbles', 'Cellos',
			'Eddy (英語（アメリカ合衆国）)', 'Flo (英語（アメリカ合衆国）)', 'Fred', 'Good News',
			'Grandma (英語（アメリカ合衆国）)', 'Grandpa (英語（アメリカ合衆国）)', 'Junior', 'Kathy',
			'Nicky', 'Ralph', 'Reed (英語（アメリカ合衆国）)', 'Rocko (英語（アメリカ合衆国）)',
			'Samantha', 'Sandy (英語（アメリカ合衆国）)', 'Shelley (英語（アメリカ合衆国）)',
			'Zarvox', 'ささやき声', 'オルガン', 'スーパースター', 'トリノイド', 'ベル', '道化', '震え'],
		zh: ['Google 普通话（中国大陆）', 'Li-Mu', 'Ting-Ting', 'Yu-shu'],
		ko: ['Google 한국의', 'Yuna'],
	};
	sp.setLanguage = lang => lang == _lang_ || sp.set(voices[_lang_ = lang]);
	return sp;
})();
////=================================================================================================================================
const { disputeFlag, searchByISO, borders, smallNations } = nations;
const ocean = await nvkelso.nation("ocean");
const lake = await nvkelso.nation("lake");
const river = await nvkelso.nation("river");
const mountain = await nvkelso.nation("mountain");
//	console.log(river);
trans.extend([
	{ ja: "国旗", en: "National flag", zh: "国旗", ko: "국기" },
	{ ja: "国名", en: "Country Name", zh: "国名", ko: "국명" },
	{ ja: "首都", en: "Captal", zh: "首都", ko: "수도" },
	{ ja: "国際連合", en: "United Nations", zh: "联合国", ko: "국제연합" },
	{ ja: "地域", en: "Region", zh: "地区", ko: "지역" },
	{ ja: "通貨", en: "Currency", zh: "货币", ko: "통화" },
	{ ja: "公用語", en: "Official Language", zh: "官方语言", ko: "공식언어" },
	{ ja: "スヴァールバル諸島", en: "Svalbard", zh: "斯瓦尔巴", ko: "스발바르 제도" },
	{ key: "_explain_", ja: "「$1」の概略を説明します", en: "Explain the outline of '$1'", zh: "我来解释一下'$1'的概要", ko: "'$1'의 개요를 설명합니다." },
	{ key: "_open_wiki_", ja: "Wikipediaで「$1」を表示します", en: "Display '$1' on Wikipedia", zh: "在维基百科上显示'$1'", ko: "Wikipedia에서 '$1' 표시" },
	{ key: "_show_flag_", ja: "「$1」の国旗を表示します", en: "Displays the flag of '$1'", zh: "显示'$1'标志", ko: "'$1'의 국기를 표시합니다." },
	{ key: "_open_map_", ja: "「$1」の地図を表示します", en: "Displays the map of '$1'", zh: "显示'$1'的地图", ko: "'$1'의 지도를 표시합니다." },
	{ key: "_flag_svg_", ja: "$1の国旗のSVGをダウンロードします", en: "Download $1 flag SVG", zh: "下载 $1 国旗 SVG", ko: "$1 국기 SVG 다운로드" },
	{ key: "_anthem_", ja: "「$1」の国歌を演奏します", en: "Play the anthem of '$1'", zh: "奏'$1'的国歌", ko: "'$1'의 노래 연주" },
	{ key: "_show_", ja: "「$1」を表示します", en: "Display '$1'", zh: "显示 '$1'", ko: "'$1' 표시" },
	{ key: "_close_", ja: "一覧表示に戻ります", en: "Return to list view", zh: "返回列表视图", ko: "목록 표시로 돌아가기" },
]);
await d3.thenEach(nations, async t => {
	if (!t.isox) console.error(t)
	//	if (!t.iso2) console.log(t.Name, t.isox);
	if (t.capital) {
		var cname = (await t.city()).filter(t => t[3]).map(t => t[1].ja)[0];
		//	console.log(t.Name, cname)
		cname || console.warn(t.Name, t.isox, cname)
	}
})
////-------------------------------------------------------------------------------------------------------------
const icon = {
	left: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="m318,154l-143,83c-18,11-18,28,0,38l143,83c18,11,33,2,33-19v-165c0-21-15-30-33-19z"/></svg>',
	right: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="m194,358l143-83c18-11,18-28,0-38l-143-83c-18-11-33-2-33,19v165c0,21,15,30,33,19z"/></svg>',
	download: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" version="1.1"><g><path d="m370,195h-18v139c0,5-4,9-9,9h-185c-5,0-9-4-9-9v-139h-18c-15,0-28,12-28,28v148c0,15,12,28,28,28h240c15,0,28-12,28-28v-148c0-15-12-28-28-28zm-55,0h-46v-92h-37v92h-46l65,94l65-94z"/></g></svg>',
	close: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="m368,320l-64-64l64-64l-32-32l-64,64l-64-64l-32,32l64,64l-64,64l32,32l64-64l64,64z"/></svg>',
	speaker: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" version="1.1"><g><path d="m221,88c-5,0-9,2-12,5l-92,92h-73c-5,0-9,2-12,5c-4,4-5,8-5,12v106c0,5,2,9,5,12c4,4,8,5,12,5h73l92,92c4,4,8,5,12,5c5,0,9-2,12-5c4-4,5-8,5-12v-301c0-5-2-9-5-12c-4-4-8-5-12-5zm112,208c8-12,12-25,12-39s-4-27-12-39c-8-12-18-21-31-26c-2-1-4-1-7-1c-5,0-9,2-12,5c-4,3-5,8-5,13c0,4,1,7,3,10c2,3,5,5,8,7c3,2,6,4,9,6c3,2,6,6,8,10c2,4,3,10,3,16c0,6-1,12-3,16c-2,4-5,8-8,10c-3,2-6,4-9,6c-3,2-6,4-8,7c-2,3-3,6-3,10c0,5,2,9,5,13c4,3,8,5,12,5c3,0,5,0,7-1c13-5,23-14,31-26zm59,39c16-24,24-50,24-78c0-28-8-54-24-78c-16-24-36-41-62-52c-2-1-5-1-7-1c-5,0-9,2-12,5c-4,4-5,8-5,12c0,7,4,13,11,16c10,5,17,9,21,12c14,10,24,22,32,38c8,15,11,31,11,48c0,17-4,33-11,48c-8,15-18,28-32,38c-4,3-11,7-21,12c-7,4-11,9-11,16c0,5,2,9,5,12c4,4,8,5,13,5c2,0,5,0,7-1c26-11,47-28,62-52zm59-195c-23-36-55-62-94-79c-2-1-5-1-7-1c-5,0-9,2-12,5c-4,4-5,8-5,12c0,7,4,12,11,16c1,1,3,2,6,3c3,1,5,2,6,3c8,5,16,9,23,14c23,17,40,38,53,63c13,25,19,52,19,80c0,28-6,55-19,80c-13,25-30,46-53,63c-7,5-14,10-23,14c-1,1-3,2-6,3c-3,1-5,2-6,3c-7,4-11,10-11,16c0,5,2,9,5,12c4,4,8,5,12,5c2,0,5,0,7-1c39-17,70-43,94-79c23-36,35-75,35-117s-12-81-35-117z"/></g></svg>',
	region: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" version="1.1"><g><path d="m256,51c-113,0-205,92-205,205s92,205,205,205s205-92,205-205s-92-205-205-205zm-79,48c-4,5-7,11-11,16c-5,9-10,19-14,29c-8-2-17-5-25-8c14-15,31-28,49-37zm-71,65c12,5,24,8,36,12c-5,20-8,41-9,63h-52c3-27,11-53,25-75zm0,183c-14-22-22-48-25-75h52c1,22,4,43,9,63c-12,3-24,7-36,12zm21,28c8-3,17-6,25-8c4,10,9,20,14,29c3,6,7,11,11,16c-19-9-35-22-49-37zm112,47c-21-8-40-31-54-63c18-3,36-5,54-6v69zm0-103c-21,1-43,3-64,8c-4-17-7-36-8-55h73v48zm0-81h-73c1-20,4-38,8-55c21,4,43,7,64,8v48zm0-81c-18-1-36-3-54-6c13-32,32-55,54-63v69zm167,6c14,22,22,48,25,75h-52c-1-22-4-43-9-63c12-3,24-7,36-12zm-21-28c-8,3-17,6-25,8c-4-10-9-20-14-29c-3-6-7-11-11-16c19,9,35,22,49,37zm-112-47c21,8,40,31,54,63c-18,3-36,5-54,6v-69zm0,103c21-1,43-3,64-8c4,17,7,36,8,55h-73v-48zm0,81h73c-1,20-4,38-8,55c-21-4-43-7-64-8v-48zm0,150v-69c18,1,36,3,54,6c-13,32-32,55-54,63zm63-10c4-5,7-11,11-16c5-9,10-19,14-29c8,2,17,5,25,8c-14,15-31,28-49,37zm71-65c-12-5-24-8-36-12c5-20,8-41,9-63h52c-3,27-11,53-25,75z"/></g></svg>',
	filter: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" version="1.1"><g><path d="m395,140c0-27-62-49-139-49c-77,0-139,22-139,49c0,5,3,11,8,16l111,192v63c0,5,9,10,20,10c11,0,20-4,20-10v-62l112-193h-1c5-5,7-10,7-16zm-139,36c-81,0-126-24-126-36s44-36,126-36c81,0,126,24,126,36s-44,36-126,36z"/></g></svg>',
	sort: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" version="1.1"><g><path d="m126,220h262c5,0,9-2,13-6c4-4,6-8,6-13c0-5-2-9-6-13l-131-131c-4-4-8-6-13-6s-9,2-13,6l-131,131c-4,4-6,8-6,13c0,5,2,9,6,13c4,4,8,6,13,6zm262,75h-262c-5,0-9,2-13,6c-4,4-6,8-6,13c0,5,2,9,6,13l131,131c4,4,8,6,13,6s9-2,13-6l131-131c4-4,6-8,6-13c0-5-2-9-6-13c-4-4-8-6-13-6z"/></g></svg>',
	search: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" version="1.1"><g><path d="m410,373l-80-80c11-18,17-38,17-61c0-65-53-117-117-117c-65,0-117,53-117,117c0,65,53,117,117,117c22,0,43-6,61-17l80,80l40-40zm-253-141c0-40,33-73,73-73c40,0,73,33,73,73c0,40-33,73-73,73c-40,0-73-33-73-73z"/></g></svg>',
	city: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 20 155 155"><path d="M49.793 28.359v111.786h46.33v.165h9.893V28.524h-2.144v-.165H49.793zm10.222 15.169h36.108v15.168H60.015V43.528zm-39.9 20.115v76.172h1.649v.33h24.402v-11.211h-13.52V118.71h13.52v-11.212h-13.52V97.277h13.19v-11.87h-13.19v-9.234h12.86v-12.53h-25.39zm89.363.989v12.2h16.158v9.234h-15.168v11.541h15.168v9.892h-14.18v11.872h14.18v9.563h-15.498v10.551H136.847V64.961h-.988v-.33h-26.38zM60.015 75.513h36.108v16.158H60.015V75.513zm0 31.986h36.108v14.84H60.015v-14.84zM5.276 144.762v5.276h144.762v-5.276H5.276z"/></svg>',
	lake: '<svg viewBox="10 10 90 80" xmlns="http://www.w3.org/2000/svg"><path d="M28.5 19.5c2.323 1.316 4.656 2.65 7 4 2.248-.906 4.248-2.239 6-4 1.752 1.761 3.752 3.094 6 4 2.248-.906 4.248-2.239 6-4 1.752 1.761 3.752 3.094 6 4 2.248-.906 4.248-2.239 6-4 2.43 2.445 5.096 4.445 8 6-.5 1.38-1.5 2.047-3 2a16.233 16.233 0 0 1-5-2c-4.033 2.546-8.033 2.546-12 0-4.033 2.546-8.033 2.546-12 0-4.033 2.546-8.033 2.546-12 0-2.462 1.566-4.962 1.9-7.5 1-.667-.667-.667-1.333 0-2 2.9-.737 5.067-2.403 6.5-5zM28.5 35.5c2.323 1.316 4.656 2.65 7 4 2.248-.906 4.248-2.239 6-4 1.752 1.761 3.752 3.094 6 4 2.248-.906 4.248-2.239 6-4 1.752 1.761 3.752 3.094 6 4 2.248-.906 4.248-2.239 6-4 2.43 2.445 5.096 4.445 8 6-.5 1.38-1.5 2.047-3 2a16.233 16.233 0 0 1-5-2c-4.033 2.546-8.033 2.546-12 0-4.033 2.546-8.033 2.546-12 0-4.033 2.546-8.033 2.546-12 0-2.462 1.566-4.962 1.9-7.5 1-.667-.667-.667-1.333 0-2 2.9-.737 5.067-2.403 6.5-5zM28.5 51.5c2.323 1.316 4.656 2.65 7 4 2.248-.906 4.248-2.239 6-4 1.752 1.761 3.752 3.094 6 4 2.248-.906 4.248-2.239 6-4 1.752 1.761 3.752 3.094 6 4 2.248-.906 4.248-2.239 6-4 2.43 2.445 5.096 4.445 8 6-.5 1.38-1.5 2.047-3 2a16.233 16.233 0 0 1-5-2c-4.033 2.546-8.033 2.546-12 0-4.033 2.546-8.033 2.546-12 0-4.033 2.546-8.033 2.546-12 0-2.462 1.566-4.962 1.9-7.5 1-.667-.667-.667-1.333 0-2 2.9-.737 5.067-2.403 6.5-5z"/></svg>',
};
////=================================================================================================================================
//// START !!!!
////=================================================================================================================================
#inline("bTia4HjZ"); // parts;
const body = d3.select("body").html(__HTML__);
const head = body.select("[name=head]").slideX(true);
[...head.selectAll("[name]")].forEach(t => head[t.getAttribute("name")] = d3.select(t));
[...head.selectAll("[icon]")].forEach(t => d3.select(t).html(icon[t.getAttribute("icon")]));
const scroll = body.select("[name=scroll]");
const modal = body.select("[name=modal]").hide();
[...modal.selectAll("[name]")].forEach(t => modal[t.getAttribute("name")] = d3.select(t));
head.areas.selectOptions(REGIONS, v => (SystemParameter.region = v, drawAll()), SystemParameter.region);
head.filter.selectOptions(FILTERS, v => (SystemParameter.filter = v, drawAll()), SystemParameter.filter);
head.sorts.selectButtons(SORTS.index, v => (SystemParameter.sort == v && (v = -v), SystemParameter.sort = v, drawAll()), SystemParameter.sort);
head.search.inputSearch(v => (SystemParameter.reg = v, drawAll()), SystemParameter.reg);
head.display.selectButtons(DISPLAY, v => (SystemParameter.display = v, drawAll()), SystemParameter.display, false)
head.langs.selectOptions(LANGUAGES, v => (SystemParameter.lang = v, drawHead(), drawAll()), SystemParameter.lang);
////------------------------------
let nationTub = [];
const target = body.select("[name=maptop]").css({ visibility: "hidden", background: "#000" });
const map = extendMap(await WhiteEarth({ target, base: "osm.street", range: [1, 8], threshold: 8 }));//マップ生成
const { border_layer, hover_layer } = map;
target.hide(); target.css({ visibility: "visible" });
////-------------------------------------------------------------------------------------------------------------
window.addEventListener("resize", resize, false);
drawHead(); drawAll(); resize();
////-------------------------------------------------------------------------------------------------------------
function resize() {
	scroll.css({ padding: 0 });
	if (SystemParameter.display == "1") {
		var [X, Y] = scroll.getSize(), [x, y] = scroll.select("div").getOuterSize();
		var n = Math.floor((X - 20) / x);
		scroll.css({ padding: "5px" });
		scroll.css({ paddingLeft: ((X - 20) - n * x) / 2 + "px" });
	}
}
////-------------------------------------------------------------------------------------------------------------
function drawHead() {
	head.selectAll("[trans]").each(function () { this.innerText = trans(this.getAttribute("trans")) })
	head.select("[icon=filter]").tip(FILTERS.tip(SystemParameter.lang));
	head.select("[icon=sort]").tip(SORTS.tip(SystemParameter.lang));
}
////-------------------------------------------------------------------------------------------------------------
async function drawAll(v) {
	nationTub = nations;
	#inline("RaLVLcna");//hebon2kana
	const makeRegexp = s => { if (!s) return ""; const h = hebon2kana(s); return new RegExp(s == h ? s : "(" + s + "|" + h + ")", "i"); }
	const { lang, region, filter, sort, reg, display } = SystemParameter;
	const { member, dire, length } = SORTS[Math.abs(sort) - 1];
	window.Language = lang;
	Speech.setLanguage(lang);
	var d = sort > 0 ? dire ? 1 : -1 : dire ? -1 : 1;
	d3.selectAll("[name=sorts] button")
		.each(function (d, i) { d3.select(this).text(trans(this.getAttribute("trans")) + (this.value == Math.abs(sort) ? (sort < 0) ? "△" : "▽" : "")); });
	const sfunc = Math.abs(sort) == 1 ? (p, q) => d * (p.sortName > q.sortName ? 1 : -1) :
		Math.abs(sort) == 2 ? (p, q) => d * (p.area > q.area ? 1 : -1) : (p, q) => d * (p[member].value > q[member].value ? 1 : -1);
	nationTub = nationTub.filter(p => !+region || +region === p.region);
	Math.abs(sort) > 2 && (nationTub = nationTub.filter(t => t[member] && t[member].length == length));
	nationTub = filter ? nationTub.filter(p => p.is(filter)) : nationTub;
	nationTub = nationTub.sort(sfunc);
	reg && (nationTub = nationTub.filter(p => p.search.match(makeRegexp(reg))));
	nationTub.forEach((t, i) => t.order = sort > 0 ? i + 1 : nationTub.length - i)
	nationTub.length ? Sound("リスト") : Sound("失敗");
	nationTub.length && [blockView, inlineView][display - 1]();
	scroll.highlight(reg, false);
	resize();
	await SystemCacheIO("SystemParameter", SystemParameter);
}
////-------------------------------------------------------------------------------------------------------------
function mapTip(q) {
	return trans("_open_map_", q.Name) + `<br/><img style="width:128px; padding:5px 0 0 20px;"; src="${q.geopngurl}"/>`;
}
function blockView() {
	scroll.empty().selectAll("div").data(nationTub).enter().append("div").each(draw);
	scroll.selectAll(".hover").on("mouseenter", () => Sound("操作M", 0.4))
	function draw(q) {
		const node = d3.select(this).classed("nation", true);
		const jpname = () => {
			const s = q.Name;
			if (SystemParameter.lang == "ja" && s.length > 14) {
				if (s.match(/および/)) return s.replace(/および/, "<br/>および");
				if (s.match(/・/)) return s.replace(/・/, "・<br/>");
			}
			return s;
		}
		const jpcap = () => {
			const s = q.capitalInfo, cap = q.capitalName;
			return (SystemParameter.lang == "ja" && cap.length > 13) ? `<span style="font-size:90%;">${s}</span>` : s;
		}
		let tr, td;
		node.append("div").classed("order", true).html("#" + q.order);
		node.append("img").classed("mapopen", true).attr("src", q.geopngurl).classed("hover", true)
			.tip(mapTip(q)).on("click", e => map.display(q, e.target));
		tr = node.append("table").append("tr");
		tr.append("td").append("img").attr("src", q.flagURL)
			.classed("hover", true).on("click", e => { e.stopPropagation(); openFlag(q, e.target) }).tip(trans("_show_flag_", q.Name));
		td = tr.append("td");
		td.append("div").append("span").classed("name", true).html(jpname() + q.euFlag + q.natoFlag + q.group)
			.classed("hover", true).on("click", e => { e.stopPropagation(); q.OpenWikipedia() }).tip(trans("_open_wiki_", q.Name));
		td.append("div").append("span").html(jpcap())
			.classed("hover", true).on("click", e => { e.stopPropagation(); q.capital && q.capital.OpenWikipedia() }).tip(trans("_open_wiki_", q.capital ? q.capital.Name : ""));
		td.append("div").html(q.info);
		td.append("div").html(q.unJoin);
		td.append("div").html(q.relation);
	}
}
////-------------------------------------------------------------------------------------------------------------
function inlineView() {
	const small = s => `<small>${s}</small>`
	const sort = Math.abs(SystemParameter.sort), region = +SystemParameter.region;
	const labels = SORTS.map(t => trans(t.label) + (t.unit ? "<br/>" + small(`[${t.unit}]`) : ""));
	const { label, member, year, length, show, dire, format, unit, ref } = SORTS[sort - 1];
	const Unit = unit ? small(`[${unit}]`) : "";
	const btns = [...head.selectAll("[name=sorts] button")];
	const table = scroll.empty().append("div").classed("list", true).append("table");
	const thead = table.append("thead"), tbody = table.append("tbody");
	header(thead);
	tbody.selectAll("tr").data(nationTub).enter().append("tr").each(draw);
	scroll.selectAll(".hover").on("mouseenter", () => Sound("操作M", 0.4));
	const last = null;
	function header(thead) {
		var tr = thead.append("tr");
		tr.append("th").attr("rowspan", 2).html("#");
		tr.append("th").attr("rowspan", 2).html(trans("国旗"));
		tr.append("th").attr("rowspan", 2).attr("colspan", 2).html(trans("国名")).classed("hover", true).on("click", e => sortExternal(0));
		(sort == 2) && tr.append("th").attr("rowspan", 2).html(trans(label) + Unit).classed("hover", true).on("click", e => sortExternal(sort - 1));
		(sort > 2) && tr.append("th").attr("colspan", show || length).html(trans(label) + Unit + small("(" + ref + ")")).classed("hover", true).on("click", e => sortExternal(sort - 1));
		tr.append("th").attr("rowspan", 2).html(trans("首都")).classed("hover", true).on("click", e => sortCapital());
		region || tr.append("th").attr("rowspan", 2).html(trans("地域")).classed("hover", true).on("click", e => sortRegion());
		tr.append("th").attr("rowspan", 2).html(trans("国際連合")).classed("hover", true).on("click", e => sortOthers("un", 0));
		tr.append("th").attr("colspan", 3).html("ISO-3166-1");
		tr.append("th").attr("colspan", 2).html("IOC");
		labels.filter((t, i) => i && (i != sort - 1) && tr.append("th").attr("rowspan", 2).html(t).classed("hover", true).on("click", e => sortExternal(i)));
		tr.append("th").attr("rowspan", 2).html(trans("通貨"));
		tr.append("th").attr("rowspan", 2).html(trans("公用語"));
		////---------------------------------------------------------------------
		tr = thead.append("tr");
		(sort > 2) && [...Array(show || length)].map((_, i) => i).forEach(i => tr.append("th").html(year - i).classed("hover", true).on("click", e => sortYear(e.target, i)));
		["a2", "a3", "num"].forEach((t, i) => tr.append("th").html(trans(t)).classed("hover", true).on("click", e => sortOthers("iso", i)));
		["code", "from"].forEach((t, i) => tr.append("th").html(trans(t)).classed("hover", true).on("click", e => sortOthers("ioc", i)));
		(sort > 2) && tr.select("th").classed("flip", true);
		////---------------------------------------------------------------------
		function sortExternal(n) { d3.select(btns[n]).trigger("click"); }
		function sortInternal(func) {
			func && (nationTub = nationTub.sort(func));
			tbody.empty().selectAll("tr").data(nationTub).enter().append("tr").each(draw);
		}
		function sortCapital() {
			const a = nationTub.filter(t => t.capital || t.territory);
			const b = nationTub.filter(t => !(t.capital || t.territory));
			const d = a[0].sortCapital < a[a.length - 1].sortCapital ? -1 : 1;
			nationTub = a.sort((p, q) => d * (p.sortCapital > q.sortCapital ? 1 : -1)).concat(b);
			sortInternal();
		}
		function sortRegion() {
			const d = nationTub[0].region < nationTub[nationTub.length - 1].region ? -1 : 1;
			sortInternal((p, q) => d * (p.region == q.region ? (p.sortName > q.sortName ? 1 : -1) : p.region > q.region ? 1 : -1));
		}
		function sortYear(target, i) {
			thead.selectAll("th").classed("flip", false); d3.select(target).classed("flip", true);
			var d = SystemParameter.sort > 0 ? dire ? 1 : -1 : dire ? -1 : 1;
			sortInternal((p, q) => d * (p[member].data[i] > q[member].data[i] ? 1 : -1));
		}
		function sortOthers(key, n) {
			var a = nationTub.filter(t => t[key]), d = a[0][key][n] > a[a.length - 1][key][n] ? 1 : -1;
			nationTub = a.sort((p, q) => d * (p[key][n] > q[key][n] ? 1 : -1)).concat(nationTub.filter(t => !t[key]));
			sortInternal();
		}
	}
	function draw(q) {
		let tr = d3.select(this), td;
		const a = [[], [q.area]].concat(SORTS.dataLabels.map(t => q[t]));
		const formats = SORTS.map(t => t.format);
		var data = a[sort - 1], format = formats[sort - 1];
		data = (Array.isArray(data) ? data : data.data).map(format);
		var value = a.map((t, i) => t ? formats[i](("value" in t) ? t.value : t[0]) : "-");
		sort > 1 && (value = value.filter((t, i) => i != sort - 1));
		value = value.slice(1);
		const [L, C, R] = [{ textAlign: "start" }, { textAlign: "center" }, { textAlign: "right" }];
		////----------------------------------------------------------------
		tr.append("th").css(C).html(q.order)
		//	.classed("hover",true).tip(trans("_explain_", q.Name)).on("click", ()=>q.speakAbstract());
		tr.append("td").css(C).append("img").attr("src", q.flagURL)
			.classed("hover", true).tip(trans("_show_flag_", q.Name)).on("click", e => openFlag(q, e.target))
		tr.append("td").css(C).css({ padding: 0 }).append("img").attr("src", q.geopngurl).css({ height: "30px" })
			.tip(mapTip(q)).on("click", e => map.display(q, e.target));
		tr.append("td").css(L).append("span").html(q.officialName)
			.classed("hover", true).tip(trans("_open_wiki_", q.Name)).on("click", () => q.OpenWikipedia());
		data.slice(0, show || length).forEach(t => tr.append("td").css(R).html(t));
		td = tr.append("td").css(L);
		td.append("span").html(q.capitalName).classed("hover", true).on("click", () => q.capital && q.capital.OpenWikipedia())
			.tip(trans("_open_wiki_", q.capital ? q.capital.Name : ""));
		q.capitalComment && td.classed("mark", true).tip(q.capitalComment)
		region || tr.append("td").css(C).html(q.regionName);
		td = tr.append("td").css(C).html(q.un ? q.un[0] : q.relation);
		q.un && q.un[1] && td.classed("mark", true).tip(q.unapproved);
		(q.iso || ["", "", ""]).forEach(t => tr.append("td").css(C).html(t));
		(q.ioc || ["", ""]).forEach(t => tr.append("td").css(C).html(t));
		value.forEach(t => tr.append("td").css(R).html(t));
		tr.append("td").css(C).html(q.Currency);
		tr.append("td").css(L).html(q.Language);
		[...tr.selectAll("currency")].forEach((t, i) => d3.select(t).tip(q.currency[i].Name).classed("hover", true).on("click", () => q.currency[i].OpenWikipedia()));
		[...tr.selectAll("language")].forEach((t, i) => d3.select(t).tip(q.languages[i].Name).classed("hover", true).on("click", () => q.languages[i].OpenWikipedia()));
	}
}
////-------------------------------------------------------------------------------------------------------------
async function openFlag(q, target) {
	await showFlag(q);
	modal.resumeShow(target, { fallback: () => scroll.hide() })
}
function closeFlag() {
	scroll.show();
	modal.node().animate({ opacity: 0 }, { duration: 500 })
		.onfinish = () => { modal.hide(); modal.css({ opacity: 1 }); };
}
////-------------------------------------------------------------------------------------------------------------
async function showFlag(q) {
	Sound("移動");
	const sft = i => {
		const n = nationTub.indexOf(q) + i, len = nationTub.length;
		return nationTub[n < 0 ? n + len : n >= len ? n - len : n];
	};
	const close = () => { Sound("リスト"); closeFlag(); }
	const flag = modal.flag.empty().append("img").attr("src", q.flagURL);
	modal.UL.html(q.flagTitle + `<img src="${q.geopngurl}"/>`);
	modal.UR.html(q.summary).css({ pointerEvents: "none" });
	modal.LL.html(q.nameInfo || q.relation);
	modal.LC.html(await q.flagInfo());
	modal.LR.html(q.anthemPlayer);
	modal.close.html(icon.close).tip(trans("_close_")).on("click", close);
	modal.svg.html(icon.download).tip(trans("_flag_svg_", q.Name)).on("click", async e => { Sound("リスト"); q.downloadFlag() });
	modal.backward.html(icon.left).tip(trans("_show_", sft(-1).Name)).on("click", e => move(-1));
	modal.forward.html(icon.right).tip(trans("_show_", sft(+1).Name)).on("click", e => move(+1));
	modal.select("audio").tip(trans("_anthem_", q.Name));
	q.capital && setTimeout(() => Speech(trans("$1の首都は、$2です", q.Name, q.capitalName)), 250);
	modal.UL.select("img").on("click", e => map.display(q, e.target))
		.tip(mapTip(q)).on("click", e => map.display(q, e.target));
	d3.escape(function () { close(); d3.escape(null); })
	////------------------------------------------------
	function move(i) {
		const r = sft(i), duration = 500;
		const translate = i => `translate(${-50 + (110) * i}%,${-50}%)`;
		const dmy = modal.flag.append("img").attr("src", r.flagURL);
		dmy.node().animate({ transform: [translate(i), translate(0)] }, { duration });
		flag.node().animate({ transform: [translate(0), translate(-i)] }, { duration })
			.onfinish = () => { dmy.remove(); showFlag(r); body.select(".overlap-tooltip").show(); };
	}
}