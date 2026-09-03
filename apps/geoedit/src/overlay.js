// 編集オーバレイ（measure.js の作法）：#map 内の2D canvas（DOM順=重なり・pointer-events:none）。
// map.onFrame で毎描画フレーム再投影＝地図が動いた時だけコストを払う。状態変更側は map.requestDraw()。
// 描くもの＝①@シンボル（点の @icon/@shape/@text/@pop） ②選択中フィーチャの輪郭＋頂点/中点ハンドル
// ③ドラッグ中ジオメトリ（gint側は paintTable で非表示） ④作図ラバーバンド ⑤スナップ吸着マーク。
// ハンドルの画面座標は描画時にキャッシュ＝controller の pointerdown ヒットテストと同じ真実源。
// ★図形/帯/曲線のプリミティブ（PICTO/SHAPE_SCALE/smoothRing/buildLinePath）の正本は
//   エンジンの anno ガジェット（apps/ortho-japan/gadgets/anno.js）＝ビューア再生と単一実装（pop/tip 共有と同じ型）。
//   ここは import して再輸出するだけ（styleform 等の既存 import 先を維持）。
import { SHAPE_NAMES, SHAPE_SCALE, PICTO, buildLinePath, smoothRing, sanitizeHTML } from "../../ortho-japan/gadgets/anno.js";
export { SHAPE_NAMES, SHAPE_SCALE, PICTO, buildLinePath, sanitizeHTML };

