// geopbf/edit/draw ── @スタイル（geoedit ⇄ anno ビューア）の描画プリミティブの**正典**（2026-09-20・packages/geoedit 分離に伴い移設）。
// 「エディタで作った表現がビューアで同じ動きで再生される」を実装の共有で担保する＝図形（PICTO/SHAPE_SCALE/BOTTOM_ANCHOR）・
// 大円分割つき投影のトレーサ（makeTracer）・帯（buildLinePath）・経度の最短差（dLon）はここ一本。
// 使う側：@ortho-earth/geoedit（overlay）・ortho-japan gadgets/anno-draw.js（worker 内の再生）・anno.js（再輸出）。DOM なし・worker 安全。
import { toVec, toLL, slerp, angleBetween } from "./sphere.js";   // 完全球体＝辺は大円で結ぶ（本人裁定 9/14）

// ---- 基本図形 ----
// marker=涙滴マーカー。pin=3Dピン（棒＋球）＝チルトで立つ／真俯瞰は円。他はスプライト。
export const SHAPE_NAMES = ["pin", "marker", "circle", "square", "triangle", "diamond", "star", "flag", "home", "camera", "train", "warn", "drop"];
// 塗り面積を「円と大体同じ」にそろえる描画スケール（solid は解析面積 f=√(π/面積係数)・シルエットは手調整）。未指定は 1。
export const SHAPE_SCALE = {
	circle: 0.9, square: 0.8, triangle: 1.25, diamond: 1.13, star: 1.39, pin: 0.8,   // pin は球(円)＝circleより少し小さめ
	marker: 1.2, flag: 1.35, home: 1.25, camera: 1.2, train: 1.15, warn: 1.35, drop: 1.3,
};
// 単色シルエット図形（塗り=@fill・穴は evenodd）。marker/flag は足元アンカー（先端/棒根本= y=24＝座標に接地）。24×24 viewBox。
export const PICTO = {
	marker: "M12 24C9.2 19.55 5.5 14.1 5.5 9.2A6.5 6.5 0 0 1 18.5 9.2C18.5 14.1 14.8 19.55 12 24Z M12 6.9A2.4 2.4 0 1 0 12.01 11.7 2.4 2.4 0 0 0 12 6.9Z",
	flag: "M11.1 2H12.9V24H11.1Z M12.9 3H21L18.2 6.7 21 10.4H12.9Z",
	home: "M12 3l9 8h-2.6v9h-4.9v-6h-3v6H5.6v-9H3z",
	camera: "M8.5 5h7l1.4 2.4H21V20H3V7.4h4.1z M12 9.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2z",
	train: "M7 3h10a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3l1.8 3.4h-2.3l-1.8-3.4H9.3l-1.8 3.4H5.2L7 17a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z M8 7v4.6h8V7z",
	warn: "M12 3l9.6 17.6H2.4z M11 9.5h2v5.4h-2z M11 16.4h2v2h-2z",
	drop: "M12 3s6.2 7.6 6.2 11.6a6.2 6.2 0 0 1-12.4 0C5.8 10.6 12 3 12 3z",
};
export const BOTTOM_ANCHOR = new Set(["marker", "flag"]);   // 足元＝座標にアンカー（他は中心）

