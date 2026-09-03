// 右クリックメニュー＝文脈連動（開くたびに「指した要素／選択／束ね中」で項目を組む）。
// 上段＝要素への操作（選択/削除/合成/ばらす）を文脈で出し分け、下段＝「ここに〜」の作図＋座標コピー。
const copyLL = c => c.lng != null && navigator.clipboard?.writeText(`${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`);

export function installContextMenu(ed) {
	const { st, map, popLayer, drawDefaults } = ed;
	map.gadget.contextmenu({
		items: ctx => {
			const m = st.model;
			const under = ctx.lng != null ? ed.pick(ctx.x, ctx.y, [ctx.lng, ctx.lat]) : null;
			const pop = under != null ? m?.feats.get(under)?.properties?.["@pop"] : null;
			const popItem = { name: "吹き出し(pop)を表示", onClick: () => popLayer.open(under, { x: ctx.x, y: ctx.y, ll: ctx.lng != null ? [ctx.lng, ctx.lat] : undefined }) };   // 右クリック点を参照点に
			const selectItem = { name: "この要素を選択", onClick: () => { ed.setTool("select"); ed.select(under); } };
			const out = [];
			if (m?.large) {   // 大規模モード＝選択/表示系だけ（作図・構造操作はPhase2まで出さない）
				if (under != null && under !== st.selection) out.push(selectItem);
				if (pop != null && pop !== "") out.push(popItem);
				out.push({ name: "座標をコピー", onClick: copyLL });
				return out;
			}
			if (st.tool === "bundle") {   // 束ね中＝確定/取消を最上段
				out.push({ name: `合成を確定（${st.bundle?.size || 0}件・Enter）`, onClick: () => ed.confirmBundle() });
				out.push({ name: "合成を取消（Esc）", onClick: () => ed.setTool("select") });
			} else {
				const start = st.selection != null ? st.selection : under;   // 選択優先・無ければ指した要素
				const fam = start != null ? m?.familyOf(m.feats.get(start)?.type || "") : null;
				if (fam === "poly" || fam === "line") out.push({ name: "合成（束ねる）を始める", onClick: () => ed.startBundleWith(start) });
				const mEid = ed.isMulti(under) ? under : ed.isMulti(st.selection) ? st.selection : null;
				if (mEid != null) out.push({ name: "ばらす（multiを解除）", onClick: () => ed.explodeEid(mEid) });
			}
			if (under != null && under !== st.selection) out.push(selectItem);   // 指した要素があれば
			const uc = under != null ? m?.feats.get(under)?.coords?.[0] : null;   // 点なら要素そのものの座標
			if (uc) out.push({ name: "要素座標をコピー", onClick: () => navigator.clipboard?.writeText(`${uc[1].toFixed(6)}, ${uc[0].toFixed(6)}`) });
			if (pop != null && pop !== "") out.push(popItem);
			if (st.selection != null) out.push({ name: "選択中の要素を削除", onClick: () => ed.doCmd({ op: "del", eid: st.selection }) });   // 選択があれば
			out.push(
				{ name: "ここに点を置く", onClick: c => c.lng != null && ed.placePointAt([c.lng, c.lat], drawDefaults.point) },
				{ name: "ここにテキストを置く", onClick: c => c.lng != null && ed.placePointAt([c.lng, c.lat], drawDefaults.text) },
				{ name: "ここから線を描く", onClick: c => { ed.setTool("line"); c.lng != null && ed.sketch.start("line", [c.lng, c.lat]); } },
				{ name: "ここから面を描く", onClick: c => { ed.setTool("polygon"); c.lng != null && ed.sketch.start("polygon", [c.lng, c.lat]); } },
			);
			if (m?.familyOf(m.feats.get(under)?.type || "") === "poly") out.push({ name: "ここに穴を開ける", onClick: c => { ed.setTool("hole"); c.lng != null && ed.sketch.start("hole", [c.lng, c.lat]); } });   // 穴はポリゴンの内側だけ
			out.push({ name: "座標をコピー", onClick: copyLL });
			return out;
		},
	});
}
