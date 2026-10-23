// sokutei の画面の配線（素の DOM）。算術は measure.js、換算は weight.js、保存は store.js。
// 流れ：home で撮る／選ぶ → measure（写真を pan/zoom・点をタップ・結果が即時に出る・保存）→ list（見返し・実測体重の追記・CSV）。
// 点の順＝基準物（a4：左上→右上→右下→左下の 4 隅／line：2 点）→ 鼻先 → 尾の付け根 →（任意）体の途中の点。点はドラッグで動かせる（拡大鏡付き）。
import { measure, REF_PRESETS } from "./measure.js";
import { SPECIES, speciesOf, estimateWeight, fitK, fitC, errorStats } from "./weight.js";
import { listRecords, putRecord, deleteRecord, getRecord, newId, loadSettings, saveSettings, toCSV } from "./store.js";

const $ = (s, el = document) => el.querySelector(s);
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) k === "class" ? e.className = v : k.startsWith("on") ? e.addEventListener(k.slice(2), v) : e.setAttribute(k, v); e.append(...kids); return e; };
const fmt1 = x => x == null ? "—" : (Math.round(x * 10) / 10).toLocaleString("ja-JP", { maximumFractionDigits: 1 });

let settings = loadSettings();
const coefOf = id => settings.coef?.[id] || {};

// ---- 画面の切り替え ----
const screens = ["home", "measure", "list", "settings"].map(id => $("#" + id));
function show(id) { for (const s of screens) s.hidden = s.id !== id; }

// ---- home ----
$("#shoot").addEventListener("change", e => e.target.files[0] && openPhoto(e.target.files[0]));
$("#pick").addEventListener("change", e => e.target.files[0] && openPhoto(e.target.files[0]));
$("#toList").addEventListener("click", () => renderList().then(() => show("list")));
$("#toSettings").addEventListener("click", () => { renderSettings(); show("settings"); });
$("#lBack").addEventListener("click", () => { refreshCount(); show("home"); });
$("#sBack").addEventListener("click", () => show("home"));
async function refreshCount() { $("#count").textContent = (await listRecords()).length; }
refreshCount();
// iOS Safari はインストールの催しが無い＝ホーム画面に追加の案内を一度だけ出す（スタンドアロンで開いていれば出さない）
if (/iP(hone|ad|od)/.test(navigator.userAgent) && !navigator.standalone && !matchMedia("(display-mode: standalone)").matches) $("#installHint").hidden = false;

// ---- measure：状態 ----
const M = { img: null, W: 0, H: 0, tx: 0, ty: 0, s: 1, ref: [], body: [], mode: "a4", refSize: { w: 297, h: 210 }, file: null };
const view = $("#view"), stage = $("#stage"), photo = $("#photo"), marks = $("#marks"), loupe = $("#loupe"), panel = $("#panel");
const F = panel.elements;

// セレクタの中身
for (const s of SPECIES) F.species.append(el("option", { value: s.id }, s.name));
for (const r of REF_PRESETS) F.ref.append(el("option", { value: r.id }, r.name));
F.ref.append(el("option", { value: "line" }, "既知の長さの 2 点（メジャー等）"));
F.species.value = settings.species || "boar";
F.ref.value = settings.ref?.id || "a4";
if (settings.ref?.id === "custom") { F.refW.value = settings.ref.w; F.refH.value = settings.ref.h; }
if (settings.line?.len) F.refLen.value = settings.line.len;

