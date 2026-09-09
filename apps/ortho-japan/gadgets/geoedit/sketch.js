import { tr } from "../../i18n.js";   // UI二言語化（ja正典・en辞書引き＝エンジン i18n.js の流儀。辞書は各モジュール持参）
const t = tr({
	"大きさがありません": "No size",
	"頂点が足りません": "Not enough vertices",
	"穴はポリゴンの内側に描いてください": "Draw the hole inside a polygon",
});
// 作図（スケッチ）：線/面/穴＝クリックで頂点を積んで Enter/ダブルクリックで確定、矩形/円＝2クリック、
// フリーハンド（free）＝pointerdown で掴んで軌跡を積み pointerup で確定（クリックでなくドラッグ＝editClick を通らない）。
// 状態は st.sketch = { kind, coords, cursor, preview? }（描くのは overlay）。確定は doCmd("add"/"hole") → 選択ツールへ復帰。
// クリック自体は editClick スロット（エンジンの4px裁定済み）から click(tool, ll) で入る。

// 矩形/円のリング生成（円＝36角形・経度は cos(lat) 補正＝画面上で円に見える）
export const twoPointRing = (kind, a, b) => {
	if (kind === "rect") return [a, [b[0], a[1]], b, [a[0], b[1]], a];
	const k = Math.max(0.2, Math.cos(a[1] * Math.PI / 180));
	const r = Math.hypot((b[0] - a[0]) * k, b[1] - a[1]);
	if (r <= 0) return null;
	const ring = [];
	for (let i = 0; i <= 36; i++) { const t = i / 36 * Math.PI * 2; ring.push([a[0] + r * Math.cos(t) / k, a[1] + r * Math.sin(t)]); }
	return ring;
};
const isTwoPoint = kind => kind === "rect" || kind === "circle";

// フリーハンドの間引き＝Douglas-Peucker（画面px）。保持する添字のマスクを返す（coords と xy は同添字）
const rdpKeep = (xy, eps) => {
	const keep = new Uint8Array(xy.length);
	keep[0] = keep[xy.length - 1] = 1;
	const stack = [[0, xy.length - 1]];
	while (stack.length) {
		const [a, b] = stack.pop();
		if (b - a < 2) continue;
		const [ax, ay] = xy[a], [bx, by] = xy[b];
		const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
		let best = -1, bd = eps;
		for (let i = a + 1; i < b; i++) {
			const d = Math.abs((xy[i][0] - ax) * dy - (xy[i][1] - ay) * dx) / len;
			if (d > bd) { bd = d; best = i; }
		}
		if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
	}
	return keep;
};
const FREE_SAMPLE_PX = 2;    // ストローク採取の最小移動
const FREE_SIMPLIFY_PX = 1.2; // 間引き許容（画面px）
const FREE_CLOSE_PX = 16;     // 始点にこれ以内で離すと面

