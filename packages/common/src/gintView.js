// gint v2 の薄い1枚（gishub / gishub-jp 共用）。ortho-japan エンジン（v2）の上で「GeoPBF を1枚見せる」だけを持つ。
// 旧＝ortho-map（v1）の createRemoteLayer({type:"gint"}).set("gint", unPackGint) ＋ zoomToFeature ＋ autoRotate。
// 新＝map.addGint(pbf)（v2 spec §4 の顔）＋ flyTo ＋ cam 直書きの自転。エンジンの口はこのファイルの外へ漏らさない
// （gint draw spec §10.2「消費側は薄いモジュール1枚に封じる」）。エンジン本体の読み込み（dev=ソース直／本番=/japan/lib/）は
// ビルド構成に依存するので各アプリ側が持ち、出来上がった map をここへ渡す。
//
// 使い方：
//   const view = createGintView(map, { overviewZoom });
//   await view.show(pbf, { tipHtml: (fid, props) => html|null, popHtml: (fid, props) => html|null });
//   view.clear();  view.spin(true|false);  view.home();
//   const off = await view.showRasterMeshes(meshes, { id, name, attribution, opacity });   // L03-b_r 型（経緯度矩形の画像群）

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const wrapLon = l => ((l + 540) % 360 + 360) % 360 - 180;

export function createGintView(map, { overviewZoom = 1.5, minZoom = 2, spinDegPerSec = 4 } = {}) {
	const tip = map.gadget.tip();   // カーソル追従（エンジンが起動時に搭載済み＝同じ setter が返る）
	const pop = map.gadget.pop();   // 地点に錨を打つ吹き出し
	let layer = null, token = 0;

	// ---- 1枚見せる ----
	async function show(pbf, { tipHtml = null, popHtml = null, fit = true } = {}) {
		clear();
		const my = ++token;
		if (!pbf?.length) return null;
		// geopbf() は既定で gint を焼く。焼かずに来た物（{gint:false} 等）だけここで焼く
		if (!pbf.unPackGint && typeof pbf.gint === "function") await pbf.gint();
		if (my !== token) return null;   // 焼いている間に次のデータ／閉じるが来た
		if (!pbf.unPackGint) { console.error("[gintView] no gint buffer (unPackGint) = cannot draw", pbf.name?.()); return null; }
		spin(false);
		layer = map.addGint(pbf, { minZoom });
		layer.on("hover", f => tip(f && tipHtml ? tipHtml(f.fid, f.properties) || null : null));
		layer.on("click", e => {
			if (e.fid == null || !popHtml) return;
			const html = popHtml(e.fid, e.properties);
			if (!html) return;
			const [lng, lat] = e.lngLat, [x, y] = map.projectLL(lng, lat);   // 箱の初期位置＝クリック点の画面座標
			pop(html, { x, y, lng, lat });
		});
		map.requestDraw();
		if (fit) fitTo(pbf);
		await layer.ready;
		return layer;
	}

	// ---- データへ寄る（旧 zoomToFeature の置き換え）----
	function fitTo(pbf) {
		const [w, s, e, n] = pbf.bbox ?? [];
		if (![w, s, e, n].every(Number.isFinite)) return;
		let lon, lat, zoom;
		if (e - w > 300) {
			// bbox がほぼ全球（±180 付近）→ bbox 中心は 0° 付近になる誤り。feature bbox 中心の 3D 平均で真の重心を出す
			let sx = 0, sy = 0, sz = 0; const pts = [];
			pbf.forEach(i => {
				const b = pbf.getBbox(i);
				if (!b || !isFinite(b[0])) return;
				const lng = (b[0] + b[2]) / 2, la = (b[1] + b[3]) / 2;
				pts.push([lng, la]);
				sx += Math.cos(la * D2R) * Math.cos(lng * D2R); sy += Math.cos(la * D2R) * Math.sin(lng * D2R); sz += Math.sin(la * D2R);
			});
			const norm = Math.hypot(sx, sy, sz);
			if (!(norm > 0)) return;
			lon = Math.atan2(sy, sx) * R2D; lat = Math.asin(sz / norm) * R2D;
			// 全球を覆う単一フィーチャ（ne_10m_ocean 等）＝点1つ＝広がり0＝地球全体の概観へ
			if (pts.length < 2) zoom = overviewZoom;
			else {   // 重心まわりへ経度を開いて（±180 跨ぎ）広がりを測る
				let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
				for (const [px, py] of pts) { const d = wrapLon(px - lon); x0 = Math.min(x0, d); x1 = Math.max(x1, d); y0 = Math.min(y0, py); y1 = Math.max(y1, py); }
				zoom = Math.max(overviewZoom, map.fitZoomForBbox([lon + x0, y0, lon + x1, y1]));
			}
		} else {
			lon = (w + e) / 2; lat = (s + n) / 2;
			zoom = Math.min(17, map.fitZoomForBbox([w, s, e, n]));   // 点1つ＝広がり0は最大ズームへ張り付くので頭打ち
		}
		return map.flyTo(lon, lat, zoom, 0, 0);
	}

	function clear() {
		token++;
		tip(null); pop.clear(true);
		if (layer) { layer.remove(); layer = null; }
		map.requestDraw();
	}

	// ---- 待ち受けの自転（旧 autoRotate）----
	// 公開のカメラ setter は flyTo（アニメ）だけ＝自転は map.cam を直に回して requestDraw（render が毎フレーム cam を読む）。
	let spinRaf = 0, spinT = 0;
	function spin(on) {
		if (!on) { cancelAnimationFrame(spinRaf); spinRaf = 0; return; }
		if (spinRaf) return;
		spinT = performance.now();
		const step = t => {
			const dt = Math.min(0.1, (t - spinT) / 1000); spinT = t;
			const c = map.cam.center;
			map.cam.center = [wrapLon(c[0] + spinDegPerSec * dt), c[1]];
			map.requestDraw();
			spinRaf = requestAnimationFrame(step);
		};
		spinRaf = requestAnimationFrame(step);
	}
	// 待ち受けへ戻る（真俯瞰・概観ズームへ飛んでから自転）。飛行中に次の show が来たら自転しない
	async function home(lat = 0) {
		const my = ++token;
		await map.flyTo(map.cam.center[0], lat, overviewZoom, 0, 0);
		if (my === token) spin(true);
	}

	return { show, clear, fitTo, spin, home, get layer() { return layer; }, tip, pop };
}

