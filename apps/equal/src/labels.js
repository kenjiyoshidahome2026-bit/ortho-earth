// ラベル層（Canvas2D・GL の上に重ねる最前面）。japan の labels2d と同じ考え方＝当選集合は間引き（衝突判定を
// 150ms ごと）で安定させ、位置は毎フレーム投影＝文字は地図と一緒に滑らかに動き、明滅しない。
// 2D 正積図なので投影は x=dλ·k(φ), y=y(φ) の 2 式だけ（球の裏側・地平線の問題がない）。
import { yOfLat, kOfLat, pxPerUnit } from "./equalearth.js";

const FONT = `"Noto Sans JP","Hiragino Sans","Yu Gothic UI","Yu Gothic",system-ui,sans-serif`;
const D2R = Math.PI / 180;

// 空港の記号＝ortho-japan の shields.js と同じ Material Icons "flight"（viewBox 24・上向き）。
// 都市の丸と同じ形にしない＝交通の記号は形で区別する（本人 2026-09-18）。色は配色テーマから貰う。
const PLANE_PATH = typeof Path2D !== "undefined" ? new Path2D("M21.5 15.5v-2l-8-5v-5.5c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v5.5l-8 5v2l8-2.5v5.5l-2 1.5v1.5l3.5-1 3.5 1v-1.5l-2-1.5v-5.5l8 2.5z") : null;
const MARKS = { plane: { path: () => PLANE_PATH, box: 24 } };   // box＝パスの viewBox（描画時に size へ縮める）

