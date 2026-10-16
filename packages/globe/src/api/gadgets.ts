// 組み込みの gadget（map.gadget の登録口・表示の門＝zoom／narrow と、検索・操作説明・コンパス・全球図・言語・太陽系・建物 3D・配色・ズーム・
// 全画面・現在地・右クリック・吹き出し・説明・凡例・計測・断面図）＝createGlobe から切り出した（globe.js の分割 ⑨・2026-10-15）。中身は切り出す前と同じ。
//   live＝createGlobe の変数（let・この呼び出しより後で宣言される定数）を読み書きする口（getter／setter）。その他＝createGlobe の中の定数・関数（中身は createGlobe と共有）
import { betaToLonLat, cameraState } from "@ortho-earth/core";
import { clipDistanceM, clipPlanes } from "@ortho-earth/core/clip";
import { compass as compassGadget } from "../gadgets/compass.js";
import { contextmenu as contextmenuGadget } from "../gadgets/contextmenu.js";
import { cpos as cposGadget } from "../gadgets/cpos.js";
import { equal as equalGadget, equalHereItem, goEqual } from "../gadgets/equal.js";
import { explain as explainGadget } from "../gadgets/explain.js";
import { full as fullGadget } from "../gadgets/full.js";
import { hint as hintGadget } from "../gadgets/hint.js";
import { lang as langGadget } from "../gadgets/lang.js";
import { legend as legendGadget } from "../gadgets/legend.js";
import { measure as measureGadget } from "../gadgets/measure-stub.js";
import { mesh as meshGadget } from "../gadgets/mesh.js";
import { palette as paletteGadget } from "../gadgets/palette-stub.js";
import { pop as popGadget } from "../gadgets/pop.js";
import { profile as profileGadget } from "../gadgets/profile-stub.js";
import { search as searchGadget } from "../gadgets/searchbox.js";
import { solar as solarGadget } from "../gadgets/solar.js";
import { tip as tipGadget } from "../gadgets/tip.js";
import { zoom as zoomGadget } from "../gadgets/zoom.js";

