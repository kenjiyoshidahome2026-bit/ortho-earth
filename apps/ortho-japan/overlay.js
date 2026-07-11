// 統合スパイク：geopbf / e-Stat 小地域を overlay に描き、クリックで identify（mat4 が geopbf を
// 識別込みで吸収）。自前の結果パネル(identEl)を持つ自己完結の機能。必要な物は入口で受け、
// グローバルに手を伸ばさない。
// e-Stat 経路は estatworker.js で全処理（fetch/gunzip/行parse/ジオメトリ生成/identify）＝mainをブロックしない。
// geopbf 経路（loadOverlay）は従来通り main＝identify は findPolygon 相当（pointInFeature）のJSレイキャスト。
import { unproject, cameraState, buildGeoJSONOverlay, pointInFeature } from "ortho-core";
import { geopbf } from "geopbf";

export function createOverlay({ renderer, cam, size, dpr, requestDraw }) {
	const identEl = document.createElement("div");
	identEl.id = "ident";   // スタイルは style.css（#map 配下に後置＝DOM順で上）
	(document.getElementById("map") || document.body).appendChild(identEl);
	// 空のままだと padding+背景が「小さな空箱」として常時見えてしまう＝中身がある時だけ表示
	const say = t => { identEl.textContent = t; identEl.style.display = t ? "block" : "none"; };
	let overlayFeatures = null, overlayOrigin = [138, 37];   // geopbf 経路（main側identify）用
	let estatActive = false;                                  // e-Stat 経路がアクティブ＝identify は worker へ

	const estatWorker = new Worker(new URL("./estatworker.js", import.meta.url), { type: "module" });
	estatWorker.onmessage = e => {
		const m = e.data;
		if (m.type === "loaded") {
			if (!m.ok) { say("e-Stat 読込失敗"); return; }
			estatActive = true; overlayFeatures = null;   // 単一スロット＝geopbf 経路の識別対象は置き換え
			renderer.set("overlay", m.overlay);
			renderer.set("overlayHi", null);
			cam.center = [m.center[0], m.center[1]]; cam.zoom = 11; cam.pitch = 0; requestDraw();
			say(`e-Stat 小地域: ${m.count} 地物 — クリックで identify（小地域コード＝突合の種）`);
		} else if (m.type === "identify") {
			renderer.set("overlayHi", m.overlay || null);
			if (m.hit >= 0) {
				const kv = Object.entries(m.props).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join("\n");
				say(`identify ✔ #${m.hit}\n${kv || "(no props)"}`);
			} else say("identify: ヒットなし");
			requestDraw();
		}
	};

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
		say(`geopbf 読込中: ${name} …`);
		const pbf = await geopbf(name, { gint: false }).catch(err => { console.warn("geopbf", err); return null; });
		if (!pbf || !pbf.features || !pbf.features.length) { say(`geopbf 読込失敗: ${name}`); return; }
		estatActive = false;   // 識別対象を geopbf 経路（main側）へ切り替え
		overlayFeatures = pbf.features;
		overlayOrigin = bboxCenter(overlayFeatures).center;
		renderer.set("overlay", buildGeoJSONOverlay(overlayFeatures, overlayOrigin));
		renderer.set("overlayHi", null);
		say(`geopbf: ${name}\n${overlayFeatures.length} features — クリックで identify`);
		requestDraw();
	}
	function identifyAt(clientX, clientY) {
		if (!estatActive && !overlayFeatures) return;
		const st = cameraState(cam, size.w, size.h);
		const ll = unproject(st, clientX * dpr, clientY * dpr);
		if (!ll) return;
		if (estatActive) { estatWorker.postMessage({ type: "identify", lon: ll[0], lat: ll[1] }); return; }   // 結果は onmessage が描く
		const hit = overlayFeatures.findIndex(f => pointInFeature(ll[0], ll[1], f.geometry));
		renderer.set("overlayHi", hit >= 0 ? buildGeoJSONOverlay([overlayFeatures[hit]], overlayOrigin) : null);   // ヒット地物だけ別 stencil で強調
		if (hit >= 0) {
			const p = overlayFeatures[hit].properties || {};
			const kv = Object.entries(p).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join("\n");
			say(`identify ✔ #${hit}\n${kv || "(no props)"}`);
		} else say("identify: ヒットなし");
		requestDraw();
	}
	// e-Stat 小地域（市区町村単位の {code}.geojsonl・gzip）：worker が fetch→gunzip→parse→ジオメトリ生成→transfer。
	async function loadEstat(codes) {
		say(`e-Stat 小地域 読込中 (${codes.length}市区町村)…`);
		estatWorker.postMessage({ type: "load", codes });
	}
	return { identifyAt, loadOverlay, loadEstat };
}
