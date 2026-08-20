// 編集コントローラ＝状態機械と結線の中枢。
//   idle/selected → dragVertex（capture-phase pointerdown でハンドルを掴む＝エンジンのパンは発火しない）
//   point/line/polygon → editClick スロット経由の作図（クリックvs.ドラッグ弁別は input.js の4px裁定に任せる）
// コミット頻度＝頂点数で二段（<10万: drag-end 300ms デバウンス / ≥10万: アイドル2s or 明示操作）。
// 構造操作（add/del）→ Worker/同期のトポロジ再抽出（デバウンス）＝頂点吸着の共有化・arc分割を回復。
import { buildTopology } from "./topo-extract.js";
import { createModel, adoptRebuilt, rebuildModel, topoFromTransfer, topoToTransfer } from "./model.js";
import { createHistory } from "./history.js";
import { createGintLayer } from "./gint-layer.js";
import { createOverlay } from "./overlay.js";
import { initToolbar } from "./toolbar.js";
import { initDrop, exportPanel, idbSave, idbLoad, idbClear } from "./io.js";
import { createPropsPanel } from "./properties.js";
import { geopbf } from "geopbf";

const BIG = 100_000;          // これ以上の頂点数＝コミットをアイドル寄せ
const SYNC_REBUILD = 200_000; // これ未満＝再抽出は main 同期（Worker往復より速い）

