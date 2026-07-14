// ガジェット：ズーム＋/−。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.zoom() で搭載する（v1 ortho-map の gadget 作法＝this が map）。
// cam.zoom を整数段へ smoothstep で寄せる（compass と同じ rAF アニメ＝onMove を毎フレ叩く）。
// 内部の手綱（フライト中断・onMove・z範囲）は本体が app.js の登録側で注入。
// 縦2連の一体ボタン（＋上・−下）＝チップと同じ隣接ボーダー共有の意匠。置き場所はスタック。
import { gadgetStack } from "./stack.js";
export function zoom({ cancelFlight, onMove, zoomMin = 1, zoomMax = 20, signal } = {}) {
	const mapEl = this.mapEl, cam = this.cam;
	if (mapEl.querySelector("#zoom")) return;   // 二重搭載は無害（搭載済みのまま）
	const box = document.createElement("div");
	box.id = "zoom";
	box.innerHTML = `
		<button id="zoom-in" data-tip="拡大（⇧↑）" aria-label="拡大（ズームイン）">＋</button>
		<button id="zoom-out" data-tip="縮小（⇧↓）" aria-label="縮小（ズームアウト）">−</button>`;
	// 置き場所はスタック（搭載順＝縦の並び）。
	gadgetStack(mapEl).append(box);
	let raf = 0;
	const glide = delta => {
		cancelFlight?.();   // フライトと喧嘩しない
		if (raf) cancelAnimationFrame(raf);   // 連打は今の到達点から次段へ（アニメを積まない）
		const z0 = cam.zoom;
		// v1 と同じ段取り＝端数があっても必ず「次の整数」へ寄る（in=floor(z+1) / out=ceil(z-1)）
		const z1 = Math.max(zoomMin, Math.min(zoomMax, delta > 0 ? Math.floor(z0 + 1) : Math.ceil(z0 - 1)));
		if (z1 === z0) return;
		const t0 = performance.now(), dur = 260;
		const step = () => {
			const k = Math.min(1, (performance.now() - t0) / dur), e = k * k * (3 - 2 * k);   // smoothstep
			cam.zoom = z0 + (z1 - z0) * e; onMove();
			raf = k < 1 ? requestAnimationFrame(step) : 0;
		};
		raf = requestAnimationFrame(step);
	};
	box.querySelector("#zoom-in").addEventListener("click", () => glide(+1));
	box.querySelector("#zoom-out").addEventListener("click", () => glide(-1));
	// キーボードのズームは createInput（⇧+↑↓＝連続ズーム）が担う＝ここはボタンの段送りだけ。
	// （旧・矢印単独ズームは廃止。矢印単独はパンへ／signal は将来のリスナー用に受けたまま）
	return box;
}
