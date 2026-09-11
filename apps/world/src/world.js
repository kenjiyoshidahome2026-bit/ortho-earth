// ortho-world ── 国別 DB のビューア／セレクタ（MIT・npm: ortho-world）。
// 取り付け先の div に閉じた部品として動く：body/html には一切書かず、意匠は .ortho-world の配下だけ。
// 用途はまさに「国のセレクタ」＝地図（別の部品）と対で使う想定で、出入口を両方向に持つ:
//   world → 外  on("select"|"hover"|"map"|"lang")
//   外 → world  hover(id) / select(id) / clear() / lang(code)
// 国の同定は **ISO 3166-1 を共通語**にする（Kenji 裁定 2026-09-12）。相手が地図である以上、Natural Earth でも
// GeoJSON でも ISO が共通鍵だから。受け側は key/iso2/iso3/番号/QID/IOC のどれで来ても引ける。
// ⚠ 1 ページ 1 インスタンス。model.js が言語状態（state）と参照表（ctx）をモジュール変数で持つ＝
//   2 つ載せると後から作った方の言語で両方が描かれる。複数必要になったらそこを閉じるのが先。

// データ=bucket GIS/world（uploader「国別DB (world)」節の成果物）。地図は後日＝geoPNG はサムネイル表示のみ（配線なし）
import "./draw.scss";                    // 先にリセット（.ortho-world 配下）
import { sel } from "common/dom";        // 後から部品の意匠＝同詳細度なら部品が勝つ
import { setTipRoot } from "common/dom/tip.js";
import "common/dom/highlight.js";
import { escape, download } from "common";
import { wiki } from "common/wiki.js";
import { loadWorld, loadI18N, refresh, systemStore, dropCache, ASSET_BASE } from "./data.js";
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