export function installGadgets(map, live, {
	REGION_BLD_ICON, REGION_BLD_LABELS, REGION_SEARCH, ZOOM_MAX, ac, cam, demFirst, flightCtl, frameHooks, getHeightP, makeProjector, meshMgr, meshOn,
	narrowMq, onMove, projectLL, requestDraw, requestSnapshot, saveView, size, switchTheme, themeFixed, toolClose, toolOpen, unprojectAt, unprojectXY
}) {
	// ガジェットの表示宣言（プラットフォームの掟 2026-09-03「アイコン配列は全zで一本」）：搭載時 opts に
	//   zoom: [zmin, zmax)  … このズーム域でだけ表示（旧・solar の showBelow 内蔵と z5 一括退場CSSの置き換え）
	//   narrow: false       … 狭画面（narrowMq=480px＝#pos の狭画面掟と同じ境界）では出さない（左上溢れ対策）
	// を添えると、その搭載でスタック(#gadgets)へ生えた要素をプラットフォームが裁く（圏外は display:none＝
	// スタックは上詰め・並び順不変）。ガジェット自身は zoom も画面幅も知らない＝定義がシンプルに保たれる。
	// 契約：同期でスタックへ生やすガジェットに効く。自前で display を裁くガジェット（compass の3D限定等）に併用しない。
	const gadgetGates = [];
	const applyGadgetGate = g => {
		const on = cam.zoom >= g.min && cam.zoom < g.max && !(g.hideNarrow && narrowMq.matches);
		if (on !== g.on) { g.on = on; g.el.style.display = on ? "" : "none"; }
	};
	frameHooks.add(() => gadgetGates.forEach(applyGadgetGate));   // 圏の出入りは動いた時にしか起きない＝render のフックで足りる
	narrowMq.addEventListener("change", () => { gadgetGates.forEach(applyGadgetGate); requestDraw(); }, { signal: ac.signal });   // 回転・窓リサイズの跨ぎは即応（静止中でも）
	map.gadget = function (name, func) {
		typeof name == "function" && name.name && (func = name, name = func.name);
		map.gadget[name] = function (opts) {
			const st = live.mapEl.querySelector("#gadgets"), before = st && new Set(st.children);
			const ret = func.apply(map, arguments);
			const zr = opts?.zoom, hideNarrow = opts?.narrow === false;
			if (zr || hideNarrow) {
				const now = live.mapEl.querySelector("#gadgets");
				const added = now ? [...now.children].filter(el => !before?.has(el)) : [];
				if (!added.length) console.warn(`[gadget] ${name}: display declaration (zoom/narrow) but no stack element appeared synchronously (gate not bound)`);
				for (const el of added) { const g = { el, min: zr?.[0] ?? -Infinity, max: zr?.[1] ?? Infinity, hideNarrow, on: null }; gadgetGates.push(g); applyGadgetGate(g); }   // 搭載した瞬間から現状態で裁く（コンパスの update() 即呼びと同じ作法）
			}
			return ret;
		};
	};
	map.gadget("search", function (opts) {   // 地名・住所検索 … map.gadget.search({ onGo? })。destroy用のsignalはここで注入
		return searchGadget.call(this, { provider: REGION_SEARCH, signal: ac.signal, ...opts });
	});
	map.gadget("hint", function (opts) {   // 操作説明カード … map.gadget.hint() → { open, close }。キー(?)用に signal を注入
		const h = hintGadget.call(this, { signal: ac.signal, onOpen: () => toolOpen("hint"), ...opts });
		if (h) toolClose.set("hint", () => h.close(false));   // 道具に場所を譲る＝記憶には書かない（次の起動で初見の人にはまた開く）
		return h;
	});
	map.gadget("compass", function (opts) {   // コンパス兼リセット … 内部の手綱（フライト中断・onMove）はここで注入
		const update = compassGadget.call(this, { cancelFlight: () => flightCtl.cancel(), onMove, signal: ac.signal, ...opts });
		if (update) { frameHooks.add(update); update(); }   // 針の追従を render のフックへ＝搭載した瞬間から現姿勢を指す
	});
	map.gadget("equal", function (opts) {   // 全球図（ortho-equal・Equal Earth）への口＝球のフレームから開く受け渡し（?morph=1）。右クリック項目は map.gadget.equalHere()
		return equalGadget.call(this, opts);
	});
	map.gadget("equalHere", function (opts) { return equalHereItem(this, opts); });   // 右クリックメニューの項目＝contextmenu の setter へ渡す材料
	map.gadget("lang", function (opts) { return langGadget.call(this, opts); });   // 言語切替（34px 規格・透明な select）… map.gadget.lang({ onChange? })
	map.gadget("equalStart", function (opts) { return goEqual(this, { morph: false, ...opts }); });   // 入口＝Equal Earth を最初から上に（?start=equal）。japan は裏で起動
	map.gadget("solar", function (opts) {   // 太陽系への口（ortho-solar）＝34px規格アイコン。表示域を絞るなら搭載側で opts.zoom
		return solarGadget.call(this, opts);
	});
	map.gadget("mesh", function (opts) {   // 建物3Dデータ管理 … モーダルを開く手綱と地域のアイコンはここで注入
		if (!meshOn) { console.warn("[mesh] opts.mesh=false = feature disabled; gadget not mounted"); return; }
		return meshGadget.call(this, { onOpen: meshMgr.openDb, icon: REGION_BLD_ICON, labels: REGION_BLD_LABELS, ...opts });
	});
	map.gadget("plateau", function (opts) { return map.gadget.mesh.call(this, opts); });   // 旧名（1.1.0 まで）＝非推奨の別名
	map.gadget("palette", function (opts) {   // 配色テーマ・ピッカー … 現在テーマ(見本から除く)と切替(switchTheme=c=差替+reload)と撮影(見本=今の視点の実写)を注入
		if (themeFixed) { console.warn("[palette] opts.theme is baked in = c= cannot override; gadget not mounted"); return; }
		return paletteGadget.call(this, { current: live.themeName, onPick: name => { switchTheme(name); saveView(); }, requestSnapshot, getZoom: () => cam.zoom, getCurrent: () => live.themeName, signal: ac.signal, ...opts });   // pick=テーマ生き替え→URL即書込（switchThemeはURLを書かない＝ここで saveView）
	});
	map.gadget("zoom", function (opts) {   // ズーム＋/− … フライト中断・onMove・z範囲はここで注入
		// zoomMin はカメラ実床（太陽系圏込み）＝ズームボタンでも太陽系の底まで降りられる（旧床2の取り残し解消 2026-08-10）
		return zoomGadget.call(this, { cancelFlight: () => flightCtl.cancel(), onMove, zoomMin: () => live.zoomMinCur, zoomMax: ZOOM_MAX, signal: ac.signal, ...opts });   // 床は関数＝編集中の z2.5 に追随
	});
	map.gadget("full", function (opts) {   // 全画面トグル … destroy用のsignalはここで注入
		return fullGadget.call(this, { signal: ac.signal, ...opts });
	});
	map.gadget("cpos", function (opts) {   // 現在地（GPS） … マーカー追随の座標ブリッジを注入し update を render のフックへ
		const update = cposGadget.call(this, { projectLL, signal: ac.signal, ...opts });
		if (update) { frameHooks.add(update); update(); }
	});
	map.gadget("contextmenu", function (opts) {   // 右クリックメニュー … 逆投影と destroy用signalを注入。戻り値＝項目差し替えの setter
		return contextmenuGadget.call(this, { unprojectAt, signal: ac.signal, ...opts });
	});
	map.gadget("tip", function (opts) {   // カーソル追従の吹き出し … destroy用signalを注入。戻り値＝内容の setter
		return tipGadget.call(this, { signal: ac.signal, ...opts });
	});
	map.gadget("pop", function (opts) {   // 地点に紐づく吹き出し … 座標ブリッジを注入し _update を render のフックへ。戻り値＝pop 関数
		const p = popGadget.call(this, { projectLL, signal: ac.signal, ...opts });
		if (p && p._update) { frameHooks.add(p._update); p._update(); }
		return p;
	});
	map.gadget("explain", function (opts) { return explainGadget.call(this, opts); });   // 上辺の説明パネル … 戻り値＝内容の setter
	map.gadget("legend", function (opts) { return legendGadget.call(this, opts); });     // 左下の凡例パネル … 戻り値＝内容の setter
	map.gadget("measure", function (opts) {   // 距離・面積の計測 … 投影/逆投影とクリック横取りの手綱を注入。本体は初回クリック/Mで import()＝frame hook は onBody で本体到着後に配線
		return measureGadget.call(this, {
			makeProjector, unprojectXY, signal: ac.signal,
			setClick: fn => { live.measureClick = fn; fn && toolOpen("measure"); },   // 計測ON＝他の道具OFF（排他）
			requestDraw: requestDraw,
			onBody: m => { live.measureBody = m; if (m && m._update) { frameHooks.add(m._update); m._update(); } },   // 抽象アクセス：本体(measure.js)到着後に _update を毎フレ描画へ（frameHooks は core 側）
			...opts,
		});
	});
	map.gadget("profile", function (opts) {   // 断面図 … 投影/逆投影・クリック横取り・標高サンプラを注入。本体は初回クリックで import()
		return profileGadget.call(this, {
			makeProjector, unprojectXY, signal: ac.signal,
			setClick: fn => { live.profileClick = fn; fn && toolOpen("profile"); },   // 断面図ON＝他の道具OFF（排他）
			// 標高サンプラ＝zoom=99 固定で最良解像度（日本=R01 DEM10B 10m・海外=ALOS/GEBCOへ自動フォールバック）。
			// getHeightP 経由＝ローダ未着でも待って照会（map.getHeight の「未着=0m」縮退はグラフには不適）。
			sampleHeight: (lon, lat) => demFirst(lon, lat, () => getHeightP.then(f => (f ? f(lon, lat, 99) : 0))).then(h => +h || 0),   // 外来の DEM（#36）が先
			onBody: p => { live.profileBody = p; if (p && p._update) { frameHooks.add(p._update); p._update(); } },   // 抽象アクセス：本体到着後に _update を毎フレ描画へ（measure と同型）
			// 3D で切る（#111）＝経路の両端 a→b の鉛直面。既定はカメラ（目の直下）の側を外す＝切り口がこちらを向く・flip で反対側
			canCut: () => live.renderBackend === "webgpu",
			cut: (a, b, flip) => {
				if (!a) return map.setClipping(false);
				const eye = betaToLonLat(cameraState(cam, size.w, size.h).eye), pl = clipPlanes({ vertical: [[a, b]] });
				const eyeKept = pl.length && clipDistanceM(pl, eye[0], eye[1], 0) >= 0;
				map.setClipping({ vertical: [eyeKept !== !!flip ? [b, a] : [a, b]] });
			},
			...opts,
		});
	});
}
