// スタイル入力フォーム（GIS素人向けの日本語UI）＝@プロパティを直接見せない編集面。
// 点/線/面でコントロールが変わる共通部品：選択中フィーチャの編集（properties.js）と
// 作図ツールの既定スタイル（toolbar.js）の両方から使う。
//   面: 面の色(picker)＋塗りの濃さ(スライダー) / 線の色 / 線幅(1–10px) / 高さ(m＝height・ビューアで 3D 押し出し)
//   線: 線の色 / 線幅
//   点: シンボル（アイコン/基本図形/テキスト）・大きさ（大中小）・色
//   共通: ツールチップ(@tip)・吹き出し(@pop)＝改行できる textarea
// set(partial, final)：input中= final:false（即プレビュー・履歴なし）、確定（change）= final:true（undo1件）。
// 値 "" は「そのキーを消す」の意（呼び出し側で delete）。
import { SHAPE_NAMES, PICTO, SHAPE_SCALE, buildLinePath, sanitizeHTML } from "./overlay.js";
import { cssColor, DEF } from "./gint-layer.js";
import { tr } from "./i18n.js";   // UI 多言語化（英語キー＝既定値・訳はパッケージ持参の i18n/ui.json → i18n/lang/<code>.json）
const t = tr();

const u32rgb = u => "#" + (u >>> 8).toString(16).padStart(6, "0");
const u32alpha = u => (u & 255) / 255;
const hex8 = (rgb, alpha) => rgb + Math.round(alpha * 255).toString(16).padStart(2, "0");
const TYPE_OF = t => t.includes("Poly") ? "polygon" : t.includes("Line") ? "line" : "point";
// カラーピッカー＝ネイティブのOSダイアログでなく地図向けの定番スウォッチ（＋末尾に「その他」のネイティブ入力）。
// 明るめ12（各色相）＋濃いめ・中立11＝23色。末尾の「その他」入力と合わせて 12列×2行ぴったり（Open Color 準拠）。
const SWATCHES = [
	"#fa5252", "#ff922b", "#fcc419", "#94d82d", "#51cf66", "#20c997", "#22b8cf", "#339af0", "#5c7cfa", "#845ef7", "#cc5de8", "#f06595",
	"#e03131", "#f76707", "#f08c00", "#2f9e44", "#0ca678", "#1971c2", "#4263eb", "#7048e8", "#868e96", "#ffffff", "#212529",
];

