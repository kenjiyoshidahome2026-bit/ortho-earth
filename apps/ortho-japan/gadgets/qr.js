// ガジェット：現在の共有URL（今の視点＝カメラ+テーマ+レイヤ）を QR コードで画面に出す。オプトイン＝map.gadget.qr()。
// 用途＝発表でスクリーンに映す→観客がスマホでスキャン→「その視点そのまま」で開く＝プログラムの拡散が始まる。
//   PLATEAU の名シーンや任意座標系の14条筆など、URLに載る状態は全部そのまま渡る（[[url-display-state-consolidation]] の map.view/hash が土台）。
// QR は自作エンコーダ（qrcode.js・依存ゼロ・byteモード・EC-L・v1〜6）。共有URLは概ね 50〜110字＝収まる。
// カードは常に白地＝スキャンの掟（白背景+黒モジュール+四周のクワイエットゾーン）。テーマ（夜等）に依らず白。
import { gadgetStack } from "./stack.js";
import { qrMatrix } from "./qrcode.js";

// QRらしいグリフ（3隅ファインダ＋数個のモジュール）。線色は本線インク直書き＝quiet-mono の夜節が自動反転（palette と同流儀）。
const ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="#3f4757" aria-hidden="true">
	<path d="M3 3h7v7H3V3zm2 2v3h3V5H5z"/><path d="M14 3h7v7h-7V3zm2 2v3h3V5h-3z"/><path d="M3 14h7v7H3v-7zm2 2v3h3v-3H5z"/>
	<rect x="14" y="14" width="2" height="2"/><rect x="19" y="14" width="2" height="2"/><rect x="17" y="17" width="2" height="2"/><rect x="14" y="19" width="2" height="2"/><rect x="19" y="19" width="2" height="2"/></svg>`;

// opts.getUrl＝現在の共有URL文字列を返す（app が注入＝location.origin+pathname+viewHash()＝常に「今の視点」）。無ければ location.href。
export function qr({ getUrl, signal, btn } = {}) {
	const mapEl = this.mapEl;
	if (!btn) {   // 直搭載（qr-stub 非経由＝単体でも動く＝独立）＝自前でボタン生成。stub 経由は btn 持参で再利用
		if (mapEl.querySelector("#qr-btn")) return;   // 二重搭載は無害
		btn = document.createElement("button");
		btn.id = "qr-btn"; btn.dataset.tip = "この視点をQRで共有"; btn.setAttribute("aria-label", "現在の視点をQRコードで共有");
		btn.innerHTML = ICON;
		gadgetStack(mapEl).append(btn);   // 置き場所はスタック（搭載順＝縦の並び）
	}

	const panel = document.createElement("div");
	panel.id = "qr-panel";
	panel.innerHTML = `<div class="qr-card"><canvas aria-label="共有URLのQRコード"></canvas><div class="qr-cap">スキャンで、この視点を開く</div><div class="qr-url"></div></div>`;
	mapEl.append(panel);   // 末尾append＝DOM順で最上面（z-index全廃の裁き）
	const canvas = panel.querySelector("canvas"), urlEl = panel.querySelector(".qr-url");

	const render = () => {
		const url = (getUrl?.() || location.href);
		try {
			const m = qrMatrix(url);
			const px = 8, quiet = 4, dim = (m.length + quiet * 2) * px;   // クワイエットゾーン4モジュール＝スキャンの掟
			canvas.width = dim; canvas.height = dim;
			const ctx = canvas.getContext("2d");
			ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, dim, dim);
			ctx.fillStyle = "#000";
			for (let r = 0; r < m.length; r++) for (let c = 0; c < m.length; c++) if (m[r][c]) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
			urlEl.textContent = url;
		} catch (e) { urlEl.textContent = "QR化に失敗（URLが長すぎ？）"; console.warn("[qr]", e); }
	};
	const close = () => panel.classList.remove("open");
	btn.addEventListener("click", () => { if (panel.classList.toggle("open")) render(); });   // 開く度に「今の視点」で作り直す
	panel.addEventListener("click", e => { if (!e.target.closest(".qr-card")) close(); });   // カード外（背景）＝閉じる
	window.addEventListener("keydown", e => { if (e.key === "Escape" && panel.classList.contains("open")) { e.preventDefault(); close(); } }, { signal });
	return { open: () => { panel.classList.add("open"); render(); }, close };   // プログラム駆動用
}