// ---- 大円分割つき投影のトレーサ（canvas2D 1 枚に束ねる）＝geoedit overlay とビューア再生の単一実装（効率レビュー H-1/§5）----
// seg: a→b を中心角 0.5° 刻みの大円（最短側＝antimeridian 跨ぎで裏側回りにしない）で分割して投影。n=1（編集ズームの大半）は
// slerp/toLL を通さず端点を直接投影＝経緯度の往復丸めもしない。walk は前辺の vb を次辺の va に使い回す（toVec は 1 頂点 1 回）。
// tracePts(fill=true)＝見えない点（projector が地平円へクランプした位置）でも切らずに一本で結ぶ＝可視部＋地平線沿いの閉路（全点不可視は描かない）。
// fill=false＝見えない区間で切る（地平線沿いに線を引かない）。projLine＝帯用の画面座標列（裏半球は落とす）。
export function makeTracer(ctx) {
	const segEmit = (pr, a, b, va, vb, emit) => {
		const n = Math.min(256, Math.max(1, Math.ceil(angleBetween(va, vb) * 180 / Math.PI / 0.5)));
		emit(pr(a[0], a[1]));
		for (let i = 1; i < n; i++) { const p = toLL(slerp(va, vb, i / n)); emit(pr(p[0], p[1])); }
		emit(pr(b[0], b[1]));
	};
	const walk = (pr, coords, emit) => {
		if (!coords || coords.length < 2) return;
		let va = toVec(coords[0][0], coords[0][1]);
		for (let i = 0; i < coords.length - 1; i++) { const b = coords[i + 1], vb = toVec(b[0], b[1]); segEmit(pr, coords[i], b, va, vb, emit); va = vb; }
	};
	const seg = (pr, a, b) => { const out = []; segEmit(pr, a, b, toVec(a[0], a[1]), toVec(b[0], b[1]), q => out.push(q)); return out; };
	const tracePts = (pr, coords, fill = false) => {
		if (fill) {
			const pts = []; let any = false;
			walk(pr, coords, q => { if (q[2] >= 0) any = true; pts.push(q); });
			if (!any) return;
			for (let i = 0; i < pts.length; i++) i ? ctx.lineTo(pts[i][0], pts[i][1]) : ctx.moveTo(pts[i][0], pts[i][1]);
			return;
		}
		let started = false;
		walk(pr, coords, q => {
			if (q[2] < 0) { started = false; return; }
			if (!started) { ctx.moveTo(q[0], q[1]); started = true; } else ctx.lineTo(q[0], q[1]);
		});
	};
	const projLine = (pr, coords) => { const q = []; walk(pr, coords, s => { if (s[2] >= 0) q.push(s); }); return q; };
	return { seg, tracePts, projLine, walk };
}
// 経度の最短差（antimeridian 跨ぎ）：線分の内挿・中点・平行移動の差分は必ずこれを通す（正典・geoedit も import）。
// 生の差 b-a で内挿すると ±179.9 の混在（normLon 産）が「地球の裏側回り」の帯になる（2026-09-12・geoedit の円で発覚）。
export const dLon = (from, to) => { const d = to - from; return d - Math.round(d / 360) * 360; };

