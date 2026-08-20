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
		panel.innerHTML = `<h3>スタイル #${eid}（${kindLabel}）</h3>`;

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
		const tog = Object.assign(document.createElement("button"), { textContent: "属性を表示 ▸" });
		const closeB = Object.assign(document.createElement("button"), { textContent: "閉じる" });
		closeB.onclick = close;
		togBar.append(tog, closeB);
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
