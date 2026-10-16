// 同一フレームのオーバーレイの口（map.overlay・map.pickOverlays）＝createGlobe から切り出した（globe.js の分割 ①・2026-10-15）。
// 中身は切り出す前と同じ。createGlobe の他の所が使う物（worker の返事・撮影・queryRenderedFeatures・層イベント・destroy）は戻り値で返す。
//   mapEl・labelCanvas＝地図の器と注記の canvas／size＝描画の大きさ（device px・createGlobe が中身を書き換える同じ物）／wPost＝render worker へ送る
import type { OverlayHandle, OverlayPick } from "../../globe.d.ts";
import type { Installing, OverlaysDeps, OverlaysReturn, OverlayHit, OverlayFeature, SnapFrame, SnapOverlay } from "../types/install.ts";
import type { OverlaysApi } from "../types/map.ts";

export function installOverlays(map: Installing<OverlaysApi>, { mapEl, labelCanvas, size, wPost }: OverlaysDeps): OverlaysReturn {
	// 同一フレームのオーバーレイ（#13・2026-09-20）：レンダーワーカー内で地球・注記と同じ rAF・同じ cam で描く自前 canvas。
	// main の onFrame で描くと 1〜2 フレーム先行する（地球は worker の次の rAF）＝その根治。url＝worker が import() するモジュール
	//（依存ゼロ・{ init(canvas, opts), message(data), frame(cam, camState, size) → true=続きが要る, destroy() }）。
	// 戻り値＝{ post(data, transfer), onmessage, remove() }。post は worker 側で dirty を立てる＝描画要求を兼ねる。canvas は #c と #labels の間。
	// モジュールには host（requestDraw/post）と、frame には api（project/projectH＝makeProjector/makeProjectorH と同じ規約・地形は worker で同期）が渡る。
	const overlays = new Map<string, OverlayHandle>();
	// 一つのオーバーレイに載る層の id（W9・2026-10-12）＝id → オーバーレイの名前。plugin が一つの canvas（＝一つの WebGL 文脈）に多くの層を載せる口。
	// render worker の WebGL 文脈は Chrome で 4 つまで（地球が 1 つ使う）＝層ごとにオーバーレイを作ると 4 つ目で一番古い文脈（地球）が落ちる。
	// pick の答えに layer（この id）を入れると、統一 picking（map.on(ev, id)・queryRenderedFeatures({ layers:[id] })・pickOverlays の names）がその id で当たる。
	const ovLayerIds = new Map<string, string>();
	const isOv = (n: string) => overlays.has(n) || ovLayerIds.has(n);
	const pickWait = new Map<number, (hits: OverlayHit[]) => void>();   // seq → resolve（統一 picking の往復・下の map.pickOverlays）
	let pickSeq = 0;
	// スナップショットのオーバーレイ画素（worker は名前付きで返す）を画面の重ね順へ：DOM 順・注記より上（above）か下か・
	// 非表示（display:none 等＝画面に出ていない）は落とす。compose.js はこの順（below→注記→above）で重ねるだけ
	function orderSnapOverlays(d: SnapFrame): SnapFrame & { overlays: SnapOverlay[]; overlaysAbove: SnapOverlay[] } {
		const byName = new Map((d.overlays || []).map(o => [o.name, o]));
		const below: SnapOverlay[] = [], above: SnapOverlay[] = [];
		for (const cv of mapEl.querySelectorAll<HTMLCanvasElement>("canvas.overlay-gl")) {
			const o = byName.get(cv.dataset.overlay!);
			if (!o || overlays.get(o.name)?.el !== cv) continue;
			const cs = getComputedStyle(cv);   // 自身の display/visibility だけ見る（地図ごと隠れた撮影でも落とさない）
			if (cs.display === "none" || cs.visibility === "hidden") continue;
			(labelCanvas.compareDocumentPosition(cv) & Node.DOCUMENT_POSITION_FOLLOWING ? above : below).push(o);
		}
		return { ...d, overlays: below, overlaysAbove: above };
	}
	map.overlay = (src, { name, opts, above = false } = {}) => {   // src＝URL（依存ゼロのモジュール・?url）か { builtin: "anno" }（render worker のバンドル内）。above＝注記の canvas より上に重ねる（覆う画像・2026-09-21）
		name ??= "ov" + (overlays.size + 1);
		if (overlays.has(name) || ovLayerIds.has(name)) throw new Error(`overlay "${name}" already exists`);
		const cv = document.createElement("canvas");
		cv.className = "overlay-gl"; cv.dataset.overlay = name;
		cv.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none";
		cv.width = size.w; cv.height = size.h;
		if (above) labelCanvas.after(cv); else mapEl.insertBefore(cv, labelCanvas);   // 既定＝注記の下（地震・衛星など）／above＝注記の上（UI 家具は後ろの DOM＝さらに上のまま）
		const off = cv.transferControlToOffscreen();
		wPost({ type: "overlayAdd", name, ...(typeof src === "string" ? { url: new URL(src, location.href).href } : { builtin: src?.builtin }), canvas: off, opts }, [off]);
		const h: OverlayHandle = {
			name, el: cv, onmessage: null,   // onmessage＝worker 側モジュールの host.post(data) を受ける口
			post: (data, transfer) => { if (overlays.get(name) === h) wPost({ type: "overlayMsg", name, data }, transfer); },
			remove() { if (overlays.get(name) !== h) return; overlays.delete(name); for (const [id, n] of ovLayerIds) if (n === name) ovLayerIds.delete(id); wPost({ type: "overlayRemove", name }); cv.remove(); },
			addLayerId(id) {   // W9：このオーバーレイが描く層の id を名乗る（pick の答えの layer がこの id の物がこの id で当たる）
				id = String(id);
				if (overlays.has(id) || (ovLayerIds.has(id) && ovLayerIds.get(id) !== name)) throw new Error(`overlay layer id "${id}" already exists`);
				if (overlays.get(name) === h) ovLayerIds.set(id, name);
				return h;
			},
			removeLayerId(id) { if (ovLayerIds.get(String(id)) === name) ovLayerIds.delete(String(id)); return h; },
			pick: (x, y, radius) => map.pickOverlays(x, y, { radius, names: [name] }),   // このオーバーレイだけに当てる（統一 picking・PR-1）
		};
		overlays.set(name, h);
		return h;
	};
	// 統一 picking（deck.gl の onHover/onClick（object が返る）相当・deck.gl 差分 PR-1・2026-10-11）：
	//   map.pickOverlays(x, y, { radius=6, names })→Promise<[{ name, id, distance, lngLat, properties, … }]>（x, y, radius＝CSS px・手前のオーバーレイから）
	//   モジュールが pick(x, y, r, ctx) を持つ物だけ答える（points-gl・czml-draw・columnar の draw-gl…）。ctx＝render worker が最後に描いたフレームの cam＝描いた絵と同じ位置で当たる。
	//   層イベント（map.on("click"|"mousemove"|…, overlayName, cb)）と queryRenderedFeatures({ layers:[overlayName] }) にもこの答えが Feature の形（layer.id＝名前・source＝名前）で混ざる
	const overlayOrder = () => [...mapEl.querySelectorAll<HTMLCanvasElement>("canvas.overlay-gl")].reverse().map(c => c.dataset.overlay).filter((n): n is string => overlays.has(n!));   // DOM の後ろ＝上＝手前から
	map.pickOverlays = (x, y, { radius = 6, names } = {}) => new Promise<OverlayPick[]>(res => {
		// names＝オーバーレイの名前か、その上の層の id（addLayerId・W9）。層の id は持ち主のオーバーレイに問い、答えの layer で絞る
		const whole = new Set<string>(), sub = new Map<string, Set<string>>();   // 丸ごと問う名前／名前 → 絞る層の id
		for (const n of names ?? overlayOrder()) {
			if (overlays.has(n)) whole.add(n);
			else if (ovLayerIds.has(n)) { const o = ovLayerIds.get(n)!; if (!sub.has(o)) sub.set(o, new Set()); sub.get(o)!.add(n); }
		}
		const order = overlayOrder(), list = order.filter(n => whole.has(n) || sub.has(n));
		if (!list.length) return res([]);
		const seq = ++pickSeq, tm = setTimeout(() => { pickWait.delete(seq); res([]); }, 3000);
		pickWait.set(seq, hits => { clearTimeout(tm); res(hits.filter(h => whole.has(h.name) || sub.get(h.name)?.has(h.layer!))); });
		wPost({ type: "overlayPick", seq, x, y, r: radius, names: list });
	});
	const overlayFeature = (h: OverlayHit): OverlayFeature => ({ type: "Feature", id: h.id ?? null, geometry: h.lngLat ? { type: "Point", coordinates: h.lngLat } : null, properties: h.properties || {}, layer: { id: h.layer ?? h.name, type: "overlay" }, source: h.layer ?? h.name, overlay: { name: h.name, distance: h.distance, q: h.q, index: h.index } });   // layer＝一つのオーバーレイに載る層の id（W9）
	return { overlays, isOv, pickWait, orderSnapOverlays, overlayFeature };
}
