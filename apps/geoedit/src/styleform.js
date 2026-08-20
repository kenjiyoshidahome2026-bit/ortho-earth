// スタイル入力フォーム（GIS素人向けの日本語UI）＝@プロパティを直接見せない編集面。
// 点/線/面でコントロールが変わる共通部品：選択中フィーチャの編集（properties.js）と
// 作図ツールの既定スタイル（toolbar.js）の両方から使う。
//   面: 面の色(picker)＋塗りの濃さ(スライダー) / 線の色 / 線幅(1–10px)
//   線: 線の色 / 線幅
//   点: シンボル（アイコン/基本図形/テキスト）・大きさ（大中小）・色
//   共通: ツールチップ(@tip)・吹き出し(@pop)＝改行できる textarea
// set(partial, final)：input中= final:false（即プレビュー・履歴なし）、確定（change）= final:true（undo1件）。
// 値 "" は「そのキーを消す」の意（呼び出し側で delete）。
import { ICON_NAMES, SHAPE_NAMES, iconURI } from "./overlay.js";
import { cssColor, DEF } from "./gint-layer.js";

const u32rgb = u => "#" + (u >>> 8).toString(16).padStart(6, "0");
const u32alpha = u => (u & 255) / 255;
const hex8 = (rgb, alpha) => rgb + Math.round(alpha * 255).toString(16).padStart(2, "0");
const TYPE_OF = t => t.includes("Poly") ? "polygon" : t.includes("Line") ? "line" : "point";

