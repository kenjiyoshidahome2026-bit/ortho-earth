// ガジェット：画面保存（スクリーンショット）。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.shot() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// ★html2canvas は使わない。worker 越しの3層（基図#c・知性#gint・ラベル#labels＝各OffscreenCanvas）は
//   worker 内 readPixels で生ピクセルにして受け（createImageBitmap/transferToImageBitmap は headless GL で詰まる）、
//   main の2Dキャンバス層（#measure-lines＝距離/面積が焼いてある）を直接重ね、出典(attr)を焼き込んで1枚に合成→webp保存。
//   GL の生ピクセルは上下反転で来る＝合成時に flip して戻す。2D（ラベル/計測）はそのまま。
//   ※pop の引出線は箱(DOM)無しでは意味を成さない＝合成に含めない。DOM家具は html2canvas 無しでは焼けない割り切り。
// requestSnapshot＝{ W, H, render:{base,w,h,labels,lw,lh}, gint?:{base,w,h} } を返す（注入は登録側）。
import { gadgetStack } from "./stack.js";
import { keyBusy } from "./keys.js";
import { composeLayersToCanvas } from "./compose.js";   // 層重ねの実体は compose.js（shot/print/palette 共用）

// 出典の既定文（instruments.js の #attr と同義＝#attr が無い画面でもライセンス表記を残す）。
const DEFAULT_ATTR = [
	"出典：国土地理院最適化ベクトルタイル（提供実験）",
	"国土交通省 PLATEAU・JAXA AW3D30（各データを加工して作成）",
	"© 2026 Kenji Yoshida",
];

// 出典の文面（#attr があればその文面／無ければ既定）＝shot の焼き込みと print の下帯で共用。
export function attrLines(mapEl) {
	const el = mapEl.querySelector("#attr");
	return (el && el.innerText.trim() ? el.innerText : DEFAULT_ATTR.join("\n")).split(/\n/).map(t => t.trim()).filter(Boolean);
}

export function shot({ requestSnapshot, signal } = {}) {
	const mapEl = this.mapEl;
	// モバイル（タッチ端末）はボタンごと出さない＝端末標準のスクリーンショットに委ねる（家具を増やさない）。
	if (window.matchMedia("(pointer: coarse)").matches) return;
	if (mapEl.querySelector("#shot-btn")) return;   // 二重搭載は無害
	const mac = /Mac|iP(hone|ad|od)/.test(navigator.platform || "");
	const keyLabel = mac ? "⌘S" : "Ctrl+S";   // ショートカット表記（低解像度でボタンが隠れても撮れる手綱）
	const btn = document.createElement("button");
	btn.id = "shot-btn"; btn.dataset.tip = `画面を画像で保存 (${keyLabel})`; btn.setAttribute("aria-label", "画面を画像で保存");
	btn.innerHTML = `
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
			<path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/>
			<circle cx="12" cy="13" r="3.4"/></svg>`;
	gadgetStack(mapEl).append(btn);
	btn.addEventListener("click", capture);
	// ショートカット＝⌘/Ctrl+S（ブラウザの「ページ保存」を画面保存へ転用）。低解像度でスタックが溢れボタンが隠れても撮れる。
	// 入力欄（検索等）フォーカス中は無効＝そちらの操作を邪魔しない。
	window.addEventListener("keydown", e => {
		if (!((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "s" || e.key === "S"))) return;
		if (keyBusy(mapEl)) return;
		e.preventDefault(); capture();
	}, { signal });
	return { composite };   // 制御ハンドル（composite＝合成器。テスト/プログラムから合成だけ叩ける）

	async function capture() {
		if (btn.disabled) return;
		btn.disabled = true; btn.classList.add("busy");
		try { save(await composite(await requestSnapshot())); }
		catch (e) { console.error("[shot] 保存に失敗", e); }
		finally { btn.disabled = false; btn.classList.remove("busy"); }
	}

	// 各層を1枚へ合成→webp Blob。層重ね（基図→知性→ラベル→計測）は composeLayersToCanvas（printと共用）。
	async function composite(snap) {
		const out = composeLayersToCanvas(snap, mapEl.querySelector("#measure-lines"));
		drawAttr(out.getContext("2d"), snap.W, snap.H);
		return out.convertToBlob({ type: "image/webp", quality: 0.92 });
	}

	function drawAttr(ctx, W, H) {   // 右下に出典を焼き込む（文面は attrLines＝printの下帯と共用）。白文字＋暗い帯で可読性を担保
		const lines = attrLines(mapEl);
		const dpr = W / mapEl.clientWidth || 1;   // canvas は device px＝表示px比で文字を拡大
		const fs = Math.round(11 * dpr), pad = Math.round(6 * dpr), lh = Math.round(fs * 1.4), gap = Math.round(8 * dpr);
		ctx.font = `${fs}px system-ui, sans-serif`; ctx.textAlign = "right"; ctx.textBaseline = "bottom";
		const wMax = Math.max(...lines.map(t => ctx.measureText(t).width));
		const boxH = lh * lines.length + pad, boxW = wMax + pad * 2;
		ctx.fillStyle = "rgba(10,16,33,.55)";
		ctx.fillRect(W - boxW - gap, H - boxH - gap, boxW, boxH);
		ctx.fillStyle = "rgba(255,255,255,.92)";
		lines.forEach((t, i) => ctx.fillText(t, W - gap - pad, H - gap - pad / 2 - (lines.length - 1 - i) * lh));
	}

	function save(blob) {   // デスクトップ専用（モバイルは非搭載）＝<a download> でそのまま保存
		const url = URL.createObjectURL(blob);
		const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
		const a = document.createElement("a"); a.href = url; a.download = `ortho-japan-${stamp}.webp`;
		document.body.appendChild(a); a.click(); a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 4000);
	}
}