// ---- @poly（ポリゴン化した線＝帯）＝折れ線を「幅 w の帯＋端形状」の単一閉路として ctx へパス構築（正典）。
// 塗り(+alpha)が矢じり込みで均一・輪郭が端形状まで一周。capS/capE ∈ ""(butt)/"square"/"round"/"arrow"。
// arrow は太さ純比例（最大幅=線幅×2・先端60°）・先端＝端点そのもの。join は miter（clamp 付き）。----
export function buildLinePath(ctx, q0, w, capS, capE) {
	const hw = Math.max(0.5, w / 2), ahalf = w, alen = w * Math.sqrt(3);   // 矢じり＝最大幅2w・先端60°（len=half/tan30°）
	// ★連続重複点の除去：seg() は区間ごとに両端点込み＝継ぎ目が二重＝方向ゼロ→miter cos=0→スパイク（ゲジゲジ）
	let q = [];
	for (const p2 of q0) { const l = q[q.length - 1]; if (!l || Math.hypot(p2[0] - l[0], p2[1] - l[1]) > 0.1) q.push(p2); }
	if (q.length < 2) return;
	const tipS = q[0], tipE = q[q.length - 1];
	const trim = (pts, atEnd, len) => {   // 矢じり側＝基部まで線体を切り詰め。★複数点を跨いで累積距離で（密点列の鈍角化防止）
		const out = atEnd ? pts.slice() : pts.slice().reverse();
		let rest = len;
		while (out.length >= 2) {
			const b = out[out.length - 1], a = out[out.length - 2];
			const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
			if (l >= rest || out.length === 2) {   // このセグメント内で切る（最短でも1割は線体を残す）
				const t = Math.min(rest, l * 0.9) / (l || 1);
				out[out.length - 1] = [b[0] - (b[0] - a[0]) * t, b[1] - (b[1] - a[1]) * t];
				break;
			}
			out.pop(); rest -= l;   // セグメントごと矢じりに呑まれる＝点を落として先へ
		}
		return atEnd ? out : out.reverse();
	};
	if (capS === "arrow") q = trim(q, false, alen);
	if (capE === "arrow") q = trim(q, true, alen);
	const n = q.length, d = [];
	for (let i = 0; i < n - 1; i++) { const dx = q[i + 1][0] - q[i][0], dy = q[i + 1][1] - q[i][1], l = Math.hypot(dx, dy) || 1; d.push([dx / l, dy / l]); }
	const R = [], L = [];
	for (let i = 0; i < n; i++) {   // miter オフセット（端は素のセグメント法線）
		const da = d[Math.max(0, i - 1)], db = d[Math.min(n - 2, i)];
		let mx = da[0] + db[0], my = da[1] + db[1], ml = Math.hypot(mx, my), nx, ny, sc;
		if (ml < 1e-6) { nx = -db[1]; ny = db[0]; sc = hw; }   // 180°折返し
		else {
			mx /= ml; my /= ml; nx = -my; ny = mx;
			sc = hw / Math.max(0.35, Math.abs(nx * -db[1] + ny * db[0]));   // 1/cos(θ/2)・clamp≈2.9倍
		}
		R.push([q[i][0] + nx * sc, q[i][1] + ny * sc]);
		L.push([q[i][0] - nx * sc, q[i][1] - ny * sc]);
	}
	const uE = d[d.length - 1], nE = [-uE[1], uE[0]];
	const uS = [-d[0][0], -d[0][1]], nS = [-d[0][1], d[0][0]];
	const qs = q[0], qe = q[n - 1];
	ctx.moveTo(R[0][0], R[0][1]);
	for (let i = 1; i < n; i++) ctx.lineTo(R[i][0], R[i][1]);
	if (capE === "arrow") {   // 肩へ張り出し→先端→肩
		ctx.lineTo(qe[0] + nE[0] * ahalf, qe[1] + nE[1] * ahalf);
		ctx.lineTo(tipE[0], tipE[1]);
		ctx.lineTo(qe[0] - nE[0] * ahalf, qe[1] - nE[1] * ahalf);
	} else if (capE === "square") {   // hw だけ外へ張り出す角
		ctx.lineTo(qe[0] + (nE[0] + uE[0]) * hw, qe[1] + (nE[1] + uE[1]) * hw);
		ctx.lineTo(qe[0] + (uE[0] - nE[0]) * hw, qe[1] + (uE[1] - nE[1]) * hw);
	} else if (capE === "round") {
		const a0 = Math.atan2(nE[1], nE[0]);
		ctx.arc(qe[0], qe[1], hw, a0, a0 - Math.PI, true);   // 減角方向＝外向き uE を通る半円
	}
	ctx.lineTo(L[n - 1][0], L[n - 1][1]);
	for (let i = n - 2; i >= 0; i--) ctx.lineTo(L[i][0], L[i][1]);
	if (capS === "arrow") {
		ctx.lineTo(qs[0] - nS[0] * ahalf, qs[1] - nS[1] * ahalf);
		ctx.lineTo(tipS[0], tipS[1]);
		ctx.lineTo(qs[0] + nS[0] * ahalf, qs[1] + nS[1] * ahalf);
	} else if (capS === "square") {
		ctx.lineTo(qs[0] + (uS[0] - nS[0]) * hw, qs[1] + (uS[1] - nS[1]) * hw);
		ctx.lineTo(qs[0] + (uS[0] + nS[0]) * hw, qs[1] + (uS[1] + nS[1]) * hw);
	} else if (capS === "round") {
		const a0 = Math.atan2(-nS[1], -nS[0]);
		ctx.arc(qs[0], qs[1], hw, a0, a0 - Math.PI, true);
	}
	ctx.closePath();
}


