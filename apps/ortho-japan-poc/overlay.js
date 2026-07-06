// 統合スパイク：geopbf / e-Stat 小地域を overlay に描き、クリックで identify（mat4 が geopbf を
// 識別込みで吸収）。自前の結果パネル(identEl)を持つ自己完結の機能。必要な物は入口で受け、
// グローバルに手を伸ばさない。identify は findPolygon 相当（pointInFeature）＝JSレイキャスト。
import { unproject, cameraState, buildGeoJSONOverlay, pointInFeature } from "ortho-japan";
import { geopbf } from "geopbf";

export function createOverlay({ renderer, cam, canvas, dpr, requestDraw }) {
	const identEl = document.createElement("div");
	identEl.style.cssText = "position:fixed;top:44px;left:10px;max-width:340px;font-size:12px;color:#334;background:rgba(255,255,255,.82);padding:6px 10px;border-radius:6px;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);white-space:pre-wrap;z-index:6;";
	document.body.appendChild(identEl);
	let overlayFeatures = null, overlayOrigin = [138, 37];

	function eachCoord(g, cb) {
		if (!g || !g.coordinates) return;
		const walk = c => { if (typeof c[0] === "number") cb(c[0], c[1]); else c.forEach(walk); };
		walk(g.coordinates);
	}
	function bboxCenter(feats) {
		let lo0 = 180, la0 = 90, lo1 = -180, la1 = -90;
		for (const f of feats) eachCoord(f.geometry, (x, y) => { if (x < lo0) lo0 = x; if (x > lo1) lo1 = x; if (y < la0) la0 = y; if (y > la1) la1 = y; });
		return { lo0, la0, lo1, la1, center: [(lo0 + lo1) / 2, (la0 + la1) / 2] };
	}
	async function loadOverlay(name) {
		identEl.textContent = `geopbf 読込中: ${name} …`;
		const pbf = await geopbf(name, { gint: false }).catch(err => { console.warn("geopbf", err); return null; });
		if (!pbf || !pbf.features || !pbf.features.length) { identEl.textContent = `geopbf 読込失敗: ${name}`; return; }
		overlayFeatures = pbf.features;
		overlayOrigin = bboxCenter(overlayFeatures).center;
		renderer.set("overlay",buildGeoJSONOverlay(overlayFeatures, overlayOrigin));
		renderer.set("overlayHi",null);
		identEl.textContent = `geopbf: ${name}\n${overlayFeatures.length} features — クリックで identify`;
		requestDraw();
	}
	function identifyAt(clientX, clientY) {
		if (!overlayFeatures) return;
		const st = cameraState(cam, canvas.width, canvas.height);
		const ll = unproject(st, clientX * dpr, clientY * dpr);
		if (!ll) return;
		const hit = overlayFeatures.findIndex(f => pointInFeature(ll[0], ll[1], f.geometry));
		renderer.set("overlayHi",hit >= 0 ? buildGeoJSONOverlay([overlayFeatures[hit]], overlayOrigin) : null);   // ヒット地物だけ別 stencil で強調
		if (hit >= 0) {
			const p = overlayFeatures[hit].properties || {};
			const kv = Object.entries(p).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join("\n");
			identEl.textContent = `identify ✔ #${hit}\n${kv || "(no props)"}`;
		} else identEl.textContent = "identify: ヒットなし";
		requestDraw();
	}
	// e-Stat 小地域（市区町村単位の {code}.geojsonl・gzip）を直接 fetch→gunzip→parse→アダプタ。
	// 小ポリゴンなので earcut でも扇なし。identify で小地域コード＝突合の種。
	async function gunzipText(bytes) {
		if (bytes[0] === 0x1f && bytes[1] === 0x8b) return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
		return new TextDecoder().decode(bytes);
	}
	async function loadEstat(codes) {
		identEl.textContent = `e-Stat 小地域 読込中 (${codes.length}市区町村)…`;
		const feats = [];
		await Promise.all(codes.map(async code => {
			try {
				const r = await fetch(`https://api.ortho-earth.com/bucket/estat/${code}.geojsonl`);
				if (!r.ok) return;
				const text = await gunzipText(new Uint8Array(await r.arrayBuffer()));
				for (const line of text.split("\n")) { const s = line.trim(); if (s) { try { feats.push(JSON.parse(s)); } catch { /* skip */ } } }
			} catch (e) { console.warn("estat", code, e); }
		}));
		if (!feats.length) { identEl.textContent = "e-Stat 読込失敗"; return; }
		overlayFeatures = feats;
		const b = bboxCenter(feats);
		overlayOrigin = b.center;
		renderer.set("overlay",buildGeoJSONOverlay(feats, overlayOrigin));
		renderer.set("overlayHi",null);
		cam.center = [b.center[0], b.center[1]]; cam.zoom = 11; cam.pitch = 0; requestDraw();
		identEl.textContent = `e-Stat 小地域: ${feats.length} 地物 — クリックで identify（小地域コード＝突合の種）`;
	}
	return { identifyAt, loadOverlay, loadEstat };
}