// label: { text, lon, lat, size(CSS px), minZoom, priority(小さいほど強い), kind:"country"|"capital"|"city", color, halo, dot, dotColor（点だけの色・無ければ color） }
export function createLabels(canvas) {
	const ctx = canvas.getContext("2d");
	let labels = [], winners = new Map(), lastCollide = -1e9, lastKey = "";
	const fades = new Map(), widthCache = new Map();
	const keyOf = L => L.kind + "|" + L.text + "@" + L.lon.toFixed(3) + "," + L.lat.toFixed(3);

	function setLabels(list) {
		labels = list.slice().sort((a, b) => a.priority - b.priority || b.size - a.size);
		lastKey = "";   // 次の draw で必ず衝突判定
	}
	const project = (view, L, W, H) => {
		const s = pxPerUnit(view.zoom);
		let dlon = L.lon - view.lon; dlon = ((dlon + 180) % 360 + 360) % 360 - 180;
		return [W / 2 + dlon * D2R * kOfLat(L.lat) * s, H / 2 - (yOfLat(L.lat) - yOfLat(view.lat)) * s];
	};
	const widthOf = L => {
		const k = L.size + "|" + L.text;
		let w = widthCache.get(k);
		if (w == null) { ctx.font = fontOf(L); w = ctx.measureText(L.text).width; widthCache.set(k, w); }
		return w;
	};
	const fontOf = L => `${L.kind === "country" ? "600" : L.kind === "capital" ? "600" : "400"} ${L.size}px ${FONT}`;

	// 衝突判定：優先順に矩形を置き、重なれば落とす（pad＝文字間の最小余白）
	function collide(view, W, H, now) {
		const boxes = [], next = new Map(), pad = 4;
		const hit = (x0, y0, x1, y1) => { for (const b of boxes) if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) return true; return false; };
		for (const L of labels) {
			if (view.zoom < L.minZoom || (L.maxZoom != null && view.zoom > L.maxZoom)) continue;
			const [x, y] = project(view, L, W, H);
			if (x < -200 || x > W + 200 || y < -50 || y > H + 50) continue;
			const mark = L.mark && MARKS[L.mark];
			const w = mark ? L.size : widthOf(L), h = mark ? L.size : L.size * 1.2;
			const dx = mark ? -w / 2 : L.dot ? L.dot + 3 : -w / 2;
			// 国名は代表点の真上に置けなければ上下にずらす（首都名と代表点が近い＝パリ/ベルリン/ローマ）
			const shifts = (L.dot || mark) ? [0] : [0, -h * 1.3, h * 1.3, -h * 2.6, h * 2.6];
			let placed = null;
			for (const dy of shifts) { const x0 = x + dx - pad, y0 = y + dy - h / 2 - pad, x1 = x + dx + w + pad, y1 = y + dy + h / 2 + pad; if (!hit(x0, y0, x1, y1)) { placed = [x0, y0, x1, y1, dy]; break; } }
			if (!placed) continue;
			boxes.push(placed);
			next.set(keyOf(L), { L, dy: placed[4] });
		}
		winners = next; lastCollide = now;
	}

	function draw(view, W, H, dpr, now = performance.now()) {
		if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
		const key = `${view.lon.toFixed(4)},${view.lat.toFixed(4)},${view.zoom.toFixed(3)},${W},${H},${labels.length}`;
		if (key !== lastKey && now - lastCollide > 150) { collide(view, W, H, now); lastKey = key; }
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, W, H);
		ctx.textBaseline = "middle"; ctx.lineJoin = "round";
		let animating = false;
		// フェード：当選＝1 へ・落選＝0 へ（0.25s）
		for (const [k, w] of winners) { const f = fades.get(k); if (!f) fades.set(k, { L: w.L, dy: w.dy, a: 0, t: now }); else f.dy = w.dy; }
		for (const [k, f] of fades) {
			const target = winners.has(k) ? 1 : 0, dt = (now - f.t) / 1000; f.t = now;
			if (f.a < target) f.a = Math.min(target, f.a + dt * 4); else if (f.a > target) f.a = Math.max(target, f.a - dt * 4);   // 到達後は動かさない（旧＝三項で減少側へ落ち 1→0→1 と振動＝永久再描画）
			if (f.a !== target) animating = true;
			if (f.a <= 0 && target === 0) { fades.delete(k); continue; }
			const L = f.L, [x, y0] = project(view, L, W, H), y = y0 + (f.dy || 0);
			ctx.globalAlpha = f.a;
			const mark = L.mark && MARKS[L.mark];
			if (mark) {   // 記号だけのラベル（空港の✈）＝地色のハローを敷いてから塗る（japan の shields.js と同じ手当て）
				const path = mark.path(), k = L.size / mark.box;
				if (path) {
					ctx.save();
					ctx.translate(x - L.size / 2, y - L.size / 2); ctx.scale(k, k);
					ctx.strokeStyle = L.halo; ctx.lineWidth = mark.box * 0.11; ctx.stroke(path);
					ctx.fillStyle = L.color; ctx.fill(path);
					ctx.restore();
				}
				continue;
			}
			ctx.font = fontOf(L);
			if (L.dot) {   // 都市の点（首都＝二重丸）
				const dc = L.dotColor || L.color;
				ctx.beginPath(); ctx.arc(x, y, L.dot, 0, Math.PI * 2); ctx.fillStyle = dc; ctx.fill();
				ctx.lineWidth = 1; ctx.strokeStyle = L.halo; ctx.stroke();
				if (L.kind === "capital") { ctx.beginPath(); ctx.arc(x, y, L.dot + 2.5, 0, Math.PI * 2); ctx.lineWidth = 1; ctx.strokeStyle = dc; ctx.stroke(); }
			}
			const tx = L.dot ? x + L.dot + 3 : x;
			ctx.textAlign = L.dot ? "left" : "center";
			if (L.spacing) ctx.letterSpacing = L.spacing; else ctx.letterSpacing = "0px";
			ctx.lineWidth = HALO_W; ctx.strokeStyle = L.halo; ctx.strokeText(L.text, tx, y);
			ctx.fillStyle = L.color; ctx.fillText(L.text, tx, y);
		}
		ctx.globalAlpha = 1;
		return animating;
	}
	return { setLabels, draw, debug: () => ({ labels: labels.length, winners: [...winners.values()].map(w => w.L.kind + ":" + w.L.text) }) };
}

// ── ラベルの材料 ──
// 地図上の文字の大きさ（本人 2026-09-18「少しだけ小さく」）＝一つのノブで国名・首都・都市をまとめて縮める。
// 0.5px 刻みに丸める＝キャンバスの字形が半端な小数でにじまない。国名 13→12 / 都市 10→9 が現物。
export const LABEL_SCALE = 0.92;
// 文字のハロー（白枠）の太さ。3 だと字画の内側まで太って和文が潰れ気味＝少しだけ細く（本人 2026-09-18）。
// 記号（✈）のハローも同じ考えで viewBox 比の係数を一段細める。
export const HALO_W = 2.4;
const S = px => Math.round(px * LABEL_SCALE * 2) / 2;

