import { tr } from "../../i18n.js";   // UI二言語化（ja正典・en辞書引き＝エンジン i18n.js の流儀。辞書は各モジュール持参）
import { toVec, quatBetween, quatAngle, quatFromAxisAngle, quatMul, rotateLL, gcCentroid } from "geopbf/edit/sphere";   // 移動＝球の中心まわりの回転（本人裁定 9/14「球体上の図形として角度で移動」）・ホイール＝重心軸まわりの回転
const t = tr({
	"大規模モードでは頂点の追加/削除はできません（移動のみ）": "Large mode cannot add/delete vertices (move only)",
	"この頂点は消せません（端点/最小構成）": "This vertex cannot be deleted (endpoint / minimum shape)",
});
// ドラッグ：頂点（v）／点フィーチャの点（p）／中点挿入（m→v）／移動ツールのフィーチャ回転移動（f＝掴んだ点→今の点の球面回転を全頂点へ）。
// capture-phase pointerdown で命中時だけエンジンから奪う（パンは発火しない）。Alt+クリック＝頂点削除もここ。
// ドラッグ中はモデルを直接動かし（履歴なし）、終端で1コマンドを push＝「適用済み・pushのみ」の規約。
// dragEids/hidden は終端で解除しない＝この編集を含むコミットが着地するまでオーバレイが現在形を描き続け、
// gint の「前のデータ」は隠したまま（本人指摘 8/20 の根治）。
//
// ホイール回転（本人裁定 9/14）：掴んでいる間のホイール＝図形の重心を軸に回す（時計回り正・1ノッチ≈2°・Shift＝15°刻み）。
// 移動ツールで選択中なら Alt+ホイールで掴まずに回せる（無修飾ホイールは常に地図ズーム＝驚きを作らない）。
// 合成は四元数1個＝ q = q_move ∘ q_spin(重心軸, 角)（base の重心を軸に回してから運ぶ＝運んだ先の重心まわりの回転と同じもの）。
// base から毎回当て直す＝順序や往復で誤差が積まない・undo は base への厳密復元（既存の rot コマンドそのまま）。

