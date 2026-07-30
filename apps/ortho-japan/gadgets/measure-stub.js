// ガジェット：距離・面積の計測の玄関スタブ。ボタンと M キーの受付だけを常駐させ、本体（球面測地・面積・専用canvas＝measure.js）は
// 初回起動（クリック or M）で一度だけ import()＝初期バンドルから隔離。計測は「使う人が使う時に一度だけ」＝起動の一瞬に載せない。
// 搭載APIは従来どおり map.gadget.measure()。本体が付いたら同じボタンへ本体のトグル(start/stop)が付き、スタブは abort で退場。
// ★frame hook（毎フレ再投影で球に追従）は core 側の frameHooks に触れる＝抽象アクセス opts.onBody(本体) 経由で本体到着後に配線。
import { gadgetStack } from "./stack.js";
import { keyBusy } from "./keys.js";

// 巻尺グリフ（本体 measure.js と同一＝スタブがボタンを作る担当）。線色は本線インク直書き＝quiet-mono の夜節が自動反転。
const ICON = `
	<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
		<rect x="2.5" y="7" width="19" height="10" rx="1.5" transform="rotate(-20 12 12)"/>
		<path d="M6.6 8.2l1 2.4M10 6.9l1.4 3.2M13.4 5.6l1 2.4M16.8 4.3l1.4 3.2" stroke-width="1.3"/></svg>`;

export function measure(opts = {}) {
	const map = this, mapEl = this.mapEl;
	if (mapEl.querySelector("#measure-btn")) return () => {};   // 二重搭載は無害（作法の対称＝no-op を返す）
	const btn = document.createElement("button");
	btn.id = "measure-btn"; btn.dataset.tip = "距離・面積を測る（M）"; btn.setAttribute("aria-label", "距離・面積を測る");
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);

	let real = null;   // Promise<handle>＝一度だけ import して本体搭載（失敗時は null に戻して再挑戦可）
	const stub = new AbortController();   // 本体が付いたらスタブのリスナーを一括退場
	opts.signal && opts.signal.addEventListener("abort", () => stub.abort(), { once: true });   // destroy 時も退場
	const boot = () => real ||= import("./measure.js")
		.then(m => { const g = m.measure.call(map, { ...opts, btn }); stub.abort(); opts.onBody?.(g); return g; })   // 本体は持参 btn を再利用／onBody＝frame hook 配線を core へ委ねる
		.catch(e => { real = null; console.error("[measure] 本体の読み込みに失敗", e); });
	let opening = false;   // 読み込み中の連打を一回に畳む（搭載後はスタブごと退場＝本体トグルが受ける）
	const activate = () => { if (opening) return; opening = true; boot().then(g => { opening = false; g && g.open?.(); }); };   // open＝計測モードON（start）
	btn.addEventListener("click", activate, { signal: stub.signal });
	// M＝計測モードのトグル（修飾なし＝OS衝突を避けた選択）。入力欄フォーカス中は無効。初回は本体を載せて開始。
	window.addEventListener("keydown", e => {
		if (e.key !== "m" && e.key !== "M") return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		if (keyBusy(mapEl)) return;
		e.preventDefault(); activate();
	}, { signal: stub.signal });
	// 戻り値＝no-op（作法の対称）＋制御ハンドル。open()＝本体到着→計測開始（本体handleを解決＝テスト/アプリが stats() を読める）。
	return Object.assign(() => {}, { open: () => boot().then(g => { g && g.open?.(); return g; }), close: () => real && real.then(g => g && g.close?.()) });
}
