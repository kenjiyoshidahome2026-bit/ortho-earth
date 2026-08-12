// 統合スパイク：geopbf / e-Stat 小地域を overlay に描き、クリックで identify（mat4 が geopbf を
// 識別込みで吸収）。自前の結果パネル(identEl)を持つ自己完結の機能。必要な物は入口で受け、
// グローバルに手を伸ばさない。
// e-Stat 経路は estatworker.js で全処理（fetch/gunzip/行parse/ジオメトリ生成/identify）＝mainをブロックしない。
// geopbf 経路（loadOverlay）は従来通り main＝identify は findPolygon 相当（pointInFeature）のJSレイキャスト。
import { unproject, cameraState, buildGeoJSONOverlay, pointInFeature } from "ortho-core";
import { geopbf } from "geopbf";

// 属性フィルタ照合＝自己完結の純関数（旧 ai/interpret.js から移設）。overlay が ai/ ツリーを
// import しない＝AI本体(ai.js/backend/catalog/interpret＋将来LLM)を初期バンドルから完全に隔離するため。
function matchesFilters(props, filters) {
	if (!filters || !filters.length) return true;
	const p = props || {};
	return filters.every(f => {
		const v = p[f.attr];
		if (v == null) return false;
		switch (f.op) {
			case "eq": return String(v) === String(f.value);
			case "ne": return String(v) !== String(f.value);
			case "lt": return Number(v) < f.value;
			case "gt": return Number(v) > f.value;
			case "contains": return String(v).includes(String(f.value));
		}
		return false;
	});
}