async function openPhoto(file) {
	M.file = file; M.ref = []; M.body = [];
	$("#step").textContent = "写真を読み込み中…";
	show("measure");
	const url = URL.createObjectURL(file);
	await new Promise((ok, ng) => { photo.onload = ok; photo.onerror = ng; photo.src = url; });
	M.img = photo; M.W = photo.naturalWidth; M.H = photo.naturalHeight;
	marks.setAttribute("width", M.W); marks.setAttribute("height", M.H); marks.setAttribute("viewBox", `0 0 ${M.W} ${M.H}`);
	fit(); redraw();
}
function fit() {
	const r = view.getBoundingClientRect();
	if (!(r.width > 0 && r.height > 0)) return;   // 画面が hidden の間（0×0）は何もしない（s=0 → 1/s=∞ の印を描かない）
	M.s = Math.min(r.width / M.W, r.height / M.H);
	M.tx = (r.width - M.W * M.s) / 2; M.ty = (r.height - M.H * M.s) / 2;
	applyT();
}
const applyT = () => { stage.style.transform = `translate(${M.tx}px,${M.ty}px) scale(${M.s})`; drawMarks(); };
// 舞台の大きさが変わったら（画面の回転・下の板が伸びた・キーボードが出た）写真を収め直す。点は画像の画素座標＝影響なし
new ResizeObserver(() => { if (M.img && !gesture) fit(); }).observe(view);

// 画面座標 ↔ 画像の画素
const toImg = (cx, cy) => { const r = view.getBoundingClientRect(); return [(cx - r.left - M.tx) / M.s, (cy - r.top - M.ty) / M.s]; };
const toScr = ([x, y]) => { const r = view.getBoundingClientRect(); return [x * M.s + M.tx + r.left, y * M.s + M.ty + r.top]; };

// 点の並び＝基準物の点 → 個体の点（表示・ヒット判定・取り消しに使う）
const refNeed = () => M.mode === "line" ? 2 : 4;
const allPts = () => [...M.ref.map((p, i) => ({ p, kind: "ref", i })), ...M.body.map((p, i) => ({ p, kind: "body", i }))];
// 4 隅は周りに沿って・**長い辺の端から**（1→2 が長辺＝measure.js の homographyFromQuad の約束。斜め撮りでは画素の長さで長辺を当てられない）
const REF_LABEL = { a4: ["基準物の隅①（長い辺の端）", "隅②（同じ長い辺のもう一端）", "隅③（②の隣・短い辺の先）", "隅④（残りの隅）"], line: ["基準の一方の端", "基準のもう一方の端"] };
function nextLabel() {
	if (M.ref.length < refNeed()) return "次：" + REF_LABEL[M.mode === "line" ? "line" : "a4"][M.ref.length] + " をタップ";
	if (M.body.length === 0) return "次：鼻先 をタップ";
	if (M.body.length === 1) return "次：尾の付け根 をタップ";
	return "体が曲がっていれば背中線の途中もタップ（点はドラッグで直せる）";
}

function addPoint(p) {
	if (M.ref.length < refNeed()) M.ref.push(p); else M.body.push(p);
	redraw();
}
$("#undo").addEventListener("click", () => { if (M.body.length) M.body.pop(); else M.ref.pop(); redraw(); });
$("#clearPts").addEventListener("click", () => { M.ref = []; M.body = []; redraw(); });
$("#mBack").addEventListener("click", () => { if (!M.ref.length && !M.body.length || confirm("この測定を捨てて戻りますか？")) { show("home"); refreshCount(); } });

// 基準物の種類・寸法が変わったら、基準物の点は捨てる（意味が変わる）
function readRef() {
	const id = F.ref.value;
	$("#customRef").hidden = id !== "custom"; $("#lineRef").hidden = id !== "line";
	const mode = id === "line" ? "line" : "a4";
	if (mode !== M.mode) { M.ref = []; M.mode = mode; }
	if (id === "line") M.refSize = { len: +F.refLen.value || 0 };
	else if (id === "custom") M.refSize = { w: +F.refW.value || 0, h: +F.refH.value || 0 };
	else { const r = REF_PRESETS.find(r => r.id === id); M.refSize = { w: r.w, h: r.h }; }
	settings.ref = id === "custom" ? { id, w: M.refSize.w, h: M.refSize.h } : { id };
	if (id === "line") settings.line = { len: M.refSize.len };
	saveSettings(settings);
}
F.ref.addEventListener("change", () => { readRef(); redraw(); });
for (const n of ["refW", "refH", "refLen"]) F[n].addEventListener("input", () => { readRef(); redraw(); });
F.species.addEventListener("change", () => { settings.species = F.species.value; saveSettings(settings); redraw(); });
for (const n of ["girth", "actWeight"]) F[n].addEventListener("input", redraw);
readRef();

