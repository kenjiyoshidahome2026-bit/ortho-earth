// ガジェット：地点に紐づく吹き出し（引出線つき）。標準装備でなくオプトイン＝orthoJapan() の戻り値から
// map.gadget.pop() で搭載する（v1 ortho-map の gadget 作法＝this が map）。戻り値＝pop 関数（.clear 付き）。
// pop(内容, { lng, lat, x, y }) で経緯度に錨を打つ＝箱は画面に留まり、線が世界の地点へ伸びる（パンで線が動く）。
// 箱はドラッグで移動・📌で固定・×で消す。裏半球へ回った錨は自動で隠れる。
// projectLL＝経緯度→画面CSS座標[x,y,front]（実装は engine の project／注入は登録側）。
// マーカー追随は本体 render のフック＝返す pop 関数の _update を登録側が frameHooks へ入れて毎フレ呼ぶ。
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
		div.className = "pop"; div.innerHTML = toHTML(content);
		const close = document.createElement("button");
		close.className = "panel-close"; close.textContent = "×"; close.title = "閉じる"; close.setAttribute("aria-label", "閉じる");
		close.addEventListener("click", e => { e.stopPropagation(); pops = pops.filter(p => p !== rec); div.remove(); draw(); });
		const pin = document.createElement("button");
		pin.className = "pop-pin"; pin.textContent = "📌"; pin.title = "固定"; pin.setAttribute("aria-label", "固定");
		pin.addEventListener("click", e => {
			e.stopPropagation(); rec.locked = pin.classList.toggle("on");
			close.style.display = rec.locked ? "none" : ""; div.style.cursor = rec.locked ? "default" : "grab";
		});
		div.append(close, pin);
		mapEl.append(div);
		const rec = { div, coords: [at.lng, at.lat], pos: [0, 0], locked: false };
		// 初期位置＝カーソル脇（クリック点 x,y の右）。画面端は内側へ寄せる。
		const r = div.getBoundingClientRect(), W = mapEl.clientWidth, H = mapEl.clientHeight;
		const osx = 12, w = r.width, h = r.height;
		let left = (at.x + osx + w > W) ? at.x - w - osx : at.x + osx;
		let top = (at.y - h / 2 < 0) ? 0 : (at.y + h / 2 > H) ? H - h : at.y - h / 2;
		place(rec, left, top);
		// ドラッグ（箱を画面上で動かす。固定中は不動。地図パンには奪わせない）
		div.style.cursor = "grab";
		div.addEventListener("pointerdown", e => {
			if (rec.locked || e.target === close || e.target === pin) return;
			e.stopPropagation(); e.preventDefault();
			const rr = mapEl.getBoundingClientRect(), x0 = e.clientX - rr.left, y0 = e.clientY - rr.top;
			const l0 = parseFloat(div.style.left), t0 = parseFloat(div.style.top);
			div.style.cursor = "grabbing"; div.setPointerCapture?.(e.pointerId);
			const onMove = ev => { const x = ev.clientX - rr.left, y = ev.clientY - rr.top; place(rec, l0 + x - x0, t0 + y - y0); draw(); };
			const onUp = () => { div.style.cursor = "grab"; div.removeEventListener("pointermove", onMove); div.removeEventListener("pointerup", onUp); };
			div.addEventListener("pointermove", onMove); div.addEventListener("pointerup", onUp);
		});
		pops.push(rec); draw();
		return div;
	};
	pop.clear = all => { pops = pops.filter(p => (all !== true && p.locked) ? true : (p.div.remove(), false)); draw(); };
	pop._update = () => {   // 毎フレ：canvas寸法を合わせ→再投影して線を引き直す
		const w = mapEl.clientWidth, h = mapEl.clientHeight;
		if (w !== cw || h !== ch) { cw = w; ch = h; canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.width = w + "px"; canvas.style.height = h + "px"; }
		draw();
	};
	return pop;

	function place(rec, left, top) {
		rec.div.style.left = left + "px"; rec.div.style.top = top + "px";
		const r = rec.div.getBoundingClientRect(); rec.pos = [left + r.width / 2, top + r.height / 2];
	}
	function draw() {
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, cw, ch);
		for (const p of pops) {
			const [sx, sy, front] = projectLL(p.coords[0], p.coords[1]);
			if (front < 0) { p.div.style.display = "none"; continue; }   // 裏半球の錨は隠す
			p.div.style.display = "";
			ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(p.pos[0], p.pos[1]);
			ctx.strokeStyle = "rgba(255,255,255,.9)"; ctx.lineWidth = 3; ctx.stroke();
			ctx.strokeStyle = "#2b3b57"; ctx.lineWidth = 1.5; ctx.stroke();
			ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2);
			ctx.fillStyle = "#fff"; ctx.fill(); ctx.strokeStyle = "#2b3b57"; ctx.lineWidth = 1.5; ctx.stroke();
		}
	}
}
