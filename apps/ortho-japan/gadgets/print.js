// ガジェット：印刷（平面図）。標準装備でなくオプトイン＝orthoJapan() の戻り値から map.gadget.print() で搭載。
// v1(ortho-map) の print（画面まるごと×3倍）とは別物＝新仕様：
//   表示中の「中心座標」を中心に、真俯瞰（上が北）の平面図を、指定の縮尺(select)・用紙(A4/A3)・縦横・dpi で
//   組版して印刷する。全くの紙仕様＝二重罫の外枠・経緯線（度分ラベル）・四隅の経緯度・縮尺バー・出典・出力日。
//   内容は画面と同じ点火状態（地名〜施設のチップ定義どおり）＝撮影は本体注入の capture がライブパイプラインを
//   一時的に印刷カメラへ振る。プレビューを見せてから出力（印刷は隠しiframe＝ポップアップ不要）。
// 縮尺の正しさは「切り出す地表幅 ↔ 紙の地図幅(mm)」の対応で構成的に保証（解像度は精細度にだけ効く）。
import { gadgetStack } from "./stack.js";
import { composeLayersToCanvas } from "./shot.js";

// 印刷の出典＝地理院ベクトルタイルの一行のみ。真俯瞰は建物3Dを描かない（renderer の show3d 裁き）＋
// noTerrain で標高ラスタも使わない＝PLATEAU/AW3D30 は紙面に写らないので表記不要（写るものだけ名乗る）。
const PRINT_ATTR = ["出典：国土地理院最適化ベクトルタイル（提供実験）を加工して作成"];

const R = 6371008.8;
export const PAPERS = { a4: [210, 297], a3: [297, 420] };            // [短辺, 長辺] mm
const SCALES = [2500, 5000, 10000, 25000, 50000, 100000, 250000];    // 1:S
const DPIS = [150, 240, 300];                                        // 紙面キャンバスの解像度（select）

// 用紙レイアウト(mm)：余白8mm・下帯14mm・二重罫（外0.7/内0.2・間2mm）。地図は内罫の内側いっぱい。
export function layoutFor(paper = "a4", orient = "landscape") {
	const [s, l] = PAPERS[paper] || PAPERS.a4;
	const [W, H] = orient === "portrait" ? [s, l] : [l, s];
	const m = 8, capH = 14;
	const outer = { x: m, y: m, w: W - m * 2, h: H - m * 2 - capH - 2 };
	const inner = { x: outer.x + 2, y: outer.y + 2, w: outer.w - 4, h: outer.h - 4 };
	const cap = { x: m, y: outer.y + outer.h + 2, w: W - m * 2, h: capH };
	return { W, H, outer, inner, cap };
}

// 縮尺→カメラz：m/csspx = 2πR/(2^z·512)（正射z＝dpr非依存）を「紙の地図幅(mm)×縮尺S＝切り出しCSS幅の地表幅」で解く。
export function zoomForScale(S, mapWmm, cropCssW) {
	const groundW = mapWmm / 1000 * S;   // 地表幅[m]
	return Math.log2(2 * Math.PI * R * cropCssW / (512 * groundW));
}

// 度→度分秒（"北緯35°41′07″" 形式）。秒の繰り上がり処理つき。
function dms(v, pos, neg) {
	const h = v < 0 ? neg : pos; v = Math.abs(v);
	let d = Math.floor(v), mf = (v - d) * 60, mi = Math.floor(mf), s = Math.round((mf - mi) * 60);
	if (s === 60) { s = 0; mi++; } if (mi === 60) { mi = 0; d++; }
	return `${h}${d}°${String(mi).padStart(2, "0")}′${String(s).padStart(2, "0")}″`;
}
// 経緯線ラベル＝辺は「分秒だけ」（度は四隅の表記が持つ＝地形図の作法・枠外余白8mmに収める）。
// ちょうど度線のときだけ「139°」と度で名乗る。秒は刻みが分未満のときだけ添える。
function tickLabel(deg, secStep) {
	const neg = deg < 0; deg = Math.abs(deg);
	const tot = Math.round(deg * 3600), d = Math.floor(tot / 3600), mi = Math.floor(tot % 3600 / 60), s = tot % 60;
	if (mi === 0 && s === 0) return `${neg ? "-" : ""}${d}°`;
	return `${String(mi).padStart(2, "0")}′${secStep % 60 ? String(s).padStart(2, "0") + "″" : ""}`;
}
// 経緯線の間隔（秒）：紙上でおよそ40〜70mmおきになる「きりのいい」六十進の刻み
const STEPS = [36000, 18000, 7200, 3600, 1800, 1200, 600, 300, 120, 60, 30, 15, 10, 5, 2, 1];
function niceStep(spanDeg, mapMm) {
	const target = Math.max(1, mapMm / 55);   // 何本ぐらい欲しいか
	const spanSec = spanDeg * 3600;
	for (const st of STEPS) if (spanSec / st >= target) return st;
	return STEPS[STEPS.length - 1];
}
// 縮尺バーのきりのいい長さ（紙上60mm以内で最大）
function niceBar(S, maxMM = 60) {
	const cands = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000];
	let best = cands[0];
	for (const c of cands) if (c / S * 1000 <= maxMM) best = c;
	return best;
}

