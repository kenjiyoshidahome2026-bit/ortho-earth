// ガジェット：共有QRの玄関スタブ。ボタンだけを常駐させ、本体（qr.js＝パネル描画＋自作QRエンコーダ qrcode.js 14KB）は
// 初回クリックで一度だけ import()＝初期バンドルから隔離。QRは「使う人が使う時に一度だけ」＝起動の一瞬に載せない。
// 搭載APIは従来どおり map.gadget.qr()。本体到着後は同じボタンへ自前リスナーを付け直し、スタブは abort で退場（二重発火なし）。
// ★ガジェット規約：独立モジュール＋（重ければ）小さな常駐スタブ＋本体は import()＝print/demo/ai と同じ型。
import { gadgetStack } from "./stack.js";

// QRらしいグリフ（本体 qr.js と同一＝スタブがボタンを作る担当）。線色は本線インク直書き＝quiet-mono の夜節が自動反転。
const ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="#3f4757" aria-hidden="true">
	<path d="M3 3h7v7H3V3zm2 2v3h3V5H5z"/><path d="M14 3h7v7h-7V3zm2 2v3h3V5h-3z"/><path d="M3 14h7v7H3v-7zm2 2v3h3v-3H5z"/>
	<rect x="14" y="14" width="2" height="2"/><rect x="19" y="14" width="2" height="2"/><rect x="17" y="17" width="2" height="2"/><rect x="14" y="19" width="2" height="2"/><rect x="19" y="19" width="2" height="2"/></svg>`;

export function qr(opts = {}) {
	const map = this, mapEl = this.mapEl;
	if (mapEl.querySelector("#qr-btn")) return;   // 二重搭載は無害
	const btn = document.createElement("button");
	btn.id = "qr-btn"; btn.dataset.tip = "この視点をQRで共有"; btn.setAttribute("aria-label", "現在の視点をQRコードで共有");
	btn.innerHTML = ICON;
	gadgetStack(mapEl).append(btn);

	let real = null;   // Promise<{open,close}>＝一度だけ import して本体搭載（失敗時は null に戻して再挑戦可）
	const stub = new AbortController();   // 本体が付いたらスタブのリスナーを一括退場
	opts.signal && opts.signal.addEventListener("abort", () => stub.abort(), { once: true });   // destroy 時も退場
	const boot = () => real ||= import("./qr.js")
		.then(m => { const g = m.qr.call(map, { ...opts, btn }); stub.abort(); return g; })   // 本体は持参 btn を再利用
		.catch(e => { real = null; console.error("[qr] 本体の読み込みに失敗", e); });
	let opening = false;   // 読み込み中の連打を一回に畳む（搭載後はスタブごと退場＝本体が受ける）
	const activate = () => { if (opening) return; opening = true; boot().then(g => { opening = false; g && g.open(); }); };
	btn.addEventListener("click", activate, { signal: stub.signal });
	return { open: () => boot().then(g => g && g.open()), close: () => real && real.then(g => g && g.close()) };
}
