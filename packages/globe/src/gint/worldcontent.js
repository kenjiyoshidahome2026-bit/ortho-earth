// 世界帯の中身（worldContent・2026-09-24）＝globe の低ズーム（z<WORLD_BAND_Z）に Equal Earth と同じ情報を描く。
// 本人「equal に入れた追加情報は最終的に globe に同じ情報を入れるため」「同じデータを 2 つ持ちしない」「i18n もできているはず」。
//   規則（どのデータ・どの名前・どのズーム・どの大きさ）＝ortho-core worldcontent（equal・world と同じ正本）
//   配色＝ortho-core worldstyle（equal・world と同じ正本・テーマ切替で repaint）
//   データ＝bucket GIS/world/ の ne-cultural（base／detail）と ne_10m_lakes を**同じキャッシュ名**で読む＝equal と IDB の実体を共有
// 描き方は globe の部品：線/面＝addGint（地物ごとの出しズームは setPaint の filter 式＝止まるたびに評価）・注記＝gadget.symbols（衝突判定つき）。
//   base   … 州境（z≥4）・係争主体の線（admin_0）・国名（NationDB の代表点）・首都/都市（populated_places）
//   detail … 市街地の塗り（z≥4）・道路・鉄道（z≥5）・空港の ✈（z≥5）＝z≥4.5 で初めて読む
//   lakes  … 湖の岸線（塗りは renderer の lakes スロット＝既存）・地物ごとの min_zoom
// 海岸線・国境（admin0 層）と河川・海洋境界線（world lines）は gint/layers.js の既存の層＝ここでは出しズームだけ equal に揃える（呼び出し側）。
import { css } from "@ortho-earth/core/worldstyle";
import { WORLD_Z, culturalUrl, culturalName, loadNations, loadI18n, loadNeCities, countryName, cityName, shortEnNames, countryLabelRule, cityLabelRule, airportLabelRule, PLANE_PATH } from "@ortho-earth/core/worldcontent";

const LABEL_ID = "world-content-labels", AIR_ID = "world-content-airports";

