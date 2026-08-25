// @pop の再生層＝エンジンの pop ガジェット（v1 pop.js）を唯一の実装として駆動する。
// geoedit も v2 ビューアも同じガジェットを叩く＝「ここで作った吹き出しが v2 で同じ動きで再生される」を
// 実装の共有で構造的に担保（本人裁定）。canvas 直描き（旧 overlay.drawPops）は廃止＝DOM箱に一本化。
//
// 表示は「常時」でなく「開いた時だけ」＝クリック(通常)/shift+click(編集中)で open(eid,{x,y,ll}) を呼んで初めて出す。
// 参照点（引出線の錨）は open した瞬間のクリック基準で確定＝点:座標／線:クリック点に最寄りの線分上／面:クリック点そのもの。
// 以後は固定（重心/中央頂点には戻さない）。× は箱を閉じるだけ（@pop データは消さない）。
import { listsOf } from "./model.js";

// 線分 a-b への点 p の最近点（経度は cos(lat) 補正で画面的な近さに合わせる）。返すのは経緯度。
function projectOnSeg(p, a, b, k) {
	const ax = a[0] * k, ay = a[1], bx = b[0] * k, by = b[1], px = p[0] * k, py = p[1];
	const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
	let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
	t = t < 0 ? 0 : t > 1 ? 1 : t;
	return [(ax + t * dx) / k, ay + t * dy];
}
// ライン（多部分可）でクリック点 ll に最も近い線分上の点。
function nearestOnLine(model, f, ll) {
	const k = Math.cos(ll[1] * Math.PI / 180) || 1;
	let best = null, bd = Infinity;
	for (const { list } of listsOf(f)) {
		const cs = model.stitch(list);
		for (let i = 0; i + 1 < cs.length; i++) {
			const q = projectOnSeg(ll, cs[i], cs[i + 1], k);
			const dx = (q[0] - ll[0]) * k, dy = q[1] - ll[1], d = dx * dx + dy * dy;
			if (d < bd) { bd = d; best = q; }
		}
	}
	return best;
}

// クリック非依存のフォールバック錨：点=座標・線=中央頂点・面=外環の重心（ll が無い時用）。
export function popAnchorLL(model, f) {
	if (f.coords) return f.coords[0];
	const first = listsOf(f)[0];
	if (!first) return null;
	const cs = model.stitch(first.list);
	if (!cs.length) return null;
	if (!first.ring) return cs[Math.floor(cs.length / 2)];
	let sx = 0, sy = 0;
	const n = cs.length - 1;
	for (let i = 0; i < n; i++) { sx += cs[i][0]; sy += cs[i][1]; }
	return [sx / n, sy / n];
}

// open 時の参照点：面=クリック点そのもの・線=クリック点に最寄りの線分上・点=座標。ll 無しは上のフォールバックへ。
function popAnchorAt(model, f, ll) {
	if (f.coords) return f.coords[0];
	if (!ll) return popAnchorLL(model, f);
	const lists = listsOf(f);
	if (lists.some(l => l.ring)) return [ll[0], ll[1]];        // 面＝クリックした点
	return nearestOnLine(model, f, ll) || popAnchorLL(model, f);   // 線＝クリック点に最寄りの線分上
}

export function createPopLayer(map, getState) {
	let popFn = null;                 // map.gadget.pop() は初回に遅延搭載（_update は frameHooks へ自動配線）
	const boxes = new Map();          // eid → { div, text }（今 DOM に出ている箱）
	const opened = new Map();         // 明示的に開いた eid → { pos:[x,y]|null, anchor:[lng,lat] }

	const dropBox = eid => { const b = boxes.get(eid); if (b) { b.div._remove?.(); boxes.delete(eid); } };
	const close = eid => { dropBox(eid); opened.delete(eid); };
	const clear = () => { for (const eid of [...opened.keys()]) close(eid); };

	// 明示的に開く。@pop が空なら何も出さない。at={x,y,ll}＝クリック点（初期位置＝x,y／参照点＝ll 基準）。
	function open(eid, at) {
		const st = getState();
		const f = st.model?.feats.get(eid);
		const raw = f?.properties?.["@pop"];
		if (raw == null || raw === "") return;
		const anchor = popAnchorAt(st.model, f, at?.ll);
		if (!anchor) return;
		opened.set(eid, { pos: at ? [at.x, at.y] : null, anchor });
		sync();
	}

	// 開いている箱だけを現在のモデルへ追随（生成/文言/退避/除去）。参照点は open 時に確定した固定値。
	function sync() {
		const st = getState();
		if (!st.model) return clear();
		const hidden = st.hidden;
		for (const eid of [...opened.keys()]) {
			const f = st.model.feats.get(eid);
			const raw = f?.properties?.["@pop"];
			if (!f || raw == null || raw === "") { close(eid); continue; }   // 削除・@pop除去＝開き自体も畳む
			if (hidden && hidden.has(eid)) { close(eid); continue; }         // 移動/編集が始まった要素＝pop は消す（本人裁定：着地で復活させない）
			const ent = opened.get(eid), a = ent.anchor;
			popFn ??= map.gadget.pop();
			const text = String(raw);
			const cur = boxes.get(eid);
			if (!cur) {
				const s = ent.pos || map.projectLL(a[0], a[1]);   // 初期位置＝クリック点（無ければ錨の脇）
				const div = popFn(text, { lng: a[0], lat: a[1], x: s[0], y: s[1], hideOffscreen: true, onClose: () => close(eid) });
				if (div) { boxes.set(eid, { div, text }); ent.pos = null; }   // 初期位置は使い切り
			} else if (cur.text !== text) {
				cur.div._setContent(text); cur.text = text;
			}
		}
	}

	return { open, close, sync, clear, destroy: clear };
}
