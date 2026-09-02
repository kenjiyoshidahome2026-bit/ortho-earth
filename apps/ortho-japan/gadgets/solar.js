// ガジェット：太陽系への口（ortho-solar）。34px規格のアイコン（2026-09-03 文字チップ"The Solar System"から改鋳＝
// アイコン配列の全z統一に伴い普通のガジェットへ。表示域を絞りたい画面は搭載時 opts.zoom=[min,max) で宣言＝
// プラットフォームが裁く。ガジェット自身は zoom を知らない）。
// map.gadget.solar() で搭載（v1 ortho-map の gadget 作法＝this が map）。押すと ortho-solar へ同タブ遷移
// ＝履歴が残るので、あちらの「← Earth」出口（history.back）でこの視点そのままに帰ってこられる。
// 地図(天動説の劇場)と太陽系(地動説の劇場)の縫い目は URL＝アプリは疎のまま（プラットフォーム＝プロトコルの流儀）。
import { gadgetStack } from "./stack.js";
import { tr, getLang } from "../i18n.js";
const t = tr({
	"太陽系へ（ortho-solar）": "To the Solar System (ortho-solar)",
	"太陽系へ": "To the Solar System",
});
export function solar({ url } = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#solar")) return;   // 二重搭載は無害（搭載済みのまま）
	// 行き先：本番＝同一オリジンの /solar/。開発＝solar の vite（別ポート）。opts.url で差し替え可
	// ?lang=＝今のUI言語をそのまま持たせる（solar 側の既定はブラウザ言語・?lang= で固定）
	const dest = url ?? (["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:5199/" : "/solar/");
	const href = dest + (dest.includes("?") ? "&" : "?") + "lang=" + getLang();
	const btn = document.createElement("button");
	btn.id = "solar"; btn.dataset.tip = t("太陽系へ（ortho-solar）"); btn.setAttribute("aria-label", t("太陽系へ"));
	// 土星のシルエット（塗り惑星＋傾いた環＝一目で宇宙。初案の「太陽+軌道+惑星の点」は18pxで目玉に見えた実測 2026-09-03）。
	// インクは他ガジェットと同じ #3f4757 属性直書き＝ui-dark の夜インク差し替えに自動で乗る。
	// 環の線は惑星の上を同色で横切る＝塗りと溶けて自然にシルエット化（白抜き線を別に描かない）
	btn.innerHTML = `
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.7" aria-hidden="true">
			<circle cx="12" cy="12" r="4.6" fill="#3f4757" stroke="none"/>
			<ellipse cx="12" cy="12" rx="10.2" ry="3.1" transform="rotate(-26 12 12)"/></svg>`;
	gadgetStack(mapEl).append(btn);   // 置き場所はスタック（搭載順＝縦の並び）
	btn.addEventListener("click", () => { location.href = href; });
	return btn;
}