export function createWorldContent({ addGint, geopbf, symbols, addImage, getZoom, lang = "en", worldStyle, bandZ, lowMem = false, requestDraw = () => {} }) {
	const H = {};            // group → addGint の手綱（base / detail / lakes）
	const held = {};         // group → GeoPBF（注記の材料）
	const state = {};        // group → 0 未 / 1 読込中 / 2 済 / 3 失敗
	let names = null, labelsOn = false, imagesAdded = false;
	const T = () => worldStyle();

	// 線と面の色・出し分け（式）。色は正本 worldstyle から毎回引く＝テーマ切替は repaint() が setPaint し直す
	const PAINT = {
		base: t => ({
			"line-color": ["case", ["==", ["get", "layer"], "admin_0"], css(t.disputedLine), css(t.admin1)],
			"line-width": ["case", ["==", ["get", "layer"], "admin_0"], 0.8, 0.5],
		}),
		detail: t => ({
			"fill-color": ["case", ["==", ["get", "layer"], "urban_areas"], css(t.urban), "rgba(0,0,0,0)"],
			"line-color": ["match", ["get", "layer"], "roads", css(t.road), "railroads", css(t.rail), "rgba(0,0,0,0)"],
			"line-width": 0.8,
		}),
		lakes: t => ({ "line-color": css(t.lakeShore), "line-width": 0.6 }),
	};
	const FILTER = {
		// 州境＝z≥4（海岸線・国境は admin0 層が上から描く＝同じ NE 10m の線が重なる）・係争主体の線＝常時。都市の点（populated_places）は描かない＝注記の領分
		base: ["any", ["==", ["get", "layer"], "admin_0"], ["all", ["==", ["get", "layer"], "admin_1"], [">=", ["zoom"], WORLD_Z.admin1]]],
		// 市街地＝z≥4・道路/鉄道＝z≥5。detail に同居する湖（lakes スロットと重複）・航路・空港の点は描かない
		detail: ["any", ["all", ["==", ["get", "layer"], "urban_areas"], [">=", ["zoom"], WORLD_Z.urban]],
			["all", ["==", ["get", "layer"], "roads"], [">=", ["zoom"], WORLD_Z.roads]],
			["all", ["==", ["get", "layer"], "railroads"], [">=", ["zoom"], WORLD_Z.rail]]],
		lakes: ["<=", ["to-number", ["coalesce", ["get", "min_zoom"], ["get", "MIN_ZOOM"], 0]], ["zoom"]],
	};
	// 層の順＝admin0（海岸線・国境 -10）の下に州境、その下に市街地/道路（塗りと線の上下は gint の中で面→線）
	const ORDER = { base: -11, detail: -12, lakes: -9 };
	const SRC = {
		base: () => geopbf(culturalUrl("base"), { name: culturalName("base") }),
		detail: () => geopbf(culturalUrl("detail"), { name: culturalName("detail") }),
		lakes: () => geopbf("ne_10m_lakes"),   // renderer の lakes スロットと同じ名前＝同じ実体（塗りはスロット・岸線はここ）
	};

	async function load(g) {
		if (state[g]) return;
		state[g] = 1;
		try {
			const pbf = await SRC[g]();
			if (!pbf?.unPackGint) throw new Error("GintBUF decode failed");
			held[g] = pbf;
			// moveBudget/outlineZoom＝移動中も地物ごとの塗り・線を保つ（admin0 と同じ・既定だと移動中は単色のベタ塗りに落ち、湖まで市街地色になる）
			// fillColor 透明＝層の単色塗り（既定のオレンジ）を消し、地物ごとの塗り（setPaint）だけ残す。style は丸ごと置き換え＝1 回で渡す
			const h = addGint(pbf, { order: ORDER[g], interactive: false, maxZoom: bandZ, fillMaxEdges: g === "detail" ? undefined : 0,
				style: { moveBudget: Infinity, outlineZoom: 0, fillColor: [0, 0, 0, 0] } });
			if (!h) throw new Error("addGint unavailable");
			h.setVisible(false);            // 絞る（出しズーム）まで出さない＝焼き上がり直後の 1 枚で全件が既定色で閃かない
			await h.ready;
			await h.setPaint(PAINT[g](T()), FILTER[g]);
			h.setVisible(true);
			H[g] = h; state[g] = 2;
			console.log(`[world-content] ${g}: ${pbf.fmap?.length ?? 0} features`);
			if (g === "base") await labels();
			if (g === "detail") await airports();
			requestDraw();
		} catch (e) { state[g] = 3; console.warn(`[world-content] ${g}`, e?.message ?? e); }
	}

	// ── 注記：国名（NationDB の代表点・面積の段）＋首都/都市（NE populated_places）＝1 つの記号の層＝衝突判定を共有 ──
	const dot = (color, r = 5) => { const s = 16, cv = new OffscreenCanvas(s, s), cx = cv.getContext("2d");
		cx.beginPath(); cx.arc(s / 2, s / 2, r, 0, Math.PI * 2); cx.fillStyle = color; cx.fill(); cx.lineWidth = 2; cx.strokeStyle = T().labelColor.halo; cx.stroke(); return cv.transferToImageBitmap(); };
	const plane = () => { const s = 40, cv = new OffscreenCanvas(s, s), cx = cv.getContext("2d");
		cx.translate(4, 4); cx.scale(32 / 24, 32 / 24); const p = new Path2D(PLANE_PATH); cx.lineWidth = 3; cx.strokeStyle = T().labelColor.halo; cx.lineJoin = "round"; cx.stroke(p); cx.fillStyle = css(T().airport); cx.fill(p); return cv.transferToImageBitmap(); };
	async function images() {   // 記号帳（テーマの色で作る＝テーマ切替で作り直す）
		await addImage("wc-dot", dot(T().labelColor.city), { pixelRatio: 2 });
		await addImage("wc-dot-cap", dot(T().capital || T().labelColor.city), { pixelRatio: 2 });
		await addImage("wc-plane", plane(), { pixelRatio: 2 });
		imagesAdded = true;
	}
	const namesP = () => names ??= Promise.all([loadNations(), loadI18n(lang).catch(() => null), loadNeCities(lang)])
		.then(([world, i18n, ne]) => ({ world, i18n, ne }))
		.catch(e => { console.warn("[world-content] names", e?.message ?? e); return null; });
	async function labels() {
		const pbf = held.base; if (!pbf) return;
		const nm = await namesP(); if (!nm) return;
		if (!imagesAdded) await images();
		const n = pbf.fmap?.length ?? 0, feats = [];
		const shortEn = shortEnNames(n, i => pbf.getProperties(i));
		for (const nation of nm.world.items) {
			const r = countryLabelRule(nation); if (!r) continue;
			feats.push({ type: "Feature", geometry: { type: "Point", coordinates: [r.lon, r.lat] },
				properties: { name: countryName(nation, nm.i18n, shortEn), kind: "country", mz: r.minZoom, pri: r.priority, size: r.size } });
		}
		for (let i = 0; i < n; i++) {
			const p = pbf.getProperties(i);
			if (p?.layer !== "populated_places") continue;
			const f = pbf.getFeature(i); if (f?.geometry?.type !== "Point") continue;
			const name = cityName(p, lang, nm.i18n, nm.ne); if (!name) continue;
			const r = cityLabelRule(p);
			feats.push({ type: "Feature", geometry: f.geometry, properties: { name, kind: r.cap ? "capital" : "city", mz: r.minZoom, pri: r.priority, size: r.size } });
		}
		labelsOn = true;
		await symbols({ type: "FeatureCollection", features: feats }, labelLayer());
	}
	const labelLayer = () => {
		const t = T(), L = t.labelColor;
		return {
			id: LABEL_ID, maxzoom: bandZ,
			filter: ["<=", ["get", "mz"], ["zoom"]],   // 出しズーム（止まるたびに評価し直される）
			layout: {
				"icon-image": ["match", ["get", "kind"], "capital", "wc-dot-cap", "city", "wc-dot", ""],
				"icon-size": ["match", ["get", "kind"], "capital", 1.3, 0.75],
				"symbol-sort-key": ["get", "pri"],
				"text-field": ["get", "name"], "text-size": ["get", "size"],
				// 国名＝点の真上に置き、衝突したら上下へずらす（equal と同じ所作）・都市＝点の右
				"text-anchor": ["case", ["==", ["get", "kind"], "country"], "center", "left"],
				"text-offset": ["case", ["==", ["get", "kind"], "country"], ["literal", [0, 0]], ["literal", [0.55, 0]]],
				"text-variable-anchor": ["case", ["==", ["get", "kind"], "country"], ["literal", ["center", "top", "bottom"]], ["literal", ["left"]]],
			},
			paint: {
				"text-color": ["case", ["==", ["get", "kind"], "country"], L.country, L.city],
				"text-halo-color": L.halo, "text-halo-width": 2,
			},
		};
	};
	async function airports() {
		const pbf = held.detail; if (!pbf) return;
		if (!imagesAdded) await images();
		const n = pbf.fmap?.length ?? 0, feats = [];
		for (let i = 0; i < n; i++) {
			const p = pbf.getProperties(i);
			if (p?.layer !== "airports") continue;
			const f = pbf.getFeature(i); if (f?.geometry?.type !== "Point") continue;
			feats.push({ type: "Feature", geometry: f.geometry, properties: { pri: airportLabelRule(p).priority } });
		}
		if (!feats.length) return;
		await symbols({ type: "FeatureCollection", features: feats }, { id: AIR_ID, minzoom: WORLD_Z.airport, maxzoom: bandZ,
			layout: { "icon-image": "wc-plane", "icon-size": 0.65, "symbol-sort-key": ["get", "pri"] } });
	}

	return {
		/** カメラが止まるたび（と起動時）に呼ぶ：見える帯に入った群だけ取りに行く（見えない層のための通信をしない） */
		update() {
			const z = getZoom();
			if (z >= bandZ) return;
			load("base");
			if (!lowMem) load("lakes");
			if (z >= WORLD_Z.detailLoad) load("detail");
		},
		/** テーマ切替＝線/面の色・記号帳・注記の色を正本から引き直す */
		async repaint() {
			for (const g of Object.keys(H)) H[g].setPaint(PAINT[g](T()), FILTER[g]).catch(() => {});
			if (imagesAdded) await images();
			if (labelsOn) await labels();
			if (held.detail) await airports();
		},
		state: () => ({ ...state, labels: labelsOn }),
	};
}