// 日本語の都市名から行政区分の接尾辞を落とす（本人 2026-09-18「〜市、〜特別市をのぞいて」）。
// NE の NAME_JA は中国・韓国・台湾の都市に区分名が付く（北京市・ソウル特別市・釜山広域市…＝実データで 489 件）。
// 地図の注記は地名だけで足りる。落とすのは「市」の族（特別市・広域市・直轄市・市）だけ＝都/府/県/州/区 は残す
// （東京都・クイーンズランド州のように区分名まで含めて通称の物がある）。末尾の 1 つだけ落とす＝
// 津市市→津市・四日市市→四日市 が正しく残り、呉市→呉・津市→津 も実データで確認済み。
export const stripJaCitySuffix = s => {
	const src = String(s ?? "");
	const t = src.replace(/(特別市|広域市|直轄市|市)$/, "");
	// 「都」は語幹が 2 文字以上の時だけ落とす（本人 2026-09-18「東京都を東京に」）。
	// 実データの「都」終わりは 東京都・京都・成都 の 3 件だけ＝語幹 東京(2)/京(1)/成(1)＝この一線で正しく分かれる。
	// 「市」に同じ門を付けないのは 呉市→呉・津市→津 が正しいから（語幹 1 文字でも地名として成立する）。
	const u = /都$/.test(t) && [...t].length >= 3 ? t.slice(0, -1) : t;
	return u || t || src;
};
// 国：World DB の代表点（Wikidata の座標）・面積で出すズームと文字の大きさを決める（大国＝下限から・小国＝寄ってから）
export function countryLabels(world, nameOf, pal) {
	const out = [];
	for (const n of world.items) {
		if (!n.coord || !(n.area > 0)) continue;
		const a = n.area;
		const [minZoom, size0] = a >= 2e6 ? [-9, 13] : a >= 5e5 ? [2.3, 12] : a >= 1e5 ? [3, 11.5] : a >= 2e4 ? [3.8, 11] : a >= 2e3 ? [4.6, 10.5] : [5.4, 10];
		const size = S(size0);
		out.push({ text: nameOf(n), lon: n.coord[0], lat: n.coord[1], size, minZoom, priority: 1 - Math.min(0.9, Math.log10(a) / 8), kind: "country", color: pal.country, halo: pal.halo, spacing: "0.08em" });
	}
	return out;
}
// 都市：NE populated_places（world の base に同梱・key 付き・属性は NE の大文字）。首都＝ADM0CAP・出すズーム＝NE の MIN_ZOOM・大きさ＝SCALERANK
export const F = (p, k) => p[k] ?? p[k.toUpperCase()] ?? p[k.toLowerCase()];
export function cityLabels(features, nameOf, pal) {
	const out = [];
	for (const f of features) {
		const p = f.properties; if (!f.geometry || f.geometry.type !== "Point") continue;
		const cap = +F(p, "adm0cap") === 1, srv = +F(p, "scalerank"), sr = Number.isFinite(srv) ? srv : 8, mz = Number.isFinite(+F(p, "min_zoom")) ? +F(p, "min_zoom") : 6;
		const text = nameOf(p); if (!text) continue;
		out.push({ text, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], size: S(cap ? 11.5 : sr <= 2 ? 11 : sr <= 4 ? 10.5 : 10),
			minZoom: cap ? Math.min(mz, 3) : mz, priority: cap ? 0.2 + sr / 20 : 2 + sr / 20, kind: cap ? "capital" : "city", color: pal.city, dotColor: cap ? (pal.capital || pal.city) : undefined, halo: pal.halo, dot: cap ? 3 : 2.2 });   // 首都の点だけ正本の capital（赤・world の国の地図と同じ顔）＝首都名の文字は他の都市と同じ色（本人 2026-09-24「黒に戻して」）   // 首都は大国（面積 1e7km²・priority≈0.13）の次＝国名の方が首都を避けて上下にずれる
	}
	return out;
}

// 空港：NE populated_places と同じ作法で「記号だけ」を置く（名前は出さない＝低ズームの地図が文字で埋まらない）。
// 出すズームは呼び出し側が渡す（本人 2026-09-18「空港の表示は z>5」）。大ハブほど先に出る（NE の scalerank）。
export function airportLabels(features, pal, { minZoom = 5, size = 12 } = {}) {
	const out = [];
	for (const f of features) {
		if (!f.geometry || f.geometry.type !== "Point") continue;
		const p = f.properties, srv = +F(p, "scalerank"), sr = Number.isFinite(srv) ? srv : 8;
		// 出しズームは一律（本人「空港の表示は z>5」）＝段階的に増やさない。混み具合は衝突判定に任せ、
		// NE の scalerank は優先順にだけ効かせる＝大ハブが先に残り、小さな飛行場から落ちる。
		out.push({ text: "", mark: "plane", lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
			size, minZoom, priority: 3 + sr / 20, kind: "airport",
			color: pal.airport || pal.city, halo: pal.halo });
	}
	return out;
}