// variant（点のみ）："symbol"＝アイコン/図形系・"text"＝テキストラベル系（パネル分離＝本人裁定 8/20）。
// 省略時は中身から自動判定（@text だけ持つ点＝text、それ以外＝symbol）。
export function styleForm(host, { geomType, variant, get, set }, signal) {
	const kind = TYPE_OF(geomType);
	const props = () => get() || {};
	const row = label => {
		const d = document.createElement("div");
		d.className = "ge-row";
		const l = document.createElement("label");
		l.textContent = label;
		d.append(l);
		host.append(d);
		return d;
	};

	// ---- 色（picker）。alphaKey=true なら濃さスライダーを添えて #rrggbbaa に合成 ----
	const colorRow = (label, key, defU32, withAlpha) => {
		const d = row(label);
		const cur = cssColor(props()[key]) ?? defU32;
		const c = Object.assign(document.createElement("input"), { type: "color", value: u32rgb(cur) });
		let alpha = withAlpha ? u32alpha(cur) : 1;
		const emit = final => set({ [key]: withAlpha ? hex8(c.value, alpha) : c.value }, final);
		c.addEventListener("input", () => emit(false), { signal });
		c.addEventListener("change", () => emit(true), { signal });
		d.append(c);
		if (withAlpha) {
			const a = Object.assign(document.createElement("input"), { type: "range", min: 5, max: 100, value: Math.round(alpha * 100), title: "塗りの濃さ" });
			const av = document.createElement("span");
			av.className = "ge-val";
			av.textContent = Math.round(alpha * 100) + "%";
			a.addEventListener("input", () => { alpha = +a.value / 100; av.textContent = a.value + "%"; emit(false); }, { signal });
			a.addEventListener("change", () => emit(true), { signal });
			d.append(a, av);
		}
	};

	// ---- 線幅（1–10px スライダー）----
	const widthRow = () => {
		const d = row("線幅");
		const cur = +props()["@width"] > 0 ? +props()["@width"] : DEF.widthPx;
		const w = Object.assign(document.createElement("input"), { type: "range", min: 1, max: 10, step: 0.5, value: cur });
		const v = document.createElement("span");
		v.className = "ge-val";
		v.textContent = cur + "px";
		w.addEventListener("input", () => { v.textContent = w.value + "px"; set({ "@width": +w.value }, false); }, { signal });
		w.addEventListener("change", () => set({ "@width": +w.value }, true), { signal });
		d.append(w, v);
	};

	// ---- 大きさ（大中小）----
	const mark = (container, b) => container.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
	const sizeRow = () => {
		const dsz = row("大きさ");
		const curSize = +props()["@size"] > 0 ? +props()["@size"] : 24;
		for (const [label, px] of [["小", 16], ["中", 24], ["大", 36]]) {
			const b = document.createElement("button");
			b.textContent = label;
			if (px === curSize) b.classList.add("on");
			b.addEventListener("click", () => { set({ "@size": px }, true); mark(dsz, b); }, { signal });
			dsz.append(b);
		}
	};

	// ---- 点（アイコン/図形系）----
	const symbolRows = () => {
		const ds = row("基本図形");   // マーカー・旗・星も図形＝色が変えられる（本人裁定 8/20）
		const GLYPH = { pin: "📍", circle: "●", square: "■", triangle: "▲", diamond: "◆", star: "★", flag: "⚑" };
		for (const s of SHAPE_NAMES) {
			const b = document.createElement("button");
			b.textContent = GLYPH[s];
			b.title = s;
			if (props()["@shape"] === s) b.classList.add("on");
			b.addEventListener("click", () => { set({ "@shape": s, "@icon": "" }, true); mark(ds, b); mark(di, null); }, { signal });
			ds.append(b);
		}
		const di = row("アイコン");
		for (const name of ICON_NAMES) {
			const b = document.createElement("button");
			b.title = name;
			b.append(Object.assign(new Image(18, 18), { src: iconURI(name) }));
			if (props()["@icon"] === name) b.classList.add("on");
			b.addEventListener("click", () => { set({ "@icon": name, "@shape": "" }, true); mark(di, b); mark(ds, null); }, { signal });
			di.append(b);
		}
		const dz = row("画像→アイコン");
		const zone = document.createElement("div");
		zone.className = "ge-drop";
		zone.textContent = "PNG/SVG をここへドロップ";
		zone.addEventListener("dragover", e => e.preventDefault(), { signal });
		zone.addEventListener("drop", e => {
			e.preventDefault(); e.stopPropagation();
			const f = e.dataTransfer.files?.[0];
			if (!f || !/^image\//.test(f.type)) return;
			const rd = new FileReader();
			rd.onload = () => { set({ "@icon": rd.result, "@shape": "" }, true); zone.textContent = `✓ ${f.name}`; mark(di, null); mark(ds, null); };
			rd.readAsDataURL(f);
		}, { signal });
		dz.append(zone);
	};

	// ---- 点（テキスト系）＝文字が本体（改行可・@sizeがフォント寸）----
	const textRows = () => {
		const dt = row("文字");
		const tx = Object.assign(document.createElement("textarea"), { rows: 2, placeholder: "地図に置く文字（改行可）", value: props()["@text"] ?? "" });
		tx.addEventListener("change", () => set({ "@text": tx.value }, true), { signal });
		dt.append(tx);
	};

	// ---- 型ごとの構成 ----
	if (kind === "polygon") { colorRow("面の色", "@fill", DEF.fill, true); colorRow("線の色", "@stroke", DEF.stroke, false); widthRow(); }
	else if (kind === "line") { colorRow("線の色", "@stroke", DEF.stroke, false); widthRow(); }
	else {
		const v = variant ?? (props()["@text"] && !props()["@icon"] && !props()["@shape"] ? "text" : "symbol");
		if (v === "text") { textRows(); sizeRow(); colorRow("文字の色", "@fill", 0x223344ff, false); }
		else { symbolRows(); sizeRow(); colorRow("色", "@fill", 0xcc4444ff, false); }
	}

	// ---- 共通：tip / pop（改行できる）----
	const ta = (label, key, ph) => {
		const d = row(label);
		const t = Object.assign(document.createElement("textarea"), { rows: 2, placeholder: ph, value: props()[key] ?? "" });
		t.addEventListener("change", () => set({ [key]: t.value }, true), { signal });
		d.append(t);
	};
	ta("ツールチップ", "@tip", "マウスを乗せた時の一言（改行可）");
	ta("吹き出し", "@pop", "常時表示の吹き出し（改行可）");
}
