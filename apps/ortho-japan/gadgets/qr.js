// ガジェット：現在の共有URL（今の視点＝カメラ+テーマ+レイヤ）を QR コードで画面に出す。オプトイン＝map.gadget.qr()。
// 用途＝発表でスクリーンに映す→観客がスマホでスキャン→「その視点そのまま」で開く＝プログラムの拡散が始まる。
//   PLATEAU の名シーンや任意座標系の14条筆など、URLに載る状態は全部そのまま渡る（[[url-display-state-consolidation]] の map.view/hash が土台）。
// QR は自作エンコーダ（qrcode.js・依存ゼロ・byteモード・EC L/M/Q/H 自動・v1〜6）。URLが短いほど強い訂正を自動採用＝中央の印を大きく置ける。
// カードは常に白地＝スキャンの掟（白背景+黒モジュール+四周のクワイエットゾーン）。テーマ（夜等）に依らず白。
import { gadgetStack } from "./stack.js";
import { qrEncode } from "./qrcode.js";

// QRらしいグリフ（3隅ファインダ＋数個のモジュール）。線色は本線インク直書き＝quiet-mono の夜節が自動反転（palette と同流儀）。
const ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="#3f4757" aria-hidden="true">
	<path d="M3 3h7v7H3V3zm2 2v3h3V5H5z"/><path d="M14 3h7v7h-7V3zm2 2v3h3V5h-3z"/><path d="M3 14h7v7H3v-7zm2 2v3h3v-3H5z"/>
	<rect x="14" y="14" width="2" height="2"/><rect x="19" y="14" width="2" height="2"/><rect x="17" y="17" width="2" height="2"/><rect x="14" y="19" width="2" height="2"/><rect x="19" y="19" width="2" height="2"/></svg>`;

// QR中央のサイン＝favicon（球＋経緯線＝独り地理院の印）。★ベクトルの <img> を canvas の上に重ねる＝pixelated 拡大の当事者外＝
// 画面でも印刷（名刺）でもエッジが鮮鋭（canvas に焼くと格子と一緒に粗く拡大されボケる）。canvas 側は印の下のモジュールを白ヌキする
// だけ（スキャン用）。色は #000 直書き固定＝白ヌキ上で最大コントラスト（名刺映え）＋public/favicon.svg の夜反転（白カードで消える）を回避。
const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" fill="none" stroke="#000" stroke-width="6">
	<ellipse cx="50" cy="50" rx="45" ry="45"/><ellipse cx="50" cy="50" rx="25" ry="45"/>
	<path d="M11 28H88 M11 72H88M50 5V95M5 50 H95"/></svg>`;
const MARK_URL = "data:image/svg+xml," + encodeURIComponent(MARK_SVG);

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
	panel.innerHTML = `<div class="qr-card"><div class="qr-wrap"><canvas aria-label="共有URLのQRコード"></canvas><img class="qr-mark" alt="" aria-hidden="true"></div><div class="qr-cap">スキャンで、この視点を開く</div><div class="qr-url"></div></div>`;
	mapEl.append(panel);   // 末尾append＝DOM順で最上面（z-index全廃の裁き）
	const canvas = panel.querySelector("canvas"), urlEl = panel.querySelector(".qr-url"), markEl = panel.querySelector(".qr-mark");
	markEl.src = MARK_URL;   // ベクトルの印（静的＝視点で変わらない）。寸法は render が白ヌキに合わせて設定

	const render = () => {
		const url = (getUrl?.() || location.href);
		try {
			const { matrix: m, ec } = qrEncode(url);   // 収まる中で最強の EC を自動採用＝中央ロゴの被覆余白を最大化
			const N = m.length, px = 8, quiet = 4, dim = (N + quiet * 2) * px;   // クワイエットゾーン4モジュール＝スキャンの掟
			canvas.width = dim; canvas.height = dim;
			const ctx = canvas.getContext("2d");
			ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, dim, dim);
			ctx.fillStyle = "#000";
			for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (m[r][c]) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
			// 中央の印の寸法＝EC 訂正能力から算定：覆えるモジュール数 ≈ 訂正能力の半分（余白確保）＝ k·k ≤ 2·ec を満たす最大の奇数。
			// 奇数化＝中心モジュールに対称に載る／下限5・上限は隅ファインダ帯に触れぬ範囲（N-14）。白ヌキは格子に吸着（半掛かりモジュールを作らない）。
			let k = Math.floor(Math.sqrt(2 * ec)); if (!(k & 1)) k--;
			k = Math.max(5, Math.min(k, N - 14)); if (!(k & 1)) k--;
			const kx = ((N - k) / 2 + quiet) * px, ko = k * px;   // N,k とも奇数→(N-k)/2 は整数＝格子にぴたり吸着
			ctx.fillStyle = "#fff"; ctx.fillRect(kx, kx, ko, ko);   // 印の下のモジュールを白ヌキ＝既知エラー（RS が訂正）
			// ベクトルの印を白ヌキに重ねる（内側1モジュールの白縁を残す）。%指定＝canvas表示サイズに追従・拡大/名刺印刷でも鮮鋭。
			markEl.style.width = (100 * (k - 2) / (N + quiet * 2)) + "%";
			urlEl.textContent = url;
		} catch (e) { markEl.style.width = "0"; urlEl.textContent = "QR化に失敗（URLが長すぎ？）"; console.warn("[qr]", e); }
	};
	const close = () => panel.classList.remove("open");
	btn.addEventListener("click", () => { if (panel.classList.toggle("open")) render(); });   // 開く度に「今の視点」で作り直す
	panel.addEventListener("click", e => { if (!e.target.closest(".qr-card")) close(); });   // カード外（背景）＝閉じる
	window.addEventListener("keydown", e => { if (e.key === "Escape" && panel.classList.contains("open")) { e.preventDefault(); close(); } }, { signal });
	return { open: () => { panel.classList.add("open"); render(); }, close };   // プログラム駆動用
}
