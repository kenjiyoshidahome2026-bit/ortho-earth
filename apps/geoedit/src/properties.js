// 選択パネル：スタイル編集（styleform＝日本語UI・型別）を主役に、生の属性テーブルは
// 「属性を表示」を開いた時だけ出す（GIS素人が最初にkey/value表と対面しない＝本人裁定 8/20）。
// スタイル変更は input中=即プレビュー（履歴なし）・確定=props コマンド1件（undo可）。
import { styleForm } from "./styleform.js";

export function createPropsPanel(container, api, signal) {   // api={getFeature(eid), applyProps(eid,next,{history,from}), toast}
	let panel = null, curEid = null;

	const close = () => { panel?.remove(); panel = null; curEid = null; };

	const merge = (cur, partial) => {
		const next = { ...cur };
		for (const [k, v] of Object.entries(partial)) {
			if (v === "" || v == null) delete next[k];
			else next[k] = v;
		}
		return next;
	};

	const render = eid => {
		close();
		const f = api.getFeature(eid);
		if (!f) return;
		curEid = eid;
		panel = document.createElement("div");
		panel.className = "ge-panel";
		const kindLabel = f.type.includes("Poly") ? "面" : f.type.includes("Line") ? "線" : "点";
		// タイトル行＝見出し＋削除＋閉じる（本人裁定：閉じる/削除はここに集約）
		const head = document.createElement("div");
		head.className = "ge-head";
		const h3 = document.createElement("h3"); h3.textContent = `#${eid}（${kindLabel}）`;
		// 削除／閉じるは同じ太さ・サイズの単色ラインアイコンで揃える（絵文字🗑は色付きで浮くため）
		const svg = d => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
		const delB = Object.assign(document.createElement("button"), { className: "ge-icon-btn", innerHTML: svg('<path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v6M14 11v6"/>'), title: "この要素を削除" });
		const closeH = Object.assign(document.createElement("button"), { className: "ge-icon-btn", innerHTML: svg('<path d="M6 6l12 12M18 6L6 18"/>'), title: "閉じる" });
		delB.onclick = () => { const e = curEid; close(); api.onDelete?.(e); };
		closeH.onclick = close;
		head.append(h3, delB, closeH);
		panel.append(head);

		// input中のプレビューを跨いで undo の戻り先を守る：最初のプレビューで元propsを控える
		let pendingFrom = null;
		styleForm(panel, {
			geomType: f.type,
			get: () => api.getFeature(eid)?.properties,
			set: (partial, final) => {
				const cur = api.getFeature(eid)?.properties;
				if (!cur) return;
				const next = merge(cur, partial);
				if (!final) { pendingFrom ??= { ...cur }; api.applyProps(eid, next, { history: false }); return; }
				api.applyProps(eid, next, { history: true, from: pendingFrom ?? { ...cur } });
				pendingFrom = null;
			},
		}, signal);

		// ---- 属性を表示（生の key/value テーブル＝上級者向け・開いた時だけ）----
		const togBar = document.createElement("div");
		togBar.className = "ge-attrbar";
		const tog = Object.assign(document.createElement("button"), { textContent: "属性を表示 ▸" });
		togBar.append(tog);
		panel.append(togBar);
		let attr = null;
		tog.onclick = () => {
			if (attr) { attr.remove(); attr = null; tog.textContent = "属性を表示 ▸"; return; }
			tog.textContent = "属性を隠す ▾";
			attr = document.createElement("div");
			const table = document.createElement("table");
			const rows = [];
			const addRow = (k, v, orig) => {
				const tr = document.createElement("tr");
				const tdK = document.createElement("td"), tdV = document.createElement("td");
				const ik = Object.assign(document.createElement("input"), { value: k, placeholder: "属性名" });
				const iv = Object.assign(document.createElement("input"), { value: v, placeholder: "値" });
				if (orig instanceof Blob) { ik.disabled = iv.disabled = true; }   // 画像バイナリ＝表からは触らせない（適用で原本維持）
				tdK.append(ik); tdV.append(iv);
				tr.append(tdK, tdV);
				table.append(tr);
				rows.push([ik, iv, orig]);
			};
			const entries = Object.entries(api.getFeature(eid)?.properties || {});
			entries.sort(([a], [b]) => (b.startsWith("@")) - (a.startsWith("@")) || a.localeCompare(b));
			for (const [k, v] of entries) addRow(k, v instanceof Blob ? `（画像 ${(v.size / 1024).toFixed(1)}KB＝BUFS一個書き）` : typeof v === "string" ? v : JSON.stringify(v), v);
			addRow("", "");
			attr.append(table);
			const applyB = Object.assign(document.createElement("button"), { textContent: "適用" });
			applyB.onclick = () => {
				const next = {};
				for (const [ik, iv, orig] of rows) {
					const k = ik.value.trim();
					if (!k) continue;
					if (orig instanceof Blob) { next[k] = orig; continue; }   // 画像は原本のまま
					let v = iv.value;
					if (v !== "" && !isNaN(+v) && k !== "@icon") v = +v;
					next[k] = v;
				}
				api.applyProps(eid, next, { history: true });
				api.toast("属性を適用しました");
				render(eid);   // スタイル節も含めて新しい姿へ
			};
			const addB = Object.assign(document.createElement("button"), { textContent: "＋行" });
			addB.onclick = () => addRow("", "");
			// Enter=適用（textarea内の改行は除く）
			attr.addEventListener("keydown", e => {
				if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") { e.preventDefault(); e.stopPropagation(); applyB.click(); }
			});
			attr.append(applyB, addB);
			panel.insertBefore(attr, togBar);
		};

		container.append(panel);
	};

	return { render, close, get eid() { return curEid; } };
}
