// ガジェット：配色テーマ・ピッカーの玄関スタブ。ボタンだけを常駐させ、本体（見本の色域写像＋合成＝palette.js）は
// 初期バンドルから隔離。ただし配色替えは常用＝「クリックで初めて import」だと初回の一拍が惜しい。そこで
// ★起動後アイドルに本体を先読み（requestIdleCallback）＝初期表示は軽いまま・押した時にはもう載っている、の両取り。
// アイドル前に押されても boot は冪等（real ||=）＝そのクリックが本体を呼び、開く。搭載APIは従来どおり map.gadget.palette()。
import { gadgetStack } from "./stack.js";
import { tr } from "../i18n.js";
const t = tr({
	"配色テーマ": "Color themes",
	"配色テーマを選ぶ": "Choose a color theme",
});

// パレット（3円の重なり）グリフ（本体 palette.js と同一＝スタブがボタンを作る担当）。線色は本線インク直書き＝夜節が自動反転。
const ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#3f4757" stroke-width="1.6" aria-hidden="true">
	<circle cx="12" cy="9" r="5"/><circle cx="9" cy="15" r="5"/><circle cx="15" cy="15" r="5"/></svg>`;

const idle = fn => (window.requestIdleCallback || (cb => setTimeout(() => cb(), 400)))(fn);   // 先読みは「暇な時に」＝初期描画を邪魔しない

export function palette(opts = {}) {
	const map = this, mapEl = this.mapEl;
	if (mapEl.querySelector("#palette-btn")) return;   // 二重搭載は無害
	const btn = document.createElement("button");
	btn.id = "palette-btn"; btn.dataset.tip = t("配色テーマ"); btn.setAttribute("aria-label", t("配色テーマを選ぶ"));
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);

	let real = null;   // Promise<{open,close}>＝一度だけ import して本体搭載（失敗時は null に戻して再挑戦可）
	const stub = new AbortController();   // 本体が付いたらスタブのリスナーを一括退場
	opts.signal && opts.signal.addEventListener("abort", () => stub.abort(), { once: true });   // destroy 時も退場
	const boot = () => real ||= import("./palette.js")
		.then(m => { const g = m.palette.call(map, { ...opts, btn }); stub.abort(); return g; })   // 本体は持参 btn を再利用
		.catch(e => { real = null; console.error("[palette] failed to load module", e); });
	let opening = false;   // 読み込み中の連打を一回に畳む（搭載後はスタブごと退場＝本体が受ける）
	const activate = () => { if (opening) return; opening = true; boot().then(g => { opening = false; g && g.open?.(); }); };
	btn.addEventListener("click", activate, { signal: stub.signal });
	idle(boot);   // ★起動後アイドル先読み＝常用ガジェットゆえ、押した時には本体が載っている状態を作る
	return { open: () => boot().then(g => { g && g.open?.(); return g; }), close: () => real && real.then(g => g && g.close?.()) };
}