export function createOverlay({ renderer, cam, size, dpr, requestDraw }) {
	const identEl = document.createElement("div");
	identEl.id = "ident";   // スタイルは style.css（#map 配下に後置＝DOM順で上）
	(document.getElementById("map") || document.body).appendChild(identEl);
	// 空のままだと padding+背景が「小さな空箱」として常時見えてしまう＝中身がある時だけ表示
	const say = t => { identEl.textContent = t; identEl.style.display = t ? "block" : "none"; };
	let overlayFeatures = null, overlayOrigin = [138, 37];   // geopbf 経路（main側identify）用
	let estatActive = false;                                  // e-Stat 経路がアクティブ＝identify は worker へ

	let planWait = null;   // loadPlan(estat経路)の完了待ち＝loaded 到着で解決（結果はAIの会話が報告する）
	let estatOpts = {};        // 直近 loadEstat の opts（moveCamera/quiet/onLoaded）＝派生アプリ用。既定は従来挙動
	let identifyHandler = null;   // identify結果の派生アプリ受け口（setIdentifyHandler）。未登録なら従来の say パネル
	let highlightWait = null;     // highlightKey の完了待ち（worker 返信は直列＝最後の呼びが勝つで足りる）

	const estatWorker = new Worker(new URL("./estatworker.js", import.meta.url), { type: "module" });
	estatWorker.onmessage = e => {
		const m = e.data;
		if (m.type === "loaded") {
			const o = estatOpts;
			if (planWait) { planWait({ ok: !!m.ok, count: m.count ?? 0 }); planWait = null; }
			if (!m.ok) { if (!o.quiet) say("e-Stat 読込失敗"); o.onLoaded?.({ ok: false, count: 0 }); return; }
			estatActive = true; overlayFeatures = null;   // 単一スロット＝geopbf 経路の識別対象は置き換え
			renderer.set("overlay", m.overlay);
			renderer.set("overlayHi", null);
			if (o.moveCamera !== false) { cam.center = [m.center[0], m.center[1]]; cam.zoom = 12; cam.pitch = 0; }   // 派生アプリは自前で寄せる＝直書きジャンプを抑止できる
			requestDraw();
			if (!o.quiet) say(`e-Stat 小地域: ${m.count} 地物 — クリックで identify（小地域コード＝突合の種）`);
			o.onLoaded?.({ ok: true, count: m.count, center: m.center });
		} else if (m.type === "identify") {
			renderer.set("overlayHi", m.overlay || null);
			if (identifyHandler) identifyHandler(m.hit >= 0 ? { hit: m.hit, props: m.props || {} } : null);
			else if (m.hit >= 0) {
				const kv = Object.entries(m.props).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join("\n");
				say(`identify ✔ #${m.hit}\n${kv || "(no props)"}`);
			} else say("identify: ヒットなし");
			requestDraw();
		} else if (m.type === "highlighted") {
			renderer.set("overlayHi", m.overlay || null);
			if (highlightWait) { highlightWait(m.bbox ? { key: m.key, bbox: m.bbox, count: m.count } : null); highlightWait = null; }
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
	// e-Stat 小地域（estat/{調査年}/{code}.geojsonl・gzip）：worker が fetch→gunzip→parse→ジオメトリ生成→transfer。
	// opts（派生アプリ用・省略時は従来挙動）: moveCamera:false=loaded時のカメラ直書きを抑止 / quiet=sayパネル抑止 / onLoaded(r)
	async function loadEstat(codes, year = "2020", style = null, opts = {}) {
		estatOpts = opts;
		if (!opts.quiet) say(`e-Stat 小地域 読込中 (${codes.length}市区町村)…`);
		estatWorker.postMessage({ type: "load", codes, year, style });
	}
	// 小地域 KEY_CODE（9/11桁）でハイライト → {key,bbox,count}｜ヒットなし・estat未ロードは null
	function highlightKey(key) {
		if (!estatActive) return Promise.resolve(null);
		return new Promise(r => { highlightWait = r; estatWorker.postMessage({ type: "highlight", key: String(key) }); });
	}
	// AIガジェットの描画スペック(plan)受け口。overlay経路＝geopbf→属性フィルタ→スタイル付き描画（identify連動）、
	// estat経路＝worker へ委譲（地名→市区町村コード解決は呼び出し側の領分＝plan.codes で受ける）。throw しない。
	async function loadPlan(plan) {
		const style = { lineColor: plan.style.rgba, lineWidth: plan.style.lineWidth };
		if (plan.route === "estat") {
			if (!plan.codes?.length) return { ok: false, reason: "nocodes" };
			const done = new Promise(r => { planWait = r; });
			loadEstat(plan.codes, "2020", style);
			return await done;   // カメラは loaded ハンドラが寄せる＝bbox は返さない
		}
		const pbf = await geopbf(plan.target, { gint: false }).catch(err => { console.warn("[ai] geopbf", plan.target, err); return null; });
		if (!pbf?.features?.length) return { ok: false, reason: "load" };
		const feats = pbf.features.filter(f => matchesFilters(f.properties, plan.filters));
		if (!feats.length) return { ok: false, reason: "empty", total: pbf.features.length };
		estatActive = false;
		overlayFeatures = feats;
		const bb = bboxCenter(feats);
		overlayOrigin = bb.center;
		renderer.set("overlay", buildGeoJSONOverlay(feats, overlayOrigin, style));
		renderer.set("overlayHi", null);
		requestDraw();
		return { ok: true, count: feats.length, bbox: [bb.lo0, bb.la0, bb.lo1, bb.la1] };
	}
	function clearPlan() {   // AI層を消す（identify対象も外す）
		estatActive = false; overlayFeatures = null;
		renderer.set("overlay", null); renderer.set("overlayHi", null);
		say(""); requestDraw();
	}
	const setIdentifyHandler = fn => { identifyHandler = fn; };   // 派生アプリの identify 受け口（null で従来 say へ復帰）
	return { identifyAt, loadOverlay, loadEstat, loadPlan, clearPlan, highlightKey, setIdentifyHandler, destroy: () => estatWorker.terminate() };   // destroy＝map.destroy() から（worker外し漏れゼロの掟）
}
