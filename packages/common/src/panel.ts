// common/panel ── 地図の上に乗る案内パネル（見出し・副題・折り畳み・本文）の共通の器（2026-10-18・アプリの統一）。
// 旧＝sats・clouds・hex・arcs・clock・parks・physical・quakes・models・terrain・onsen・yokohama・choju の 13 頁が
// 同じ枠の CSS と折り畳みを各自コピーしていた（幅 292〜420px・切替幅 640/720px・PC で左右どちらに置くか・スマホで畳むかが頁ごとにバラバラ）。
// ここが枠の唯一の正本。頁が書くのは中身（本文の部品）だけ＝中身の CSS は頁の class（cls）の下に頁が持つ。
//
// 掟（全頁で同じ）：
//   PC＝右上（inset-inline-end）に幅 width（既定 320px）のカード。スタック（左上の丸ボタン列）と重ならない側。
//       夜空の時計（#sky-clock＝右上）がある地球儀ではその下から（旧 clock・parks は時計を避けて左に置き、スタックを隠していた）。
//   下端はどちらも出典（#attr）の上で止める（PC＝丈の頭打ち・スマホ＝シートの下端）。
//   スマホ（≤640px）＝下端いっぱいのシート。出典（#attr）の高さを測って、その上に浮かす（出典が 2 行でも 4 行でも重ならない）。
//                     最初は畳む（見出しだけ＝地図を先に見せる）。開いている間は操作方法カード（#hint）を隠す（重なるため）。
//   配色＝黒地・白文字の一つだけ（紙の地図の頁も同じ。旧 theme "light"＝physical・terrain・onsen の白地は 2026-10-23 本人「黒地のパネルに」で廃止）。
//         --qm-* の変数を枠の中で夜値に決め直す＝中身の CSS は var(--qm-text) 等で書けば黒地で読める（紙の頁の #map が配る昼値に勝つ）。
//         枠の外に浮かぶ頁の部品（断面図・グラフ等）も class "oe-dark" を付ければ同じ変数と地色（--oe-panel-bg）を受ける。
//         地色の上の小物：--oe-field（入力・選択の地）・--oe-hover（行の hover）・--oe-on（選んだ行＝赤み）・--oe-inset（詳細の囲み）・--oe-halo（図の文字の縁取り）。
// 文言は呼び手が渡す（common は i18n を持たない＝各頁の t() で訳した物）。
// 二つ以上のアプリが使う＝共有エンジンの入口 common/panel（apps/engine/src/entries.mjs）＝各アプリの束に焼かない。

/** スマホとみなす幅（px 以下）。頁の中身の CSS もこの値に揃える（@media (max-width:640px)） */
export const PANEL_MOBILE = 640;
const MQ = `(max-width:${PANEL_MOBILE}px)`;

export interface PanelOpts {
	/** 置き場（地図の要素＝map.mapEl） */
	host: HTMLElement;
	/** 見出し（訳済みの文字列）。HTML でなく文字として入れる */
	title: string;
	/** 副題（任意・文字）。後から el.sub に書いてもよい */
	sub?: string;
	/** 頁の class（中身の CSS の錨。例 "sats-panel"） */
	cls?: string;
	/** PC での幅（px）。既定 320 */
	width?: number;
	/** スマホで最初に畳むか。既定 true */
	foldMobile?: boolean;
	/** 折り畳みボタンの札（訳済み）。既定は英語 */
	labels?: { fold?: string; unfold?: string };
	/** 畳む／開くたびに呼ぶ（min＝畳んだ） */
	onFold?: (min: boolean) => void;
}
export interface Panel {
	el: HTMLElement;
	head: HTMLElement;
	h1: HTMLHeadingElement;
	sub: HTMLElement;
	body: HTMLElement;
	fold: HTMLButtonElement;
	/** 畳む（true）／開く（false） */
	setFold(min: boolean): void;
	folded(): boolean;
	/** 外す（頁の後片付け） */
	destroy(): void;
}

