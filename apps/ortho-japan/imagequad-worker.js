// 四隅で貼った画像（geopbf/edit/imagequad）を z/x/y の画像タイルに焼いて配るプロバイダ worker（2026-09-21・MapLibre の image source 相当）。
// 画像タイル層（ortho-core/raster-src の "port" 契約）へ流す＝地形へのドレープ・透明度・重ね順は既存のラスタ層がそのまま受け持つ。
// 所有者は main（入れ子 worker 禁止）。main が MessageChannel を作り、port1 をここへ・port2 を render worker へ。
//
// 受け口（main → ここ）: { type:"open", image: Blob|ImageBitmap, corners: [[lon,lat]×4 左上→右上→右下→左下], port, name? }
// 返事（ここ → main）:   { type:"opened", info } | { type:"error", error }
// 焼き方：タイルの各画素中心（メルカトル）→ 逆射影変換で画像 uv → ミップ段を選んで双一次補間。四隅の外は透明。
// ミップ＝縦横半分ずつの箱フィルタ（遠目でちらつかない）。段はタイル中心での画素の足跡（画像画素/タイル画素）で 1 タイル 1 段。
import { quadMapping, apply3 } from "geopbf/edit/imagequad";

const MAX_SIDE = 4096;   // 取り込む画像の長辺上限（それ以上は縮めてから持つ＝RGBA 64MB 以内）
const TS = 256;

self.onmessage = async e => {
	const m = e.data || {};
	if (m.type !== "open") return;
	try {
		let bm = m.image instanceof ImageBitmap ? m.image : await createImageBitmap(m.image);
		if (Math.max(bm.width, bm.height) > MAX_SIDE) {
			const s = MAX_SIDE / Math.max(bm.width, bm.height);
			const b2 = await createImageBitmap(bm, { resizeWidth: Math.max(1, Math.round(bm.width * s)), resizeHeight: Math.max(1, Math.round(bm.height * s)), resizeQuality: "high" });
			bm.close?.(); bm = b2;
		}
		const W0 = bm.width, H0 = bm.height;
		const cv = new OffscreenCanvas(W0, H0), g = cv.getContext("2d");
		g.drawImage(bm, 0, 0); bm.close?.();
		const levels = [{ w: W0, h: H0, d: g.getImageData(0, 0, W0, H0).data }];
		while (levels.length < 14) {   // 箱フィルタで半分ずつ（1px まで）
			const p = levels[levels.length - 1]; if (p.w <= 1 && p.h <= 1) break;
			const w = Math.max(1, p.w >> 1), h = Math.max(1, p.h >> 1), d = new Uint8ClampedArray(w * h * 4);
			for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
				const x0 = Math.min(p.w - 1, x * 2), x1 = Math.min(p.w - 1, x * 2 + 1), y0 = Math.min(p.h - 1, y * 2), y1 = Math.min(p.h - 1, y * 2 + 1);
				for (let c = 0; c < 4; c++) d[(y * w + x) * 4 + c] = (p.d[(y0 * p.w + x0) * 4 + c] + p.d[(y0 * p.w + x1) * 4 + c] + p.d[(y1 * p.w + x0) * 4 + c] + p.d[(y1 * p.w + x1) * 4 + c] + 2) >> 2;
			}
			levels.push({ w, h, d });
		}
		const map = quadMapping(m.corners);
		const [mx0, my0, mx1, my1] = map.mercBox;
		const nativeZ = Math.log2(Math.max(W0, H0) / Math.max(mx1 - mx0, my1 - my0) / TS);
		const info = { tileSize: TS, minZoom: 0, maxZoom: Math.max(0, Math.min(22, Math.ceil(nativeZ))), bbox: map.bbox, name: m.name || "image", attribution: null };
		const out = new OffscreenCanvas(TS, TS), og = out.getContext("2d");
		const Hi = map.Hi;
		const render = (z, tx, ty) => {
			const n = 2 ** z, bx0 = tx / n, by0 = ty / n, bx1 = (tx + 1) / n, by1 = (ty + 1) / n;
			if (bx1 < mx0 || bx0 > mx1 || by1 < my0 || by0 > my1) return null;   // 画像の外接箱に掛からない
			// 段＝タイル中心の足跡（画像 0 段の画素 / タイル画素）
			const cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2, px = 1 / (n * TS);
			const a = apply3(Hi, cx, cy), b = apply3(Hi, cx + px, cy), c = apply3(Hi, cx, cy + px);
			const foot = Math.max(Math.hypot((b[0] - a[0]) * W0, (b[1] - a[1]) * H0), Math.hypot((c[0] - a[0]) * W0, (c[1] - a[1]) * H0));
			const L = levels[Math.max(0, Math.min(levels.length - 1, Math.floor(Math.log2(Math.max(1, foot)))))];
			const img = og.createImageData(TS, TS), o = img.data, d = L.d, w = L.w, h = L.h;
			let any = false;
			for (let j = 0; j < TS; j++) {
				const my = by0 + (j + 0.5) * px;
				for (let i = 0; i < TS; i++) {
					const mx = bx0 + (i + 0.5) * px;
					const ww = Hi[6] * mx + Hi[7] * my + Hi[8];
					const u = (Hi[0] * mx + Hi[1] * my + Hi[2]) / ww, v = (Hi[3] * mx + Hi[4] * my + Hi[5]) / ww;
					if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) continue;
					const fx = Math.min(w - 1, Math.max(0, u * w - 0.5)), fy = Math.min(h - 1, Math.max(0, v * h - 0.5));
					const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
					const k00 = (y0 * w + x0) * 4, k10 = (y0 * w + x1) * 4, k01 = (y1 * w + x0) * 4, k11 = (y1 * w + x1) * 4, q = (j * TS + i) * 4;
					for (let ch = 0; ch < 4; ch++) {
						const top = d[k00 + ch] + (d[k10 + ch] - d[k00 + ch]) * ax, bot = d[k01 + ch] + (d[k11 + ch] - d[k01 + ch]) * ax;
						o[q + ch] = top + (bot - top) * ay;
					}
					any = true;
				}
			}
			if (!any) return null;
			og.clearRect(0, 0, TS, TS); og.putImageData(img, 0, 0);
			return out.transferToImageBitmap();
		};
		const port = m.port;
		port.onmessage = ev => {
			const q = ev.data || {};
			if (q.abort || q.id == null) return;
			try { const bmp = render(q.z, q.x, q.y); port.postMessage({ id: q.id, bitmap: bmp }, bmp ? [bmp] : []); }
			catch (err) { port.postMessage({ id: q.id, error: String(err && err.message || err) }); }
		};
		port.postMessage({ type: "info", info });
		self.postMessage({ type: "opened", info });
	} catch (err) {
		self.postMessage({ type: "error", error: String(err && err.message || err) });
	}
};