// 結果の計算と表示
let last = { cm: null, kg: null, method: null };
function redraw() {
	drawMarks();
	$("#step").textContent = nextLabel();
	const r = M.img ? measure({ mode: M.mode, ref: M.ref, refSize: M.refSize, body: M.body }) : { cm: null };
	const girth = +F.girth.value || null;
	const w = estimateWeight({ species: F.species.value, length: r.cm, girth, coef: coefOf(F.species.value) });
	last = { cm: r.cm, kg: w.kg, method: w.method };
	$("#outLen").textContent = fmt1(r.cm);
	$("#outWt").textContent = fmt1(w.kg);
	$("#outHow").textContent = w.method === "girth" ? "（体長＋胸囲）" : w.method === "length" ? "（体長から・目安）" : speciesOf(F.species.value).k == null && r.cm ? "（この獣種は式なし）" : "";
	$("#readout").textContent = r.cm ? `体長 ${fmt1(r.cm)} cm` + (w.kg ? ` ／ 約 ${fmt1(w.kg)} kg` : "") : "";
	const warn = r.warn || (M.mode === "line" && r.cm ? "2 点方式は真上から撮った写真でだけ正しく出ます（4 隅方式を推奨）" : "");
	$("#warn").textContent = warn; $("#warn").hidden = !warn;
	$("#save").disabled = !(r.cm > 0);
}

// SVG の印：基準物は四角と番号、個体は折れ線と鼻先・尾。半径は画面上で一定（1/s）
function drawMarks() {
	if (!M.img) return;
	const k = 1 / M.s, r = 9 * k, sw = 2 * k, fs = 13 * k;
	let svg = "";
	if (M.ref.length) svg += `<polygon points="${M.ref.map(p => p.join(",")).join(" ")}" fill="rgba(80,160,255,.12)" stroke="#4da3ff" stroke-width="${sw}" ${M.ref.length < refNeed() ? 'stroke-dasharray="' + 6 * k + '"' : ""}/>`;
	if (M.body.length > 1) svg += `<polyline points="${M.body.map(p => p.join(",")).join(" ")}" fill="none" stroke="#f5c542" stroke-width="${sw * 1.5}"/>`;
	for (const { p, kind, i } of allPts()) {
		const c = kind === "ref" ? "#4da3ff" : "#f5c542", lab = kind === "ref" ? String(i + 1) : i === 0 ? "鼻" : i === 1 ? "尾" : "";
		svg += `<circle cx="${p[0]}" cy="${p[1]}" r="${r}" fill="${c}" fill-opacity=".25" stroke="${c}" stroke-width="${sw}"/><circle cx="${p[0]}" cy="${p[1]}" r="${sw}" fill="${c}"/>`;
		if (lab) svg += `<text x="${p[0] + r * 1.3}" y="${p[1] - r * 0.6}" font-size="${fs}" fill="${c}" stroke="#000" stroke-width="${k * 3}" paint-order="stroke" font-weight="700">${lab}</text>`;
	}
	marks.innerHTML = svg;
}

