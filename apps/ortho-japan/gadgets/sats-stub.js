// ガジェット：人工衛星（いま軌道にいる衛星）の玄関スタブ。ボタンだけを常駐させ、本体（軌道要素の取得＋SGP4/SDP4 伝播＋
// 専用 canvas 描画＝sats.js）は初回クリックで一度だけ import()＝初期バンドルから隔離（measure-stub と同じ作法）。
// ★frame hook（カメラが動いた時の再投影）は core 側の frameHooks に触れる＝抽象アクセス opts.onBody(本体) 経由で本体到着後に配線。
import { gadgetStack } from "./stack.js";
import { tr } from "../i18n.js";
const t = tr();

// 軌道グリフ（本体と共有＝スタブがボタンを作る担当）：左下の地球＋右上へ広がる 2 本の軌道の弧＋弧の上の衛星の点。
// 初案（円＋傾いた輪＋点）は真上の太陽系ボタン（土星）と見分けが付かなかった（実測 2026-09-19）＝輪を捨てて「地球のまわりの層」を描く。
// stac の「衛星本体＋パネル」グリフとも別物。線色は本線インク直書き＝夜節が自動反転（点の塗りは on で白＝quiet-mono #sats-btn）。
export const ICON = `
	<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
		<circle cx="7" cy="17" r="4"/>
		<path d="M7 9.5A7.5 7.5 0 0 1 14.5 17"/>
		<path d="M7 4A13 13 0 0 1 20 17"/>
		<circle cx="13.5" cy="13.25" r="1.7" fill="#3f4757" stroke="none"/>
		<circle cx="13.5" cy="5.74" r="1.7" fill="#3f4757" stroke="none"/></svg>`;

export function sats(opts = {}) {
	const map = this, mapEl = this.mapEl;
	if (mapEl.querySelector("#sats-btn")) return () => {};   // 二重搭載は無害
	const btn = document.createElement("button");
	btn.id = "sats-btn"; btn.dataset.tip = t("Satellites in orbit now"); btn.setAttribute("aria-label", t("Satellites in orbit now"));
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);

	let real = null;   // Promise<handle>＝一度だけ import（失敗時は null に戻して再挑戦可）
	const stub = new AbortController();   // 本体が付いたらスタブのリスナーを退場（以後は本体のトグルが受ける）
	opts.signal && opts.signal.addEventListener("abort", () => stub.abort(), { once: true });
	const boot = () => real ||= import("./sats.js")
		.then(m => { const g = m.sats.call(map, { ...opts, btn }); stub.abort(); opts.onBody?.(g); return g; })
		.catch(e => { real = null; console.error("[sats] failed to load module", e); });
	let opening = false;
	btn.addEventListener("click", () => {
		if (opening) return; opening = true;
		boot().then(g => { opening = false; g && g.open(); });
	}, { signal: stub.signal });
	return Object.assign(() => {}, { open: () => boot().then(g => { g && g.open(); return g; }), close: () => real && real.then(g => g && g.close()) });
}