export default async function world(opts = {}) {
	// ── 取り付け先＝コンテナ div。body には一切書かない ──
	// target 省略時だけ #world を探し（無ければ作り）、ページの持ち物として振る舞う＝素の index.html でも動く。
	const embedded = opts.target !== undefined;
	const el = (() => {
		const t = opts.target;
		const found = typeof t === "string" ? document.querySelector(t) : (t && t.node) ? t.node() : t;
		if (t !== undefined && !found) throw new Error(`ortho-world: target が見つからない（${t}）`);
		return found || document.getElementById("world")
			|| document.body.appendChild(Object.assign(document.createElement("div"), { id: "world" }));
	})();
	el.classList.add("ortho-world");
	setTipRoot(el);   // ツールチップもこの箱の中に生む＝dir/意匠が箱のものに従い、箱ごと片付く
	const root = sel(el);
	// 外の世界へ触る手＝埋め込み時は既定で全部閉じる（URL を書かない・window を汚さない・? を読まない）
	const useURL = opts.urlHash ?? !embedded;
	const debugGlobals = opts.debugGlobals ?? !embedded;
	const listeners = {};   // on() の控え
	const emit = (ev, payload) => { (listeners[ev] || []).forEach(f => { try { f(payload); } catch (e) { console.error(`ortho-world: on("${ev}") で例外`, e); } }); };
	const offs = [];        // destroy() で外す手
	const loading = root.append("div").attr("name", "loading").html("<span>Loading the world…</span>");
	////-------------------------------------------------------------------------------------------------------------
	const store = await systemStore();
	Object.assign(state, await store.load());
	// ?lang=xx（26言語・langs.json）が最優先。無ければ保存値→ブラウザ言語→en
	{
		const known = new Set(LANG_LIST.map(l => l.code));
		const q = (opts.lang ?? (useURL ? new URLSearchParams(location.search).get("lang") : null));
		const nav = (navigator.language || "en").split("-")[0];
		state.lang = known.has(q) ? q : known.has(state.lang) ? state.lang : known.has(nav) ? nav : "en";
	}
	const applyLang = () => {   // 言語と書字方向（ar/fa/ur/he は RTL）＝コンテナ自身に置く（html には触らない）
		const el = root.node();
		el.lang = state.lang;
		el.dir = isRTL(state.lang) ? "rtl" : "ltr";
		if (useURL) { const u = new URL(location.href); u.searchParams.set("lang", state.lang); history.replaceState(null, "", u); }   // 他の ?open= 等は保持
		emit("lang", { lang: state.lang, rtl: isRTL(state.lang) });
	};
	let data;   // IDB 優先（温＝即）・初回だけ一段並列（冷）。裏の更新は描画後の refresh() で
	try { data = await loadWorld(state.lang); state.i18n = data.i18n; } catch (e) { loading.html(`<span>Failed to load: ${e.message}</span>`); throw e; }
	applyLang();
	// 旗/地図PNG＝bucket の個別ファイル URL（<img loading=lazy> で見えた分だけ取得・edge 1h キャッシュ）。
	// 旗の有無は NationDB の key 集合＋領有国代替で決める（zip を丸ごと落とさない）
	const assets = (() => {
		const flags = {};   // 実在する旗＝data.flags（bucket flags/ 一覧・裏更新で差し替わる）。無い国は model 側で領有国の旗へ代替
		const flagURL = k => `${ASSET_BASE}flags/${encodeURIComponent(k)}.svg`;
		return { flagURL, hasFlag: k => data.flags.has(k), flag: k => flags[k] || (flags[k] = makeFlag(flagURL(k))), geomURL: k => `${ASSET_BASE}geoms/${encodeURIComponent(k)}.png`, openWiki: (url, name) => showWiki(url, name) };
	})();
	// 温起動＝IDB をそのまま食う。そのデータが今のコードと別の版の形だと buildModel が落ちる
	// （例: v1 の CityDB は nation が文字列・v2 は配列）。ここで投げるとモジュールごと死んで下の refresh() に
	// 到達しない＝キャッシュが直る機会が永久に来ない。なので温のときだけ捨てて冷やし直す。
	let model;
	try { model = buildModel(data, assets); }
	catch (e) {
		if (!data.warm) { loading.html(`<span>Failed to build: ${e.message}</span>`); throw e; }
		console.warn("cached data is from an older schema; dropping the cache and refetching.", e);
		await dropCache();
		data = await loadWorld(state.lang); state.i18n = data.i18n;
		model = buildModel(data, assets);
	}
	let nations = model.nations;
	////-------------------------------------------------------------------------------------------------------------
	// 効果音（音源.zip）と読み上げ（Web Speech API）
	const Sound = (() => {
		const src = {}; Object.entries(data.sounds).forEach(([k, f]) => src[k] = new Audio(URL.createObjectURL(f)));
		// 出所不明だった 移動/リスト の 2 本は撤去（2026-09-10 Kenji 裁定「OtoLogic の既存音で代用」）＝音源.zip は全 9 本 OtoLogic（CC BY 4.0）
		const alias = { 移動: "操作H", リスト: "操作L" };
		const f = (s, v = 1) => { const a = src[s] || src[alias[s]]; if (!a) return; a.currentTime = 0; a.volume = v; a.play().catch(() => { }); };
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
	root.html(`
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
</div>
<div name="wiki" class="hidden">
	<div class="bar"><img name="logo" alt="Wikipedia"/><span name="title" class="title"></span><a name="newtab" target="_blank" rel="noopener"></a><button name="close"></button></div>
	<iframe name="frame" title="Wikipedia"></iframe>
</div>`);
	const head = root.select("[name=head]").slideX(true);
	[...head.selectAll("[name]")].forEach(t => head[t.getAttribute("name")] = sel(t));
	[...head.selectAll("[icon]")].forEach(t => sel(t).html(icon[t.getAttribute("icon")]));
	const scroll = root.select("[name=scroll]");
	const modal = root.select("[name=modal]");
	[...modal.selectAll("[name]")].forEach(t => modal[t.getAttribute("name")] = sel(t));
	// Wikipedia はアプリ内の iframe で（census と同じ・Kenji 2026-09-10）。記事は m. 版＝狭い枠でも読みやすい。別タブは ↗ で
	const wikiPane = root.select("[name=wiki]");
	[...wikiPane.selectAll("[name]")].forEach(t => wikiPane[t.getAttribute("name")] = sel(t));
	wikiPane.logo.attr("src", wiki.logo); wikiPane.newtab.html("&nearr;"); wikiPane.close.html(icon.close).on("click", () => closeWiki());
	let modalEscape = null;   // 国旗モーダルの Escape（wiki を閉じた後に復帰させる）
	function showWiki(url, name) {
		Sound("操作H");
		wikiPane.title.text(name || ""); wikiPane.newtab.attr("href", url).tip(trans("Open '$1' on Wikipedia", name || ""));
		wikiPane.close.tip(trans("Back to list"));
		wikiPane.frame.attr("src", url.replace(/^https:\/\/([a-z-]+)\.wikipedia\.org/, "https://$1.m.wikipedia.org")); wikiPane.show();
		escape(() => closeWiki());
	}
	function closeWiki() {
		Sound("リスト"); wikiPane.hide(); wikiPane.frame.attr("src", "about:blank");
		escape(modal.isVisible() && modalEscape ? modalEscape : null);
	}
	selectOptions(head.areas, REGIONS, v => (state.region = v, drawAll()), state.region, trans);
	selectOptions(head.filter, FILTERS, v => (state.filter = v, drawAll()), state.filter, trans);
	selectButtons(head.sorts, SORTS.index, v => (String(state.sort) == String(v) ? (v = -v) : 0, state.sort = +v || v, drawAll()), Math.abs(state.sort), true, trans);
	inputSearch(head.search, v => (state.reg = v, drawAll()), state.reg);
	selectButtons(head.display, [[icon.block, "1"], [icon.inline, "2"]], v => (state.display = v, drawAll()), state.display, false);
	const applyI18N = v => { state.i18n = v; applyLang(); model.rebuildSearch(); drawHead(); drawAll(); };
	selectOptions(head.langs, LANGUAGES, async v => { state.lang = v; applyI18N(await loadI18N(v, fresh => state.lang == v && applyI18N(fresh))); }, state.lang);   // 言語切替＝IDB にあれば即・裏で取り直し
	////-------------------------------------------------------------------------------------------------------------
	// ── 国の同定＝ISO 共通語（key/iso2/iso3/番号/QID/IOC のどれでも引ける）──
	let index = new Map();
	const rebuildIndex = () => {
		index = new Map();
		const put = (k, n) => { if (k != null && k !== "") index.set(String(k).toUpperCase(), n); };
		for (const n of nations) { put(n.key, n); put(n.qid, n); put(n.ioc, n); (n.iso || []).forEach(v => put(v, n)); }
	};
	rebuildIndex();
	/** 合図に載せる形。ISO を先頭に置く＝地図側の共通鍵 */
	const sign = n => n && ({ iso2: (n.iso && n.iso[0]) || "", iso3: (n.iso && n.iso[1]) || "", isoNum: (n.iso && n.iso[2]) ?? null,
		key: n.key, qid: n.qid || "", ioc: n.ioc || "", name: (n.name && n.name.en) || "", label: n.Name, nation: n });
	/** key/iso2/iso3/番号/QID/IOC いずれでも引く。Nation そのものを渡しても良い */
	const find = id => (id == null || id === "") ? null : (id.key ? id : index.get(String(id).toUpperCase()) || null);
	let hovered = null;   // 外から差されている国（remote hover）

	let nationTub = [];
	window.addEventListener("resize", resize, false); offs.push(() => window.removeEventListener("resize", resize, false));
	drawHead(); await drawAll(); resize();
	debugGlobals && Object.assign(window, { nations, model, state, Sound });   // console からの作業用（埋め込み時は生やさない）
	// 裏の更新: 一覧の ETag を突合→変わったファイルだけ取得→差があれば組み直して再描画（国旗モーダル中は閉じた時に）
	let pendingUpdate = null;
	refresh(state.lang, changed => {
		const f = changed, D = { NationDB: "nations", CityDB: "cities", LanguageDB: "languages", CurrencyDB: "currencies", Conflicts: "conflicts" };
		Object.entries(D).forEach(([k, m]) => f[k] && (data[m] = f[k]));
		f[`i18n/${state.lang}`] && (state.i18n = f[`i18n/${state.lang}`]);
		f.flags && (data.flags = f.flags);
		const redo = () => {
			pendingUpdate = null;
			if (Object.keys(f).some(k => D[k])) { model = buildModel(data, assets); nations = model.nations; rebuildIndex(); debugGlobals && Object.assign(window, { nations, model }); }
			else model.rebuildSearch();
			drawHead(); drawAll(); console.log("data updated:", Object.keys(f).join(", "));
		};
		modal.node().offsetParent === null ? redo() : (pendingUpdate = redo);
	}).catch(e => console.warn("refresh:", e));
	// ディープリンク: ?open=key（iso2 か台帳キー）で国旗モーダルを開いた状態で起動
	{
		const q = opts.open ?? (useURL ? new URLSearchParams(location.search).get("open") : null);
		const t = q && (model.nation_hash[q] || model.key_hash[q] || model.key_hash[q.toUpperCase()]);
		t && setTimeout(() => openFlag(t, scroll.select(".nation img.hover").node() || root.node()), 300);
	}
	////-------------------------------------------------------------------------------------------------------------
	function resize() { /* ブロック表示は CSS Grid（justify-content:center）＝JS での中央寄せ・余白計算は不要になった 2026-09-10 */ }
	function drawHead() {
		head.selectAll("[trans]").each(function () { this.innerText = trans(this.getAttribute("trans")); });
		head.select("[name=search] input").attr("placeholder", trans("search"));
		head.select("[icon=filter]").tip(FILTERS.tip(state.lang));
		head.select("[icon=sort]").tip(SORTS.tip(state.lang));
		head.select("[icon=region]").tip("Sound effects: OtoLogic (CC BY 4.0) https://otologic.jp");   // 素材クレジット（CC BY の表示義務・packages/world/README.md「素材の出所」）
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
			sel(this).text(trans(this.getAttribute("trans")) + (this.value == Math.abs(sort) ? (sort < 0) ? "△" : "▽" : ""));
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
	// 行/カードのホバーを外へ。描画のたびに張り直す（DOM は毎回作り直されるため）
	function bindHover() {
		scroll.selectAll("div.nation, .list tbody tr").each(function (q) {
			if (!q) return;
			sel(this).on("mouseenter.remote", () => emit("hover", sign(q))).on("mouseleave.remote", () => emit("hover", null));
		});
	}
	function mapTip(q) { return trans("Show '$1'", q.Name) + (q.geopngurl ? `<br/><img style="width:128px; padding:5px 0 0 20px;" src="${q.geopngurl}" alt=""/>` : ""); }
	function blockView() {
		scroll.classed("grid", true);   // CSS Grid（draw.scss 末尾）＝float 崩れの根治
		scroll.selectAll("div.nation").data(nationTub).enter().append("div").each(function (q) { try { draw.call(this, q); } catch (e) { console.error("card失敗:", q && q.key, e); } });
		scroll.selectAll(".hover").on("mouseenter", () => Sound("操作M", 0.4));
		bindHover();
		function draw(q) {
			const node = sel(this).classed("nation", true);
			const jpcap = () => { const s = q.capitalInfo, cap = q.capitalName; return (state.lang == "ja" && cap.length > 13) ? `<span style="font-size:90%;">${s}</span>` : s; };
			node.append("div").classed("order", true).html("#" + q.order);
			q.geopngurl && node.append("img").classed("mapopen", true).attr("src", q.geopngurl).attr("loading", "lazy").attr("alt", "").tip(mapTip(q))
				.on("click", e => { e.stopPropagation(); emit("map", { ...sign(q), url: q.geopngurl }); });   // 地図の実体は持たない＝外へ合図だけ
			const tr = node.append("table").append("tr");
			tr.append("td").append("img").attr("src", q.flagURL).attr("alt", q.Name).attr("loading", "lazy").classed("hover", true)
				.on("click", e => { e.stopPropagation(); emit("select", sign(q)); openFlag(q, e.target); }).tip(trans("Show the flag of '$1'", q.Name));
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
		bindHover();
		function safeDraw(q) { try { draw.call(this, q); } catch (e) { console.error("row失敗:", q && q.key, e); } }
		function header(thead) {
			let tr = thead.append("tr");
			tr.append("th").attr("rowspan", 2).html("#");
			tr.append("th").attr("rowspan", 2).html(trans("National flag"));
			tr.append("th").attr("rowspan", 2).attr("colspan", 2).html(trans("Country")).classed("hover", true).on("click", () => sortExternal(0));
			(sort == 2) && tr.append("th").attr("rowspan", 2).html(trans(label) + Unit).classed("hover", true).on("click", () => sortExternal(sort - 1));
			(sort > 2) && tr.append("th").attr("colspan", show || length).html(trans(label) + Unit + small("(" + ref + ")")).classed("hover", true).on("click", () => sortExternal(sort - 1));
			tr.append("th").attr("rowspan", 2).html(trans("Capital")).classed("hover", true).on("click", () => sortCapital());
			region || tr.append("th").attr("rowspan", 2).html(trans("Region")).classed("hover", true).on("click", () => sortRegion());
			tr.append("th").attr("rowspan", 2).html(trans("United Nations")).classed("hover", true).on("click", () => sortOthers("un"));
			tr.append("th").attr("colspan", 3).html("ISO-3166-1");
			tr.append("th").attr("rowspan", 2).html("IOC");
			labels.forEach((t, i) => i && (i != sort - 1) && tr.append("th").attr("rowspan", 2).html(t).classed("hover", true).on("click", () => sortExternal(i)));
			tr.append("th").attr("rowspan", 2).html(trans("Currency"));
			tr.append("th").attr("rowspan", 2).html(trans("Official language"));
			tr = thead.append("tr");
			(sort > 2) && [...Array(show || length)].forEach((_, i) => tr.append("th").html(year - i).classed("hover", true).on("click", e => sortYear(e.target, i)));
			["a2", "a3", "num"].forEach((t, i) => tr.append("th").html(t).classed("hover", true).on("click", () => sortOthers("iso", i)));
			["code", "from"].forEach((t, i) => tr.append("th").html(t).classed("hover", true).on("click", () => sortOthers("ioc", i)));
			(sort > 2) && tr.select("th").classed("flip", true);
			function sortExternal(n) { sel(btns[n]).trigger(new MouseEvent("click", { bubbles: true })); }
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
				thead.selectAll("th").classed("flip", false); sel(target).classed("flip", true);
				const d = state.sort > 0 ? dire ? 1 : -1 : dire ? -1 : 1;
				sortInternal((p, q) => d * ((p[member].data[i] || 0) > (q[member].data[i] || 0) ? 1 : -1));
			}
			function sortOthers(key, n) {   // n 省略＝値そのもの（un は加盟日の文字列）
				const v = t => n == null ? t[key] : t[key][n];
				const a = nationTub.filter(t => t[key]); if (!a.length) return;
				const d = v(a[0]) > v(a[a.length - 1]) ? 1 : -1;
				nationTub = a.sort((p, q) => d * (v(p) > v(q) ? 1 : -1)).concat(nationTub.filter(t => !t[key])); sortInternal();
			}
		}
		function draw(q) {
			const tr = sel(this);
			const a = [[], [q.area]].concat(SORTS.dataLabels.map(t => q[t]));
			const formats = SORTS.map(t => t.format);
			let data = a[sort - 1];
			data = (Array.isArray(data) ? data : data ? data.data : []).map(v => v == null ? "-" : format(v));
			let value = a.map((t, i) => t ? formats[i](("value" in t) ? t.value : t[0]) : "-");
			sort > 1 && (value = value.filter((t, i) => i != sort - 1));
			value = value.slice(1);
			const [L, C, R] = [{ textAlign: "start" }, { textAlign: "center" }, { textAlign: "right" }];
			tr.append("th").css(C).html(q.order);
			tr.append("td").css(C).append("img").attr("src", q.flagURL).attr("alt", q.Name).attr("loading", "lazy").classed("hover", true).tip(trans("Show the flag of '$1'", q.Name)).on("click", e => { emit("select", sign(q)); openFlag(q, e.target); });
			const geo = tr.append("td").css(C).css({ padding: 0 }); q.geopngurl && geo.append("img").attr("src", q.geopngurl).attr("loading", "lazy").attr("alt", "").css({ height: "30px" }).tip(mapTip(q));
			tr.append("td").css(L).append("span").html(q.officialName).classed("hover", true).tip(trans("Open '$1' on Wikipedia", q.Name)).on("click", () => q.OpenWikipedia());
			data.slice(0, show || length).forEach(t => tr.append("td").css(R).html(t));
			const td = tr.append("td").css(L);
			td.append("span").html(q.capitalName).classed("hover", true).on("click", () => q.capital && q.capital.OpenWikipedia()).tip(trans("Open '$1' on Wikipedia", q.capital ? q.capital.Name : ""));
			q.capitalComment && td.classed("mark", true).tip(q.capitalComment);
			region || tr.append("td").css(C).html(q.regionName);
			tr.append("td").css(C).html(q.un ? q.unDate : q.relation);
			(q.iso || ["", "", ""]).forEach(t => tr.append("td").css(C).html(t == null ? "" : t));
			tr.append("td").css(C).html(q.ioc || "");
			value.forEach(t => tr.append("td").css(R).html(t));
			tr.append("td").css(C).html(q.Currency);
			tr.append("td").css(L).html(q.Language);
			[...tr.selectAll("currency")].forEach((t, i) => sel(t).tip(q.currency[i].Name).classed("hover", true).on("click", () => q.currency[i].OpenWikipedia()));
			[...tr.selectAll("language")].forEach((t, i) => sel(t).tip(q.languages[i].Name).classed("hover", true).on("click", () => q.languages[i].OpenWikipedia()));
		}
	}
	////-------------------------------------------------------------------------------------------------------------
	async function openFlag(q, target) { await showFlag(q); modal.resumeShow(target, { fallback: () => scroll.hide() }); }
	function closeFlag() {
		scroll.show();
		modal.node().animate({ opacity: 0 }, { duration: 500 }).onfinish = () => { modal.hide(); modal.css({ opacity: 1 }); pendingUpdate && pendingUpdate(); };
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
		modalEscape = () => { close(); escape(null); modalEscape = null; }; escape(modalEscape);
		function move(i) {
			const r = sft(i), duration = 500;
			const translate = i => `translate(${-50 + (110) * i}%,${-50}%)`;
			const dmy = modal.flag.append("img").attr("src", r.flagURL);
			dmy.node().animate({ transform: [translate(i), translate(0)] }, { duration });
			flag.node().animate({ transform: [translate(0), translate(-i)] }, { duration })
				.onfinish = () => { dmy.remove(); showFlag(r); sel(".overlap-tooltip").show(); };
		}
	}


	// ── 外から差し込む口 ───────────────────────────────────────────────────
	// 地図の上でホバー／クリックされた国を、この一覧に映す。id は key/iso2/iso3/番号/QID/IOC のどれでも良い。
	const cardOf = n => {
		let hit = null;
		scroll.selectAll("div.nation, .list tbody tr").each(function (q) { if (q === n) hit = this; });
		return hit;
	};
	const paintHover = () => {
		scroll.selectAll(".remote-hover").classed("remote-hover", false);
		if (!hovered) return;
		const el = cardOf(hovered);
		el && (el.classList.add("remote-hover"), el.scrollIntoView({ block: "nearest", behavior: "smooth" }));
	};

	const api = {
		/** 取り付いている div（意匠は .ortho-world 配下） */
		el,
		/** 合図を受ける。ev = "select" | "hover" | "map" | "lang" */
		on(ev, cb) { (listeners[ev] || (listeners[ev] = [])).push(cb); return api; },
		off(ev, cb) { listeners[ev] = (listeners[ev] || []).filter(f => f !== cb); return api; },
		/** 地図の上でホバーされた国をこの一覧に映す。null で解除 */
		hover(id) { hovered = find(id); paintHover(); return api; },
		/** 地図の上でクリックされた国を開く（カード側のクリックと同じ＝国旗モーダル） */
		select(id) { const n = find(id); if (n) { hovered = n; paintHover(); openFlag(n, cardOf(n) || el); } return api; },
		/** remote hover の解除 */
		clear() { hovered = null; paintHover(); return api; },
		/** 引数無し＝今の言語／有り＝切り替え（Promise） */
		lang(code) { if (code === undefined) return state.lang; return (async () => { state.lang = code; applyI18N(await loadI18N(code, fresh => state.lang == code && applyI18N(fresh))); })(); },
		/** id から国を引く（key/iso2/iso3/番号/QID/IOC） */
		nation(id) { const n = find(id); return n ? sign(n) : null; },
		/** 今の並び順で見えている国（絞り込み・並べ替えの結果） */
		list() { return nationTub.map(sign); },
		/** 箱ごと片付ける。外に張った手も全部外す */
		destroy() {
			offs.forEach(f => { try { f(); } catch { } });
			Object.keys(listeners).forEach(k => delete listeners[k]);
			root.html("");
			el.classList.remove("ortho-world");
			setTipRoot(null);
		},
	};
	// ⚠ "ready" は作らない。world() の中で発火しても、呼び出し側が .on() を張るのは Promise が解決した後＝
	//    構造的に絶対に受け取れない（npm 検定が捕まえた 2026-09-12）。**Promise の解決がそのまま準備完了の合図**。
	return api;
}
