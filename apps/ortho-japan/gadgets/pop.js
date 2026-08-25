// ガジェット：地点に紐づく吹き出し（引出線つき）。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.pop() で搭載する（v1 ortho-map の gadget 作法＝this が map）。戻り値＝pop 関数（.clear 付き）。
// pop(内容, { lng, lat, x, y }) で経緯度に錨を打つ＝箱は画面に留まり、線が世界の地点へ伸びる（パンで線が動く）。
// 箱はドラッグで移動・📌で固定・×で消す。裏半球へ回った錨は自動で隠れる。
// projectLL＝経緯度→画面CSS座標[x,y,front]（実装は engine の project／注入は登録側）。
// マーカー追随は本体 render のフック＝返す pop 関数の _update を登録側が frameHooks へ入れて毎フレ呼ぶ。
import { tr } from "../i18n.js";
const t = tr({ "閉じる": "Close", "固定": "Pin" });
// 📌 は絵文字でなく SVG（白抜きを環境非依存に・currentColor で色を CSS へ委譲）。
// 固定中は「刺さったピンを真上から見た頭」＝○に切替（＝ここに刺さっている、の意）。
const PIN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5a3 3 0 0 1-3 3v2h5.97v7l1 1 1-1v-7H19v-2a3 3 0 0 1-3-3z"/></svg>';
const PINNED_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="12" r="5.5"/></svg>';
export function pop({ projectLL, signal } = {}) {
	const mapEl = this.mapEl;
	if (mapEl.querySelector("#pop-lines")) return () => {};   // 二重搭載は無害
	const dpr = window.devicePixelRatio || 1;
	const canvas = document.createElement("canvas");
	canvas.id = "pop-lines";   // 引出線の層＝#map 直下（既存canvasより後＝上、pop箱より先＝下）
	mapEl.append(canvas);
	const ctx = canvas.getContext("2d");
	let cw = 0, ch = 0;
	const toHTML = s => Array.isArray(s) ? s.map(t => `<div>${t}</div>`).join("")
		: (typeof s === "string" && s.includes("\n")) ? toHTML(s.split(/\n/)) : s;
	let pops = [];

	const pop = (content, at) => {
		if (!content || !at) return;
		const div = document.createElement("div");
		div.className = "pop";
		const body = document.createElement("div");   // 文言だけの器＝×/📌を消さずに差し替えできる（編集器の @pop 追随用）
		body.className = "pop-body"; body.innerHTML = toHTML(content);
		const close = document.createElement("button");
		close.className = "panel-close"; close.textContent = "×"; close.title = t("閉じる"); close.setAttribute("aria-label", t("閉じる"));
		close.addEventListener("click", e => {
			e.stopPropagation();
			if (at.onClose) return at.onClose();   // 始末を呼び出し側が持つ場合（編集器＝@popを消す）＝箱の除去は _remove 経由に一本化
			pops = pops.filter(p => p !== rec); div.remove(); draw();
		});
		const pin = document.createElement("button");
		pin.className = "pop-pin"; pin.innerHTML = PIN_SVG; pin.title = t("固定"); pin.setAttribute("aria-label", t("固定"));
		pin.addEventListener("click", e => {
			e.stopPropagation(); rec.locked = pin.classList.toggle("on");
			pin.innerHTML = rec.locked ? PINNED_SVG : PIN_SVG;   // 固定中＝刺さったピンの頭（○）＝右端へ（×が消えた席）
			close.style.display = rec.locked ? "none" : ""; div.style.cursor = rec.locked ? "default" : "grab";
		});
		div.append(body, close, pin);
		mapEl.append(div);
		const rec = { div, coords: [at.lng, at.lat], pos: [0, 0], half: [0, 0], locked: false, hideOffscreen: !!at.hideOffscreen };
		// 初期位置＝カーソル脇（クリック点 x,y の右）。画面端は内側へ寄せる。
		const r = div.getBoundingClientRect(), W = mapEl.clientWidth, H = mapEl.clientHeight;
		const osx = 12, w = r.width, h = r.height;
		let left = (at.x + osx + w > W) ? at.x - w - osx : at.x + osx;
		let top = (at.y - h / 2 < 0) ? 0 : (at.y + h / 2 > H) ? H - h : at.y - h / 2;
		place(rec, left, top);
		// ドラッグ（箱を画面上で動かす。固定中は不動。地図パンには奪わせない）
		div.style.cursor = "grab";
		div.addEventListener("pointerdown", e => {
			if (rec.locked || close.contains(e.target) || pin.contains(e.target)) return;   // ×/📌（内部SVG含む）上は掴まない＝クリックをドラッグに食わせない
			e.stopPropagation(); e.preventDefault();
			const rr = mapEl.getBoundingClientRect(), x0 = e.clientX - rr.left, y0 = e.clientY - rr.top;
			const l0 = parseFloat(div.style.left), t0 = parseFloat(div.style.top);
			div.style.cursor = "grabbing"; div.setPointerCapture?.(e.pointerId);
			const onMove = ev => { const x = ev.clientX - rr.left, y = ev.clientY - rr.top; place(rec, l0 + x - x0, t0 + y - y0); draw(); };
			const onUp = () => { div.style.cursor = "grab"; div.removeEventListener("pointermove", onMove); div.removeEventListener("pointerup", onUp); };
			div.addEventListener("pointermove", onMove); div.addEventListener("pointerup", onUp);
		});
		// 追随フックとプログラム操作の手綱（既存の imperative 呼び出しには無害・編集器の照合が使う）＝
		// 文言差し替え／アンカー移動／プログラム除去。これで「作った吹き出しが v2 ビューアでも同じ動きで再生」を同一実装で担保。
		div._setContent = c => { body.innerHTML = toHTML(c); place(rec, parseFloat(div.style.left) || 0, parseFloat(div.style.top) || 0); draw(); };
		div._setAnchor = (lng, lat) => { rec.coords = [lng, lat]; draw(); };
		div._remove = () => { pops = pops.filter(p => p !== rec); div.remove(); draw(); };
		pops.push(rec); draw();
		return div;
	};
	pop.clear = all => { pops = pops.filter(p => (all !== true && p.locked) ? true : (p.div.remove(), false)); draw(); };
	pop._update = () => {   // 毎フレ：popが1つも無ければ即return＝全画面canvasの消去・合成とレイアウト読みを毎フレ積まない（PLATEAU時のカクツキ対策）
		if (pops.length) draw();   // 空になった時の消去は close/clear 側の draw() が済ませている
	};
	return pop;

	function place(rec, left, top) {
		rec.div.style.left = left + "px"; rec.div.style.top = top + "px";
		const r = rec.div.getBoundingClientRect();
		rec.pos = [left + r.width / 2, top + r.height / 2];
		rec.half = [r.width / 2, r.height / 2];   // 縁クリップ用の半寸（描画時のレイアウト読みを避ける）
	}
	function draw() {
		const w = mapEl.clientWidth, h = mapEl.clientHeight;   // 寸法合わせは描く時だけ（_updateから移設）
		if (w !== cw || h !== ch) { cw = w; ch = h; canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = w + "px"; canvas.style.height = h + "px"; }
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cw, ch);
		for (const p of pops) {
			const [sx, sy, front] = projectLL(p.coords[0], p.coords[1]);
			if (front < 0 || (p.hideOffscreen && (sx < 0 || sy < 0 || sx > cw || sy > ch))) { p.div.style.display = "none"; continue; }   // 裏半球／(指定時)錨が画面外＝隠す
			p.div.style.display = "";
			// 引出線は箱の中心でなく外周で止める（中心まで伸ばすと箱越しに線が薄く透ける＝本人指摘）。
			const [cx, cy] = p.pos, [hw, hh] = p.half, dx = sx - cx, dy = sy - cy;
			const adx = Math.abs(dx), ady = Math.abs(dy);
			const s = Math.min(adx > 0 ? hw / adx : Infinity, ady > 0 ? hh / ady : Infinity);   // 中心→縁（アンカー向き）の縮率
			if (s < 1) {   // アンカーが箱の外にある時だけ線を引く（縁の交点まで）
				const ex = cx + dx * s, ey = cy + dy * s;
				ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey);
				ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 3; ctx.stroke();
				ctx.strokeStyle = "#2b3b57"; ctx.lineWidth = 1.5; ctx.stroke();
			}
			ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2);
			ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "#2b3b57"; ctx.lineWidth = 1.5; ctx.stroke();
		}
	}
}
