// ガジェット：太陽系への口（ortho-solar）。星空圏（z<境界＝空の家具の圏）でだけ左上スタックに現れる。
// map.gadget.solar() で搭載（v1 ortho-map の gadget 作法＝this が map）。押すと ortho-solar へ同タブ遷移
// ＝履歴が残るので、あちらの「← Earth」出口（history.back）でこの視点そのままに帰ってこられる。
// 地図(天動説の劇場)と太陽系(地動説の劇場)の縫い目は URL＝アプリは疎のまま（プラットフォーム＝プロトコルの流儀）。
import { gadgetStack } from "./stack.js";
export function solar({ url, showBelow = 5 } = {}) {
	const mapEl = this.mapEl, cam = this.cam;
	if (mapEl.querySelector("#solar")) return;   // 二重搭載は無害（搭載済みのまま）
	// 行き先：本番＝同一オリジンの /solar/。開発＝solar の vite（別ポート）。opts.url で差し替え可
	const href = url ?? (["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:5199/" : "/solar/");
	// 見た目は紙のチップでなく星空家具の文字リンク（意匠は quiet-mono #solar＝sky-clock の血筋）。
	// 並びは太陽系の文字が上・日本の扉（#japan-btn）がその下（order は quiet-mono の world 節）
	const btn = document.createElement("button");
	btn.id = "solar"; btn.dataset.tip = "太陽系へ（ortho-solar）"; btn.setAttribute("aria-label", "太陽系へ");
	btn.textContent = "The Solar System";
	gadgetStack(mapEl).append(btn);
	btn.addEventListener("click", () => { location.href = href; });
	return function update() {   // 星空圏でだけ表示（コンパスの3D限定と同じ所作＝display:none で下が上へ詰まる）
		btn.style.display = cam.zoom < showBelow ? "flex" : "none";
	};
}
