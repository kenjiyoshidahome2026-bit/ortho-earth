// ガジェット：検査表示（maplibre-gl-inspect 相当・#174）の玄関スタブ。ボタンだけを常駐させ、本体（層の色・札・下地の切り替え＝inspect.js）は
// 初回クリックで一度だけ import()＝初期バンドルから隔離（measure-stub と同流儀・キー割当はなし＝単キー名前空間を温存）。
// 起動時から検査表示（showInspectMap）・通常表示のホバー札（showMapPopup）を頼まれた時はすぐ本体を載せる。
// showInspectButton:false＝ボタンを出さない（互換の MaplibreInspect は MapLibre の四隅に自前のボタンを持つ）。
// 戻り値＝制御ハンドル（open/close/toggle は本体の到着を待って Promise で返す・isOpen は同期）。
import { gadgetStack } from "./stack.ts";
import { tr } from "../i18n.js";
import type { InspectHandle, InspectOptions } from "../../globe.d.ts";
import type { GlobeMap } from "../types/map.ts";
import type { InspectInner } from "./inspect.ts";
const t = tr();

// 虫めがね＋タイルの格子（本体 inspect.js と同一＝スタブがボタンを作る担当）。線色は本線インク直書き＝quiet-mono の夜節が自動反転。
export const INSPECT_ICON = `
	<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
		<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.3 15.3L21 21"/>
		<path d="M7 8.8h7M7 12.2h7M8.8 7v7M12.2 7v7" stroke-width="1.1"/></svg>`;

/** 検査表示の入口（本体 inspect.ts は初回に読む）。ボタンつきの二重搭載は null */
export function inspect(this: GlobeMap, opts: InspectOptions & Omit<InspectInner, "btn"> = {} as InspectOptions & InspectInner): InspectHandle | null {
	const map = this, mapEl = this.mapEl;
	const withBtn = opts.showInspectButton !== false;
	if (withBtn && mapEl.querySelector("#inspect-btn")) return null;   // 二重搭載は無害（ボタンの無い搭載＝互換の口は何度でも）
	let btn: HTMLButtonElement | null = null;
	if (withBtn) {
		btn = document.createElement("button");
		btn.id = "inspect-btn"; btn.className = "qm-panel-btn"; btn.type = "button";
		btn.dataset.tip = t("Inspect vector tiles"); btn.setAttribute("aria-label", t("Inspect vector tiles")); btn.setAttribute("aria-pressed", "false");
		btn.innerHTML = INSPECT_ICON;
		gadgetStack(mapEl).append(btn);
	}
	let real: Promise<InspectHandle | null> | null = null, body: InspectHandle | null = null;   // real＝Promise<本体の手綱>（一度だけ import・失敗時は null に戻して再挑戦可）・body＝着いた手綱
	const stub = new AbortController();   // 本体が付いたらスタブのリスナーを一括退場
	opts.signal && opts.signal.addEventListener("abort", () => stub.abort(), { once: true });   // destroy 時も退場
	const boot = () => real ||= import("./inspect.ts")
		.then(m => { body = m.inspect.call(map, { ...opts, btn }); stub.abort(); return body; })   // 本体は持参 btn を再利用
		.catch(e => { real = null; console.error("[inspect] failed to load module", e); return null; });
	let opening = false;   // 読み込み中の連打を一回に畳む（搭載後はスタブごと退場＝本体が受ける）
	btn?.addEventListener("click", () => { if (opening) return; opening = true; boot().then(g => { opening = false; g?.toggle(); }); }, { signal: stub.signal });
	if (opts.showInspectMap || opts.showMapPopup) boot();   // 本体が自分で開く（showInspectMap）・通常表示の札を聞き始める
	// k は手綱の口の名前（下の 3 つだけ）。呼ぶ前に関数かを確かめる（動的な口の呼び出しの作法）
	const via = (k: "open" | "toggle" | "render") => (...a: unknown[]) => boot().then(g => g && typeof g[k] === "function" ? (g[k] as (...x: unknown[]) => Promise<unknown>)(...a) : null);
	return {
		open: via("open"), close: () => (real ? real.then(g => g?.close()) : Promise.resolve(null)), toggle: via("toggle"),
		toggleInspector: via("toggle"),   // maplibre-gl-inspect と同名
		render: via("render"),            // 層の台帳を読み直して検査の層を足す（source を足した後など）
		isOpen: () => !!body?.isOpen(),
		layers: () => body?.layers() ?? [],   // 検査の層の id（下から）
		sources: () => body?.sources() ?? [],   // 直近の層の台帳（source ごとの source-layer 一覧と出所）
		destroy: () => { stub.abort(); if (real) real.then(g => g?.destroy()); else btn?.remove(); },
	};
}