// ---- pan / zoom / タップ / ドラッグ（Pointer Events・2 本指ピンチ）----
const ptrs = new Map();
let gesture = null;   // { kind:"pan"|"pinch"|"drag", ... }
view.addEventListener("pointerdown", e => {
	if (!M.img) return;
	view.setPointerCapture(e.pointerId);
	ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() });
	if (ptrs.size === 2) {
		const [a, b] = [...ptrs.values()];
		gesture = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y), s0: M.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, tx0: M.tx, ty0: M.ty };
		loupe.hidden = true;
		return;
	}
	// 既存の点を掴んだか（画面上 22px 以内）
	const hit = allPts().map(o => ({ o, d: Math.hypot(...toScr(o.p).map((v, i) => v - [e.clientX, e.clientY][i])) })).filter(h => h.d < 22).sort((a, b) => a.d - b.d)[0];
	gesture = hit ? { kind: "drag", o: hit.o, off: [hit.o.p[0] - toImg(e.clientX, e.clientY)[0], hit.o.p[1] - toImg(e.clientX, e.clientY)[1]] } : { kind: "pan", tx0: M.tx, ty0: M.ty };
	if (gesture.kind === "drag") showLoupe(hit.o.p);
});
view.addEventListener("pointermove", e => {
	const p = ptrs.get(e.pointerId); if (!p || !gesture) return;
	p.x = e.clientX; p.y = e.clientY;
	if (gesture.kind === "pinch" && ptrs.size === 2) {
		const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
		const s = Math.min(Math.max(gesture.s0 * d / gesture.d0, 0.05), 40), r = view.getBoundingClientRect();
		// 2 本指の中点が画像の同じ点を指し続けるように
		const ix = (gesture.mx - r.left - gesture.tx0) / gesture.s0, iy = (gesture.my - r.top - gesture.ty0) / gesture.s0;
		M.s = s; M.tx = mx - r.left - ix * s; M.ty = my - r.top - iy * s; applyT();
	} else if (gesture.kind === "pan") {
		M.tx = gesture.tx0 + p.x - p.x0; M.ty = gesture.ty0 + p.y - p.y0; applyT();
	} else if (gesture.kind === "drag") {
		const q = toImg(e.clientX, e.clientY), np = [Math.min(Math.max(q[0] + gesture.off[0], 0), M.W), Math.min(Math.max(q[1] + gesture.off[1], 0), M.H)];
		(gesture.o.kind === "ref" ? M.ref : M.body)[gesture.o.i] = np;
		showLoupe(np); redraw();
	}
});
const endPtr = e => {
	const p = ptrs.get(e.pointerId); ptrs.delete(e.pointerId);
	if (!p || !gesture) return;
	if (gesture.kind === "pan" && ptrs.size === 0 && Math.hypot(p.x - p.x0, p.y - p.y0) < 8 && performance.now() - p.t0 < 500 && e.type === "pointerup") {
		const q = toImg(e.clientX, e.clientY);
		if (q[0] >= 0 && q[1] >= 0 && q[0] <= M.W && q[1] <= M.H) addPoint(q);
	}
	if (ptrs.size === 0) { gesture = null; loupe.hidden = true; }
	else if (gesture.kind === "pinch") { const [a] = [...ptrs.values()]; a.x0 = a.x; a.y0 = a.y; gesture = { kind: "pan", tx0: M.tx, ty0: M.ty }; }
};
view.addEventListener("pointerup", endPtr); view.addEventListener("pointercancel", endPtr);
view.addEventListener("wheel", e => {   // PC：ホイールで拡大縮小（マウスの位置を軸に）
	e.preventDefault(); const r = view.getBoundingClientRect(), f = Math.exp(-e.deltaY * 0.0015), s = Math.min(Math.max(M.s * f, 0.05), 40);
	const ix = (e.clientX - r.left - M.tx) / M.s, iy = (e.clientY - r.top - M.ty) / M.s;
	M.s = s; M.tx = e.clientX - r.left - ix * s; M.ty = e.clientY - r.top - iy * s; applyT();
}, { passive: false });

// 拡大鏡：掴んだ点の周りを 4 倍で丸く見せる＋十字
function showLoupe([x, y]) {
	loupe.hidden = false;
	const g = loupe.getContext("2d"), n = loupe.width, z = 4, half = n / z / 2;
	g.fillStyle = "#000"; g.fillRect(0, 0, n, n);
	g.drawImage(M.img, x - half, y - half, half * 2, half * 2, 0, 0, n, n);
	g.strokeStyle = "#f5c542"; g.lineWidth = 1; g.beginPath(); g.moveTo(n / 2, 0); g.lineTo(n / 2, n); g.moveTo(0, n / 2); g.lineTo(n, n / 2); g.stroke();
}

