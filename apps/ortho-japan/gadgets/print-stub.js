// ガジェット：印刷（平面図）の玄関スタブ。ボタンと ⌘/Ctrl+P の受付だけを常駐させ、
// 本体（組版・経緯線・PDFライタ・モーダル＝print.js）は初回起動時に import()＝初期バンドルから隔離。
// 印刷は「使う人が使う時に一度だけ」の機能＝起動の一瞬に載せない。搭載APIは従来どおり map.gadget.print()。
// 本体が搭載されると同じボタンへ自前のリスナーを付け直し、スタブ側は abort で退場（二重発火なし）。
import { gadgetStack } from "./stack.js";
import { keyBusy } from "./keys.js";

export function print(opts = {}) {
	const map = this, mapEl = this.mapEl;
	if (window.matchMedia("(pointer: coarse)").matches) return;   // モバイル非搭載＝端末の共有/スクショに委ねる（shotと同じ）
	if (mapEl.querySelector("#print-btn")) return;   // 二重搭載は無害
	const mac = /Mac|iP(hone|ad|od)/.test(navigator.platform || "");
	const btn = document.createElement("button");
	btn.id = "print-btn"; btn.dataset.tip = `平面図を印刷 (${mac ? "⌘P" : "Ctrl+P"})`; btn.setAttribute("aria-label", "平面図を印刷");
	btn.innerHTML = `
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
			<path d="M6.5 9V3.5h11V9"/>
			<path d="M6.5 17.5H4.3A1.8 1.8 0 0 1 2.5 15.7v-4.9A1.8 1.8 0 0 1 4.3 9h15.4a1.8 1.8 0 0 1 1.8 1.8v4.9a1.8 1.8 0 0 1-1.8 1.8h-2.2"/>
			<rect x="6.5" y="14" width="11" height="6.5"/></svg>`;
	gadgetStack(mapEl).append(btn);

	let real = null;   // Promise<{open,close}>＝一度だけ import して本体を搭載（失敗時は null に戻して再挑戦可）
	const stub = new AbortController();   // 本体が付いたらスタブのリスナーを一括退場
	opts.signal && opts.signal.addEventListener("abort", () => stub.abort(), { once: true });   // destroy 時も退場
	const boot = () => real ||= import("./print.js")
		.then(m => { const g = m.print.call(map, { ...opts, btn }); stub.abort(); return g; })
		.catch(e => { real = null; console.error("[print] 本体の読み込みに失敗", e); });
	let opening = false;   // 読み込み中の連打を一回に畳む（搭載後はスタブごと退場済み＝本体が受ける）
	const activate = () => { if (opening) return; opening = true; boot().then(g => { opening = false; g && g.open(); }); };
	btn.addEventListener("click", activate, { signal: stub.signal });
	// ⌘/Ctrl+P＝印刷（平面図）を開く（ブラウザ印刷を平面図プレビューへ転用・⇧無し＝plateau ⌘⇧P と区別）。入力欄フォーカス中は無効。
	window.addEventListener("keydown", e => {
		if (!((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "p" || e.key === "P"))) return;
		if (keyBusy(mapEl)) return;
		e.preventDefault(); activate();
	}, { signal: stub.signal });
	return { open: () => boot().then(g => g && g.open()), close: () => real && real.then(g => g && g.close()) };
}