const DEG = Math.PI / 180;
const wheelDeg = e => (e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 800 : e.deltaY) * 0.02;   // 1ノッチ(≈100)＝2°。行/ページ単位（Firefox）は px 相当へ
const snapDeg = (raw, shift) => shift ? Math.round(raw / 15) * 15 : raw;
const ROT_IDLE_MS = 500;   // Alt+ホイールの「手が止まった」＝1手として確定
const baseLists = base => base.coords ? [base.coords] : base.rings.map(r => r.pts);   // featureVerts → 重心用の点列群
const spinQ = (cVec, deg) => quatFromAxisAngle(cVec, -deg * DEG);   // 外向き法線まわりの右手系は反時計回り＝時計回りを正にするため符号反転

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
	const hideSet = eids => {   // 隠し集合へ合流・tip 消し・pop 退避（掴み始め／Alt+ホイール開始の共通）
		st.dragEids = new Set([...(st.dragEids || []), ...eids]); st.hidden = st.dragEids;   // 未コミットの前回分と合流
		ed.hideTip();
		layer.hide(st.dragEids);
		overlay.redraw();
		popLayer.sync();   // 掴んだフィーチャの @pop 箱は隠す（着地=commit で戻す）
	};
	const begin = (e, eids) => {   // 共通の掴み始め：capture・カーソル
		try { mapEl.setPointerCapture(e.pointerId); } catch { /* 合成イベント（試験）は capture 不可＝move/up は mapEl で拾えるので無害 */ }
		mapEl.style.cursor = "grabbing";
		hideSet(eids);
	};

	// ---- 回転移動の適用：q = q_move ∘ q_spin を base へ（恒等なら base をそのまま戻す）。st.rot＝軸（重心）の表示 ----
	const applyRot = (eid, r) => {   // r = { base, c, cVec, qm, deg, snapped }
		const qs = r.deg ? spinQ(r.cVec, r.deg) : null;
		const q = r.qm && qs ? quatMul(r.qm, qs) : (r.qm || qs);
		st.model.rotateFeature(eid, q && quatAngle(q) > 0 ? q : null, r.base, { index: false });   // ドラッグ中は索引追記オフ（終端で一括reindex）
		st.rot = r.deg || r.spun ? { c: q ? rotateLL(q, r.c[0], r.c[1]) : r.c, deg: r.deg, snapped: r.snapped } : null;   // 一度でも回したら軸を出し続ける（0°へ戻っても）
		st.editGen++;
		overlay.redraw();
		return q;
	};
	const rotState = (eid, base) => { const c = gcCentroid(baseLists(base)); return { base, c, cVec: toVec(c[0], c[1]), qm: null, angRaw: 0, deg: 0, snapped: false, spun: false }; };
	const wheelSpin = (e, r) => { r.angRaw += wheelDeg(e); r.deg = snapDeg(r.angRaw, e.shiftKey); r.snapped = e.shiftKey; r.spun = true; };

	// ---- Alt+ホイール（掴まずに回す）：移動ツールで選択中。手が止まって ROT_IDLE_MS で1手に確定（pointerdown/選択替え/ツール替えでも確定）----
	let wr = null;   // { eid, model, r, q, timer }
	const flushRot = () => {
		if (!wr) return;
		clearTimeout(wr.timer);
		const { eid, model, r, q } = wr;
		wr = null; st.rot = null;
		if (model === st.model && st.model.feats.has(eid)) {   // モデルが差し替わっていたら捨てるだけ
			st.model.reindexFeature(eid);
			if (q) { hist.push({ op: "rot", eid, q, base: r.base, restore: false }); ed.bar.syncHist(hist.canUndo, hist.canRedo); }
		}
		ed.scheduleCommit();
		overlay.redraw();
	};
	ed.flushRot = flushRot;
	const wheelAlt = e => {
		const eid = st.selection;
		if (wr && wr.eid !== eid) flushRot();
		if (!wr) { wr = { eid, model: st.model, r: rotState(eid, st.model.featureVerts(eid)), q: null, timer: 0 }; hideSet(moveTargets(st.model, eid)); }
		wheelSpin(e, wr.r);
		wr.q = applyRot(eid, wr.r);
		clearTimeout(wr.timer); wr.timer = setTimeout(flushRot, ROT_IDLE_MS);
	};
	mapEl.addEventListener("wheel", e => {
		if (st.busy || !st.model || st.model.large) return;
		const drag = st.drag;
		if (drag) {
			if (drag.kind !== "f") return;   // 頂点ドラッグ中のホイール＝エンジン（ズーム）へ
			e.preventDefault(); e.stopPropagation();
			wheelSpin(e, drag.r);
			drag.q = applyRot(drag.eid, drag.r); drag.moved = true;
			return;
		}
		if (e.altKey && st.tool === "move" && st.selection != null && st.model.feats.has(st.selection) && ed.onSurface(e)) { e.preventDefault(); e.stopPropagation(); wheelAlt(e); }
	}, { capture: true, passive: false, signal });

	mapEl.addEventListener("pointerdown", e => {
		flushRot();   // 進行中の Alt+ホイール回転は、次の操作が何であれここで1手に確定
		// ツール不問＝選択中フィーチャのハンドル命中なら常にドラッグ（「作図ツールのまま頂点が動かせない」罠の根治 8/20）。
		// スケッチ中だけは除外（クリック＝頂点追加が主導）。Shift 押下は @pop 開き専用＝ここでは掴まない。
		if (st.busy || !st.model || st.sketch || e.shiftKey || !ed.onSurface(e)) return;   // 家具の押下は奪わない（同族＝sketch.js free）
		const [x, y] = ed.localXY(e);
		if (st.tool === "move") {   // 移動モード＝「押した場所の要素」を掴んで平行移動（自動選択）。何も無い場所は素通し＝パン
			const ll0 = map.unprojectXY(x, y);
			if (!ll0) return;
			const target = ed.pick(x, y, ll0, true);   // 広い当たり幅（「掴みにくい」本人指摘 9/14）
			if (target == null) return;
			if (st.selection !== target) ed.select(target);
			e.stopPropagation(); e.preventDefault();
			st.drag = { kind: "f", eid: target, a: toVec(ll0[0], ll0[1]), r: rotState(target, st.model.featureVerts(target)), q: null, pointerId: e.pointerId, moved: false };   // r.base＝掴み始めの頂点列（毎回ここから回す）
			begin(e, moveTargets(st.model, target));
			return;
		}
		if (st.selection == null) return;
		let h = overlay.handleAt(x, y, e.pointerType === "touch");
		if (!h) return;
		e.stopPropagation(); e.preventDefault();
		if (e.altKey && h.kind === "v") {   // Alt+クリック＝頂点削除（doCmd 経由＝隠し/世代/pop の規約を他の構造操作と揃える）
			if (st.model.large) return toast(t("大規模モードでは頂点の追加/削除はできません（移動のみ）"));
			if (ed.doCmd({ op: "delete", addr: st.model.addrOf(h.arcId, h.idx) }) === false) toast(t("この頂点は消せません（端点/最小構成）"));
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
		if (drag.kind === "f") {   // フィーチャ回転移動＝掴んだ点 a → 今の点 b の最小回転（軸 a×b）にホイール回転を合成して base 全頂点へ（球面上で形が保たれる・極付近/縫い目でも歪まない）
			const qm = quatBetween(drag.a, toVec(ll[0], ll[1]));
			if (quatAngle(qm) > 0 || drag.r.qm) {
				drag.r.qm = qm;
				drag.q = applyRot(drag.eid, drag.r); drag.moved = true;
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
		if (d.kind === "f") st.rot = null;
		if (d.moved && (d.kind !== "f" || d.q)) {   // 回転移動は正味の回転が残った時だけ1手（回して戻した＝恒等は積まない）
			if (d.kind === "f") st.model.reindexFeature(d.eid);   // translate終端＝スナップ索引へ一括追記
			const cmd = d.kind === "f"
				? { op: "rot", eid: d.eid, q: d.q, base: d.r.base, restore: false }   // undo＝restore:true＝base へ厳密復元
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
