// ── 国別DB ビューア（旧 draw.js の移植・2026-09-09）──
// データ=bucket GIS/world（uploader「国別DB (world)」節の成果物）。地図は後日＝geoPNG はサムネイル表示のみ（配線なし）
import * as d3 from 'd3';
import "common/d3/selection.js";
import "common/d3/tip-pop.js";
import "common/d3/highlight.js";
import { escape, download } from "common";
import "./draw.scss";
import { loadWorld, loadI18N, systemStore, ASSET_BASE } from "./data.js";
import { state, REGIONS, SORTS, FILTERS, LANGUAGES, LANG_LIST, isRTL, trans, collator, buildModel } from "./model.js";
import { selectOptions, selectButtons, inputSearch } from "./controls.js";
import { makeFlag } from "./flag.js";
import { hebon2kana, kanaPattern } from "./hebon2kana.js";
// ── カードの文字を枠に収める（Kenji 2026-09-10「はみ出すものは、フォントを小さくしてでも、枠に入れた方が綺麗」「描画前にサイズを計算しておく」）
//   DOM に入れる前に canvas.measureText で行幅を測り、枠幅を超える行だけ font-size を縮める（レイアウト読み戻し無し＝262 枚でも一瞬）。
//   下限 FIT_MIN までで収まらない極端な行だけ CSS の折り返し（draw.scss の overflow-wrap）に落ちる
const meas = document.createElement("canvas").getContext("2d");
const CARD_PX = 11;                          // .nation の font-size（draw.scss）
const FIT_W = 280 - 6 - 72 - 10 - 28 - 2;    // カード幅 − table の border-spacing(2px×3) − 旗列(72) − td 余白(5+5) − 右上 #番号の余白(28) − 丸め余裕＝draw.scss の定数と対（実測: div.clientWidth 192 − padding 28 = 164）
const FIT_MIN = 0.7;
function fitScale(html, font, { lines = 1, outerSpan = false } = {}) {
	if (!html) return 1;
	const px = parseFloat(font.match(/([\d.]+)px/)[1]);   // "bold 13.2px verdana" → 13.2（parseFloat(font) は bold で NaN）
	const setFont = k => meas.font = font.replace(/[\d.]+px/, (px * k).toFixed(2) + "px");
	// 行内の付加物: span { padding:0 0.3em }・img.inline（高さ 14px の旗 ≒ 幅 21px + 余白）・.G7/.G20 の :before バッジ
	const extra = (seg, k) => ((seg.match(/<span/g) || []).length + (outerSpan ? 1 : 0)) * 0.6 * px * k + (seg.match(/<img/g) || []).length * 24 + (/class="G(7|20)"/.test(seg) ? 28 : 0);
	const text = seg => seg.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ");
	// 貪欲な折り返しの模擬: 空白で区切って詰める（空白の無い連＝CJK は任意位置で折れる前提で幅÷枠）
	const need = (seg, k, allow) => {
		setFont(k); const space = meas.measureText(" ").width; let n = 1, cur = 0;
		const perm = (seg.match(/<span class="permanent">([^<]*)<\/span>/) || [])[1];   // .permanent は font-size:80%＝別に測る
		const body = perm ? seg.replace(perm, "") : seg;
		const words = text(body).split(/\s+/).filter(Boolean).map(w => meas.measureText(w).width).concat(extra(seg, k) || []);
		if (perm) { setFont(k * 0.8); words.push(meas.measureText(perm).width + 6); setFont(k); }
		for (const ww of words) {
			const add = (cur ? space : 0) + ww;
			if (cur + add <= allow) cur += add;
			else if (ww <= allow) { n++; cur = ww; }
			else { const m = Math.ceil((cur + add) / allow); n += m - 1; cur = cur + add - (m - 1) * allow; }
		}
		return n;
	};
	const segs = html.split(/<br\s*\/?>/), perSeg = segs.length > 1 ? 1 : lines;   // <br/> で割ってある名前は各片 1 行
	for (let k = 1; k >= FIT_MIN - 1e-6; k -= 0.025) {   // 収まる最大の倍率（下限 FIT_MIN で打ち切り＝以降は CSS の折り返し）
		if (segs.every(seg => need(seg, k, FIT_W) <= perSeg)) return k;
	}
	return FIT_MIN;
}

