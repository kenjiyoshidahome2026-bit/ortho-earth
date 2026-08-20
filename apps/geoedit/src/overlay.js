// 編集オーバレイ（measure.js の作法）：#map 内の2D canvas（DOM順=重なり・pointer-events:none）。
// map.onFrame で毎描画フレーム再投影＝地図が動いた時だけコストを払う。状態変更側は map.requestDraw()。
// 描くもの＝①@シンボル（点の @icon/@shape/@text/@pop） ②選択中フィーチャの輪郭＋頂点/中点ハンドル
// ③ドラッグ中ジオメトリ（gint側は paintTable で非表示） ④作図ラバーバンド ⑤スナップ吸着マーク。
// ハンドルの画面座標は描画時にキャッシュ＝controller の pointerdown ヒットテストと同じ真実源。

const COL = {
	edge: "#2b5f8f", edgeShared: "#cc5533", fill: "rgba(120,170,221,.25)",
	handle: "#ffffff", handleRing: "#2b5f8f", mid: "#ffffff", midRing: "#7f9fbf",
	sketch: "#d08833", snap: "#33bb77", popBg: "rgba(16,24,44,.78)", popFg: "#e8eef8",
};
const FONT = '12px "Noto Sans JP","Hiragino Sans",sans-serif';

// 内蔵アイコン（SVG→dataURI・固定配色のピクトグラム）。@icon にはこの名前 か data:URI（画像ドロップ）。
// マーカー・旗・星は「基本図形」（@fill/@stroke で色が変えられる canvas パス）へ移設＝本人裁定 8/20。
const ICON_SVG = {
	home: '<path d="M4 11l8-7 8 7v9h-6v-6h-4v6H4z" fill="#7f9f6f" stroke="#54704a"/>',
	camera: '<rect x="3" y="7" width="18" height="13" rx="2" fill="#667" stroke="#445"/><circle cx="12" cy="13.5" r="4" fill="#223" stroke="#889"/><rect x="8" y="4" width="8" height="4" rx="1" fill="#667"/>',
	warn: '<path d="M12 3L22 20H2z" fill="#e0a030" stroke="#986c1c"/><rect x="11" y="9" width="2" height="6" fill="#fff"/><rect x="11" y="16.5" width="2" height="2" fill="#fff"/>',
	drop: '<path d="M12 3s6 7.4 6 11.5a6 6 0 0 1-12 0C6 10.4 12 3 12 3z" fill="#4a90d9" stroke="#2f5f95"/>',
	train: '<rect x="5" y="3" width="14" height="14" rx="3" fill="#b05555" stroke="#7c3a3a"/><rect x="7" y="6" width="10" height="5" fill="#e8eef8"/><circle cx="9" cy="14" r="1.5" fill="#fff"/><circle cx="15" cy="14" r="1.5" fill="#fff"/><path d="M7 21l2-3M17 21l-2-3" stroke="#7c3a3a" stroke-width="2"/>',
};
export const ICON_NAMES = Object.keys(ICON_SVG);
export const SHAPE_NAMES = ["pin", "circle", "square", "triangle", "diamond", "star", "flag"];   // pin/flag は足元アンカー
export const iconURI = name => "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">${ICON_SVG[name]}</svg>`);

export function createOverlay(map, mapEl, getState) {
	const canvas = document.createElement("canvas");
	canvas.className = "ge-overlay";
	mapEl.append(canvas);
	const ctx = canvas.getContext("2d");
	let W = 0, H = 0, dpr = 1;
	const syncSize = () => {
		const w = mapEl.clientWidth, h = mapEl.clientHeight, d = devicePixelRatio || 1;
		if (w === W && h === H && d === dpr) return;
		W = w; H = h; dpr = d;
		canvas.width = w * d; canvas.height = h * d;
	};

	const images = new Map();   // @icon 値 → Image（内蔵名・data:URI・Blob/File 共通のキャッシュ。Blobはインスタンスがキー＝
	// geopbf復元は同一参照を共有(readValueのbinキャッシュ)＋Worker→mainのstructured cloneもエイリアシング保存＝1画像1Image）
	const iconImg = v => {
		let im = images.get(v);
		if (im) return im.complete ? im : null;
		im = new Image();
		if (typeof v === "string") im.src = v.startsWith("data:") ? v : ICON_SVG[v] ? iconURI(v) : "";
		else if (v instanceof Blob) im.src = URL.createObjectURL(v);
		else return null;
		im.onload = () => map.requestDraw();
		images.set(v, im);
		return im.complete ? im : null;
	};

	let handles = [];   // 描画時キャッシュ：{x,y,kind:"v"|"m"|"p", arcId?,idx?, eid?,ptIdx?}
	let symHits = [];   // 描画時キャッシュ：シンボルの当たり矩形 {x0,y0,x1,y1,eid}＝「見えている絵」で選択するための真実源
	const seg = (pr, a, b) => {   // 大圏分割つき線分（編集ズームでは大抵1分割）
		const dx = Math.abs(a[0] - b[0]), dy = Math.abs(a[1] - b[1]);
		const n = Math.min(32, Math.max(1, Math.ceil(Math.max(dx, dy) / 0.5)));
		const out = [];
		for (let i = 0; i <= n; i++) {
			const t = i / n;
			out.push(pr(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
		}
		return out;
	};
	const tracePts = (pr, coords) => {   // coords（経緯度列）→ 現在パスへ
		let started = false;
		for (let i = 0; i < coords.length - 1; i++) {
			for (const p of seg(pr, coords[i], coords[i + 1])) {
				if (p[2] < 0) { started = false; continue; }
				if (!started) { ctx.moveTo(p[0], p[1]); started = true; } else ctx.lineTo(p[0], p[1]);
			}
		}
	};

	const dot = (x, y, r, fill, ring) => {
		ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
		ctx.fillStyle = fill; ctx.fill();
		ctx.lineWidth = 1.5; ctx.strokeStyle = ring; ctx.stroke();
	};
	const BOTTOM_ANCHOR = new Set(["pin", "flag"]);   // 足元＝座標にアンカー（他は中心）
	const shapePath = (kind, x, y, r) => {
		ctx.beginPath();
		if (kind === "square") ctx.rect(x - r, y - r, r * 2, r * 2);
		else if (kind === "triangle") { ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.87, y + r * 0.5); ctx.lineTo(x - r * 0.87, y + r * 0.5); ctx.closePath(); }
		else if (kind === "diamond") { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
		else if (kind === "star") { for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; ctx[i ? "lineTo" : "moveTo"](x + rr * Math.cos(a), y + rr * Math.sin(a)); } ctx.closePath(); }
		else if (kind === "pin") { ctx.moveTo(x, y); ctx.arc(x, y - r * 1.15, r * 0.7, Math.PI * 0.75, Math.PI * 2.25); ctx.closePath(); }   // 涙滴＝先端が座標
		else if (kind === "flag") { ctx.moveTo(x, y); ctx.lineTo(x, y - r * 2); ctx.lineTo(x + r * 1.4, y - r * 1.55); ctx.lineTo(x, y - r * 1.1); ctx.closePath(); }   // ポール＋旗布
		else ctx.arc(x, y, r, 0, Math.PI * 2);   // circle
	};

	function drawSymbols(pr, st) {
		for (const [eid, f] of st.model.feats) {
			if (!f.coords || (st.hidden && st.hidden.has(eid))) continue;
			const p = f.properties || {};
			const size = +p["@size"] > 0 ? +p["@size"] : 24;
			for (const c of f.coords) {
				const s = pr(c[0], c[1]);
				if (s[2] < 0 || s[0] < -60 || s[0] > W + 60 || s[1] < -60 || s[1] > H + 60) continue;
				const icon = p["@icon"] && iconImg(p["@icon"]);
				const shape = p["@shape"], text = p["@text"];
				const textOnly = !icon && !shape && text != null && text !== "";   // テキスト系ラベル＝図形なし・文字が本体
				const bottom = icon || BOTTOM_ANCHOR.has(shape);
				// 当たり矩形＝実際に描く範囲（足元アンカーは座標の上に絵が乗る。クリックは絵に対して行われる）
				if (!textOnly) symHits.push(bottom
					? { x0: s[0] - size / 2, y0: s[1] - size * 1.1, x1: s[0] + size * (shape === "flag" ? 0.75 : 0.5), y1: s[1], eid }
					: { x0: s[0] - size / 2, y0: s[1] - size / 2, x1: s[0] + size / 2, y1: s[1] + size / 2, eid });
				if (icon) ctx.drawImage(icon, s[0] - size / 2, s[1] - size, size, size);   // 底辺アンカー（ピン風）
				else if (shape) {
					shapePath(shape, s[0], s[1], size / 2);
					ctx.fillStyle = p["@fill"] || "#cc4444"; ctx.fill();
					ctx.lineWidth = 1.5; ctx.strokeStyle = p["@stroke"] || "rgba(0,0,0,.45)"; ctx.stroke();
				} else if (!text) dot(s[0], s[1], 4, p["@fill"] || "#cc4444", "rgba(0,0,0,.4)");
				if (text) {
					// テキスト系＝文字が本体（@sizeがフォント寸・座標に中央配置）／図形付き＝図形の上に小さく
					const fpx = textOnly ? Math.max(11, size * 0.7) : 12;
					ctx.font = `${fpx}px "Noto Sans JP","Hiragino Sans",sans-serif`;
					ctx.textAlign = "center";
					const lines = String(text).split("\\n").join("\n").split("\n");
					const baseY = textOnly ? s[1] + fpx * 0.35 - (lines.length - 1) * fpx * 0.6 : s[1] - size * 0.6 - 3 - (lines.length - 1) * fpx * 1.2;
					let maxW = 0;
					lines.forEach((l, i) => {
						const yy = baseY + i * fpx * 1.2;
						ctx.lineWidth = 3; ctx.strokeStyle = "rgba(255,255,255,.85)";
						ctx.strokeText(l, s[0], yy);
						ctx.fillStyle = textOnly ? (p["@fill"] || "#223") : (p["@stroke"] || "#223");
						ctx.fillText(l, s[0], yy);
						maxW = Math.max(maxW, ctx.measureText(l).width);
					});
					if (textOnly) symHits.push({ x0: s[0] - maxW / 2 - 4, y0: baseY - fpx, x1: s[0] + maxW / 2 + 4, y1: baseY + (lines.length - 1) * fpx * 1.2 + 4, eid });
					ctx.textAlign = "start";
				}
			}
		}
	}

	// @pop＝引き出し線つき吹き出し。点だけでなく線・面にも出す（アンカー：点=座標・線=中間頂点・面=外環の重心）。
	// 改行対応＝\n で複数行（tip/pop は改行できる方がわかりやすい＝本人裁定 8/20）。
	const popAnchor = (st, f) => {
		if (f.coords) return f.coords[0];
		const first = st.model.listsOf(f)[0];
		if (!first) return null;
		const cs = st.model.stitch(first.list);
		if (!first.ring) return cs[Math.floor(cs.length / 2)];
		let sx = 0, sy = 0;
		const n = cs.length - 1;   // 閉じ重複を除いた平均＝十分な重心近似
		for (let i = 0; i < n; i++) { sx += cs[i][0]; sy += cs[i][1]; }
		return [sx / n, sy / n];
	};
	function drawPops(pr, st) {
		const LH = 16;
		for (const [eid, f] of st.model.feats) {
			const pop = f.properties?.["@pop"];
			if (pop == null || pop === "" || (st.hidden && st.hidden.has(eid))) continue;
			const a = popAnchor(st, f);
			if (!a) continue;
			const s = pr(a[0], a[1]);
			if (s[2] < 0 || s[0] < -80 || s[0] > W + 80 || s[1] < -80 || s[1] > H + 80) continue;
			const off = f.coords ? (+f.properties["@size"] > 0 ? +f.properties["@size"] : 24) : 6;
			ctx.font = FONT;
			const lines = String(pop).split("\n");
			let tw = 0;
			for (const l of lines) tw = Math.max(tw, ctx.measureText(l).width);
			const bh = lines.length * LH + 8;
			const bx = s[0] + 14, by = s[1] - off - 12 - bh;
			ctx.strokeStyle = "rgba(200,210,226,.8)"; ctx.lineWidth = 1;
			ctx.beginPath(); ctx.moveTo(s[0], s[1] - off * 0.5); ctx.lineTo(bx, by + bh); ctx.stroke();
			ctx.fillStyle = COL.popBg;
			ctx.beginPath(); ctx.roundRect(bx, by, tw + 14, bh, 6); ctx.fill();
			ctx.fillStyle = COL.popFg;
			lines.forEach((l, i) => ctx.fillText(l, bx + 7, by + 15 + i * LH));
		}
	}

	function drawFeature(pr, st, eid, { fill = false } = {}) {
		const f = st.model.feats.get(eid);
		if (!f) return;
		if (f.coords) {   // ポイント＝ハンドルだけ（シンボルは drawSymbols が担当）
			f.coords.forEach((c, i) => {
				const s = pr(c[0], c[1]);
				if (s[2] < 0) return;
				dot(s[0], s[1], 5, COL.handle, COL.handleRing);
				handles.push({ x: s[0], y: s[1], kind: "p", eid, ptIdx: i });
			});
			return;
		}
		for (const { list, ring } of st.model.listsOf(f)) {
			const coords = st.model.stitch(list);
			if (fill && ring) {
				ctx.beginPath(); tracePts(pr, coords);
				ctx.closePath(); ctx.fillStyle = COL.fill; ctx.fill("evenodd");
			}
			// 辺：共有arc（refs>1）はアクセント色＝「ここを動かすと隣も動く」の可視化
			for (const s of list) {
				const aid = s < 0 ? ~s : s, arc = st.model.arcs.get(aid);
				ctx.beginPath(); tracePts(pr, st.model.arcCoords(s));
				ctx.lineWidth = 2; ctx.strokeStyle = arc.refs.size > 1 ? COL.edgeShared : COL.edge; ctx.stroke();
			}
		}
	}
	function drawHandles(pr, st, eid) {
		const f = st.model.feats.get(eid);
		if (!f || f.coords) return;
		const seen = new Set();
		for (const { list } of st.model.listsOf(f)) for (const s of list) {
			const aid = s < 0 ? ~s : s;
			if (seen.has(aid)) continue;
			seen.add(aid);
			const arc = st.model.arcs.get(aid), n = arc.pts.length / 2, u = n - (arc.closed ? 1 : 0);
			for (let i = 0; i < u; i++) {
				const sc = pr(arc.pts[i * 2], arc.pts[i * 2 + 1]);
				if (sc[2] < 0) continue;
				dot(sc[0], sc[1], 5, COL.handle, COL.handleRing);
				handles.push({ x: sc[0], y: sc[1], kind: "v", arcId: aid, idx: i });
			}
			for (let i = 0; i < n - 1; i++) {   // 中点＝挿入ハンドル
				const mx = (arc.pts[i * 2] + arc.pts[i * 2 + 2]) / 2, my = (arc.pts[i * 2 + 1] + arc.pts[i * 2 + 3]) / 2;
				const sc = pr(mx, my);
				if (sc[2] < 0) continue;
				dot(sc[0], sc[1], 3, COL.mid, COL.midRing);
				handles.push({ x: sc[0], y: sc[1], kind: "m", arcId: aid, idx: i, ll: [mx, my] });
			}
		}
	}

	function draw() {
		syncSize();
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, W, H);
		handles = []; symHits = [];
		const st = getState();
		if (!st.model) return;
		const pr = map.makeProjector();
		drawSymbols(pr, st);
		drawPops(pr, st);
		if (st.dragEids) for (const eid of st.dragEids) drawFeature(pr, st, eid, { fill: true });
		if (st.selection != null && st.model.feats.has(st.selection)) {
			drawFeature(pr, st, st.selection, { fill: st.dragEids == null });
			drawHandles(pr, st, st.selection);
		}
		if (st.sketch && st.sketch.preview) {   // 矩形/円＝確定形のプレビュー（閉リング）
			ctx.beginPath(); tracePts(pr, st.sketch.preview);
			ctx.setLineDash([6, 4]); ctx.lineWidth = 2; ctx.strokeStyle = COL.sketch; ctx.stroke(); ctx.setLineDash([]);
			const s0 = pr(st.sketch.coords[0][0], st.sketch.coords[0][1]);
			if (s0[2] >= 0) dot(s0[0], s0[1], 3.5, COL.handle, COL.sketch);
		} else if (st.sketch && st.sketch.coords.length) {
			const cs = st.sketch.cursor ? [...st.sketch.coords, st.sketch.cursor] : st.sketch.coords;
			ctx.beginPath(); tracePts(pr, cs);
			if (st.sketch.kind !== "line" && cs.length > 2) { const s0 = pr(cs[0][0], cs[0][1]); if (s0[2] >= 0) { const sl = pr(cs[cs.length - 1][0], cs[cs.length - 1][1]); ctx.moveTo(sl[0], sl[1]); ctx.lineTo(s0[0], s0[1]); } }   // 面・穴＝閉じプレビュー
			ctx.setLineDash([6, 4]); ctx.lineWidth = 2; ctx.strokeStyle = COL.sketch; ctx.stroke(); ctx.setLineDash([]);
			for (const c of st.sketch.coords) { const s = pr(c[0], c[1]); if (s[2] >= 0) dot(s[0], s[1], 3.5, COL.handle, COL.sketch); }
		}
		if (st.snapMark) {
			const s = pr(st.snapMark[0], st.snapMark[1]);
			if (s[2] >= 0) { ctx.beginPath(); ctx.arc(s[0], s[1], 9, 0, Math.PI * 2); ctx.lineWidth = 2.5; ctx.strokeStyle = COL.snap; ctx.stroke(); }
		}
	}

	const unsub = map.onFrame(draw);
	return {
		canvas,
		redraw: () => map.requestDraw(),
		handleAt(x, y, touch) {   // 頂点優先→中点→ポイント。半径は マウス10px/タッチ16px（6/12は実機で狭すぎた＝8/20）
			const R = touch ? 16 : 10;
			let best = null, bd = R * R;
			for (const pass of ["v", "p", "m"]) {
				for (const h of handles) {
					if (h.kind !== pass) continue;
					const d = (h.x - x) ** 2 + (h.y - y) ** 2;
					if (d <= bd) { best = h; bd = d; }
				}
				if (best) return best;
			}
			return null;
		},
		symbolAt(x, y) {   // 「見えている絵」で点フィーチャを選ぶ（後勝ち＝上に描かれた方）。±4pxのゆとり付き
			for (let i = symHits.length - 1; i >= 0; i--) {
				const r = symHits[i];
				if (x >= r.x0 - 4 && x <= r.x1 + 4 && y >= r.y0 - 4 && y <= r.y1 + 4) return r.eid;
			}
			return null;
		},
		destroy() { unsub(); canvas.remove(); },
	};
}
