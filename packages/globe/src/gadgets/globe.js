// ガジェット：ミニ地球儀（右下）＝v1 ortho-map border.js draw_globe の移植（2026-09-21・本人指名）。
// 標準装備でなくオプトイン＝map.gadget.globe() で搭載（v1 の gadget 作法＝this が map）。
// 小さな正射投影の地球（海・陸＝Natural Earth 110m land・経緯線・縁）に、今の視野の枠（画面四辺を 30 点ずつ逆投影→再投影）を赤線で描く。
// v1 との差＝d3 を使わない（自前の正射式・数十行）。北上（bearing は畳む＝v1 も γ=0）。クリック＝その地点へ同ズームで飛ぶ（v2 で追加）。
// 出現域＝z ≤ maxZoom（v1 既定 8）。狭画面（<480px）では出さない。毎フレームの追従は本体の frame フック（戻り値 update を登録側が掴む）。
// 四戒：独立（エンジンへは this.unprojectXY / this.flyTo / this.cam のみ）／遅延（陸データは初回に取得）／抽象アクセス／表示は自前の display 裁き。
import { geopbf } from "geopbf";
import { tr } from "../i18n.js";
const t = tr();
const D2R = Math.PI / 180;

export function globe({ size = 125, maxZoom = 8, land = "rgb(160,200,160)", sea = "rgb(200,240,255)", line = "rgb(150,0,0)", signal } = {}) {
	const map = this, mapEl = this.mapEl, cam = this.cam;
	if (mapEl.querySelector("#globe-mini")) return;   // 二重搭載は無害
	const cv = document.createElement("canvas");
	cv.id = "globe-mini"; cv.setAttribute("role", "img"); cv.setAttribute("aria-label", t("Globe minimap: current view"));
	cv.title = t("Click to fly there");
	const dpr = Math.min(2, window.devicePixelRatio || 1);
	cv.width = size * dpr; cv.height = size * dpr; cv.style.width = size + "px"; cv.style.height = size + "px";
	mapEl.append(cv);
	const ctx = cv.getContext("2d");
	let landPolys = null;   // [[ [lon,lat]… ]…]（外環＋穴も同じ扱い＝小さな地球儀では穴は見えない）
	// 陸＝Natural Earth 110m land（bucket の GeoPBF。無ければ NE の zip へフォールバック＝geopbf が shp を食い IDB キャッシュ）
	(async () => {
		let pbf = await geopbf("ne_110m_land", { gint: false }).catch(() => null);
		if (!pbf?.length) pbf = await geopbf("https://naturalearth.s3.amazonaws.com/110m_physical/ne_110m_land.zip", { name: "ne_110m_land", gint: false }).catch(() => null);
		const feats = pbf?.geojson?.features || [];
		const polys = [];
		for (const f of feats) {
			const g = f.geometry; if (!g) continue;
			const cs = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
			for (const poly of cs) for (const ring of poly) polys.push(ring);
		}
		landPolys = polys; last = ""; update();
	})();

	// 正射投影（北上・回転＝視野中心）。戻り＝[x, y, visible]（visible=false は裏側＝縁へ張り付ける）
	const R = size / 2 - 1.5;
	let cosP0 = 1, sinP0 = 0, lon0 = 0;
	const proj = (lon, lat) => {
		const l = (lon - lon0) * D2R, p = lat * D2R, cp = Math.cos(p), sp = Math.sin(p);
		const x = cp * Math.sin(l), y = cosP0 * sp - sinP0 * cp * Math.cos(l);
		const cosc = sinP0 * sp + cosP0 * cp * Math.cos(l);
		if (cosc >= 0) return [size / 2 + x * R, size / 2 - y * R, true];
		const n = Math.hypot(x, y) || 1;   // 裏側＝縁（limb）へ投影＝塗り面が破綻しない（d3 の clipAngle 90 の簡易版）
		return [size / 2 + x / n * R, size / 2 - y / n * R, false];
	};
	const pathRing = ring => {
		let first = true;
		for (const [lon, lat] of ring) { const [x, y] = proj(lon, lat); if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y); }
		ctx.closePath();
	};
	function draw() {
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, size, size);
		const cx = size / 2, cy = size / 2;
		ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fillStyle = sea; ctx.fill();
		ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
		if (landPolys) { ctx.beginPath(); for (const ring of landPolys) pathRing(ring); ctx.fillStyle = land; ctx.fill("nonzero"); }
		// 経緯線 10°（v1 graticule）＝表側だけ線を引く（裏側は pen up）
		ctx.beginPath(); ctx.strokeStyle = "rgba(255,255,255,0.5)"; ctx.lineWidth = 0.6;
		const seg = (pts) => { let up = true; for (const [lon, lat] of pts) { const [x, y, v] = proj(lon, lat); if (!v) { up = true; continue; } if (up) { ctx.moveTo(x, y); up = false; } else ctx.lineTo(x, y); } };
		for (let lon = -180; lon < 180; lon += 10) { const pts = []; for (let lat = -80; lat <= 80; lat += 5) pts.push([lon, lat]); seg(pts); }
		for (let lat = -80; lat <= 80; lat += 10) { const pts = []; for (let lon = -180; lon <= 180; lon += 5) pts.push([lon, lat]); seg(pts); }
		ctx.stroke();
		ctx.restore();
		ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.lineWidth = 1.5; ctx.stroke();
		// 視野の枠＝画面四辺を各 30 点逆投影（球外＝null＝pen up）→ ミニ地球儀へ再投影
		const W = mapEl.clientWidth, H = mapEl.clientHeight, N = 30;
		const edge = (x0, y0, x1, y1) => { const out = []; for (let i = 0; i < N; i++) { const s = i / N; out.push(map.unprojectXY(x0 + (x1 - x0) * s, y0 + (y1 - y0) * s)); } return out; };
		const pts = [...edge(0, 0, W, 0), ...edge(W, 0, W, H), ...edge(W, H, 0, H), ...edge(0, H, 0, 0)];
		if (pts.some(p => p)) {
			ctx.beginPath(); let up = true;
			for (const p of pts) { if (!p) { up = true; continue; } const [x, y, v] = proj(p[0], p[1]); if (!v) { up = true; continue; } if (up) { ctx.moveTo(x, y); up = false; } else ctx.lineTo(x, y); }
			if (!pts.some(p => !p)) ctx.closePath();   // 四隅とも球上＝閉じた枠。球の縁を跨ぐ（null 混じり）なら開いた折れ線
			ctx.strokeStyle = line; ctx.lineWidth = 1.5; ctx.stroke();
		}
	}
	// クリック＝その地点へ（同ズーム・真俯瞰）。逆正射：画面点→球面。球外は無視
	cv.addEventListener("click", e => {
		const r = cv.getBoundingClientRect();
		const x = (e.clientX - r.left - size / 2) / R, y = -(e.clientY - r.top - size / 2) / R;
		const rho = Math.hypot(x, y); if (rho > 1) return;
		const c = Math.asin(rho), sc = Math.sin(c), cc = Math.cos(c);
		const lat = rho ? Math.asin(cc * sinP0 + y * sc * cosP0 / rho) / D2R : Math.asin(sinP0) / D2R;
		const lon = lon0 + (rho ? Math.atan2(x * sc, rho * cosP0 * cc - y * sinP0 * sc) / D2R : 0);
		map.flyTo(((lon + 540) % 360) - 180, lat, cam.zoom, 0);
	}, { signal });
	signal?.addEventListener("abort", () => cv.remove(), { once: true });

	let last = "";
	function update() {   // 本体 render のフック＝視点が変わった時だけ描く。z>maxZoom・狭画面は隠す
		const narrow = mapEl.clientWidth < 480;
		const show = cam.zoom <= maxZoom && !narrow;
		cv.style.display = show ? "block" : "none";
		if (!show) return;
		const key = `${cam.center[0].toFixed(3)}/${cam.center[1].toFixed(3)}/${cam.zoom.toFixed(2)}/${(cam.pitch || 0).toFixed(3)}/${(cam.bearing || 0).toFixed(3)}/${mapEl.clientWidth}x${mapEl.clientHeight}`;
		if (key === last) return;
		last = key;
		lon0 = cam.center[0]; cosP0 = Math.cos(cam.center[1] * D2R); sinP0 = Math.sin(cam.center[1] * D2R);
		draw();
	}
	update.el = cv;
	return update;
}
