// ドラッグ：頂点（v）／点フィーチャの点（p）／中点挿入（m→v）／移動ツールのフィーチャ平行移動（f）。
// capture-phase pointerdown で命中時だけエンジンから奪う（パンは発火しない）。Alt+クリック＝頂点削除もここ。
// ドラッグ中はモデルを直接動かし（履歴なし）、終端で1コマンドを push＝「適用済み・pushのみ」の規約。
// dragEids/hidden は終端で解除しない＝この編集を含むコミットが着地するまでオーバレイが現在形を描き続け、
// gint の「前のデータ」は隠したまま（本人指摘 8/20 の根治）。

// 移動ツール＝一緒に動く/隠すフィーチャ集合（自分＋共有arc・共有ノードでつながる隣）。affectedEids（controller）とも共用
export const moveTargets = (model, eid) => {
	const f = model.feats.get(eid), eids = new Set([eid]);
	if (!f || f.coords) return eids;
	for (const { list } of model.listsOf(f)) for (const s of list) {
		const aid = s < 0 ? ~s : s;
		for (const e2 of model.arcs.get(aid).refs) eids.add(e2);
		for (const end of [0, 1]) {
			const nid = model.endNodeOf(aid, end);
			const nd = nid != null ? model.nodes.get(nid) : null;
			if (nd) for (const [a2] of nd.ends) for (const e2 of model.arcs.get(a2).refs) eids.add(e2);
		}
	}
	return eids;
};