// ---- 保存 ----
panel.addEventListener("submit", async e => {
	e.preventDefault();
	if (!(last.cm > 0)) return;
	$("#save").disabled = true; $("#save").textContent = "保存中…";
	const rec = {
		id: newId(), at: new Date().toISOString(), species: F.species.value, sex: F.sex.value, age: F.age.value,
		length: Math.round(last.cm * 10) / 10, girth: +F.girth.value || null, estWeight: last.kg, estMethod: last.method, actWeight: +F.actWeight.value || null,
		lat: null, lon: null, note: F.note.value.trim(), refMode: M.mode, refSize: M.refSize, points: { ref: M.ref, body: M.body, imgW: M.W, imgH: M.H },
		thumb: thumbnail(640),
	};
	if (F.geo.checked && navigator.geolocation) {
		const pos = await new Promise(ok => navigator.geolocation.getCurrentPosition(p => ok(p), () => ok(null), { timeout: 8000, maximumAge: 60000 }));
		if (pos) { rec.lat = +pos.coords.latitude.toFixed(6); rec.lon = +pos.coords.longitude.toFixed(6); }
	}
	await putRecord(rec);
	$("#save").textContent = "保存"; F.girth.value = F.actWeight.value = F.note.value = "";
	await renderList(); show("list");
});
function thumbnail(max) {
	const s = Math.min(1, max / Math.max(M.W, M.H)), c = document.createElement("canvas");
	c.width = Math.round(M.W * s); c.height = Math.round(M.H * s);
	const g = c.getContext("2d"); g.drawImage(M.img, 0, 0, c.width, c.height);
	// 印も焼き込む（見返した時にどこを測ったか分かる）
	g.lineWidth = 2; g.strokeStyle = "#4da3ff"; if (M.ref.length > 1) { g.beginPath(); M.ref.forEach(([x, y], i) => i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)); g.closePath(); g.stroke(); }
	g.strokeStyle = "#f5c542"; g.lineWidth = 3; if (M.body.length > 1) { g.beginPath(); M.body.forEach(([x, y], i) => i ? g.lineTo(x * s, y * s) : g.moveTo(x * s, y * s)); g.stroke(); }
	return c.toDataURL("image/jpeg", 0.8);
}

// ---- 記録一覧 ----
async function renderList() {
	const recs = await listRecords(), box = $("#records");
	box.replaceChildren();
	$("#count").textContent = recs.length;
	if (!recs.length) { box.append(el("div", { class: "empty" }, "記録はまだありません")); return; }
	for (const r of recs) {
		box.append(el("div", { class: "rec", onclick: () => openDetail(r.id) },
			el("img", { src: r.thumb || "", alt: "" }),
			el("div", {}, el("div", { class: "t" }, r.at.replace("T", " ").slice(0, 16) + "　" + speciesOf(r.species).name + (r.sex ? "・" + { m: "オス", f: "メス" }[r.sex] : "") + (r.age ? "・" + { adult: "成獣", young: "幼獣" }[r.age] : "")),
				el("div", { class: "v" }, "体長 ", el("b", {}, fmt1(r.length)), " cm　", ...(r.estWeight != null ? ["約 ", el("b", {}, fmt1(r.estWeight)), " kg"] : []), r.actWeight ? `（実測 ${fmt1(r.actWeight)} kg）` : "")),
			el("div", { class: "t" }, r.lat != null ? "📍" : "")));
	}
}
async function openDetail(id) {
	const r = await getRecord(id); if (!r) return;
	const d = $("#detail");
	const act = el("input", { type: "number", inputmode: "decimal", step: "any", min: "0.1", value: r.actWeight ?? "" });
	const girth = el("input", { type: "number", inputmode: "decimal", step: "any", min: "1", value: r.girth ?? "" });
	const note = el("input", { type: "text", value: r.note || "" });
	d.replaceChildren(
		el("img", { src: r.thumb || "", alt: "" }),
		el("p", {}, `${r.at.replace("T", " ").slice(0, 16)}　${speciesOf(r.species).name}　体長 ${fmt1(r.length)} cm　推定 ${fmt1(r.estWeight)} kg` + (r.lat != null ? `　(${r.lat}, ${r.lon})` : "")),
		el("div", { class: "row" }, el("label", {}, "胸囲 cm", girth), el("label", {}, "実測体重 kg（量ったら入れる）", act)),
		el("label", {}, "メモ", note),
		el("div", { class: "row" },
			el("button", { class: "btn danger", onclick: async () => { if (confirm("この記録を削除しますか？")) { await deleteRecord(id); d.close(); renderList(); } } }, "削除"),
			el("button", { class: "btn", onclick: () => d.close() }, "閉じる"),
			el("button", { class: "btn primary", onclick: async () => {
				r.actWeight = +act.value || null; r.girth = +girth.value || null; r.note = note.value.trim();
				const w = estimateWeight({ species: r.species, length: r.length, girth: r.girth, coef: coefOf(r.species) }); r.estWeight = w.kg; r.estMethod = w.method;
				await putRecord(r); d.close(); renderList();
			} }, "保存")));
	d.showModal();
}
$("#exportCsv").addEventListener("click", async () => {
	const recs = await listRecords(); if (!recs.length) return alert("記録がありません");
	const csv = toCSV(recs, id => speciesOf(id).name), name = `sokutei-${new Date().toISOString().slice(0, 10)}.csv`;
	const file = new File([csv], name, { type: "text/csv" });
	if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return; } catch { /* 取り消し＝下の保存へ */ } }
	const a = el("a", { href: URL.createObjectURL(file), download: name }); document.body.append(a); a.click(); a.remove();
});