const body = d3.select("body");
const loading = body.append("div").attr("name", "loading").html("<span>Loading the world…</span>");
////-------------------------------------------------------------------------------------------------------------
const store = await systemStore();
Object.assign(state, await store.load());
// ?lang=xx（26言語・langs.json）が最優先。無ければ保存値→ブラウザ言語→en
{
	const known = new Set(LANG_LIST.map(l => l.code));
	const q = new URLSearchParams(location.search).get("lang");
	const nav = (navigator.language || "en").split("-")[0];
	state.lang = known.has(q) ? q : known.has(state.lang) ? state.lang : known.has(nav) ? nav : "en";
}
const applyLang = () => {   // 文書の言語と書字方向（ar/fa/ur/he は RTL）
	document.documentElement.lang = state.lang;
	document.documentElement.dir = isRTL(state.lang) ? "rtl" : "ltr";
	const u = new URL(location.href); u.searchParams.set("lang", state.lang); history.replaceState(null, "", u);   // 他の ?open= 等は保持
};
let data;
try { [data, state.i18n] = await Promise.all([loadWorld(), loadI18N(state.lang)]); } catch (e) { loading.html(`<span>Failed to load: ${e.message}</span>`); throw e; }
applyLang();
// 旗/地図PNG＝bucket の個別ファイル URL（<img loading=lazy> で見えた分だけ取得・edge 1h キャッシュ）。
// 旗の有無は NationDB の key 集合＋領有国代替で決める（zip を丸ごと落とさない）
const assets = (() => {
	const flags = {}, keys = data.flags;   // 実在する旗（bucket flags/ 一覧）。無い国は model 側で領有国の旗へ代替
	const flagURL = k => `${ASSET_BASE}flags/${encodeURIComponent(k)}.svg`;
	return { flagURL, hasFlag: k => keys.has(k), flag: k => flags[k] || (flags[k] = makeFlag(flagURL(k))), geomURL: k => `${ASSET_BASE}geoms/${encodeURIComponent(k)}.png` };
})();
const model = buildModel(data, assets);
const { nations } = model;
////-------------------------------------------------------------------------------------------------------------
// 効果音（音源.zip）と読み上げ（Web Speech API）
const Sound = (() => {
	const src = {}; Object.entries(data.sounds).forEach(([k, f]) => src[k] = new Audio(URL.createObjectURL(f)));
	const f = (s, v = 1) => { const a = src[s]; if (!a) return; a.currentTime = 0; a.volume = v; a.play().catch(() => { }); };
	f.list = Object.keys(src); return f;
})();
const Speech = (() => {
	const tag = { ja: "ja-JP", en: "en-US", zh: "zh-CN", ko: "ko-KR", fr: "fr-FR", de: "de-DE", es: "es-ES", pt: "pt-BR", it: "it-IT", nl: "nl-NL", pl: "pl-PL", ru: "ru-RU", uk: "uk-UA",
		hu: "hu-HU", sv: "sv-SE", tr: "tr-TR", el: "el-GR", id: "id-ID", vi: "vi-VN", th: "th-TH", bn: "bn-BD", hi: "hi-IN", ar: "ar-SA", fa: "fa-IR", ur: "ur-PK", he: "he-IL" }; let lang = "en";
	const f = text => {
		const synth = window.speechSynthesis; if (!synth || !text) return;
		synth.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = tag[lang] || "en-US";
		const v = synth.getVoices().find(v => v.lang.replace("_", "-").startsWith(u.lang.split("-")[0])); v && (u.voice = v);
		synth.speak(u);
	};
	f.setLanguage = l => lang = l; return f;
})();
////-------------------------------------------------------------------------------------------------------------
const icon = {
	block: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="m72,72h161v161h-161zm207,0h161v161h-161zm-207,207h161v161h-161zm207,0h161v161h-161z"/></svg>',
	inline: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="m431,135h-350c-9,0-16,7-16,16c0,9,7,16,16,16h350c9,0,16-7,16-16c0-9-7-16-16-16zm0,141h-350c-9,0-16,7-16,16c0,9,7,16,16,16h350c9,0,16-7,16-16c0-9-7-16-16-16zm0,141h-350c-9,0-16,7-16,16c0,9,7,16,16,16h350c9,0,16-7,16-16c0-9-7-16-16-16zm-350-321h350c9,0,16-7,16-16c0-8-7-16-16-16h-350c-9,0-16,8-16,16c0,9,7,16,16,16zm350,109h-350c-9,0-16,7-16,16s7,16,16,16h350c9,0,16-7,16-16s-7-16-16-16zm0,141h-350c-9,0-16,7-16,16c0,9,7,16,16,16h350c9,0,16-7,16-16c0-9-7-16-16-16z"/></svg>',
	left: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="m318,154l-143,83c-18,11-18,28,0,38l143,83c18,11,33,2,33-19v-165c0-21-15-30-33-19z"/></svg>',
	right: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="m194,358l143-83c18-11,18-28,0-38l-143-83c-18-11-33-2-33,19v165c0,21,15,30,33,19z"/></svg>',
	download: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="m370,195h-18v139c0,5-4,9-9,9h-185c-5,0-9-4-9-9v-139h-18c-15,0-28,12-28,28v148c0,15,12,28,28,28h240c15,0,28-12,28-28v-148c0-15-12-28-28-28zm-55,0h-46v-92h-37v92h-46l65,94l65-94z"/></svg>',
	close: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="m368,320l-64-64l64-64l-32-32l-64,64l-64-64l-32,32l64,64l-64,64l32,32l64-64l64,64z"/></svg>',
	region: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="m256,51c-113,0-205,92-205,205s92,205,205,205s205-92,205-205s-92-205-205-205zm-79,48c-4,5-7,11-11,16c-5,9-10,19-14,29c-8-2-17-5-25-8c14-15,31-28,49-37zm-71,65c12,5,24,8,36,12c-5,20-8,41-9,63h-52c3-27,11-53,25-75zm0,183c-14-22-22-48-25-75h52c1,22,4,43,9,63c-12,3-24,7-36,12zm21,28c8-3,17-6,25-8c4,10,9,20,14,29c3,6,7,11,11,16c-19-9-35-22-49-37zm112,47c-21-8-40-31-54-63c18-3,36-5,54-6v69zm0-103c-21,1-43,3-64,8c-4-17-7-36-8-55h73v48zm0-81h-73c1-20,4-38,8-55c21,4,43,7,64,8v48zm0-81c-18-1-36-3-54-6c13-32,32-55,54-63v69zm167,6c14,22,22,48,25,75h-52c-1-22-4-43-9-63c12-3,24-7,36-12zm-21-28c-8,3-17,6-25,8c-4-10-9-20-14-29c-3-6-7-11-11-16c19,9,35,22,49,37zm-112-47c21,8,40,31,54,63c-18,3-36,5-54,6v-69zm0,103c21-1,43-3,64-8c4,17,7,36,8,55h-73v-48zm0,81h73c-1,20-4,38-8,55c-21-4-43-7-64-8v-48zm0,150v-69c18,1,36,3,54,6c-13,32-32,55-54,63zm63-10c4-5,7-11,11-16c5-9,10-19,14-29c8,2,17,5,25,8c-14,15-31,28-49,37zm71-65c-12-5-24-8-36-12c5-20,8-41,9-63h52c-3,27-11,53-25,75z"/></svg>',
	filter: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="m395,140c0-27-62-49-139-49c-77,0-139,22-139,49c0,5,3,11,8,16l111,192v63c0,5,9,10,20,10c11,0,20-4,20-10v-62l112-193h-1c5-5,7-10,7-16zm-139,36c-81,0-126-24-126-36s44-36,126-36c81,0,126,24,126,36s-44,36-126,36z"/></svg>',
	sort: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="m126,220h262c5,0,9-2,13-6c4-4,6-8,6-13c0-5-2-9-6-13l-131-131c-4-4-8-6-13-6s-9,2-13,6l-131,131c-4,4-6,8-6,13c0,5,2,9,6,13c4,4,8,6,13,6zm262,75h-262c-5,0-9,2-13,6c-4,4-6,8-6,13c0,5,2,9,6,13l131,131c4,4,8,6,13,6s9-2,13-6l131-131c4-4,6-8,6-13c0-5-2-9-6-13c-4-4-8-6-13-6z"/></svg>',
	search: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="m410,373l-80-80c11-18,17-38,17-61c0-65-53-117-117-117c-65,0-117,53-117,117c0,65,53,117,117,117c22,0,43-6,61-17l80,80l40-40zm-253-141c0-40,33-73,73-73c40,0,73,33,73,73c0,40-33,73-73,73c-40,0-73-33-73-73z"/></svg>',
	speaker: '<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg"><path d="m221,88c-5,0-9,2-12,5l-92,92h-73c-5,0-9,2-12,5c-4,4-5,8-5,12v106c0,5,2,9,5,12c4,4,8,5,12,5h73l92,92c4,4,8,5,12,5c5,0,9-2,12-5c4-4,5-8,5-12v-301c0-5-2-9-5-12c-4-4-8-5-12-5zm112,208c8-12,12-25,12-39s-4-27-12-39c-8-12-18-21-31-26c-2-1-4-1-7-1c-5,0-9,2-12,5c-4,3-5,8-5,13c0,4,1,7,3,10c2,3,5,5,8,7c3,2,6,4,9,6c3,2,6,6,8,10c2,4,3,10,3,16c0,6-1,12-3,16c-2,4-5,8-8,10c-3,2-6,4-9,6c-3,2-6,4-8,7c-2,3-3,6-3,10c0,5,2,9,5,13c4,3,8,5,12,5c3,0,5,0,7-1c13-5,23-14,31-26z"/></svg>',
};
////-------------------------------------------------------------------------------------------------------------
loading.remove();
body.html(`
<div name="head">
	<span icon="region"></span><div name="areas"></div>
	<span icon="filter"></span><div name="filter"></div>
	<span icon="sort"></span><div name="sorts"></div>
	<span icon="search"></span><div name="search"></div>
	<div name="display"></div>
	<div name="langs"></div>
</div>
<div name="main"><div name="scroll"></div></div>
<div name="modal" class="hidden">
	<div class="head left" name="UL"></div><div class="head right" name="UR"></div>
	<div name="flag"></div>
	<div class="foot left" name="LL"></div><div class="foot center" name="LC"></div><div class="foot right" name="LR"></div>
	<button name="backward"></button><button name="forward"></button><button name="close"></button><button name="svg"></button>
</div>`);
const head = body.select("[name=head]").slideX(true);
[...head.selectAll("[name]")].forEach(t => head[t.getAttribute("name")] = d3.select(t));
[...head.selectAll("[icon]")].forEach(t => d3.select(t).html(icon[t.getAttribute("icon")]));
const scroll = body.select("[name=scroll]");
const modal = body.select("[name=modal]");
[...modal.selectAll("[name]")].forEach(t => modal[t.getAttribute("name")] = d3.select(t));
selectOptions(head.areas, REGIONS, v => (state.region = v, drawAll()), state.region, trans);
selectOptions(head.filter, FILTERS, v => (state.filter = v, drawAll()), state.filter, trans);
selectButtons(head.sorts, SORTS.index, v => (String(state.sort) == String(v) ? (v = -v) : 0, state.sort = +v || v, drawAll()), Math.abs(state.sort), true, trans);
inputSearch(head.search, v => (state.reg = v, drawAll()), state.reg);
selectButtons(head.display, [[icon.block, "1"], [icon.inline, "2"]], v => (state.display = v, drawAll()), state.display, false);
selectOptions(head.langs, LANGUAGES, async v => { state.lang = v; state.i18n = await loadI18N(v); applyLang(); model.rebuildSearch(); drawHead(); drawAll(); }, state.lang);   // 言語切替＝その言語のテーブル1本だけ取得
////-------------------------------------------------------------------------------------------------------------
let nationTub = [];
window.addEventListener("resize", resize, false);
drawHead(); await drawAll(); resize();
Object.assign(window, { nations, model, state, Sound });   // console からの作業用
// ディープリンク: ?open=国名（name.ja / key / iso2）で国旗モーダルを開いた状態で起動
{
	const q = new URLSearchParams(location.search).get("open");
	const t = q && (model.nation_hash[q] || model.key_hash[q] || model.key_hash[q.toUpperCase()]);
	t && setTimeout(() => openFlag(t, scroll.select(".nation img.hover").node() || document.body), 300);
}
////-------------------------------------------------------------------------------------------------------------
function resize() { /* ブロック表示は CSS Grid（justify-content:center）＝JS での中央寄せ・余白計算は不要になった 2026-09-10 */ }
function drawHead() {
	head.selectAll("[trans]").each(function () { this.innerText = trans(this.getAttribute("trans")); });
	head.select("[name=search] input").attr("placeholder", trans("search"));
	head.select("[icon=filter]").tip(FILTERS.tip(state.lang));
	head.select("[icon=sort]").tip(SORTS.tip(state.lang));
}
// 検索＝各言語名・首都名・地域名・ISO・キー を | 連結した search 文字列へ正規表現（大文字小文字無視）
// 検索語（ローマ字可）→ 正規表現。ローマ字はヘボン式でカタカナ化し「生の文字列 | カナ（長音任意）」で当てる＝英語名にもカナ名にも効く
function makeRegexp(s) {
	if (!s) return null;
	const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), kana = hebon2kana(s);
	try { return new RegExp(kana && kana != s ? `(?:${esc}|${kanaPattern(kana)})` : esc, "i"); } catch { return null; }
}
async function drawAll() {
	nationTub = nations;
	const { region, filter, sort, reg, display, lang } = state;
	const { member, dire } = SORTS[Math.abs(sort) - 1];
	Speech.setLanguage(lang);
	const d = sort > 0 ? dire ? 1 : -1 : dire ? -1 : 1;
	head.selectAll("[name=sorts] button").each(function () {
		d3.select(this).text(trans(this.getAttribute("trans")) + (this.value == Math.abs(sort) ? (sort < 0) ? "△" : "▽" : ""));
	});
	const cmp = collator();
	const sfunc = Math.abs(sort) == 1 ? (p, q) => d * cmp.compare(p.sortName, q.sortName) :
		Math.abs(sort) == 2 ? (p, q) => d * ((p.area || 0) > (q.area || 0) ? 1 : -1) : (p, q) => d * (p[member].value > q[member].value ? 1 : -1);
	nationTub = nationTub.filter(p => !+region || +region === +p.region);
	Math.abs(sort) > 2 && (nationTub = nationTub.filter(t => t[member]));
	nationTub = filter ? nationTub.filter(p => p.is(filter)) : nationTub;
	nationTub = nationTub.slice().sort(sfunc);
	const re = makeRegexp(reg); re && (nationTub = nationTub.filter(p => re.test(p.search)));
	nationTub.forEach((t, i) => t.order = sort > 0 ? i + 1 : nationTub.length - i);
	nationTub.length ? Sound("リスト") : Sound("失敗");
	scroll.empty();
	nationTub.length && [blockView, inlineView][display - 1]();
	if (reg) { const re = makeRegexp(reg); re && scroll.highlight(`/${re.source}/i`, false); }   // highlight は "/…/i" 文字列で正規表現を受ける
	resize();
	{ const { i18n, ...persist } = state; await store.save(persist); }   // i18n テーブル（〜100KB）は保存しない
}
////-------------------------------------------------------------------------------------------------------------
function mapTip(q) { return trans("Show '$1'", q.Name) + (q.geopngurl ? `<br/><img style="width:128px; padding:5px 0 0 20px;" src="${q.geopngurl}" alt=""/>` : ""); }
function blockView() {
	scroll.classed("grid", true);   // CSS Grid（draw.scss 末尾）＝float 崩れの根治
	scroll.selectAll("div.nation").data(nationTub).enter().append("div").each(function (q) { try { draw.call(this, q); } catch (e) { console.error("card失敗:", q && q.name && q.name.ja, e); } });
	scroll.selectAll(".hover").on("mouseenter", () => Sound("操作M", 0.4));
	function draw(q) {
		const node = d3.select(this).classed("nation", true);
		const jpcap = () => { const s = q.capitalInfo, cap = q.capitalName; return (state.lang == "ja" && cap.length > 13) ? `<span style="font-size:90%;">${s}</span>` : s; };
		node.append("div").classed("order", true).html("#" + q.order);
		q.geopngurl && node.append("img").classed("mapopen", true).attr("src", q.geopngurl).attr("loading", "lazy").attr("alt", "").tip(mapTip(q));   // 地図は後日＝配線なし
		const tr = node.append("table").append("tr");
		tr.append("td").append("img").attr("src", q.flagURL).attr("alt", q.Name).attr("loading", "lazy").classed("hover", true)
			.on("click", e => { e.stopPropagation(); openFlag(q, e.target); }).tip(trans("Show the flag of '$1'", q.Name));
		const td = tr.append("td");
		// 各行は描画前に幅を測って枠に収める（fitScale）。行の div に font-size を置く＝.name の 120% はその相対で効く
		const fitDiv = (html, font, opt) => { const k = fitScale(html, font, opt); const div = td.append("div"); k < 1 && div.css({ fontSize: (CARD_PX * k).toFixed(2) + "px" }); return div; };
		const F = CARD_PX + "px verdana", FB = "bold " + (CARD_PX * 1.2) + "px verdana";
		const nameTail = q.euFlag + q.natoFlag + q.group, capHTML = jpcap();
		// 国名: 1 行に収まればそのまま。収まらなければ 2 行（ja は「・/、/および」の切れ目に <br/> を入れた候補も比べ、同じ倍率なら切れ目で折る＝「アンティグア・バーブー/ダ」を避ける）
		const nameFit = { lines: 2, outerSpan: true };
		let nameHTML = q.Name + nameTail;
		if (fitScale(nameHTML, FB, { lines: 1, outerSpan: true }) < 1) {
			const cands = [nameHTML];
			if (state.lang == "ja") for (const m of q.Name.matchAll(/・|、|および/g)) { const i = m.index + (m[0] == "および" ? 0 : m[0].length); cands.push(q.Name.slice(0, i) + "<br/>" + q.Name.slice(i) + nameTail); }
			const k0 = fitScale(nameHTML, FB, nameFit); let best = k0 - 0.05 - 1e-6;   // 切れ目で折る方が 2 段（5%）までなら小さくてもそちら
			for (const c of cands.slice(1)) { const k = fitScale(c, FB, nameFit); if (k > best) { best = k; nameHTML = c; } }
		}
		fitDiv(nameHTML, FB, nameFit).append("span").classed("name", true).html(nameHTML)
			.classed("hover", true).on("click", e => { e.stopPropagation(); q.OpenWikipedia(); }).tip(trans("Open '$1' on Wikipedia", q.Name));
		fitDiv(capHTML, F, { outerSpan: true }).append("span").html(capHTML).classed("hover", true)
			.on("click", e => { e.stopPropagation(); q.capital && q.capital.OpenWikipedia(); }).tip(trans("Open '$1' on Wikipedia", q.capital ? q.capital.Name : ""));
		fitDiv(q.info, F).html(q.info);
		fitDiv(q.unJoin, F).html(q.unJoin);
		fitDiv(q.relation, F).html(q.relation);
	}
}
////-------------------------------------------------------------------------------------------------------------
function inlineView() {
	const small = s => `<small>${s}</small>`;
	const sort = Math.abs(state.sort), region = +state.region;
	const labels = SORTS.map(t => trans(t.label) + (t.unit ? "<br/>" + small(`[${t.unit}]`) : ""));
	const { label, member, year, length, show, dire, format, unit, ref } = SORTS[sort - 1];
	const Unit = unit ? small(`[${unit}]`) : "";
	const btns = [...head.selectAll("[name=sorts] button")];
	scroll.classed("grid", false);
	const table = scroll.append("div").classed("list", true).append("table");
	const thead = table.append("thead"), tbody = table.append("tbody");
	header(thead);
	tbody.selectAll("tr").data(nationTub).enter().append("tr").each(safeDraw);
	scroll.selectAll(".hover").on("mouseenter", () => Sound("操作M", 0.4));
	function safeDraw(q) { try { draw.call(this, q); } catch (e) { console.error("row失敗:", q && q.name && q.name.ja, e); } }
	function header(thead) {
		let tr = thead.append("tr");
		tr.append("th").attr("rowspan", 2).html("#");
		tr.append("th").attr("rowspan", 2).html(trans("National flag"));
		tr.append("th").attr("rowspan", 2).attr("colspan", 2).html(trans("Country")).classed("hover", true).on("click", () => sortExternal(0));
		(sort == 2) && tr.append("th").attr("rowspan", 2).html(trans(label) + Unit).classed("hover", true).on("click", () => sortExternal(sort - 1));
		(sort > 2) && tr.append("th").attr("colspan", show || length).html(trans(label) + Unit + small("(" + ref + ")")).classed("hover", true).on("click", () => sortExternal(sort - 1));
		tr.append("th").attr("rowspan", 2).html(trans("Capital")).classed("hover", true).on("click", () => sortCapital());
		region || tr.append("th").attr("rowspan", 2).html(trans("Region")).classed("hover", true).on("click", () => sortRegion());
		tr.append("th").attr("rowspan", 2).html(trans("United Nations")).classed("hover", true).on("click", () => sortOthers("un", 0));
		tr.append("th").attr("colspan", 3).html("ISO-3166-1");
		tr.append("th").attr("colspan", 2).html("IOC");
		labels.forEach((t, i) => i && (i != sort - 1) && tr.append("th").attr("rowspan", 2).html(t).classed("hover", true).on("click", () => sortExternal(i)));
		tr.append("th").attr("rowspan", 2).html(trans("Currency"));
		tr.append("th").attr("rowspan", 2).html(trans("Official language"));
		tr = thead.append("tr");
		(sort > 2) && [...Array(show || length)].forEach((_, i) => tr.append("th").html(year - i).classed("hover", true).on("click", e => sortYear(e.target, i)));
		["a2", "a3", "num"].forEach((t, i) => tr.append("th").html(t).classed("hover", true).on("click", () => sortOthers("iso", i)));
		["code", "from"].forEach((t, i) => tr.append("th").html(t).classed("hover", true).on("click", () => sortOthers("ioc", i)));
		(sort > 2) && tr.select("th").classed("flip", true);
		function sortExternal(n) { d3.select(btns[n]).trigger(new MouseEvent("click", { bubbles: true })); }
		function sortInternal(func) { func && (nationTub = nationTub.slice().sort(func)); tbody.empty().selectAll("tr").data(nationTub).enter().append("tr").each(safeDraw); }
		function sortCapital() {
			const a = nationTub.filter(t => t.capital || t.territory), b = nationTub.filter(t => !(t.capital || t.territory));
			const d = a.length > 1 && a[0].sortCapital < a[a.length - 1].sortCapital ? -1 : 1;
			nationTub = a.sort((p, q) => d * (p.sortCapital > q.sortCapital ? 1 : -1)).concat(b); sortInternal();
		}
		function sortRegion() {
			const d = nationTub[0].region < nationTub[nationTub.length - 1].region ? -1 : 1;
			sortInternal((p, q) => d * (p.region == q.region ? (p.sortName > q.sortName ? 1 : -1) : p.region > q.region ? 1 : -1));
		}
		function sortYear(target, i) {
			thead.selectAll("th").classed("flip", false); d3.select(target).classed("flip", true);
			const d = state.sort > 0 ? dire ? 1 : -1 : dire ? -1 : 1;
			sortInternal((p, q) => d * ((p[member].data[i] || 0) > (q[member].data[i] || 0) ? 1 : -1));
		}
		function sortOthers(key, n) {
			const a = nationTub.filter(t => t[key]); if (!a.length) return;
			const d = a[0][key][n] > a[a.length - 1][key][n] ? 1 : -1;
			nationTub = a.sort((p, q) => d * (p[key][n] > q[key][n] ? 1 : -1)).concat(nationTub.filter(t => !t[key])); sortInternal();
		}
	}
	function draw(q) {
		const tr = d3.select(this);
		const a = [[], [q.area]].concat(SORTS.dataLabels.map(t => q[t]));
		const formats = SORTS.map(t => t.format);
		let data = a[sort - 1];
		data = (Array.isArray(data) ? data : data ? data.data : []).map(v => v == null ? "-" : format(v));
		let value = a.map((t, i) => t ? formats[i](("value" in t) ? t.value : t[0]) : "-");
		sort > 1 && (value = value.filter((t, i) => i != sort - 1));
		value = value.slice(1);
		const [L, C, R] = [{ textAlign: "start" }, { textAlign: "center" }, { textAlign: "right" }];
		tr.append("th").css(C).html(q.order);
		tr.append("td").css(C).append("img").attr("src", q.flagURL).attr("alt", q.Name).attr("loading", "lazy").classed("hover", true).tip(trans("Show the flag of '$1'", q.Name)).on("click", e => openFlag(q, e.target));
		const geo = tr.append("td").css(C).css({ padding: 0 }); q.geopngurl && geo.append("img").attr("src", q.geopngurl).attr("loading", "lazy").attr("alt", "").css({ height: "30px" }).tip(mapTip(q));
		tr.append("td").css(L).append("span").html(q.officialName).classed("hover", true).tip(trans("Open '$1' on Wikipedia", q.Name)).on("click", () => q.OpenWikipedia());
		data.slice(0, show || length).forEach(t => tr.append("td").css(R).html(t));
		const td = tr.append("td").css(L);
		td.append("span").html(q.capitalName).classed("hover", true).on("click", () => q.capital && q.capital.OpenWikipedia()).tip(trans("Open '$1' on Wikipedia", q.capital ? q.capital.Name : ""));
		q.capitalComment && td.classed("mark", true).tip(q.capitalComment);
		region || tr.append("td").css(C).html(q.regionName);
		const un = tr.append("td").css(C).html(q.un ? q.un[0] : q.relation);
		q.un && q.un[1] && q.un[1].length && un.classed("mark", true).tip(q.unapproved);
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
async function openFlag(q, target) { await showFlag(q); modal.resumeShow(target, { fallback: () => scroll.hide() }); }
function closeFlag() {
	scroll.show();
	modal.node().animate({ opacity: 0 }, { duration: 500 }).onfinish = () => { modal.hide(); modal.css({ opacity: 1 }); };
}
async function showFlag(q) {
	Sound("移動");
	const sft = i => { const n = nationTub.indexOf(q) + i, len = nationTub.length; return nationTub[n < 0 ? n + len : n >= len ? n - len : n]; };
	const close = () => { Sound("リスト"); closeFlag(); };
	const flag = modal.flag.empty().append("img").attr("src", q.flagURL).attr("alt", q.Name);
	modal.UL.html(q.flagTitle + (q.geopngurl ? `<img src="${q.geopngurl}"/>` : ""));
	modal.UR.html(q.summary).css({ pointerEvents: "none" });
	modal.LL.html(q.nameInfo || q.relation);
	modal.LC.html(await q.flagInfo());
	modal.LR.html(q.anthemPlayer);
	modal.close.html(icon.close).tip(trans("Back to list")).on("click", close);
	modal.svg.html(icon.download).tip(trans("Download the flag of $1 (SVG)", q.Name)).on("click", async () => { Sound("リスト"); q.nationalFlag && download(await q.nationalFlag.format(), q.Name + ".svg"); });
	modal.backward.html(icon.left).tip(trans("Show '$1'", sft(-1).Name)).on("click", () => move(-1));
	modal.forward.html(icon.right).tip(trans("Show '$1'", sft(+1).Name)).on("click", () => move(+1));
	modal.select("audio").tip(trans("Play the anthem of '$1'", q.Name));
	modal.UL.select("img").tip(mapTip(q));
	q.capital && setTimeout(() => Speech(trans("The capital of $1 is $2", q.Name, q.capitalName)), 250);
	escape(() => { close(); escape(null); });
	function move(i) {
		const r = sft(i), duration = 500;
		const translate = i => `translate(${-50 + (110) * i}%,${-50}%)`;
		const dmy = modal.flag.append("img").attr("src", r.flagURL);
		dmy.node().animate({ transform: [translate(i), translate(0)] }, { duration });
		flag.node().animate({ transform: [translate(0), translate(-i)] }, { duration })
			.onfinish = () => { dmy.remove(); showFlag(r); body.select(".overlap-tooltip").show(); };
	}
}