export function installDrag(ed) {
	const { st, map, mapEl, signal, overlay, layer, popLayer, hist, toast } = ed;
	const dragTargets = h => {   // 動かす対象と、gint側で隠す eid 集合
		if (h.kind === "p") return new Set([h.eid]);
		const arc = st.model.arcs.get(h.arcId);
		const eids = new Set(arc.refs);
		const n = arc.pts.length / 2;
		if (h.idx === 0 || h.idx === n - 1) {   // 端点＝ノード接続の全arcの参照フィーチャも動く
			const nid = st.model.endNodeOf(h.arcId, h.idx === 0 ? 0 : 1);
			const nd = st.model.nodes.get(nid);
			if (nd) for (const [aid] of nd.ends) for (const e of st.model.arcs.get(aid).refs) eids.add(e);
		}
		return eids;
	};
	const begin = (e, eids) => {   // 共通の掴み始め：隠し集合へ合流・tip 消し・カーソル・pop 退避
		try { mapEl.setPointerCapture(e.pointerId); } catch { /* 合成イベント（試験）は capture 不可＝move/up は mapEl で拾えるので無害 */ }
		st.dragEids = new Set([...(st.dragEids || []), ...eids]); st.hidden = st.dragEids;   // 未コミットの前回分と合流
		ed.hideTip();
		mapEl.style.cursor = "grabbing";
		layer.hide(st.dragEids);
		overlay.redraw();
		popLayer.sync();   // 掴んだフィーチャの @pop 箱は隠す（着地=commit で戻す）
	};

	mapEl.addEventListener("pointerdown", e => {
		// ツール不問＝選択中フィーチャのハンドル命中なら常にドラッグ（「作図ツールのまま頂点が動かせない」罠の根治 8/20）。
		// スケッチ中だけは除外（クリック＝頂点追加が主導）。Shift 押下は @pop 開き専用＝ここでは掴まない。
		if (st.busy || !st.model || st.sketch || e.shiftKey) return;
		const [x, y] = ed.localXY(e);
		if (st.tool === "move") {   // 移動モード＝「押した場所の要素」を掴んで平行移動（自動選択）。何も無い場所は素通し＝パン
			const ll0 = map.unprojectXY(x, y);
			if (!ll0) return;
			const target = ed.pick(x, y, ll0);
			if (target == null) return;
			if (st.selection !== target) ed.select(target);
			e.stopPropagation(); e.preventDefault();
			st.drag = { kind: "f", eid: target, lastLL: ll0, total: [0, 0], pointerId: e.pointerId, moved: false };
			begin(e, moveTargets(st.model, target));
			return;
		}
		if (st.selection == null) return;
		let h = overlay.handleAt(x, y, e.pointerType === "touch");
		if (!h) return;
		e.stopPropagation(); e.preventDefault();
		if (e.altKey && h.kind === "v") {   // Alt+クリック＝頂点削除（doCmd 経由＝隠し/世代/pop の規約を他の構造操作と揃える）
			if (st.model.large) return toast("大規模モードでは頂点の追加/削除はできません（移動のみ）");
			if (ed.doCmd({ op: "delete", addr: st.model.addrOf(h.arcId, h.idx) }) === false) toast("この頂点は消せません（端点/最小構成）");
			return;
		}
		if (h.kind === "m") {   // 中点＝挿入してそのまま掴む
			const cmd = { op: "insert", addr: st.model.addrOf(h.arcId, h.idx), ll: h.ll };
			ed.doCmd(cmd);
			const r = st.model.resolveAddr(cmd.addrNew);
			h = { kind: "v", arcId: r.arcId, idx: r.idx };
		}
		const start = h.kind === "p"
			? [...st.model.feats.get(h.eid).coords[h.ptIdx]]
			: [st.model.arcs.get(h.arcId).pts[h.idx * 2], st.model.arcs.get(h.arcId).pts[h.idx * 2 + 1]];
		st.drag = { ...h, start, last: start, pointerId: e.pointerId, moved: false };
		begin(e, dragTargets(h));
	}, { capture: true, signal });

	mapEl.addEventListener("pointermove", e => {
		const drag = st.drag;
		if (!drag || e.pointerId !== drag.pointerId) return;
		e.stopPropagation();
		const [x, y] = ed.localXY(e);
		const ll = map.unprojectXY(x, y);
		if (!ll) return;
		if (drag.kind === "f") {   // フィーチャ平行移動（適用できた分だけ total へ＝格子量子化と整合）
			const res = st.model.translateFeature(drag.eid, ll[0] - drag.lastLL[0], ll[1] - drag.lastLL[1], { index: false });   // ドラッグ中は索引追記オフ（終端で一括reindex）
			if (res) {
				drag.total[0] += res.d[0]; drag.total[1] += res.d[1];
				drag.lastLL = [drag.lastLL[0] + res.d[0], drag.lastLL[1] + res.d[1]];
				if (res.d[0] || res.d[1]) { drag.moved = true; st.editGen++; }
			}
			overlay.redraw();
			return;
		}
		const self = en => drag.kind === "p" ? en.eid === drag.eid && en.ptIdx === drag.ptIdx : en.arcId === drag.arcId && en.idx === drag.idx;
		const snapped = ed.snapLL(ll, self);
		if (drag.kind === "p") st.model.movePoint(drag.eid, drag.ptIdx, snapped[0], snapped[1]);
		else st.model.moveVertex(drag.arcId, drag.idx, snapped[0], snapped[1]);
		st.editGen++;
		drag.last = snapped; drag.moved = true;
		overlay.redraw();
	}, { capture: true, signal });

	const endDrag = e => {
		const d = st.drag;
		if (!d || e.pointerId !== d.pointerId) return;
		e.stopPropagation();
		st.drag = null;
		st.snapMark = null;
		mapEl.style.cursor = "";
		if (d.moved) {
			if (d.kind === "f") st.model.reindexFeature(d.eid);   // translate終端＝スナップ索引へ一括追記
			const cmd = d.kind === "f"
				? { op: "tr", eid: d.eid, d: d.total }
				: d.kind === "p"
					? { op: "movePt", eid: d.eid, ptIdx: d.ptIdx, from: d.start, to: d.last }
					: { op: "move", addr: st.model.addrOf(d.arcId, d.idx), from: d.start, to: d.last };
			hist.push(cmd);   // 適用済み＝pushのみ（ドラッグ中に直接適用済み）
			if (st.model.large) st.largeDirty = true;
			ed.bar.syncHist(hist.canUndo, hist.canRedo);
		}
		ed.scheduleCommit();
		overlay.redraw();
	};
	mapEl.addEventListener("pointerup", endDrag, { capture: true, signal });
	mapEl.addEventListener("pointercancel", endDrag, { capture: true, signal });
}