// 紙面の組版：白紙→地図→経緯線→二重罫→北マーク→度分ラベル→四隅経緯度→下帯（題・縮尺バー・出典・出力日）。
export function composePage({ screen, rectDev, layout, S, corners, font, attr, dpi = 240, title = "平面図（上が北）" }) {
	const MM = dpi / 25.4, mm = v => v * MM;
	const page = new OffscreenCanvas(Math.round(layout.W * MM), Math.round(layout.H * MM));
	const ctx = page.getContext("2d");
	const O = layout.outer, I = layout.inner, C = layout.cap;
	ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, page.width, page.height);
	// 地図（切り出しを内罫の内側へ）
	ctx.drawImage(screen, rectDev.x, rectDev.y, rectDev.w, rectDev.h, mm(I.x), mm(I.y), mm(I.w), mm(I.h));

	// 経緯線：四隅の経緯度から上下辺(経度)・左右辺(緯度)を線形補間＝子午線の収束もそのまま出る
	const grat = [];   // [{type:"lon"|"lat", deg, a:[xmm,ymm], b:[xmm,ymm]}]
	if (corners && corners.nw && corners.ne && corners.sw && corners.se) {
		const { nw, ne, sw, se } = corners;
		const lonStep = niceStep(Math.abs(ne[0] - nw[0]), I.w), latStep = niceStep(Math.abs(nw[1] - sw[1]), I.h);
		const xTop = lon => I.x + (lon - nw[0]) / (ne[0] - nw[0]) * I.w;
		const xBot = lon => I.x + (lon - sw[0]) / (se[0] - sw[0]) * I.w;
		const yLeft = lat => I.y + (lat - nw[1]) / (sw[1] - nw[1]) * I.h;
		const yRight = lat => I.y + (lat - ne[1]) / (se[1] - ne[1]) * I.h;
		const first = (lo, st) => Math.ceil(lo * 3600 / st) * st / 3600;
		for (let lon = first(Math.min(nw[0], sw[0]), lonStep); lon <= Math.max(ne[0], se[0]); lon += lonStep / 3600) {
			const xt = xTop(lon), xb = xBot(lon);
			if (xt < I.x || xt > I.x + I.w || xb < I.x || xb > I.x + I.w) continue;
			grat.push({ type: "lon", deg: lon, step: lonStep, a: [xt, I.y], b: [xb, I.y + I.h] });
		}
		for (let lat = first(Math.min(sw[1], se[1]), latStep); lat <= Math.max(nw[1], ne[1]); lat += latStep / 3600) {
			const yl = yLeft(lat), yr = yRight(lat);
			if (yl < I.y || yl > I.y + I.h || yr < I.y || yr > I.y + I.h) continue;
			grat.push({ type: "lat", deg: lat, step: latStep, a: [I.x, yl], b: [I.x + I.w, yr] });
		}
		ctx.strokeStyle = "rgba(56,80,120,.5)"; ctx.lineWidth = mm(0.15);
		for (const g of grat) { ctx.beginPath(); ctx.moveTo(mm(g.a[0]), mm(g.a[1])); ctx.lineTo(mm(g.b[0]), mm(g.b[1])); ctx.stroke(); }
	}

	// 二重罫（外太・内細）
	ctx.strokeStyle = "#222";
	ctx.lineWidth = mm(0.7); ctx.strokeRect(mm(O.x), mm(O.y), mm(O.w), mm(O.h));
	ctx.lineWidth = mm(0.2); ctx.strokeRect(mm(I.x), mm(I.y), mm(I.w), mm(I.h));

	// 北マーク（図郭内右上）＝上が北の名乗り。切子矢（カイト型・左半分=墨/右半分=白）＝地図の方位マークの正統・
	// アプリのコンパス針と同じ語彙。地図の上に乗るので白ハローで縁取る（注記と同じ可読の作法）。
	{
		const cx = I.x + I.w - 6, ty = I.y + 6.2;   // 矢の頂点(mm)
		// カイト形：頂点(0,0)・右裾(+2.1,+6)・切込(0,+4.6)・左裾(-2.1,+6)（compassの針形を踏襲）
		const kite = [[0, 0], [2.1, 6], [0, 4.6], [-2.1, 6]];
		const path = pts => { ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(mm(cx + x), mm(ty + y)) : ctx.moveTo(mm(cx + x), mm(ty + y))); ctx.closePath(); };
		ctx.lineJoin = "round";
		// ハロー：矢の全形＋Nを白で厚めに
		ctx.font = `700 ${mm(3.1)}px ${font}`; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
		ctx.strokeStyle = "rgba(255,255,255,.92)"; ctx.fillStyle = "rgba(255,255,255,.92)";
		ctx.lineWidth = mm(1.1); path(kite); ctx.stroke(); ctx.fill();
		ctx.lineWidth = mm(0.9); ctx.strokeText("N", mm(cx), mm(ty - 1.4));
		// 本体：左半分=墨・右半分=白+細い墨縁、Nは墨
		ctx.fillStyle = "#222"; path([kite[0], kite[3], kite[2]]); ctx.fill();
		ctx.fillStyle = "#fff"; ctx.strokeStyle = "#222"; ctx.lineWidth = mm(0.22);
		path([kite[0], kite[1], kite[2]]); ctx.fill(); ctx.stroke();
		path([kite[0], kite[3], kite[2]]); ctx.stroke();   // 左半分も同じ細縁＝輪郭を締める
		ctx.fillStyle = "#222"; ctx.fillText("N", mm(cx), mm(ty - 1.4));
	}

	// 経緯線の度分ラベル（枠外・四隅の表記と衝突する端は避ける）
	ctx.fillStyle = "#333"; ctx.font = `${mm(2.1)}px ${font}`;
	for (const g of grat) {
		const label = tickLabel(g.deg, g.step);
		if (g.type === "lon") {
			if (g.a[0] < O.x + 42 || g.a[0] > O.x + O.w - 42) continue;   // 隅の経緯度表記（約38mm幅）の席を空ける
			ctx.textAlign = "center"; ctx.textBaseline = "bottom";
			ctx.fillText(label, mm(g.a[0]), mm(O.y - 0.8));
		} else {
			if (g.a[1] < O.y + 6 || g.a[1] > O.y + O.h - 6) continue;
			ctx.textAlign = "right"; ctx.textBaseline = "middle";
			ctx.fillText(label, mm(O.x - 1), mm(g.a[1]));
		}
	}

	// 四隅の経緯度（度分秒・枠外）
	if (corners) {
		const fmt = c => c ? `${dms(c[1], "北緯", "南緯")} ${dms(c[0], "東経", "西経")}` : "";
		ctx.fillStyle = "#222"; ctx.font = `${mm(2.3)}px ${font}`;
		ctx.textBaseline = "bottom";
		ctx.textAlign = "left"; corners.nw && ctx.fillText(fmt(corners.nw), mm(O.x), mm(O.y - 0.8));
		ctx.textAlign = "right"; corners.ne && ctx.fillText(fmt(corners.ne), mm(O.x + O.w), mm(O.y - 0.8));
		ctx.textBaseline = "top";
		ctx.textAlign = "left"; corners.sw && ctx.fillText(fmt(corners.sw), mm(O.x), mm(O.y + O.h + 0.8));
		ctx.textAlign = "right"; corners.se && ctx.fillText(fmt(corners.se), mm(O.x + O.w), mm(O.y + O.h + 0.8));
	}

	// 下帯：左=題・出力日／中=縮尺と縮尺バー／右=出典
	ctx.fillStyle = "#222";
	ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
	ctx.font = `600 ${mm(2.7)}px ${font}`;
	ctx.fillText(title || "平面図（上が北）", mm(C.x), mm(C.y + 5.4), mm(C.w * 0.34));   // 長い題は左1/3幅に詰める
	ctx.font = `${mm(2.1)}px ${font}`; ctx.fillStyle = "#555";
	ctx.fillText(`出力日 ${new Date().toLocaleDateString("sv-SE")}`, mm(C.x), mm(C.y + 9.4));   // sv-SE＝ローカル日付のYYYY-MM-DD表記
	// 縮尺（中央）＋バー
	ctx.fillStyle = "#222"; ctx.textAlign = "center";
	ctx.font = `600 ${mm(3.2)}px ${font}`;
	ctx.fillText(`1:${S.toLocaleString()}`, mm(layout.W / 2), mm(C.y + 5.6));
	const bar = niceBar(S), barMM = bar / S * 1000, bx = layout.W / 2 - barMM / 2, by = C.y + 8.8;
	ctx.strokeStyle = "#222"; ctx.lineWidth = mm(0.4); ctx.beginPath();
	ctx.moveTo(mm(bx), mm(by)); ctx.lineTo(mm(bx + barMM), mm(by));                       // 横棒
	ctx.moveTo(mm(bx), mm(by - 1.4)); ctx.lineTo(mm(bx), mm(by));                          // 左端ティック
	ctx.moveTo(mm(bx + barMM / 2), mm(by - 0.9)); ctx.lineTo(mm(bx + barMM / 2), mm(by));  // 中央ティック
	ctx.moveTo(mm(bx + barMM), mm(by - 1.4)); ctx.lineTo(mm(bx + barMM), mm(by));          // 右端ティック
	ctx.stroke();
	ctx.font = `${mm(2.1)}px ${font}`; ctx.textAlign = "left";
	ctx.fillText(bar >= 1000 ? `${bar / 1000} km` : `${bar} m`, mm(bx + barMM + 1.6), mm(by + 0.7));
	// 出典（右寄せ・複数行）
	if (attr && attr.length) {
		ctx.textAlign = "right"; ctx.fillStyle = "#555"; ctx.font = `${mm(1.9)}px ${font}`;
		attr.slice(0, 3).forEach((t, i) => ctx.fillText(t, mm(C.x + C.w), mm(C.y + 3.6 + i * 2.9)));
	}
	return page;
}