export function createSketch(ed) {
	const { st, map, mapEl, signal, overlay, layer, toast, drawDefaults } = ed;

	const start = (kind, ll) => { st.sketch = { kind, coords: ll ? [ed.snapLL(ll)] : [], cursor: null }; overlay.redraw(); };   // 右クリック「ここから〜」＝1点目込みで開始
	const click = (kind, ll) => {   // editClick からの1打
		if (isTwoPoint(kind)) {   // 2点作図：1打目=基点、2打目=確定
			if (!st.sketch) return start(kind, ll);
			return finishTwoPoint(st.sketch.coords[0], ed.snapLL(ll));
		}
		if (!st.sketch) st.sketch = { kind, coords: [], cursor: null };   // line / polygon / hole＝頂点追加
		st.sketch.coords.push(ed.snapLL(ll));
		overlay.redraw();
	};
	const cancel = () => { if (st.sketch) { st.sketch = null; st.snapMark = null; overlay.redraw(); } };

	function finishTwoPoint(a, b) {
		const ring = twoPointRing(st.sketch.kind, a, b);
		st.sketch = null; st.snapMark = null;
		if (!ring || (ring[0][0] === ring[2][0] && ring[0][1] === ring[2][1]) || ring[0][0] === ring[1][0] || ring[0][1] === ring[3][1]) { overlay.redraw(); return toast(t("大きさがありません")); }   // 縮退（幅/高さゼロも）
		const cmd = { op: "add", feature: { type: "Feature", properties: { ...drawDefaults.polygon }, geometry: { type: "Polygon", coordinates: [ring] } } };
		ed.doCmd(cmd);
		ed.setTool("select");
		ed.select(cmd.eid);
	}
	function finish() {
		const sk = st.sketch;
		if (!sk) return;
		st.sketch = null; st.snapMark = null;
		if (sk.kind === "line" ? sk.coords.length < 2 : sk.coords.length < 3) { overlay.redraw(); return toast(t("頂点が足りません")); }
		if (sk.kind === "hole") {   // 穴＝描いたリングを「その1点目を含むポリゴン」の内環として追加（gint識別で対象決定）
			const eid = layer.identify(sk.coords[0][0], sk.coords[0][1], map.getZoom());
			const f = eid != null ? st.model.feats.get(eid) : null;
			if (!f || !f.type.includes("Poly")) { overlay.redraw(); return toast(t("穴はポリゴンの内側に描いてください")); }
			ed.doCmd({ op: "hole", eid, ring: sk.coords });
			ed.setTool("select");
			ed.select(eid);
			return;
		}
		const geometry = sk.kind === "line"
			? { type: "LineString", coordinates: sk.coords }
			: { type: "Polygon", coordinates: [[...sk.coords, sk.coords[0]]] };
		const cmd = { op: "add", feature: { type: "Feature", properties: { ...drawDefaults[sk.kind] }, geometry } };
		ed.doCmd(cmd);
		ed.setTool("select");   // 描いたら即整える＝選択ツールへ自動復帰（点ツールは連続配置のため残す）
		ed.select(cmd.eid);     // setTool の後＝選択パネルが開く
	}

	// フリーハンドの確定：間引き→始点回帰なら面/それ以外は線。ツールは free のまま＝連続ストローク（点ツールと同じ流儀）
	function finishFree() {
		const sk = st.sketch;
		st.sketch = null;
		if (!sk || sk.xy.length < 2) return overlay.redraw();   // クリックだけ＝何も描かない
		const keep = rdpKeep(sk.xy, FREE_SIMPLIFY_PX);
		const coords = sk.coords.filter((_, i) => keep[i]);
		const [ax, ay] = sk.xy[0], [bx, by] = sk.xy[sk.xy.length - 1];
		const closed = coords.length >= 3 && Math.hypot(bx - ax, by - ay) < FREE_CLOSE_PX;
		const geometry = closed
			? { type: "Polygon", coordinates: [[...coords, coords[0]]] }
			: { type: "LineString", coordinates: coords };
		const cmd = { op: "add", feature: { type: "Feature", properties: { ...drawDefaults[closed ? "polygon" : "line"] }, geometry } };
		ed.doCmd(cmd);
		ed.select(cmd.eid);
	}
	// フリーハンドの掴み始め＝capture-phase でエンジンから奪う（drag.js と同じ流儀＝パンは発火しない）。
	// 選択中フィーチャのハンドル命中は譲る（「作図ツールのまま頂点が動かせない」罠の根治 8/20 を free でも守る）。
	mapEl.addEventListener("pointerdown", e => {
		if (st.tool !== "free" || st.busy || !st.model || st.drag || st.sketch || e.shiftKey || e.button !== 0) return;
		const [x, y] = ed.localXY(e);
		if (st.selection != null && overlay.handleAt(x, y, e.pointerType === "touch")) return;   // ハンドルは drag.js へ
		const ll = map.unprojectXY(x, y);
		if (!ll) return;
		e.stopPropagation(); e.preventDefault();
		try { mapEl.setPointerCapture(e.pointerId); } catch { /* 合成イベント（試験）は capture 不可＝move/up は mapEl で拾えるので無害 */ }
		st.sketch = { kind: "free", coords: [ll], xy: [[x, y]], cursor: null, pointerId: e.pointerId };
		overlay.redraw();
	}, { capture: true, signal });
	mapEl.addEventListener("pointerup", e => {
		if (st.sketch?.kind === "free" && e.pointerId === st.sketch.pointerId) { e.stopPropagation(); finishFree(); }
	}, { capture: true, signal });
	mapEl.addEventListener("pointercancel", e => {
		if (st.sketch?.kind === "free" && e.pointerId === st.sketch.pointerId) cancel();   // ジェスチャに奪われた＝描き捨て
	}, { capture: true, signal });

	// ラバーバンドのカーソル頂点＋吸着マーク（矩形/円は確定形をプレビュー）
	mapEl.addEventListener("pointermove", e => {
		if (!st.sketch || st.drag) return;
		const [x, y] = ed.localXY(e);
		const ll = map.unprojectXY(x, y);
		if (!ll) return;
		if (st.sketch.kind === "free") {   // ストローク中＝一定以上動いた点だけ積む（間引きの前段）
			if (e.pointerId !== st.sketch.pointerId) return;
			e.stopPropagation();
			const last = st.sketch.xy[st.sketch.xy.length - 1];
			if (Math.hypot(x - last[0], y - last[1]) < FREE_SAMPLE_PX) return;
			st.sketch.xy.push([x, y]);
			st.sketch.coords.push(ll);
			overlay.redraw();
			return;
		}
		st.sketch.cursor = ed.snapLL(ll);
		if (isTwoPoint(st.sketch.kind)) st.sketch.preview = twoPointRing(st.sketch.kind, st.sketch.coords[0], st.sketch.cursor);
		overlay.redraw();
	}, { capture: true, signal });
	mapEl.addEventListener("dblclick", e => {
		if (st.sketch) { e.stopPropagation(); e.preventDefault(); finish(); }
	}, { capture: true, signal });

	return { start, click, finish, cancel };
}