// ---- 経緯度矩形の画像群（L03-b_r のメッシュ画像）を map.raster のタイル供給へ ----
// v1 は image レイヤに bbox 付き画像を直に置いていた。v2 の画像層は XYZ タイル（ウェブメルカトル）契約＝
// MessagePort のプロバイダ（raster-src.js の port 契約：info を1通→{id,z,x,y} に {id,bitmap} で返す）で供給する。
// 画像は等緯度経度（GeoTIFF 由来）＝タイル内を 8 本の帯に分けて緯度方向だけ区分線形に写す（1帯32px＝誤差は画素未満）。
// 土地利用は分類値＝補間しない（imageSmoothing=false）。低ズームは全メッシュの縮約モザイク1枚から切る＝メモリを抑える。
export async function showRasterMeshes(map, meshes, { id = "meshes", name = null, attribution = null, opacity = 0.85, maxZoom = 12 } = {}) {
	const list = [...meshes].map(([key, m]) => ({ key, bbox: m.bbox, bytes: m.webpData ?? m.bytes, mime: m.mime || "image/webp" }));
	if (!list.length) return () => {};
	const bb = list.reduce((a, m) => [Math.min(a[0], m.bbox[0]), Math.min(a[1], m.bbox[1]), Math.max(a[2], m.bbox[2]), Math.max(a[3], m.bbox[3])], [180, 90, -180, -90]);
	const decode = m => createImageBitmap(new Blob([m.bytes], { type: m.mime }));

	// メッシュ画像の LRU（高ズーム用）
	const LRU_MAX = 32, lru = new Map();
	const bitmapOf = async m => {
		let p = lru.get(m.key);
		if (p) { lru.delete(m.key); lru.set(m.key, p); return p; }
		p = decode(m).catch(() => null);
		lru.set(m.key, p);
		while (lru.size > LRU_MAX) { const [k, old] = lru.entries().next().value; lru.delete(k); old.then(b => b?.close?.()); }
		return p;
	};
	// 低ズーム用の縮約モザイク（0.02°/px）＝一度だけ作る
	const MOSAIC_DEG = 0.02, OVERVIEW_MAXZ = 6;
	let mosaicP = null;
	const mosaic = () => mosaicP ??= (async () => {
		const W = Math.ceil((bb[2] - bb[0]) / MOSAIC_DEG), H = Math.ceil((bb[3] - bb[1]) / MOSAIC_DEG);
		const cv = new OffscreenCanvas(W, H), cx = cv.getContext("2d");
		cx.imageSmoothingEnabled = false;
		for (const m of list) {   // 1枚ずつ解いて描いて閉じる（全部を同時に持たない）
			const b = await decode(m).catch(() => null);
			if (!b) continue;
			const [w, s, e, n] = m.bbox;
			cx.drawImage(b, (w - bb[0]) / MOSAIC_DEG, (bb[3] - n) / MOSAIC_DEG, (e - w) / MOSAIC_DEG, (n - s) / MOSAIC_DEG);
			b.close();
		}
		return { img: cv.transferToImageBitmap(), bbox: bb };
	})();

	const TS = 256, STRIPS = 8;
	const tileLat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (1 << z)))) * R2D;
	const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
	// 等緯度経度画像（bbox=[w,s,e,n]）をタイルへ。帯ごとに緯度→画素を線形に写す
	function drawEquirect(cx, img, [w, s, e, n], lon0, lon1, z, x, y) {
		const W = img.width, H = img.height;
		const qx0 = Math.max(lon0, w), qx1 = Math.min(lon1, e);
		if (qx0 >= qx1) return;
		const dx0 = (qx0 - lon0) / (lon1 - lon0) * TS, dx1 = (qx1 - lon0) / (lon1 - lon0) * TS;
		const sx0 = (qx0 - w) / (e - w) * W, sx1 = (qx1 - w) / (e - w) * W;
		for (let k = 0; k < STRIPS; k++) {
			const latT = tileLat(y + k / STRIPS, z), latB = tileLat(y + (k + 1) / STRIPS, z);
			const qT = Math.min(latT, n), qB = Math.max(latB, s);
			if (qT <= qB) continue;
			const d0 = k * TS / STRIPS, d1 = (k + 1) * TS / STRIPS;
			const dy0 = d0 + (latT - qT) / (latT - latB) * (d1 - d0), dy1 = d0 + (latT - qB) / (latT - latB) * (d1 - d0);
			const sy0 = (n - qT) / (n - s) * H, sy1 = (n - qB) / (n - s) * H;
			cx.drawImage(img, sx0, sy0, sx1 - sx0, sy1 - sy0, dx0, dy0, dx1 - dx0, dy1 - dy0);
		}
	}
	async function renderTile(z, x, y) {
		const n2 = 1 << z, lon0 = x / n2 * 360 - 180, lon1 = (x + 1) / n2 * 360 - 180;
		const tb = [lon0, tileLat(y + 1, z), lon1, tileLat(y, z)];
		if (!overlaps(tb, bb)) return null;
		const cv = new OffscreenCanvas(TS, TS), cx = cv.getContext("2d");
		cx.imageSmoothingEnabled = false;
		if (z <= OVERVIEW_MAXZ) {
			const mo = await mosaic();
			drawEquirect(cx, mo.img, mo.bbox, lon0, lon1, z, x, y);
		} else {
			const hit = list.filter(m => overlaps(tb, m.bbox));
			if (!hit.length) return null;
			const bms = await Promise.all(hit.map(bitmapOf));
			hit.forEach((m, i) => bms[i] && drawEquirect(cx, bms[i], m.bbox, lon0, lon1, z, x, y));
		}
		return cv.transferToImageBitmap();
	}

	const ch = new MessageChannel(), port = ch.port1;
	port.onmessage = async ev => {
		const { id: rid, z, x, y, abort } = ev.data || {};
		if (abort) return;   // 描きかけは捨てるだけ（相手は既に reject 済み＝遅着は向こうが閉じる）
		try { const bitmap = await renderTile(z, x, y); port.postMessage({ id: rid, bitmap }, bitmap ? [bitmap] : []); }
		catch (e) { port.postMessage({ id: rid, error: String(e?.message || e) }); }
	};
	port.postMessage({ type: "info", info: { tileSize: TS, minZoom: 0, maxZoom, bbox: bb, name, attribution } });
	await map.raster.add(id, { port: ch.port2, name, attribution }, { order: "over", opacity, hideFills: false });
	map.requestDraw();
	return () => {
		map.raster.remove(id);
		port.onmessage = null; port.close();
		for (const p of lru.values()) p.then(b => b?.close?.());
		lru.clear();
		mosaicP?.then(m => m.img.close?.());
	};
}
