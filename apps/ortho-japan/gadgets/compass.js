// ガジェット：コンパス兼リセット。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.compass() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// 3D（傾き or 回転）の時だけ表示。針は方位を指し、押すと水平・北向きへスッと戻る。
// 針の毎フレーム追従は本体 render のフック＝この関数が返す update を本体（app.js の登録側）が掴んで呼ぶ。
import { shortBearingOf } from "ortho-core";
import { gadgetStack } from "./stack.js";
import { keyBusy } from "./keys.js";
import { tr } from "../i18n.js";
const t = tr({
	"北向き・水平に戻す（N）": "Reset to north, level view (N)",
	"北向き・水平に戻す": "Reset to north, level view",
});
export function compass({ cancelFlight, onMove, signal } = {}) {
	const mapEl = this.mapEl, cam = this.cam;
	if (mapEl.querySelector("#reset")) return;   // 二重搭載は無害（搭載済みのまま）
	const btn = document.createElement("button");
	btn.id = "reset"; btn.dataset.tip = t("北向き・水平に戻す（N）"); btn.setAttribute("aria-label", t("北向き・水平に戻す"));
	btn.innerHTML = `
		<svg viewBox="0 0 40 40" width="26" height="26" aria-hidden="true">
			<polygon points="20,4 26,20 20,16.5 14,20" fill="#2b3b57"/>
			<polygon points="20,36 26,20 20,23.5 14,20" fill="#ffffff" stroke="#9aa0ac" stroke-width="1"/>
		</svg>`;
	// 置き場所はスタック（搭載順＝縦の並び）。2Dで display:none の間は流れから抜け、下のガジェットが上へ詰まる。
	gadgetStack(mapEl).append(btn);
	const svg = btn.querySelector("svg");
	const shortBearing = () => shortBearingOf(cam.bearing);   // 最短回転へ正規化（実装はengine）
	const reset = () => {
		cancelFlight?.();   // リセットアニメと喧嘩しない
		const p0 = cam.pitch, b0 = shortBearing(), t0 = performance.now(), dur = 700;   // 3D→2Dは少しゆっくり＝地面が起き上がる感覚を残す
		const step = () => {
			const k = Math.min(1, (performance.now() - t0) / dur), e = k * k * (3 - 2 * k);   // smoothstep
			cam.pitch = p0 * (1 - e); cam.bearing = b0 * (1 - e); onMove();
			if (k < 1) requestAnimationFrame(step);
			else { cam.pitch = 0; cam.bearing = 0; onMove(); }
		};
		requestAnimationFrame(step);
	};
	btn.addEventListener("click", reset);
	// N＝北向き・水平へリセット（修飾なし＝OS衝突を避けた選択）。入力欄フォーカス中は無効。
	window.addEventListener("keydown", e => {
		if (e.key !== "n" && e.key !== "N") return;
		if (e.ctrlKey || e.metaKey || e.altKey) return;   // 修飾つきは他操作に譲る
		if (keyBusy(mapEl)) return;
		e.preventDefault(); reset();
	}, { signal });
	return function update() {   // 3D（傾き or 回転）の時だけ表示・針を方位へ
		const is3D = cam.pitch > 0.005 || Math.abs(shortBearing()) > 0.005;
		btn.style.display = is3D ? "flex" : "none";
		if (is3D) svg.style.transform = `rotate(${-cam.bearing * 180 / Math.PI}deg)`;
	};
}