// ---- 設定 ----
async function renderSettings() {
	const box = $("#coefs"); box.replaceChildren();
	for (const s of SPECIES.filter(s => s.k != null)) {
		const c = coefOf(s.id);
		const k = el("input", { type: "number", step: "any", value: c.k ?? s.k }), cc = el("input", { type: "number", step: "any", value: c.c ?? s.c });
		const upd = () => { settings.coef = settings.coef || {}; settings.coef[s.id] = { k: +k.value || s.k, c: +cc.value || s.c }; saveSettings(settings); };
		k.addEventListener("input", upd); cc.addEventListener("input", upd);
		box.append(el("div", { class: "coef" }, el("div", { class: "nm" }, s.name), el("label", {}, "k（体長だけ）", k), el("label", {}, "c（体長＋胸囲）", cc)));
	}
	const recs = await listRecords(), st = errorStats(recs, coefOf);
	$("#fitInfo").textContent = st ? `実測体重のある記録 ${st.n} 件に対し、今の係数での推定の誤差は中央値 ${st.medianPct}%` : "実測体重のある記録がまだありません（記録を開いて実測体重を入れると、ここで係数を出し直せます）";
	const defRef = $("#defRef"); defRef.replaceChildren(...REF_PRESETS.filter(r => r.id !== "custom").map(r => el("option", { value: r.id }, r.name)), el("option", { value: "line" }, "既知の長さの 2 点"));
	defRef.value = settings.ref?.id && settings.ref.id !== "custom" ? settings.ref.id : "a4";
	defRef.onchange = () => { settings.ref = { id: defRef.value }; saveSettings(settings); F.ref.value = defRef.value; readRef(); };
}
$("#fitBtn").addEventListener("click", async () => {
	const recs = await listRecords(); const msgs = [];
	for (const s of SPECIES.filter(s => s.k != null)) {
		const rs = recs.filter(r => r.species === s.id), k = fitK(rs), c = fitC(rs);
		if (k == null && c == null) { msgs.push(`${s.name}：実測体重のある記録が 3 件未満`); continue; }
		settings.coef = settings.coef || {}; settings.coef[s.id] = { k: k ?? coefOf(s.id).k ?? s.k, c: c ?? coefOf(s.id).c ?? s.c };
		msgs.push(`${s.name}：k=${(k ?? coefOf(s.id).k).toExponential(2)}（${rs.filter(r => r.actWeight > 0).length} 件）` + (c != null ? `・c=${Math.round(c)}` : ""));
	}
	saveSettings(settings); renderSettings(); alert(msgs.join("\n"));
});
$("#resetCoef").addEventListener("click", () => { delete settings.coef; saveSettings(settings); renderSettings(); });

// ---- サービスワーカー（本番だけ）----
if (import.meta.env.PROD && "serviceWorker" in navigator) navigator.serviceWorker.register(import.meta.env.BASE_URL + "sw.js", { scope: import.meta.env.BASE_URL }).catch(() => {});