// 紙面canvas→単ページPDF（依存ゼロの自前ライタ）：JPEG を DCTDecode でそのまま埋める最小構造。
// MediaBox に用紙の実寸(pt=1/72inch)を書く＝「100%（実際のサイズ）で印刷」すれば縮尺が厳密に出る。
export async function pdfFromCanvas(canvas, Wmm, Hmm) {
	const jpg = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 })).arrayBuffer());
	const Wpt = (Wmm * 72 / 25.4).toFixed(2), Hpt = (Hmm * 72 / 25.4).toFixed(2);
	const enc = new TextEncoder();
	const content = `q\n${Wpt} 0 0 ${Hpt} 0 0 cm\n/Im1 Do\nQ\n`;
	const objs = [
		`<< /Type /Catalog /Pages 2 0 R >>`,
		`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`,
		`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${Wpt} ${Hpt}] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>`,
		{ dict: `<< /Length ${content.length} >>`, stream: enc.encode(content) },
		{ dict: `<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>`, stream: jpg },
	];
	const chunks = [enc.encode("%PDF-1.4\n")];
	let off = chunks[0].length; const xref = [];
	objs.forEach((o, i) => {
		xref.push(off);
		const head = enc.encode(`${i + 1} 0 obj\n${typeof o === "string" ? o : o.dict}\n`);
		chunks.push(head); off += head.length;
		if (typeof o !== "string") {
			const s1 = enc.encode("stream\n"); chunks.push(s1, o.stream); off += s1.length + o.stream.length;
			const s2 = enc.encode("\nendstream\n"); chunks.push(s2); off += s2.length;
		}
		const tail = enc.encode("endobj\n"); chunks.push(tail); off += tail.length;
	});
	const startxref = off;
	const xrefStr = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
		xref.map(o => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
		`trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
	chunks.push(enc.encode(xrefStr));
	return new Blob(chunks, { type: "application/pdf" });
}

export function print({ capture, signal } = {}) {
	const mapEl = this.mapEl;
	if (window.matchMedia("(pointer: coarse)").matches) return;   // モバイル非搭載＝端末の共有/スクショに委ねる（shotと同じ）
	if (mapEl.querySelector("#print-btn")) return;   // 二重搭載は無害
	const font = (getComputedStyle(document.documentElement).getPropertyValue("--qm-font") || "system-ui").trim();

	const btn = document.createElement("button");
	btn.id = "print-btn"; btn.dataset.tip = "平面図を印刷"; btn.setAttribute("aria-label", "平面図を印刷");
	btn.innerHTML = `
		<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#3f4757" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true">
			<path d="M6.5 9V3.5h11V9"/>
			<path d="M6.5 17.5H4.3A1.8 1.8 0 0 1 2.5 15.7v-4.9A1.8 1.8 0 0 1 4.3 9h15.4a1.8 1.8 0 0 1 1.8 1.8v4.9a1.8 1.8 0 0 1-1.8 1.8h-2.2"/>
			<rect x="6.5" y="14" width="11" height="6.5"/></svg>`;
	gadgetStack(mapEl).append(btn);

	// モーダル（プレビュー＋設定）。#map 直下の後置＝DOM順で上（z-index不使用の掟）。
	const modal = document.createElement("div");
	modal.id = "print";
	modal.innerHTML = `
		<div class="print-box">
			<div class="print-head">平面図の印刷（中心＝表示中の画面・上が北）<button class="panel-close" title="閉じる" aria-label="閉じる">×</button></div>
			<div class="print-row">
				<label>用紙</label><select id="print-paper"><option value="a4" selected>A4</option><option value="a3">A3</option></select>
				<label>向き</label><select id="print-orient"><option value="landscape" selected>横</option><option value="portrait">縦</option></select>
				<label>縮尺</label><select id="print-scale">${SCALES.map(s => `<option value="${s}"${s === 25000 ? " selected" : ""}>1:${s.toLocaleString()}</option>`).join("")}</select>
				<label>dpi</label><select id="print-dpi">${DPIS.map(d => `<option value="${d}"${d === 240 ? " selected" : ""}>${d}</option>`).join("")}</select>
			</div>
			<div class="print-row">
				<label>題</label><input type="text" id="print-title" value="平面図（上が北）" maxlength="40">
			</div>
			<img id="print-preview" alt="印刷プレビュー">
			<div id="print-note"></div>
			<div class="print-actions"><button id="print-pdf">PDF保存</button><button id="print-go">印刷</button></div>
		</div>`;
	mapEl.append(modal);
	const $ = s => modal.querySelector(s);
	const img = $("#print-preview"), noteEl = $("#print-note"), goBtn = $("#print-go"), pdfBtn = $("#print-pdf"), titleIn = $("#print-title");
	const sels = ["#print-paper", "#print-orient", "#print-scale", "#print-dpi"].map(s => $(s));
	const note = (t, warn) => { noteEl.textContent = t; noteEl.classList.toggle("warn", !!warn); };

	let busy = false, pending = false, lastPage = null, lastPaperCss = "A4 landscape", lastMeta = null, lastShot = null, prevUrl = null;
	const setBusy = b => { sels.forEach(s => s.disabled = b); goBtn.disabled = pdfBtn.disabled = b || !lastPage; img.classList.toggle("busy", b); };

	async function regen() {
		if (busy) { pending = true; return; }
		busy = true; setBusy(true);
		try {
			const paper = sels[0].value, orient = sels[1].value, S = +sels[2].value, dpi = +sels[3].value;
			const L = layoutFor(paper, orient);
			const asp = L.inner.w / L.inner.h;
			const cw = mapEl.clientWidth, ch = mapEl.clientHeight;
			let w = Math.min(cw * 0.96, ch * 0.96 * asp);
			const cropCss = { w: Math.round(w), h: Math.round(w / asp) };
			const zoom = zoomForScale(S, L.inner.w, cropCss.w);
			const mapDpi = Math.round(cropCss.w * (window.devicePixelRatio || 1) / (L.inner.w / 25.4));
			note(`平面図を作成中…（カメラz ${zoom.toFixed(1)}・タイル読み込み待ち）`);
			const cap = await capture({ zoom, cropCss });
			const screen = composeLayersToCanvas(cap.snap, mapEl.querySelector("#measure-lines"));
			const k = cap.dpr;
			const rectDev = { x: Math.round(cap.rect.x * k), y: Math.round(cap.rect.y * k), w: Math.round(cap.rect.w * k), h: Math.round(cap.rect.h * k) };
			lastShot = { screen, rectDev, layout: L, S, corners: cap.corners, dpi };   // 題の打ち直しは再撮影なしで組み直す
			lastPaperCss = `${paper.toUpperCase()} ${orient === "portrait" ? "portrait" : "landscape"}`;
			lastMeta = { Wmm: L.W, Hmm: L.H, S, paper };
			await recompose();
			note(`カメラz ${zoom.toFixed(1)}・地図部 約${mapDpi}dpi（紙面 ${dpi}dpi）` +
				(zoom < 4.5 ? "／この縮尺は広域すぎるため基図が写りません" : mapDpi < 110 ? "／画面が小さいため地図の精細度は控えめです" : ""), zoom < 4.5);
		} catch (e) {
			console.error("[print] プレビュー作成に失敗", e);
			note("プレビューの作成に失敗しました", true);
		} finally {
			busy = false; setBusy(false);
			if (pending) { pending = false; regen(); }
		}
	}

	function doPrint() {
		if (!lastPage || busy || !prevUrl) return;
		const f = document.createElement("iframe");
		f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
		f.srcdoc = `<!doctype html><html><head><style>@page{size:${lastPaperCss};margin:0}html,body{margin:0}img{width:100vw;height:100vh;object-fit:contain}</style></head><body><img src="${prevUrl}"></body></html>`;
		document.body.appendChild(f);
		f.onload = () => {
			const im = f.contentDocument.querySelector("img");
			const go = () => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 60000); };
			im.complete ? go() : (im.onload = go);
		};
	}

	// 紙面の組み直し（撮影済みの切り出しから）：題の打ち直し・出典はここで反映＝再撮影なしで速い
	async function recompose() {
		if (!lastShot) return;
		lastPage = composePage({ ...lastShot, font, attr: PRINT_ATTR, title: titleIn.value.trim() });
		const blob = await lastPage.convertToBlob({ type: "image/png" });
		if (prevUrl) URL.revokeObjectURL(prevUrl);
		prevUrl = URL.createObjectURL(blob); img.src = prevUrl;
	}

	async function doPdf() {   // MediaBox=用紙実寸のPDF＝「100%で印刷」すれば縮尺が厳密（理想の出力形）
		if (!lastPage || busy || !lastMeta) return;
		const blob = await pdfFromCanvas(lastPage, lastMeta.Wmm, lastMeta.Hmm);
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url; a.download = `平面図_1-${lastMeta.S}_${lastMeta.paper.toUpperCase()}_${new Date().toISOString().slice(0, 10)}.pdf`;
		document.body.appendChild(a); a.click(); a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 4000);
	}

	const open = () => { modal.classList.add("open"); regen(); };
	const close = () => modal.classList.remove("open");
	btn.addEventListener("click", open);
	$(".panel-close").addEventListener("click", close);
	modal.addEventListener("click", e => { if (e.target === modal) close(); });
	window.addEventListener("keydown", e => { if (e.key === "Escape" && modal.classList.contains("open")) close(); }, { signal });
	sels.forEach(s => s.addEventListener("change", regen));
	titleIn.addEventListener("change", () => { if (!busy) recompose(); });   // 題だけ＝再撮影なしの組み直し
	goBtn.addEventListener("click", doPrint);
	pdfBtn.addEventListener("click", doPdf);
	return { open, close };
}