// variant（点のみ）："symbol"＝アイコン/図形系・"text"＝テキストラベル系（パネル分離＝本人裁定 8/20）。
// 省略時は中身から自動判定（@text だけ持つ点＝text、それ以外＝symbol）。
export function styleForm(host, { geomType, variant, get, set: setRaw }, signal) {
	const kind = TYPE_OF(geomType);
	const props = () => get() || {};
	let preview = null;
	const set = (partial, final) => { setRaw(partial, final); preview?.draw(); };   // 変更のたびに上部の見本を更新
	const divider = () => { const h = document.createElement("div"); h.className = "ge-hr"; host.append(h); };   // 見出しでなく区切り線（言葉を減らす）
	const closeAllPops = () => {   // 一度に開くパレットは1つ（別の色を開いたら前のを畳む）
		host.querySelectorAll(".ge-color-pop:not([hidden])").forEach(p => { p.hidden = true; });
		host.querySelectorAll(".ge-color-trigger.open").forEach(t => t.classList.remove("open"));
	};
	let mount = host;   // 行の置き場（ポリゴン化ONの時だけ見せる箱などへ切替可）
	const row = label => {
		const d = document.createElement("div");
		d.className = "ge-row";
		const l = document.createElement("label");
		l.textContent = label;
		d.append(l);
		mount.append(d);
		return d;
	};

	// ---- 色（ポップオーバー式）。行には現色チップ＋▾だけ、押すと下にパレットが開く。選ぶと閉じる。
	//      withAlpha なら「濃さ」スライダーを別行に添えて #rrggbbaa に合成 ----
	const colorRow = (label, key, defU32, withAlpha) => {
		const d = row(label);
		const cur = cssColor(props()[key]) ?? defU32;
		let hex = u32rgb(cur), alpha = withAlpha ? u32alpha(cur) : 1;
		const emit = final => set({ [key]: withAlpha ? hex8(hex, alpha) : hex }, final);

		const trigger = document.createElement("button");
		trigger.type = "button"; trigger.className = "ge-color-trigger"; trigger.title = t("Pick a color");
		const chip = document.createElement("span"); chip.className = "ge-color-chip"; chip.style.background = hex;
		const caret = document.createElement("span"); caret.className = "ge-color-caret"; caret.textContent = "▾";
		trigger.append(chip, caret);
		d.append(trigger);

		const pop = document.createElement("div"); pop.className = "ge-color-pop"; pop.hidden = true;
		const wrap = document.createElement("div"); wrap.className = "ge-swatches";
		const chips = [];
		const refresh = () => chips.forEach(o => o.el.classList.toggle("on", o.val === hex.toLowerCase()));
		const pick = (h, final, closeAfter) => { hex = h; chip.style.background = h; custom.value = h; refresh(); emit(final); if (closeAfter) closePop(); };
		for (const sw of SWATCHES) {
			const b = document.createElement("button");
			b.type = "button"; b.className = "ge-swatch"; b.style.background = sw; b.title = sw;
			b.addEventListener("click", () => pick(sw, true, true), { signal });
			chips.push({ el: b, val: sw.toLowerCase() }); wrap.append(b);
		}
		const custom = Object.assign(document.createElement("input"), { type: "color", value: hex, title: t("Other color") });
		custom.className = "ge-swatch ge-swatch-custom";
		custom.addEventListener("input", () => pick(custom.value, false, false), { signal });   // ドラッグ中はプレビュー・開いたまま
		custom.addEventListener("change", () => pick(custom.value, true, false), { signal });
		wrap.append(custom);
		pop.append(wrap);
		mount.append(pop);   // 行の下にインライン展開＝パネルの overflow でクリップされない
		refresh();

		const closePop = () => { pop.hidden = true; trigger.classList.remove("open"); };
		trigger.addEventListener("click", () => { if (pop.hidden) { closeAllPops(); pop.hidden = false; trigger.classList.add("open"); } else closePop(); }, { signal });

		if (withAlpha) {
			const da = row(t("Opacity"));
			const a = Object.assign(document.createElement("input"), { type: "range", min: 5, max: 100, value: Math.round(alpha * 100), title: t("Fill opacity") });
			const av = document.createElement("span");
			av.className = "ge-val"; av.textContent = Math.round(alpha * 100) + "%";
			a.addEventListener("input", () => { alpha = +a.value / 100; av.textContent = a.value + "%"; emit(false); }, { signal });
			a.addEventListener("change", () => emit(true), { signal });
			da.append(a, av);
		}
		return d;
	};

	// ---- 線幅（1–10px スライダー）----
	const widthRow = () => {
		const d = row(t("Width"));
		const cur = +props()["@width"] > 0 ? +props()["@width"] : DEF.widthPx;
		const w = Object.assign(document.createElement("input"), { type: "range", min: 1, max: 10, step: 0.5, value: cur });
		const v = document.createElement("span");
		v.className = "ge-val";
		v.textContent = cur + "px";
		w.addEventListener("input", () => { v.textContent = w.value + "px"; set({ "@width": +w.value }, false); }, { signal });
		w.addEventListener("change", () => set({ "@width": +w.value }, true), { signal });
		d.append(w, v);
		return d;
	};

	// ---- ぼかし（@blur・不確定エリア＝soft塗り・線なし。0=オフ）。ONの間は線コントロールを隠す ----
	const blurRow = (hideWhenOn = []) => {
		const d = row(t("Blur"));
		const cur = +props()["@blur"] > 0 ? +props()["@blur"] : 0;
		const w = Object.assign(document.createElement("input"), { type: "range", min: 0, max: 20, step: 1, value: cur, title: t("Fuzzy area (blurred fill, no outline)") });
		const v = document.createElement("span");
		v.className = "ge-val"; v.textContent = cur ? cur + "px" : t("None");
		const syncHide = () => { const on = +w.value > 0; if (on) closeAllPops(); for (const el of hideWhenOn) el.style.display = on ? "none" : ""; };   // 行を隠す時は開きっぱなしのパレットも畳む
		w.addEventListener("input", () => { v.textContent = +w.value ? w.value + "px" : t("None"); set({ "@blur": +w.value || "" }, false); syncHide(); }, { signal });
		w.addEventListener("change", () => set({ "@blur": +w.value || "" }, true), { signal });
		d.append(w, v);
		syncHide();   // 初期表示（既に blur ならこの時点で線を隠す）
	};

	// ---- 線の始点/終点（@start/@end：なし=gint標準／square/round/arrow=canvas2D 経路。矢じりは太さ純比例）----
	// ボタンは文字でなく絵（薄い縦線＝端点の位置・太い短線＝キャップの形。始点行は左右反転）＝本人裁定。
	const capIcon = (val, atStart) => {
		const W = 24, H = 14, dpr = window.devicePixelRatio || 1;
		const c = document.createElement("canvas");
		c.width = W * dpr; c.height = H * dpr; c.style.width = W + "px"; c.style.height = H + "px";
		const g = c.getContext("2d"); g.scale(dpr, dpr);
		if (atStart) { g.translate(W, 0); g.scale(-1, 1); }   // 始点＝飾りが左に来る向き
		const y = H / 2, x0 = 3, x1 = 16;   // x1＝端点の位置
		g.strokeStyle = "rgba(205,214,230,.35)"; g.lineWidth = 1;
		g.beginPath(); g.moveTo(x1 + .5, 1); g.lineTo(x1 + .5, H - 1); g.stroke();
		g.strokeStyle = g.fillStyle = PALETTE_INK; g.lineWidth = 6; g.lineCap = "butt";
		if (val === "arrow") {
			g.beginPath(); g.moveTo(x0, y); g.lineTo(x1 - 9, y); g.stroke();
			g.beginPath(); g.moveTo(x1, y); g.lineTo(x1 - 9, y - 5); g.lineTo(x1 - 9, y + 5); g.closePath(); g.fill();
		} else {
			if (val === "square") g.lineCap = "square"; else if (val === "round") g.lineCap = "round";
			g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
		}
		return c;
	};
	const capRow = (label, key) => {
		const d = row(label);
		const atStart = key === "@start";
		for (const [val, title] of [["", t("None")], ["square", t("Square")], ["round", t("Round")], ["arrow", t("Arrow")]]) {
			const b = document.createElement("button");
			b.className = "ge-shape-btn"; b.title = title;
			b.append(capIcon(val, atStart));
			if ((props()[key] || "") === val) b.classList.add("on");
			b.addEventListener("click", () => { set({ [key]: val }, true); mark(d, b); }, { signal });
			d.append(b);
		}
	};

	// ---- オン/オフ（@spline/@poly 等の真偽フラグ）。onToggle＝依存行の出し入れ用 ----
	const boolRow = (label, key, onText, onToggle) => {
		const d = row(label);
		const b = document.createElement("button");
		b.textContent = onText;
		const cur = () => !!props()[key];
		b.classList.toggle("on", cur());
		b.addEventListener("click", () => { const v = cur() ? "" : "1"; set({ [key]: v }, true); b.classList.toggle("on", !!v); onToggle?.(!!v); }, { signal });
		d.append(b);
	};

	// ---- 大きさ（大中小）----
	const mark = (container, b) => container.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
	const sizeRow = () => {
		const dsz = row(t("Size"));
		const curSize = +props()["@size"] > 0 ? +props()["@size"] : 24;
		for (const [label, px] of [[t("S ##size"), 16], [t("M ##size"), 24], [t("L ##size"), 36]]) {
			const b = document.createElement("button");
			b.textContent = label;
			if (px === curSize) b.classList.add("on");
			b.addEventListener("click", () => { set({ "@size": px }, true); mark(dsz, b); }, { signal });
			dsz.append(b);
		}
	};

	// ---- 点（基本図形系）＝アイコンは全て基本図形に一本化（色が変えられる canvas パス・本人裁定）。
	//      任意画像を使いたい時だけ「画像」へドロップ（@icon に File 直格納）。----
	// パレットは全図形を canvas で単色描画＝塗り面積を大体そろえ、絵文字/SVG混在の不揃いを解消（drawShape 共用）。
	const PALETTE_INK = "#cdd6e6";
	const symbolRow = () => {
		const ds = row(t("Shape"));
		for (const s of SHAPE_NAMES) {
			const b = document.createElement("button");
			b.className = "ge-shape-btn"; b.title = s;
			const S = 20, dpr = window.devicePixelRatio || 1;
			const c = document.createElement("canvas");
			c.width = S * dpr; c.height = S * dpr; c.style.width = c.style.height = S + "px";
			const g = c.getContext("2d"); g.scale(dpr, dpr);
			drawShape(g, s, S / 2, S / 2, 6, PALETTE_INK, "transparent");
			b.append(c);
			if (s === "pin") { const bd = document.createElement("span"); bd.className = "ge-3d-badge"; bd.textContent = "3D"; b.append(bd); b.title = t("pin (3D, stands up when tilted)"); }   // circle と区別
			if (props()["@shape"] === s) b.classList.add("on");
			b.addEventListener("click", () => { set({ "@shape": s, "@icon": "" }, true); mark(ds, b); }, { signal });
			ds.append(b);
		}
	};
	const imageRow = () => {
		const dz = row(t("Image"));
		const zone = document.createElement("div");
		zone.className = "ge-drop";
		zone.textContent = t("Drop a PNG/SVG here");
		zone.addEventListener("dragover", e => e.preventDefault(), { signal });
		zone.addEventListener("drop", e => {
			e.preventDefault(); e.stopPropagation();
			const f = e.dataTransfer.files?.[0];
			if (!f || !/^image\//.test(f.type)) return;
			// File をそのまま @icon へ＝geopbf の BUFS プールに一個書き（バイナリ等価は abcomp が同一idへ）。
			// data-URI 方式（base64+33%・多点で重複）は先代zip形式の悪癖の再演＝廃止（本人裁定 8/20）
			set({ "@icon": f, "@shape": "" }, true);
			zone.textContent = `✓ ${f.name}`;
			mark(ds, null);
		}, { signal });
		dz.append(zone);
	};

	// ---- 点（テキスト系）＝文字が本体（改行可・@sizeがフォント寸）----
	const textRows = () => {
		const dt = row(t("Text ##label"));
		const tx = Object.assign(document.createElement("textarea"), { rows: 2, placeholder: t("Text to place on the map (multi-line OK)"), value: props()["@text"] ?? "" });
		tx.addEventListener("change", () => set({ "@text": tx.value }, true), { signal });
		dt.append(tx);
	};

	// ---- 見本（現在のスタイルを小さく描く。set のたびに再描画）----
	const drawShape = (g, s, x, y, r, fill, stroke) => {
		r *= SHAPE_SCALE[s] || 1;   // 塗り面積を大体そろえる（地図と同じ係数）
		if (PICTO[s]) {   // 単色シルエット図形（marker/flag/家/カメラ等）
			g.save(); g.translate(x - r, y - r); g.scale(2 * r / 24, 2 * r / 24);
			const path = new Path2D(PICTO[s]);
			g.fillStyle = fill; g.fill(path, "evenodd");
			g.lineWidth = 1.4; g.strokeStyle = stroke; g.stroke(path);
			g.restore(); return;
		}
		// pin は円で描く（真俯瞰＝球の頭）。パレットでは「3D」バッジで circle と区別（symbolRow が付与）。
		g.beginPath();
		if (s === "square") g.rect(x - r, y - r, 2 * r, 2 * r);
		else if (s === "triangle") { g.moveTo(x, y - r); g.lineTo(x + r * 0.87, y + r * 0.5); g.lineTo(x - r * 0.87, y + r * 0.5); g.closePath(); }
		else if (s === "diamond") { g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y); g.closePath(); }
		else if (s === "star") { for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; g[i ? "lineTo" : "moveTo"](x + rr * Math.cos(a), y + rr * Math.sin(a)); } g.closePath(); }
		else g.arc(x, y, r, 0, Math.PI * 2);   // circle（pin/flag は PICTO）
		g.fillStyle = fill; g.fill(); g.lineWidth = 1.5; g.strokeStyle = stroke; g.stroke();
	};
	const makePreview = () => {
		const d = document.createElement("div"); d.className = "ge-preview";
		const W = 60, H = 38, dpr = window.devicePixelRatio || 1;
		const cv = document.createElement("canvas");
		cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
		const g = cv.getContext("2d"); g.scale(dpr, dpr);
		d.append(cv);
		const draw = () => {
			const p = props(), cx = W / 2, cy = H / 2;
			g.clearRect(0, 0, W, H);
			if (kind === "polygon") {
				g.beginPath(); g.roundRect(9, 7, W - 18, H - 14, 5);
				g.fillStyle = p["@fill"] || "rgba(120,170,221,.28)"; g.fill();
				g.lineWidth = Math.min(6, +p["@width"] > 0 ? +p["@width"] : DEF.widthPx); g.strokeStyle = p["@stroke"] || "#2b5f8f"; g.stroke();
			} else if (kind === "line") {
				const lw = Math.min(9, +p["@width"] > 0 ? +p["@width"] : DEF.widthPx), col = p["@stroke"] || "#2b5f8f";
				const q = [[9, H - 11], [W - 9, 11]];
				if (p["@poly"]) {   // ポリゴン化＝帯（塗り+輪郭+端形状）＝地図と同じ buildLinePath
					g.beginPath();
					buildLinePath(g, q, lw, p["@start"] || p["@cap0"] || "", p["@end"] || p["@cap1"] || "");   // @cap0/1＝旧名の後方互換
					g.fillStyle = p["@fill"] || "rgba(120,170,221,.25)"; g.fill();
					g.lineWidth = 1.2; g.lineJoin = "round"; g.strokeStyle = col; g.stroke();
				} else {
					g.beginPath(); g.moveTo(q[0][0], q[0][1]); g.lineTo(q[1][0], q[1][1]);
					g.lineCap = "round"; g.lineWidth = lw; g.strokeStyle = col; g.stroke();
				}
			} else if (p["@text"] != null && p["@text"] !== "" && !p["@shape"] && !p["@icon"]) {
				g.font = "bold 16px 'Noto Sans JP',sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
				g.fillStyle = p["@fill"] || "#223"; g.fillText((String(p["@text"]).split("\n")[0] || "A").slice(0, 4), cx, cy);
			} else {
				drawShape(g, p["@shape"] || "circle", cx, cy, 12, p["@fill"] || "#cc4444", p["@stroke"] || "rgba(0,0,0,.45)");
			}
		};
		return { el: d, draw };
	};

	// ---- 高さ（面のみ・height＝メートル）。ビューアが 3D に押し出す（MapLibre の fill-extrusion と同じ鍵名＝他の道具へ持ち出しても通じる）。
	//      @ を付けない＝見た目でなくデータ（建物の高さ）。空欄＝消す（平らな面に戻る）----
	const heightRow = () => {
		const d = row(t("Height"));
		const cur = +props().height > 0 ? +props().height : "";
		const inp = Object.assign(document.createElement("input"), { type: "number", min: 0, max: 9000, step: 1, value: cur, placeholder: "0", title: t("Height in metres (stands up in 3D in the viewer)") });
		inp.className = "ge-num";
		const u = document.createElement("span"); u.className = "ge-val"; u.textContent = "m";
		const val = () => { const v = +inp.value; return v > 0 ? Math.min(9000, v) : ""; };
		inp.addEventListener("input", () => set({ height: val() }, false), { signal });
		inp.addEventListener("change", () => set({ height: val() }, true), { signal });
		d.append(inp, u);
	};

	// ---- 型ごとの構成 ----
	preview = makePreview(); host.append(preview.el);
	if (kind === "polygon") {
		colorRow(t("Fill color ##polygon"), "@fill", DEF.fill, true);
		const strokeRow = colorRow(t("Line color"), "@stroke", DEF.stroke, false), widthEl = widthRow();
		boolRow(t("Smooth"), "@spline", t("Curve (fuzzy)"));
		blurRow([strokeRow, widthEl]);   // blur ON の間は線の色/線幅を隠す（stroke 無し）
		heightRow();
	}
	else if (kind === "line") {
		colorRow(t("Line color"), "@stroke", DEF.stroke, false);
		widthRow();
		// ポリゴン化＝帯（塗り+輪郭+端形状）。ON の時だけ塗り色・始点/終点が現れる（本人裁定＝旧自作実装の型）
		const polyBox = document.createElement("div");
		polyBox.className = "ge-sub";   // 従属行＝左に薄い罫でぶら下がりを見せる
		boolRow(t("As band"), "@poly", t("Band (fill + outline)"), on => { polyBox.style.display = on ? "" : "none"; });
		mount = polyBox;
		colorRow(t("Fill color ##band"), "@fill", DEF.fill, true);
		capRow(t("Start"), "@start"); capRow(t("End"), "@end");
		mount = host;
		host.append(polyBox);
		polyBox.style.display = props()["@poly"] ? "" : "none";
		boolRow(t("Smooth"), "@spline", t("Curve (fuzzy)"));
	}
	else {
		const v = variant ?? (props()["@text"] && !props()["@icon"] && !props()["@shape"] ? "text" : "symbol");
		if (v === "text") { textRows(); sizeRow(); colorRow(t("Text color"), "@fill", 0x223344ff, false); }
		else { symbolRow(); colorRow(t("Color"), "@fill", 0xcc4444ff, false); sizeRow(); imageRow(); }   // 図形→色→大きさ→画像
	}
	preview.draw();

	// ---- 共通：tip（1行）/ pop（改行可）。pop 行に「↓」＝上のツールチップと同じ文にする定番操作 ----
	divider();   // 見た目 と 注記(tip/pop) の間＝薄い区切り線だけ（見出しは置かない）
	const ta = (label, key, ph, rows, extra) => {
		const d = row(label);
		const area = Object.assign(document.createElement("textarea"), { rows, placeholder: ph, value: props()[key] ?? "" });
		area.addEventListener("change", () => {   // HTMLらしき入力は保存前に消毒（コピペ事故を出荷前に落とす・平文は素通し）
			const v = area.value.includes("<") ? sanitizeHTML(area.value) : area.value;
			if (v !== area.value) area.value = v;
			set({ [key]: v }, true);
		}, { signal });
		if (extra) d.append(extra);   // ラベルの隣（テキストエリアの上）に小ボタン
		d.append(area);
		return area;
	};
	const tipTA = ta(t("Tooltip"), "@tip", t("Shown on hover (HTML / images OK)"), 2);
	const copyTip = Object.assign(document.createElement("button"), { type: "button", className: "ge-copytip", textContent: t("↓ copy"), title: t("Copy the tooltip above (use the same text)") });
	copyTip.addEventListener("click", () => { const v = tipTA.value; popTA.value = v; set({ "@pop": v }, true); }, { signal });
	const popTA = ta(t("Popup"), "@pop", t("Popup balloon (HTML / images OK)"), 2, copyTip);
}