const COL = {
	edge: "#2b5f8f", edgeShared: "#cc5533", fill: "rgba(120,170,221,.25)",
	handle: "#ffffff", handleRing: "#2b5f8f", mid: "#ffffff", midRing: "#7f9fbf",
	sketch: "#d08833", snap: "#33bb77",
	bundleHi: "#a855f7", bundleFill: "rgba(168,85,247,.18)",   // 束ね選集合のハイライト（選択の青と別色）
};


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

	const pictoCache = new Map();   // シルエット図形の Path2D キャッシュ（毎フレの再パースを避ける）
	const getPicto = n => pictoCache.get(n) || (pictoCache.set(n, new Path2D(PICTO[n])), pictoCache.get(n));
	const images = new Map();   // @icon 値 → Image（内蔵名・data:URI・Blob/File 共通のキャッシュ。Blobはインスタンスがキー＝
	// geopbf復元は同一参照を共有(readValueのbinキャッシュ)＋Worker→mainのstructured cloneもエイリアシング保存＝1画像1Image）
	// ★描けるのは「読み込み済みで壊れていない」画像だけ（naturalWidth>0）。broken 画像は complete=true のまま
	//   drawImage が InvalidStateError を投げ、エンジンの frame() は render() の例外で rAF を再予約しない＝
	//   地図全体が止まる。旧式の内蔵アイコン名（"marker" 等の非 data: 文字列）は不明値＝null（既定の点で描く）。
	const usable = im => im.complete && im.naturalWidth > 0 ? im : null;
	const iconImg = v => {
		let im = images.get(v);
		if (im) return usable(im);
		if (typeof v === "string" ? !v.startsWith("data:") : !(v instanceof Blob)) return null;   // 内蔵アイコン名は廃止＝data:URI か画像のみ
		im = new Image();
		im.src = typeof v === "string" ? v : URL.createObjectURL(v);
		im.onload = () => map.requestDraw();
		images.set(v, im);
		return usable(im);
	};

	// 環境層（点シンボル/blur面/帯線）の描画リスト＝モデルと st.envGen（顔ぶれの世代）ごとに一度だけ全走査して作る。
	// 毎フレーム全 feats を3周（旧実装）は 10万点級でパン中の主コストだった。頂点移動では envGen は進まない（座標は
	// f.coords / arcs を直読みするので索引は古びない）。
	let env = { model: null, gen: -1, points: [], blurs: [], bands: [] };
	const envOf = st => {
		if (env.model === st.model && env.gen === st.envGen) return env;
		const points = [], blurs = [], bands = [];
		for (const [eid, f] of st.model.feats) {
			if (f.coords) { points.push(eid); continue; }
			const p = f.properties;
			if (!p) continue;
			if (+p["@blur"] > 0) blurs.push(eid);
			if (p["@poly"]) bands.push(eid);
		}
		env = { model: st.model, gen: st.envGen, points, blurs, bands };
		return env;
	};
	// 視野の経緯度箱（点の投影前カリング用）：四隅を逆投影。球外（低ズームで縁が見える）や日付変更線跨ぎは null＝間引かない
	const viewBox = () => {
		const c = [map.unprojectXY(0, 0), map.unprojectXY(W, 0), map.unprojectXY(0, H), map.unprojectXY(W, H)];
		if (c.some(q => !q)) return null;
		let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
		for (const [lng, lat] of c) { if (lng < x0) x0 = lng; if (lng > x1) x1 = lng; if (lat < y0) y0 = lat; if (lat > y1) y1 = lat; }
		if (x1 - x0 > 180) return null;
		const mx = (x1 - x0) / W * 80, my = (y1 - y0) / H * 80;   // 余白＝80px 相当（シンボル寸＋足元アンカー分）
		return { x0: x0 - mx, x1: x1 + mx, y0: y0 - my, y1: y1 + my };
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
	const BOTTOM_ANCHOR = new Set(["marker", "flag"]);   // 足元＝座標にアンカー（pin=3Dピンは球=中心／他も中心）
	const shapePath = (kind, x, y, r) => {
		ctx.beginPath();
		if (kind === "square") ctx.rect(x - r, y - r, r * 2, r * 2);
		else if (kind === "triangle") { ctx.moveTo(x, y - r); ctx.lineTo(x + r * 0.87, y + r * 0.5); ctx.lineTo(x - r * 0.87, y + r * 0.5); ctx.closePath(); }
		else if (kind === "diamond") { ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); }
		else if (kind === "star") { for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * 0.45 : r; ctx[i ? "lineTo" : "moveTo"](x + rr * Math.cos(a), y + rr * Math.sin(a)); } ctx.closePath(); }
		else ctx.arc(x, y, r, 0, Math.PI * 2);   // circle（pin/flag はシルエット図形 PICTO へ移設）
	};

	function drawSymbols(pr, st) {
		const feats = st.model.feats, vb = viewBox();
		for (const eid of envOf(st).points) {
			const f = feats.get(eid);
			if (!f?.coords || (st.hidden && st.hidden.has(eid))) continue;
			const p = f.properties || {};
			const size = +p["@size"] > 0 ? +p["@size"] : 24;
			for (const c of f.coords) {
				if (vb && (c[0] < vb.x0 || c[0] > vb.x1 || c[1] < vb.y0 || c[1] > vb.y1)) continue;   // 視野外＝投影すらしない
				const s = pr(c[0], c[1]);
				if (s[2] < 0 || s[0] < -60 || s[0] > W + 60 || s[1] < -60 || s[1] > H + 60) continue;
				const icon = p["@icon"] && iconImg(p["@icon"]);
				const shape = p["@shape"], text = p["@text"];
				const textOnly = !icon && !shape && text != null && text !== "";   // テキスト系ラベル＝図形なし・文字が本体
				const bottom = BOTTOM_ANCHOR.has(shape);   // 画像は中央アンカー（本人裁定）。pin/flag のみ足元
				// 当たり矩形＝実際に描く範囲（足元アンカーは座標の上に絵が乗る。クリックは絵に対して行われる）
				if (!textOnly) symHits.push(bottom
					? { x0: s[0] - size / 2, y0: s[1] - size * 1.1, x1: s[0] + size * (shape === "flag" ? 0.75 : 0.5), y1: s[1], eid }
					: { x0: s[0] - size / 2, y0: s[1] - size / 2, x1: s[0] + size / 2, y1: s[1] + size / 2, eid });
				if (icon) {   // 中央アンカー＋アスペクト比維持：非正方は中央正方形にクロップ（cover＝長辺を上下/左右で削る）
					const iw = icon.naturalWidth || icon.width, ih = icon.naturalHeight || icon.height, sd = Math.min(iw, ih);
					ctx.drawImage(icon, (iw - sd) / 2, (ih - sd) / 2, sd, sd, s[0] - size / 2, s[1] - size / 2, size, size);
				}
				else if (shape && PICTO[shape]) {   // 単色シルエット図形（pin/flag/家/カメラ等）＝@fillで塗る・穴はevenodd
					const path = getPicto(shape), bs = size * (SHAPE_SCALE[shape] || 1);   // 面積そろえのスケール
					ctx.save();
					ctx.translate(s[0] - bs / 2, bottom ? s[1] - bs : s[1] - bs / 2); ctx.scale(bs / 24, bs / 24);   // 足元アンカーは先端を座標へ
					ctx.fillStyle = p["@fill"] || "#cc4444"; ctx.fill(path, "evenodd");
					ctx.lineWidth = 1.4; ctx.strokeStyle = p["@stroke"] || "rgba(0,0,0,.35)"; ctx.stroke(path);
					ctx.restore();
				} else if (shape) {
					shapePath(shape, s[0], s[1], (size / 2) * (SHAPE_SCALE[shape] || 1));   // 塗り面積を大体そろえる
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

	// @pop（引き出し線つき吹き出し）は pop-layer.js が DOM 箱＝エンジンの pop ガジェットで再生（v2 と同一実装）。
	// canvas 直描きは廃止＝ここでは扱わない。

	// @blur＝不確定エリア＝canvas2D の blur で soft な塗りを描く（stroke なし・面のみ・@spline と併用可）。gint は非描画。
	function drawBlurs(pr, st) {
		const feats = st.model.feats;
		for (const eid of envOf(st).blurs) {
			const f = feats.get(eid);
			if (!f || f.coords || (st.hidden && st.hidden.has(eid))) continue;   // 点／ドラッグ中は対象外
			const blur = +f.properties?.["@blur"];
			if (!(blur > 0)) continue;
			const rings = st.model.listsOf(f).filter(l => l.ring);
			if (!rings.length) continue;
			const spline = !!f.properties["@spline"];
			ctx.save();
			ctx.filter = `blur(${blur}px)`;
			ctx.beginPath();
			for (const { list } of rings) { tracePts(pr, spline ? smoothRing(st.model.stitch(list), true) : st.model.stitch(list)); ctx.closePath(); }
			ctx.fillStyle = f.properties["@fill"] || "rgba(120,170,221,.5)";
			ctx.fill("evenodd");
			ctx.restore();
		}
	}

	function drawPolyLines(pr, st) {   // @poly＝ポリゴン化した線（帯）。gint 非描画・blur と同型の canvas2D 経路
		const feats = st.model.feats;
		for (const eid of envOf(st).bands) {
			const f = feats.get(eid);
			if (!f || f.coords || (st.hidden && st.hidden.has(eid))) continue;
			const p = f.properties || {};
			if (!p["@poly"]) continue;
			const lists = st.model.listsOf(f).filter(l => !l.ring);   // 線のみ
			if (!lists.length) continue;
			const w = +p["@width"] > 0 ? +p["@width"] : 1.5;
			const capS = p["@start"] || p["@cap0"] || "", capE = p["@end"] || p["@cap1"] || "";   // @cap0/1＝旧名の後方互換（正名=@start/@end・本人裁定）
			for (const { list } of lists) {
				const cs = p["@spline"] ? smoothRing(st.model.stitch(list), false) : st.model.stitch(list);
				const q = [];   // 画面座標の折れ線（大圏分割込み・裏半球は落とす）
				for (let i = 0; i < cs.length - 1; i++) for (const s of seg(pr, cs[i], cs[i + 1])) if (s[2] >= 0) q.push(s);
				if (q.length < 2) continue;
				ctx.beginPath();
				buildLinePath(ctx, q, w, capS, capE);
				ctx.fillStyle = p["@fill"] || "rgba(120,170,221,.25)"; ctx.fill();
				ctx.lineWidth = 1.5; ctx.lineJoin = "round"; ctx.strokeStyle = p["@stroke"] || "#2b5f8f"; ctx.stroke();
			}
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
		const lists = st.model.listsOf(f);
		const spline = !!f.properties?.["@spline"];   // 不確定エリア＝制御点を Catmull-Rom で曲線化して見せる
		const coordsOf = (list, ring) => spline ? smoothRing(st.model.stitch(list), ring) : st.model.stitch(list);
		if (fill) {   // 塗りは外環＋穴を一本のパスに入れて一度だけ＝evenoddで穴(内環)は塗られない
			ctx.beginPath();
			let any = false;
			for (const { list, ring } of lists) if (ring) { tracePts(pr, coordsOf(list, ring)); ctx.closePath(); any = true; }
			if (any) { ctx.fillStyle = COL.fill; ctx.fill("evenodd"); }
		}
		if (spline) {   // 曲線＝環/線ごとに一本のストローク（共有arcのアクセントは省く）
			for (const { list, ring } of lists) { ctx.beginPath(); tracePts(pr, coordsOf(list, ring)); ctx.lineWidth = 2; ctx.strokeStyle = COL.edge; ctx.stroke(); }
		} else for (const { list } of lists) {
			// 辺：共有arc（refs>1）はアクセント色＝「ここを動かすと隣も動く」の可視化
			for (const s of list) {
				const aid = s < 0 ? ~s : s, arc = st.model.arcs.get(aid);
				ctx.beginPath(); tracePts(pr, st.model.arcCoords(s));
				ctx.lineWidth = 2; ctx.strokeStyle = arc.refs.size > 1 ? COL.edgeShared : COL.edge; ctx.stroke();
			}
		}
	}
	function drawBundleHi(pr, st, eid) {   // 束ね候補の強調：面=薄紫塗り(穴抜き)＋太紫線／線=太紫線／点=紫丸
		const f = st.model.feats.get(eid);
		if (!f) return;
		if (f.coords) { for (const c of f.coords) { const s = pr(c[0], c[1]); if (s[2] >= 0) dot(s[0], s[1], 7, COL.bundleHi, "#fff"); } return; }
		const lists = st.model.listsOf(f);
		ctx.beginPath(); let any = false;
		for (const { list, ring } of lists) if (ring) { tracePts(pr, st.model.stitch(list)); ctx.closePath(); any = true; }
		if (any) { ctx.fillStyle = COL.bundleFill; ctx.fill("evenodd"); }
		for (const { list } of lists) { ctx.beginPath(); tracePts(pr, st.model.stitch(list)); ctx.lineWidth = 3.5; ctx.strokeStyle = COL.bundleHi; ctx.stroke(); }
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
			if (st.model.large) continue;   // 大規模モード＝中点（挿入）ハンドル無し（arc数を変える操作はPhase2対象外）
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
		// 大規模モード＝環境系パス（シンボル/blur/帯＝全feats走査）は描かない。選択・ドラッグ中の
		// フィーチャとハンドルだけ描く（Phase2 頂点編集＝GintBUF lift 済みの arcs を model と同規約で読む）
		if (!st.model.large) {
			drawBlurs(pr, st);   // 不確定エリアのぼかし塗り（面の下地）
			drawPolyLines(pr, st);   // ポリゴン化した線＝帯（@poly＝canvas2D 経路）
			drawSymbols(pr, st);
		}
		// 大規模モードの編集近傍（focus）＝gint消灯中の代役描画（選択とドラッグ分は下の各パスが描く＝重複除外）
		if (st.model.large && st.focus) for (const eid of st.focus) {
			if (eid === st.selection || st.dragEids?.has(eid)) continue;
			drawFeature(pr, st, eid, { fill: false });
		}
		if (st.dragEids) for (const eid of st.dragEids) drawFeature(pr, st, eid, { fill: true });
		if (st.bundle && st.bundle.size) for (const eid of st.bundle) drawBundleHi(pr, st, eid);   // 束ね選集合＝紫のハイライト
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

	// frameHooks は render() の中＝ここで投げるとエンジンの描画ループごと止まる。オーバレイ1枚の不具合を地図の死に昇格させない
	const unsub = map.onFrame(() => { try { draw(); } catch (e) { console.error("[geoedit] overlay draw failed", e); } });
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
		destroy() { unsub(); canvas.remove(); for (const [v, im] of images) if (v instanceof Blob) URL.revokeObjectURL(im.src); images.clear(); },
	};
}
