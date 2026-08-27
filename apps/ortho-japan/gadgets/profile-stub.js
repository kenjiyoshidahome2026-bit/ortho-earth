// ガジェット：断面図の玄関スタブ。ボタンだけを常駐させ、本体（経路指定・標高サンプル・グラフ＝profile.js）は
// 初回クリックで一度だけ import()＝初期バンドルから隔離（measure-stub と同流儀。キー割当はなし＝単キー名前空間を温存）。
// 搭載APIは map.gadget.profile()。本体が付いたら同じボタンへ本体のトグル(start/stop)が付き、スタブは abort で退場。
// ★frame hook（毎フレ再投影で球に追従）は core 側の frameHooks に触れる＝抽象アクセス opts.onBody(本体) 経由で本体到着後に配線。
import { gadgetStack } from "./stack.js";
import { tr } from "../i18n.js";
const t = tr({ "断面図（クリックで経路指定）": "Elevation profile (click a route)", "断面図": "Elevation profile" });

// 軸＋山なみグリフ（本体 profile.js と同一＝スタブがボタンを作る担当）。線色は本線インク直書き＝quiet-mono の夜節が自動反転。
const ICON = `
	<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
		<path d="M3.5 4v16h17"/>
		<path d="M5 17.5l4-8 3 3.5 4-6.5 3.5 11" stroke-width="1.6"/></svg>`;

export function profile(opts = {}) {
	const map = this, mapEl = this.mapEl;
	if (mapEl.querySelector("#profile-btn")) return () => {};   // 二重搭載は無害（作法の対称＝no-op を返す）
	const btn = document.createElement("button");
	btn.id = "profile-btn"; btn.dataset.tip = t("断面図（クリックで経路指定）"); btn.setAttribute("aria-label", t("断面図"));
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);

	let real = null;   // Promise<handle>＝一度だけ import して本体搭載（失敗時は null に戻して再挑戦可）
	const stub = new AbortController();   // 本体が付いたらスタブのリスナーを一括退場
	opts.signal && opts.signal.addEventListener("abort", () => stub.abort(), { once: true });   // destroy 時も退場
	const boot = () => real ||= import("./profile.js")
		.then(m => { const g = m.profile.call(map, { ...opts, btn }); stub.abort(); opts.onBody?.(g); return g; })   // 本体は持参 btn を再利用／onBody＝frame hook 配線を core へ委ねる
		.catch(e => { real = null; console.error("[profile] failed to load module", e); });
	let opening = false;   // 読み込み中の連打を一回に畳む（搭載後はスタブごと退場＝本体トグルが受ける）
	const activate = () => { if (opening) return; opening = true; boot().then(g => { opening = false; g && g.open?.(); }); };   // open＝経路指定モードON（start）
	btn.addEventListener("click", activate, { signal: stub.signal });
	// 戻り値＝no-op（作法の対称）＋制御ハンドル。open()＝本体到着→経路指定開始（本体handleを解決＝テスト/アプリが stats() を読める）。
	return Object.assign(() => {}, { open: () => boot().then(g => { g && g.open?.(); return g; }), close: () => real && real.then(g => g && g.close?.()) });
}