const CSS = `
.oe-panel{--oe-panel-w:320px;position:absolute;top:12px;inset-inline-end:12px;z-index:30;width:var(--oe-panel-w);max-width:calc(100% - 24px);
 max-height:calc(100% - 28px - var(--oe-attr-h,40px));overflow:auto;box-sizing:border-box;padding:12px 14px;border-radius:12px;
 backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font:13px/1.5 var(--qm-font,system-ui,sans-serif);scrollbar-width:thin;
 background:var(--oe-panel-bg);color:var(--qm-text);border:1px solid var(--qm-border-soft);box-shadow:var(--oe-panel-shadow)}
.oe-panel,.oe-dark{--qm-ink:#fff;--qm-text:#e7ecf5;--qm-num:#cfd8e8;--qm-label:#9aa6bd;--qm-text-dim:#9aa6bd;--qm-text-faint:#8793aa;
 --qm-border:rgba(255,255,255,.22);--qm-border-soft:rgba(255,255,255,.16);--qm-border-strong:rgba(255,255,255,.42);--qm-panel-solid:rgba(12,17,32,.96);
 --qm-shadow-card:0 3px 10px rgba(0,0,0,.3);--qm-shadow-pop:0 8px 28px rgba(0,0,0,.35);
 --oe-panel-bg:rgba(12,17,32,.88);--oe-panel-shadow:0 8px 28px rgba(0,0,0,.35);
 --oe-field:rgba(255,255,255,.07);--oe-hover:rgba(255,255,255,.08);--oe-on:rgba(255,92,112,.2);--oe-inset:rgba(255,255,255,.05);--oe-halo:#0c1120;color-scheme:dark}
@media (min-width:${PANEL_MOBILE + 1}px){.oe-panel-host:has(#sky-clock)>.oe-panel{top:calc(46px + env(safe-area-inset-top,0px));max-height:calc(100% - 62px - var(--oe-attr-h,40px))}}   /* 夜空の時計（右上・#sky-clock）の下へ＝重ねない（PC だけ・スマホは下端） */
.oe-panel .oe-panel-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.oe-panel .oe-panel-head h1{flex:1;min-width:0;font-size:15px;line-height:1.35;margin:0;font-weight:700;letter-spacing:.02em;color:var(--qm-ink)}
.oe-panel .oe-panel-fold{flex:none;width:28px;height:28px;border-radius:7px;border:1px solid var(--qm-border-soft);background:transparent;
 color:var(--qm-text-dim);font-size:15px;line-height:1;cursor:pointer;padding:0}
.oe-panel .oe-panel-fold:hover{color:var(--qm-ink);border-color:var(--qm-text-dim)}
.oe-panel .oe-panel-sub{color:var(--qm-text-dim);font-size:11.5px;margin:2px 0 8px}
.oe-panel .oe-panel-sub:empty{display:none}
.oe-panel.min .oe-panel-body{display:none}
.oe-panel.min .oe-panel-sub{margin-bottom:0}
@media ${MQ}{
 .oe-panel{top:auto;bottom:calc(var(--oe-attr-h,40px) + 8px);inset-inline:8px;width:auto;max-width:none;max-height:50%;padding:10px 12px}
 .oe-panel-open #hint{display:none}
}`;

function injectCss(): void {
	if (document.getElementById("oe-panel-css")) return;
	const s = document.createElement("style");
	s.id = "oe-panel-css"; s.textContent = CSS;
	document.head.append(s);
}

// 出典（#attr）の高さ＝スマホのシートの下端。出典は後から差し替わる（地域・言語）＝ResizeObserver で追う
function watchAttr(host: HTMLElement, signal: AbortSignal): void {
	let ro: ResizeObserver | null = null;
	const bind = (): boolean => {
		const a = host.querySelector<HTMLElement>("#attr") || document.getElementById("attr");
		if (!a) return false;
		const put = () => host.style.setProperty("--oe-attr-h", `${Math.ceil(a.getBoundingClientRect().height + (parseFloat(getComputedStyle(a).bottom) || 0))}px`);
		put();
		if (typeof ResizeObserver !== "undefined") { ro = new ResizeObserver(put); ro.observe(a); }
		return true;
	};
	if (!bind()) {   // まだ無い＝地図の器が組み上がるのを数フレーム待つ
		let n = 0;
		const retry = () => { if (signal.aborted || bind() || ++n > 120) return; requestAnimationFrame(retry); };
		requestAnimationFrame(retry);
	}
	signal.addEventListener("abort", () => ro?.disconnect());
}

/** 案内パネルを作って host に付ける。中身は戻りの body に入れる */
export function createPanel({ host, title, sub = "", cls = "", width = 320, foldMobile = true, labels = {}, onFold }: PanelOpts): Panel {
	injectCss();
	const ac = new AbortController();
	const el = document.createElement("section");
	el.className = `oe-panel${cls ? " " + cls : ""}`;
	if (width !== 320) el.style.setProperty("--oe-panel-w", `${width}px`);
	el.innerHTML = `<div class="oe-panel-head"><h1></h1><button type="button" class="oe-panel-fold"></button></div><div class="oe-panel-sub"></div><div class="oe-panel-body"></div>`;
	const head = el.querySelector<HTMLElement>(".oe-panel-head")!;
	const h1 = head.querySelector("h1")!;
	const fold = head.querySelector<HTMLButtonElement>(".oe-panel-fold")!;
	const subEl = el.querySelector<HTMLElement>(".oe-panel-sub")!;
	const body = el.querySelector<HTMLElement>(".oe-panel-body")!;
	h1.textContent = title; subEl.textContent = sub;
	el.setAttribute("aria-label", title);
	const mq = matchMedia(MQ);
	const mark = () => host.classList.toggle("oe-panel-open", mq.matches && !el.classList.contains("min"));
	const setFold = (min: boolean) => {
		el.classList.toggle("min", min);
		fold.textContent = min ? "＋" : "−";
		const name = min ? labels.unfold || "Expand panel" : labels.fold || "Collapse panel";
		fold.setAttribute("aria-label", name); fold.title = name;
		fold.setAttribute("aria-expanded", String(!min));
		mark(); onFold?.(min);
	};
	fold.addEventListener("click", () => setFold(!el.classList.contains("min")), { signal: ac.signal });
	// 畳んだ板（スマホの下のシート）は見出しのどこを押しても開く＝小さな「＋」を探させない（横浜・市民ファースト 2026-10-25）
	head.addEventListener("click", e => { if (el.classList.contains("min") && !fold.contains(e.target as Node)) setFold(false); }, { signal: ac.signal });
	mq.addEventListener("change", mark, { signal: ac.signal });
	host.classList.add("oe-panel-host");
	host.append(el);
	watchAttr(host, ac.signal);
	setFold(foldMobile && mq.matches);
	return {
		el, head, h1, sub: subEl, body, fold, setFold,
		folded: () => el.classList.contains("min"),
		destroy: () => { ac.abort(); el.remove(); host.classList.remove("oe-panel-open"); },
	};
}
