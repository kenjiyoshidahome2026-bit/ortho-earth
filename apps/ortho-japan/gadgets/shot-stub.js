// ガジェット：画面保存(shot)の玄関スタブ。★デスクトップ専用＝モバイル(coarse pointer)は入口で return＝
//   ボタンも作らず本体も import しない＝本体(shot.js＝層合成/webp化/出典焼込・5.7KB)がモバイルの死荷重にならない。
// デスクトップはボタンと ⌘/Ctrl+S だけ常駐、本体は初回クリック/⌘Sで一度だけ import()＝初期バンドルから隔離（print と同型）。
// 本体到着後は同じボタンへ本体のリスナーが付き、スタブは abort で退場（二重発火なし）。搭載APIは従来どおり map.gadget.shot()。
import { gadgetStack } from "./stack.js";
import { keyBusy } from "./keys.js";

// カメラ（レンズ+本体）グリフ（本体 shot.js と同一＝スタブがボタンを作る担当）。線色は本線インク直書き＝夜節が自動反転。
const ICON = `
	<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
		<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/>
		<circle cx="12" cy="13" r="3.4"/></svg>`;

export function shot(opts = {}) {
	const map = this, mapEl = this.mapEl;
	if (window.matchMedia("(pointer: coarse)").matches) return;   // モバイル非搭載＝本体も fetch しない（端末標準スクショに委ねる）
	if (mapEl.querySelector("#shot-btn")) return;   // 二重搭載は無害
	const mac = /Mac|iP(hone|ad|od)/.test(navigator.platform || "");
	const btn = document.createElement("button");
	btn.id = "shot-btn"; btn.dataset.tip = `画面を画像で保存 (${mac ? "⌘S" : "Ctrl+S"})`; btn.setAttribute("aria-label", "画面を画像で保存");
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);

	let real = null;   // Promise<handle>＝一度だけ import して本体搭載（失敗時は null に戻して再挑戦可）
	const stub = new AbortController();   // 本体が付いたらスタブのリスナーを一括退場
	opts.signal && opts.signal.addEventListener("abort", () => stub.abort(), { once: true });   // destroy 時も退場
	const boot = () => real ||= import("./shot.js")
		.then(m => { const g = m.shot.call(map, { ...opts, btn }); stub.abort(); return g; })   // 本体は持参 btn を再利用
		.catch(e => { real = null; console.error("[shot] 本体の読み込みに失敗", e); });
	let opening = false;   // 読み込み中の連打を一回に畳む（搭載後はスタブごと退場＝本体が受ける）
	const activate = () => { if (opening) return; opening = true; boot().then(g => { opening = false; g && g.open?.(); }); };   // open＝capture（撮影）
	btn.addEventListener("click", activate, { signal: stub.signal });
	// ⌘/Ctrl+S＝ページ保存を止めて撮影を起動（低解像度でボタンが隠れても撮れる手綱）。入力欄フォーカス中は無効。
	window.addEventListener("keydown", e => {
		if (!((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "s" || e.key === "S"))) return;
		if (keyBusy(mapEl)) return;
		e.preventDefault(); activate();
	}, { signal: stub.signal });
	// 戻り＝open()=撮影／composite=合成器（テスト/プログラムが直接叩く＝初回は本体をロードして委譲＝撮影は起こさない）。
	return {
		open: () => boot().then(g => { g && g.open?.(); return g; }),
		composite: async (...a) => { const g = await boot(); return g && g.composite(...a); },
		close: () => {},
	};
}
