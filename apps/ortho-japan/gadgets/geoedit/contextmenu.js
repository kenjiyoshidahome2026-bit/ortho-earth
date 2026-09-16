import { tr } from "../../i18n.js";   // UI 多言語化（英語キー＝既定値・訳は i18n/<lang>.json＝i18n.js）
const t = tr();

// 右クリックメニュー＝文脈連動（開くたびに「指した要素／選択／複数選択」で項目を組む）。
// 上段＝要素への操作（選択/追加/削除/グループ化/解除）を文脈で出し分け、下段＝「ここに〜」の作図＋座標コピー。
const copyLL = c => c.lng != null && navigator.clipboard?.writeText(`${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`);

export function installContextMenu(ed) {   // 戻り値＝項目を搭載前（既定）へ戻す関数（本体地図に載った時の後片付け）
	const { st, map, popLayer, drawDefaults } = ed;
	const cm = map.gadget.contextmenu({
		items: ctx => {
			const m = st.model;
			const under = ctx.lng != null ? ed.pick(ctx.x, ctx.y, [ctx.lng, ctx.lat]) : null;
			const pop = under != null ? m?.feats.get(under)?.properties?.["@pop"] : null;
			const popItem = { name: t("Show popup"), onClick: () => popLayer.open(under, { x: ctx.x, y: ctx.y, ll: ctx.lng != null ? [ctx.lng, ctx.lat] : undefined }) };   // 右クリック点を参照点に
			const selectItem = { name: t("Select this feature"), onClick: () => { ed.setTool("select"); ed.select(under); } };
			const out = [];
			if (m?.large) {   // 大規模モード＝選択/表示系だけ（作図・構造操作はPhase2まで出さない）
				if (under != null && under !== st.selection) out.push(selectItem);
				if (pop != null && pop !== "") out.push(popItem);
				out.push({ name: t("Copy coordinates"), onClick: copyLL });
				return out;
			}
			// 複数選択（⌘/Ctrl+クリック or ここ）→「グループ化（n件）」。グループ（Multi*）を指す/選んでいる→「グループ化解除」（本人裁定 9/15＝ツールバーから右クリックへ）
			const inMulti = under != null && st.multi?.has(under);
			if (under != null && under !== st.selection && !inMulti) {
				out.push(selectItem);
				if (st.selection != null) out.push({ name: t("Add to selection"), onClick: () => { ed.setTool("select"); ed.toggleMulti(under); } });
			} else if (inMulti && st.multi.size > 1) out.push({ name: t("Remove from selection"), onClick: () => ed.toggleMulti(under) });
			if (st.multi && st.multi.size > 1) out.push({ name: t("Group ($1)", st.multi.size), onClick: () => ed.groupMulti() });
			const mEid = ed.isMulti(under) ? under : ed.isMulti(st.selection) ? st.selection : null;
			if (mEid != null) out.push({ name: t("Ungroup"), onClick: () => ed.explodeEid(mEid) });
			const uc = under != null ? m?.feats.get(under)?.coords?.[0] : null;   // 点なら要素そのものの座標
			if (uc) out.push({ name: t("Copy feature coordinates"), onClick: () => navigator.clipboard?.writeText(`${uc[1].toFixed(6)}, ${uc[0].toFixed(6)}`) });
			if (pop != null && pop !== "") out.push(popItem);
			if (st.multi && st.multi.size > 1) out.push({ name: t("Delete $1 selected features", st.multi.size), onClick: () => { for (const e of [...st.multi]) ed.doCmd({ op: "del", eid: e }); st.multi = null; } });
			else if (st.selection != null) out.push({ name: t("Delete selected feature"), onClick: () => ed.doCmd({ op: "del", eid: st.selection }) });   // 選択があれば
			out.push(
				{ name: t("Place a point here"), onClick: c => c.lng != null && ed.placePointAt([c.lng, c.lat], drawDefaults.point) },
				{ name: t("Place text here"), onClick: c => c.lng != null && ed.placePointAt([c.lng, c.lat], drawDefaults.text) },
				{ name: t("Start a line here"), onClick: c => { ed.setTool("line"); c.lng != null && ed.sketch.start("line", [c.lng, c.lat]); } },
				{ name: t("Start a polygon here"), onClick: c => { ed.setTool("polygon"); c.lng != null && ed.sketch.start("polygon", [c.lng, c.lat]); } },
			);
			if (m?.familyOf(m.feats.get(under)?.type || "") === "poly") out.push({ name: t("Cut a hole here"), onClick: c => { ed.setTool("hole"); c.lng != null && ed.sketch.start("hole", [c.lng, c.lat]); } });   // 穴はポリゴンの内側だけ
			out.push({ name: t("Copy coordinates"), onClick: copyLL });
			return out;
		},
	});
	return () => cm?.setItems?.(null);
}