export function initEditor(map) {
	const mapEl = map.mapEl;
	const ac = new AbortController(), signal = ac.signal;
	const st = { model: null, selection: null, dragEids: null, hidden: null, sketch: null, snapMark: null, busy: false };
	const hist = createHistory();
	const layer = createGintLayer(map);
	const overlay = createOverlay(map, mapEl, () => st);
	let tool = "select", gridExp = 6;
	let editGen = 0;   // 編集世代＝「このコミットは最新の編集を含むか」の判定（含むなら隠し/オーバレイを引き継ぐ）
	// 作図ツールの既定スタイル（=「次に描くもの」の@プロパティ。styleform が toolbar 経由で書く）
	const drawDefaults = { point: {}, text: { "@text": "テキスト" }, line: {}, polygon: {} };
	const mergeProps = (cur, partial) => {
		const next = { ...cur };
		for (const [k, v] of Object.entries(partial)) { if (v === "" || v == null) delete next[k]; else next[k] = v; }
		return next;
	};

	// ---- トースト ----
	let toastEl = null, toastT = 0;
	const toast = msg => {
		if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "ge-toast"; mapEl.append(toastEl); }
		toastEl.textContent = msg;
		toastEl.classList.remove("gone");
		clearTimeout(toastT);
		toastT = setTimeout(() => toastEl.classList.add("gone"), 2600);
	};

	// ---- Worker（構築/再抽出）----
	let worker = null, reqId = 0;
	const pending = new Map();
	const callWorker = (msg, transfer = []) => new Promise((res, rej) => {
		if (!worker) {
			worker = new Worker(new URL("./model-worker.js", import.meta.url), { type: "module" });
			worker.onmessage = e => {
				const p = pending.get(e.data.id);
				if (!p) return;
				pending.delete(e.data.id);
				e.data.ok ? p.res(e.data.payload) : p.rej(new Error(e.data.error));
			};
		}
		const id = ++reqId;
		pending.set(id, { res, rej });
		worker.postMessage({ id, ...msg }, transfer);
	});

	// ---- コミット（確定層＋自動保存）----
	let commitTimer = 0;
	const scheduleCommit = force => {
		clearTimeout(commitTimer);
		const big = st.model && st.model.stats().vertices >= BIG;
		commitTimer = setTimeout(commit, force ? 0 : big ? 2000 : 300);
	};
	async function commit(moveCamera = false) {
		if (!st.model) return;
		const genAt = editGen;
		const done = await layer.commit(st.model, { moveCamera });
		// 新gintが「この時点までの編集」を含んで着地＝隠し/オーバレイの役目をここで初めて引き継ぐ
		//（旧実装はドラッグ終端で即解除＝コミット着地までの間「前のデータ」が顔を出していた＝本人指摘 8/20）
		if (done && editGen === genAt && !drag) {
			layer.unhide();
			st.dragEids = null; st.hidden = null;
			overlay.redraw();
		}
		if (layer.pbf?.arrayBuffer) idbSave({ buf: layer.pbf.arrayBuffer, gridExp, view: map.view?.hash, t: Date.now() });
	}

	// ---- 再抽出（構造操作の後始末＝共有回復）----
	let rebuilding = false, rebuildQueued = false;
	async function rebuild() {
		if (!st.model) return;
		if (rebuilding) { rebuildQueued = true; return; }
		rebuilding = true;
		try {
			if (st.model.stats().vertices < SYNC_REBUILD) st.model = rebuildModel(st.model);
			else {
				st.busy = true; toast("トポロジ再抽出中…");
				const { payload: out, transfer } = topoToTransfer(st.model, { snap: false });   // 送り便＝基底ソート不要
				const res = await callWorker({ mode: "retopo", payload: out, gridExp: st.model.gridExp }, transfer);
				st.model = adoptRebuilt(topoFromTransfer(res), res.eids, st.model);
				st.busy = false;
			}
		} catch (e) { console.error("[geoedit] rebuild failed", e); st.busy = false; }
		rebuilding = false;
		if (rebuildQueued) { rebuildQueued = false; return rebuild(); }
		overlay.redraw();
	}

	// ---- 読み込み（fc → モデル → コミット）----
	async function finishLoad(model, { fly = true, stripEid = false } = {}) {
		if (stripEid) for (const f of model.feats.values()) if (f.properties && "__eid" in f.properties) { const p2 = { ...f.properties }; delete p2.__eid; f.properties = p2; }   // 復元＝コミット時に注入した__eidを剥がす
		st.model = model;
		for (const w of model.warnings) console.warn("[geoedit]", w);
		hist.clear();
		st.selection = null; st.sketch = null;
		await commit(fly && model.feats.size > 0);
		const stat = model.stats();
		if (stat.features) toast(`読込完了：${stat.features}フィーチャ・${stat.arcs}arc・${stat.vertices}頂点`);
		bar.syncHist(hist.canUndo, hist.canRedo);
	}
	async function loadFC(fc, { fly = true } = {}) {   // GeoJSON入口（試験・API互換。大規模の正規経路は loadBuffer）
		try {
			st.busy = true;
			const n = fc.features.length;
			if (n) toast(`トポロジ抽出中…（${n}フィーチャ）`);
			const model = n >= 2000
				? createModel(topoFromTransfer(await callWorker({ mode: "fc", fc, gridExp })))
				: createModel(buildTopology(fc, gridExp));
			await finishLoad(model, { fly });
		} catch (e) { console.error("[geoedit] load failed", e); toast("読み込みに失敗しました"); }
		finally { st.busy = false; overlay.redraw(); }
	}
	async function loadBuffer(buffer, { fly = true, stripEid = false } = {}) {   // geopbfバイト列＝正規経路（GeoJSON中間なし）
		try {
			st.busy = true;
			toast("トポロジ抽出中…");
			const model = createModel(topoFromTransfer(await callWorker({ mode: "pbf", buffer, gridExp }, [buffer])));
			await finishLoad(model, { fly, stripEid });
		} catch (e) { console.error("[geoedit] load failed", e); toast("読み込みに失敗しました"); }
		finally { st.busy = false; overlay.redraw(); }
	}
	async function importFile(file) {
		try {
			toast(`変換中… ${file.name}`);
			const pbf = await geopbf(file, { name: "drop/" + file.name });   // 任意形式→geopbfバイト列（デコードworker）。.geojson は呼ばない
			if (!pbf) return toast("対応していない形式です");
			const buffer = pbf.arrayBuffer;
			pbf.destroy?.();   // デコード器の即時解放（旧世代を残さない）
			await loadBuffer(buffer);
		} catch (e) { console.error("[geoedit] import failed", e); toast(`取込失敗: ${file.name}`); }
	}

	// ---- スナップ ----
	const snapLL = (ll, skip) => {
		const en = st.model?.snap.nearest(ll[0], ll[1], skip);
		if (en) { st.snapMark = [en.x, en.y]; return [en.x, en.y]; }
		st.snapMark = null;
		return ll;
	};

	// ---- 履歴経由の適用（undo/redo・構造操作共通）----
	const affectedEids = (cmd, res) => {   // このコマンドで gint 表示が古くなるフィーチャ群
		const out = new Set();
		const arcRefs = aid => { const a = st.model.arcs.get(aid); if (a) for (const e of a.refs) out.add(e); };
		if (cmd.op === "move" && res?.dirty) for (const aid of res.dirty) arcRefs(aid);
		else if (cmd.op === "movePt" || cmd.op === "del" || cmd.op === "add" || cmd.op === "hole" || cmd.op === "unhole") out.add(cmd.eid);
		else if (cmd.op === "tr") for (const e of moveTargets(cmd.eid)) out.add(e);
		else if (cmd.op === "insert" || cmd.op === "delete") { const r = st.model.resolveAddr(cmd.addr); if (r) arcRefs(r.arcId); }
		return out;
	};
	const applyR = cmd => {
		const res = st.model.applyCmd(cmd);
		editGen++;
		if (cmd.op === "props") layer.restyleProps(st.model);   // スタイルは表の即時再焼き＝コミットを待たない
		else {
			const aff = affectedEids(cmd, res);
			if (aff.size) { st.dragEids = new Set([...(st.dragEids || []), ...aff]); st.hidden = st.dragEids; layer.hide(st.dragEids); }
		}
		if (cmd.op === "add" || cmd.op === "del" || cmd.op === "hole" || cmd.op === "unhole") { if (st.selection === cmd.eid && cmd.op === "del") { st.selection = null; props.close(); } rebuild(); }
		if (cmd.op === "props" && props.eid === cmd.eid) props.render(cmd.eid);   // undo/redo でもパネルを追随
		scheduleCommit();
		overlay.redraw();
	};
	const doCmd = cmd => { applyR(cmd); hist.push(cmd); bar.syncHist(hist.canUndo, hist.canRedo); };
	const undo = () => { hist.undo(applyR, c => st.model.invertCmd(c)); bar.syncHist(hist.canUndo, hist.canRedo); };
	const redo = () => { hist.redo(applyR); bar.syncHist(hist.canUndo, hist.canRedo); };

	// ---- 選択パネル（styleform＝日本語UI・生の属性は「属性を表示」でだけ）----
	const props = createPropsPanel(document.getElementById("stage"), {
		getFeature: eid => st.model?.feats.get(eid),
		applyProps: (eid, next, { history = true, from = null } = {}) => {
			if (history) doCmd({ op: "props", eid, from: from ?? st.model.feats.get(eid).properties, to: next });
			else { st.model.feats.get(eid).properties = next; editGen++; layer.restyleProps(st.model); scheduleCommit(); overlay.redraw(); }   // input中の即プレビュー（表の即時再焼き）
		},
		toast,
	}, signal);

	// ---- 点の配置（クリック・右クリックメニュー共通）----
	const placePointAt = (ll, defs) => {
		const cmd = { op: "add", feature: { type: "Feature", properties: { ...defs }, geometry: { type: "Point", coordinates: snapLL(ll) } } };
		doCmd(cmd);
		select(cmd.eid);
	};

	// ---- 選択・作図（クリックは editClick スロット＝エンジンの4px裁定済み）----
	const select = eid => {
		st.selection = eid; st.sketch = null;
		eid != null && tool === "select" ? props.render(eid) : props.close();   // パネルは選択ツール時のみ（作図中は既定スタイルパネルが主役）
		overlay.redraw();
	};
	map.setEditClick((x, y) => {
		if (st.busy || !st.model) return;
		const ll = map.unprojectXY(x, y);
		if (!ll) return;
		if (tool === "select") {
			// 選択の優先順：①シンボルの見た目（アイコンは足元アンカー＝絵の位置と実座標がずれるため画面矩形で）②gint識別
			const symEid = overlay.symbolAt(x, y);
			return select(symEid ?? layer.identify(ll[0], ll[1], map.getZoom()));
		}
		if (tool === "point" || tool === "text") {
			if (tool === "text" && !drawDefaults.text["@text"]) return toast("パネルに文字を入れてから置いてください");
			return placePointAt(ll, drawDefaults[tool]);
		}
		if (tool === "move") return select(overlay.symbolAt(x, y) ?? layer.identify(ll[0], ll[1], map.getZoom()));   // 移動ツール＝クリックで対象選択（ドラッグは pointerdown 側）
		if (tool === "rect" || tool === "circle") {   // 2点作図：1打目=基点、2打目=確定
			if (!st.sketch) { st.sketch = { kind: tool, coords: [snapLL(ll)], cursor: null }; overlay.redraw(); return; }
			return finishTwoPoint(st.sketch.coords[0], snapLL(ll));
		}
		// line / polygon / hole＝スケッチへ頂点追加
		if (!st.sketch) st.sketch = { kind: tool, coords: [], cursor: null };
		st.sketch.coords.push(snapLL(ll));
		overlay.redraw();
	});
	// 矩形/円のリング生成（円＝36角形・経度は cos(lat) 補正＝画面上で円に見える）
	const twoPointRing = (kind, a, b) => {
		if (kind === "rect") return [a, [b[0], a[1]], b, [a[0], b[1]], a];
		const k = Math.max(0.2, Math.cos(a[1] * Math.PI / 180));
		const r = Math.hypot((b[0] - a[0]) * k, b[1] - a[1]);
		if (r <= 0) return null;
		const ring = [];
		for (let i = 0; i <= 36; i++) { const t = i / 36 * Math.PI * 2; ring.push([a[0] + r * Math.cos(t) / k, a[1] + r * Math.sin(t)]); }
		return ring;
	};
	function finishTwoPoint(a, b) {
		const ring = twoPointRing(st.sketch.kind, a, b);
		st.sketch = null; st.snapMark = null;
		if (!ring || (ring[0][0] === ring[2][0] && ring[0][1] === ring[2][1])) { overlay.redraw(); return toast("大きさがありません"); }
		const cmd = { op: "add", feature: { type: "Feature", properties: { ...drawDefaults.polygon }, geometry: { type: "Polygon", coordinates: [ring] } } };
		doCmd(cmd);
		setTool("select");
		select(cmd.eid);
	}
	function finishSketch() {
		const sk = st.sketch;
		if (!sk) return;
		st.sketch = null; st.snapMark = null;
		if (sk.kind === "line" ? sk.coords.length < 2 : sk.coords.length < 3) { overlay.redraw(); return toast("頂点が足りません"); }
		if (sk.kind === "hole") {   // 穴＝描いたリングを「その1点目を含むポリゴン」の内環として追加（gint識別で対象決定）
			const eid = layer.identify(sk.coords[0][0], sk.coords[0][1], map.getZoom());
			const f = eid != null ? st.model.feats.get(eid) : null;
			if (!f || !f.type.includes("Poly")) { overlay.redraw(); return toast("穴はポリゴンの内側に描いてください"); }
			const cmd = { op: "hole", eid, ring: sk.coords };
			doCmd(cmd);
			setTool("select");
			select(eid);
			return;
		}
		const geometry = sk.kind === "line"
			? { type: "LineString", coordinates: sk.coords }
			: { type: "Polygon", coordinates: [[...sk.coords, sk.coords[0]]] };
		const cmd = { op: "add", feature: { type: "Feature", properties: { ...drawDefaults[sk.kind] }, geometry } };
		doCmd(cmd);
		setTool("select");   // 描いたら即整える＝選択ツールへ自動復帰（点ツールは連続配置のため残す）
		select(cmd.eid);     // setTool の後＝選択パネルが開く
	}
	const cancelSketch = () => { if (st.sketch) { st.sketch = null; st.snapMark = null; overlay.redraw(); } };

	// ---- @tip ツールチップの器 ----
	let tipTimer = 0, tipEl = null;
	const hideTip = () => { tipEl?.remove(); tipEl = null; };

	// ---- 頂点ドラッグ（capture-phase＝命中時だけエンジンから奪う）----
	let drag = null;   // {kind:"v"|"p", arcId,idx | eid,ptIdx, start:[x,y], last:[x,y], pointerId, moved}
	const localXY = e => { const r = mapEl.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
	const dragTargets = h => {   // 動かす対象と、gint側で隠す eid 集合
		if (h.kind === "p") return { eids: new Set([h.eid]) };
		const arc = st.model.arcs.get(h.arcId);
		const eids = new Set(arc.refs);
		const n = arc.pts.length / 2;
		if (h.idx === 0 || h.idx === n - 1) {   // 端点＝ノード接続の全arcの参照フィーチャも動く
			const nid = st.model.endNodeOf(h.arcId, h.idx === 0 ? 0 : 1);
			const nd = st.model.nodes.get(nid);
			if (nd) for (const [aid] of nd.ends) for (const e of st.model.arcs.get(aid).refs) eids.add(e);
		}
		return { eids };
	};
	// 移動ツール＝一緒に動く/隠すフィーチャ集合（自分＋共有arc・共有ノードでつながる隣）
	const moveTargets = eid => {
		const f = st.model.feats.get(eid), eids = new Set([eid]);
		if (!f || f.coords) return eids;
		for (const { list } of st.model.listsOf(f)) for (const s of list) {
			const aid = s < 0 ? ~s : s;
			for (const e2 of st.model.arcs.get(aid).refs) eids.add(e2);
			for (const end of [0, 1]) {
				const nid = st.model.endNodeOf(aid, end);
				const nd = nid != null ? st.model.nodes.get(nid) : null;
				if (nd) for (const [a2] of nd.ends) for (const e2 of st.model.arcs.get(a2).refs) eids.add(e2);
			}
		}
		return eids;
	};
	mapEl.addEventListener("pointerdown", e => {
		// ツール不問＝選択中フィーチャのハンドル命中なら常にドラッグ（「作図ツールのまま頂点が動かせない」罠の根治 8/20）。
		// スケッチ中だけは除外（クリック＝頂点追加が主導）。
		if (st.busy || !st.model || st.sketch) return;
		const [x, y] = localXY(e);
		if (tool === "move") {   // 移動モード＝「押した場所の要素」を掴んで平行移動（自動選択）。何も無い場所は素通し＝パン
			const ll0 = map.unprojectXY(x, y);
			if (!ll0) return;
			const target = overlay.symbolAt(x, y) ?? layer.identify(ll0[0], ll0[1], map.getZoom());
			if (target == null) return;
			if (st.selection !== target) select(target);
			e.stopPropagation(); e.preventDefault();
			try { mapEl.setPointerCapture(e.pointerId); } catch { /* 合成イベントは capture 不可＝無害 */ }
			drag = { kind: "f", eid: target, lastLL: ll0, total: [0, 0], pointerId: e.pointerId, moved: false };
			st.dragEids = new Set([...(st.dragEids || []), ...moveTargets(target)]); st.hidden = st.dragEids;   // 未コミットの前回分と合流
			hideTip();
			mapEl.style.cursor = "grabbing";
			layer.hide(st.dragEids);
			overlay.redraw();
			return;
		}
		if (st.selection == null) return;
		let h = overlay.handleAt(x, y, e.pointerType === "touch");
		if (!h) return;
		e.stopPropagation(); e.preventDefault();
		if (e.altKey && h.kind === "v") {   // Alt+クリック＝頂点削除
			const addr = st.model.addrOf(h.arcId, h.idx);
			const cmd = { op: "delete", addr };
			const res = st.model.applyCmd(cmd);
			if (!res) return toast("この頂点は消せません（端点/最小構成）");
			hist.push(cmd); bar.syncHist(hist.canUndo, hist.canRedo);
			scheduleCommit(); overlay.redraw();
			return;
		}
		if (h.kind === "m") {   // 中点＝挿入してそのまま掴む
			const cmd = { op: "insert", addr: st.model.addrOf(h.arcId, h.idx), ll: h.ll };
			doCmd(cmd);
			const r = st.model.resolveAddr(cmd.addrNew);
			h = { kind: "v", arcId: r.arcId, idx: r.idx };
		}
		try { mapEl.setPointerCapture(e.pointerId); } catch { /* 合成イベント（試験）はcapture不可＝move/upはmapElで拾えるので無害 */ }
		const start = h.kind === "p"
			? [...st.model.feats.get(h.eid).coords[h.ptIdx]]
			: [st.model.arcs.get(h.arcId).pts[h.idx * 2], st.model.arcs.get(h.arcId).pts[h.idx * 2 + 1]];
		const { eids } = dragTargets(h);
		drag = { ...h, start, last: start, pointerId: e.pointerId, moved: false };
		st.dragEids = new Set([...(st.dragEids || []), ...eids]); st.hidden = st.dragEids;   // 未コミットの前回分と合流
		hideTip();
		mapEl.style.cursor = "grabbing";
		layer.hide(eids);
		overlay.redraw();
	}, { capture: true, signal });
	mapEl.addEventListener("pointermove", e => {
		if (drag) {
			if (e.pointerId !== drag.pointerId) return;
			e.stopPropagation();
			const [x, y] = localXY(e);
			const ll = map.unprojectXY(x, y);
			if (!ll) return;
			if (drag.kind === "f") {   // フィーチャ平行移動（適用できた分だけ total へ＝格子量子化と整合）
				const res = st.model.translateFeature(drag.eid, ll[0] - drag.lastLL[0], ll[1] - drag.lastLL[1], { index: false });   // ドラッグ中は索引追記オフ（終端で一括reindex）
				if (res) {
					drag.total[0] += res.d[0]; drag.total[1] += res.d[1];
					drag.lastLL = [drag.lastLL[0] + res.d[0], drag.lastLL[1] + res.d[1]];
					if (res.d[0] || res.d[1]) { drag.moved = true; editGen++; }
				}
				overlay.redraw();
				return;
			}
			const self = en => drag.kind === "p" ? en.eid === drag.eid && en.ptIdx === drag.ptIdx : en.arcId === drag.arcId && en.idx === drag.idx;
			const snapped = snapLL(ll, self);
			if (drag.kind === "p") st.model.movePoint(drag.eid, drag.ptIdx, snapped[0], snapped[1]);
			else st.model.moveVertex(drag.arcId, drag.idx, snapped[0], snapped[1]);
			editGen++;
			drag.last = snapped; drag.moved = true;
			overlay.redraw();
			return;
		}
		if (st.sketch) {   // ラバーバンドのカーソル頂点＋吸着マーク（矩形/円は確定形をプレビュー）
			const [x, y] = localXY(e);
			const ll = map.unprojectXY(x, y);
			if (ll) {
				st.sketch.cursor = snapLL(ll);
				if (st.sketch.kind === "rect" || st.sketch.kind === "circle")
					st.sketch.preview = twoPointRing(st.sketch.kind, st.sketch.coords[0], st.sketch.cursor);
				overlay.redraw();
			}
			return;
		}
		const [x, y] = localXY(e);
		if (st.selection != null && !st.busy)   // ハンドルにホバー＝掴めることをカーソルで示す
			mapEl.style.cursor = overlay.handleAt(x, y, e.pointerType === "touch") ? "grab" : "";
		// @tip ホバー＝一言ツールチップ（識別はデバウンス120ms＝findPolygon全走査を毎moveで払わない）
		clearTimeout(tipTimer);
		tipTimer = setTimeout(() => {
			if (drag || st.sketch || st.busy || !st.model) return hideTip();
			const ll = map.unprojectXY(x, y);
			if (!ll) return hideTip();
			const eid = overlay.symbolAt(x, y) ?? layer.identify(ll[0], ll[1], map.getZoom());
			const tip = eid != null ? st.model.feats.get(eid)?.properties?.["@tip"] : null;
			if (tip == null || tip === "") return hideTip();
			if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "ge-tip"; mapEl.append(tipEl); }
			tipEl.textContent = String(tip);
			tipEl.style.left = x + 14 + "px";
			tipEl.style.top = y - 10 + "px";
		}, 120);
	}, { capture: true, signal });
	const endDrag = e => {
		if (!drag || e.pointerId !== drag.pointerId) return;
		e.stopPropagation();
		const d = drag; drag = null;
		st.snapMark = null;
		mapEl.style.cursor = "";
		// dragEids/hidden はここで解除しない＝この編集を含むコミットが着地するまで
		// オーバレイが現在形を描き続け、gint の「前のデータ」は隠したまま（本人指摘 8/20 の根治）
		if (d.moved) {
			if (d.kind === "f") st.model.reindexFeature(d.eid);   // translate終端＝スナップ索引へ一括追記
			const cmd = d.kind === "f"
				? { op: "tr", eid: d.eid, d: d.total }
				: d.kind === "p"
					? { op: "movePt", eid: d.eid, ptIdx: d.ptIdx, from: d.start, to: d.last }
					: { op: "move", addr: st.model.addrOf(d.arcId, d.idx), from: d.start, to: d.last };
			hist.push(cmd);   // 適用済み＝pushのみ（ドラッグ中に直接適用済み）
			bar.syncHist(hist.canUndo, hist.canRedo);
		}
		scheduleCommit();
		overlay.redraw();
	};
	mapEl.addEventListener("pointerup", endDrag, { capture: true, signal });
	mapEl.addEventListener("pointercancel", endDrag, { capture: true, signal });
	mapEl.addEventListener("dblclick", e => {
		if (st.sketch) { e.stopPropagation(); e.preventDefault(); finishSketch(); }
	}, { capture: true, signal });

	// ---- キーボード ----
	const typing = () => { const t = document.activeElement?.tagName; return t === "INPUT" || t === "TEXTAREA" || document.activeElement?.isContentEditable; };
	addEventListener("keydown", e => {
		if (typing() || st.busy) return;
		const mod = e.metaKey || e.ctrlKey;
		if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
		if (e.key === "Escape") { cancelSketch(); select(null); return; }
		if (e.key === "Enter") { if (st.sketch) { e.preventDefault(); finishSketch(); } return; }
		if ((e.key === "Delete" || e.key === "Backspace") && st.selection != null) {
			e.preventDefault();
			doCmd({ op: "del", eid: st.selection });
			return;
		}
		const k = e.key.toLowerCase();
		if (k === "v") setTool("select");
		else if (k === "a") setTool("point");
		else if (k === "t") setTool("text");
		else if (k === "l") setTool("line");
		else if (k === "p") setTool("polygon");
		else if (k === "r") setTool("rect");
		else if (k === "c") setTool("circle");
		else if (k === "h") setTool("hole");
		else if (k === "m") setTool("move");
	}, { signal });

	// ---- ツールバー結線 ----
	const setTool = t => {
		tool = t;
		cancelSketch();
		if (t === "line" || t === "polygon" || t === "hole" || t === "rect" || t === "circle") select(null);   // 作図モードに選択は残さない（最初の一打がハンドルドラッグに化ける競合の根治）
		else if (t === "select" && st.selection != null) props.render(st.selection);
		else props.close();               // 点/テキスト/移動ツール＝パネルは出さない or 既定スタイルが主役
		bar.syncTool(t);
	};
	const bar = initToolbar(document.getElementById("toolbar"), {
		setTool, undo, redo,
		gridExp: () => gridExp,
		setGrid: exp => { gridExp = exp; st.model?.setGrid(exp); toast(`スナップ格子: 1e-${exp} 度`); },
		getDefaults: t => drawDefaults[t === "rect" || t === "circle" ? "polygon" : t],   // 矩形/円＝面の既定スタイルを共有
		setDefaults: (t, partial) => { const k = t === "rect" || t === "circle" ? "polygon" : t; drawDefaults[k] = mergeProps(drawDefaults[k], partial); },
		importFile,
		exportOpen: () => exportPanel(document.getElementById("stage"), () => st.model && layer.exportPbf(st.model), toast),
		clearAll: async () => { if (confirm("編集内容を全て消去して新規セッションを始めますか？")) { await idbClear(); loadFC({ type: "FeatureCollection", features: [] }); } },
	}, signal);
	bar.syncHist(false, false);

	// ---- 右クリックメニュー＝編集アクション（contextmenu ガジェットへ items 注入・本人裁定 8/20）----
	const startSketchAt = c => { if (c.lng == null) return; st.sketch = { kind: tool, coords: [snapLL([c.lng, c.lat])], cursor: null }; overlay.redraw(); };
	map.gadget.contextmenu({
		items: [
			{ name: "ここの要素を選択", onClick: c => { if (c.lng == null) return; setTool("select"); select(overlay.symbolAt(c.x, c.y) ?? layer.identify(c.lng, c.lat, map.getZoom())); } },
			{ name: "ここに点を置く", onClick: c => c.lng != null && placePointAt([c.lng, c.lat], drawDefaults.point) },
			{ name: "ここにテキストを置く", onClick: c => c.lng != null && placePointAt([c.lng, c.lat], drawDefaults.text) },
			{ name: "ここから線を描く", onClick: c => { setTool("line"); startSketchAt(c); } },
			{ name: "ここから面を描く", onClick: c => { setTool("polygon"); startSketchAt(c); } },
			{ name: "ここに穴を開ける", onClick: c => { setTool("hole"); startSketchAt(c); } },
			{ name: "選択中の要素を削除", onClick: () => { st.selection != null ? doCmd({ op: "del", eid: st.selection }) : toast("先に要素を選択してください"); } },
			{ name: "座標をコピー", onClick: c => c.lng != null && navigator.clipboard?.writeText(`${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`) },
		],
	});

	// ---- 取り込み（ドロップ）----
	initDrop(mapEl, importFile, signal);

	// ---- セッション復元 or 空モデルで開始 ----
	(async () => {
		const rec = await idbLoad();
		if (rec?.buf && confirm("前回の編集セッションを復元しますか？")) {
			gridExp = rec.gridExp ?? 6;
			if (rec.view) location.hash = rec.view;
			await loadBuffer(rec.buf, { fly: !rec.view, stripEid: true });   // コミット由来の__eidは剥がす
		} else {
			await loadFC({ type: "FeatureCollection", features: [] });
			toast("GISファイルをドロップ、またはツールで作図を始めてください");
		}
	})();

	return {
		destroy() { ac.abort(); map.setEditClick(null); overlay.destroy(); clearTimeout(commitTimer); clearTimeout(tipTimer); hideTip(); worker?.terminate(); },
		get state() { return st; },
		get model() { return st.model; },
		commitNow: () => { clearTimeout(commitTimer); return commit(false); },   // 明示フラッシュ（試験・保存前）
		layer,   // デバッグの手すり（identify/pbf の検分用。公式口ではない）
		decode: file => geopbf(file, { name: "decode/" + file.name }),   // 同じく手すり＝自バンドルのgeopbfで任意ファイルを解く（計測・検分用）
		loadFC, loadBuffer, importFile, toast,
	};
}
