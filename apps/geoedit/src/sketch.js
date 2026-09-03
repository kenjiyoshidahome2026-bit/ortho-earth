import { tr } from "../../ortho-japan/i18n.js";   // UI二言語化（ja正典・en辞書引き＝エンジン i18n.js の流儀。辞書は各モジュール持参）
const t = tr({
	"大きさがありません": "No size",
	"頂点が足りません": "Not enough vertices",
	"穴はポリゴンの内側に描いてください": "Draw the hole inside a polygon",
});
// 作図（スケッチ）：線/面/穴＝クリックで頂点を積んで Enter/ダブルクリックで確定、矩形/円＝2クリック。
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

	// ラバーバンドのカーソル頂点＋吸着マーク（矩形/円は確定形をプレビュー）
	mapEl.addEventListener("pointermove", e => {
		if (!st.sketch || st.drag) return;
		const [x, y] = ed.localXY(e);
		const ll = map.unprojectXY(x, y);
		if (!ll) return;
		st.sketch.cursor = ed.snapLL(ll);
		if (isTwoPoint(st.sketch.kind)) st.sketch.preview = twoPointRing(st.sketch.kind, st.sketch.coords[0], st.sketch.cursor);
		overlay.redraw();
	}, { capture: true, signal });
	mapEl.addEventListener("dblclick", e => {
		if (st.sketch) { e.stopPropagation(); e.preventDefault(); finish(); }
	}, { capture: true, signal });

	return { start, click, finish, cancel };
}
