// 統合スパイク：geopbf / e-Stat 小地域を overlay に描き、クリックで identify（mat4 が geopbf を
// 識別込みで吸収）。自前の結果パネル(identEl)を持つ自己完結の機能。必要な物は入口で受け、
// グローバルに手を伸ばさない。
// e-Stat 経路は estatworker.js で全処理（fetch/gunzip/行parse/ジオメトリ生成/identify）＝mainをブロックしない。
// geopbf 経路（loadOverlay）は従来通り main＝identify は findPolygon 相当（pointInFeature）のJSレイキャスト。
import { unproject, cameraState, buildGeoJSONOverlay, pointInFeature } from "@ortho-earth/core";
import { geopbf } from "geopbf";
import { tr } from "./i18n.js";

const t = tr();

// 町丁目(estat)ハイライトの表現＝地物をべた塗りせず「周辺を薄く暗くして地物を浮かせる」マスク（本人裁定2026-08-14
// 「べた塗りはデータが見えにくい」）。setOverlayHi が {mask,color} を周辺マスクとして解釈する。
const HI_MASK = { mask: true, color: [0, 0, 0, 0.1] };

export function createOverlay({ renderer, cam, size, dpr, requestDraw, tip }) {
	const identEl = document.createElement("div");
	identEl.id = "ident";   // スタイルは style.css（#map 配下に後置＝DOM順で上）
	(document.getElementById("map") || document.body).appendChild(identEl);
	// 空のままだと padding+背景が「小さな空箱」として常時見えてしまう＝中身がある時だけ表示
	const say = t => { identEl.textContent = t; identEl.style.display = t ? "block" : "none"; };
	let overlayFeatures = null, overlayOrigin = [138, 37];   // geopbf 経路（main側identify）用
	let estatActive = false;                                  // e-Stat 経路がアクティブ＝identify は worker へ

	let estatOpts = {};        // 直近 loadEstat の opts（moveCamera/quiet/onLoaded）＝派生アプリ用。既定は従来挙動
	let identifyHandler = null;   // identify結果の派生アプリ受け口（setIdentifyHandler）。未登録なら従来の say パネル
	let highlightWait = null;     // highlightKey の完了待ち（worker 返信は直列＝最後の呼びが勝つで足りる）

	// e-Stat worker は初めて要る時（loadEstat）に立てる＝census2020 以外の頁では起動しない（旧＝起動時に常に立っていた・2026-09-22）
	let estatW = null;
	const estatWorker = () => estatW ??= Object.assign(new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "estat" }), { onmessage: onEstatMessage });
	const onEstatMessage = e => {
		const m = e.data;
		if (m.type === "loaded") {
			const o = estatOpts;
			if (!m.ok) { if (!o.quiet) say(t("e-Stat load failed")); o.onLoaded?.({ ok: false, count: 0 }); return; }
			estatActive = true; overlayFeatures = null;   // 単一スロット＝geopbf 経路の識別対象は置き換え
			renderer.set("overlay", m.overlay);
			renderer.set("overlayHover", null);   // ホバー境界は消す（overlayHi＝選択マスクは setSelected/highlightKey 管理＝ここで消すと市区町村選択マスクが即消える不具合）
			if (o.moveCamera !== false) { cam.center = [m.center[0], m.center[1]]; cam.zoom = 12; cam.pitch = 0; }   // 派生アプリは自前で寄せる＝直書きジャンプを抑止できる
			requestDraw();
			if (!o.quiet) say(t("e-Stat small areas: $1 features — click to identify (small-area code = the join key)", m.count));
			o.onLoaded?.({ ok: true, count: m.count, center: m.center });
		} else if (m.type === "identify") {
			// 生 identify は「当たり報告」だけ＝マスク(overlayHi)には触れない。選択マスクは選択フロー
			// （setSelectionMask＝県/市 ／ highlightKey＝町丁目）が単独で握る＝別市区町村クリック時の
			// 非同期上書き競合（旧市の hit<0 応答が新選択マスクを消す）を構造的に断つ（本人指摘2026-08-14「スパゲッティ」）。
			if (identifyHandler) { identifyHandler(m.hit >= 0 ? { hit: m.hit, props: m.props || {} } : null); return; }
			renderer.set("overlayHi", m.overlay || null, HI_MASK);   // ハンドラ未登録の自己完結デモ時だけ当たりを周辺マスクで示す
			if (m.hit >= 0) {
				const kv = Object.entries(m.props).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join("\n");
				say(`identify ✔ #${m.hit}\n${kv || "(no props)"}`);
			} else say(t("identify: no hit"));
			requestDraw();
		} else if (m.type === "highlighted") {
			renderer.set("overlayHi", m.overlay || null, HI_MASK);   // 町丁目(estat)選択＝周辺マスク（塗りつぶさない）
			if (highlightWait) { highlightWait(m.bbox ? { key: m.key, bbox: m.bbox, count: m.count } : null); highlightWait = null; }
			requestDraw();
		} else if (m.type === "hovertip") {
			tip?.(m.name || null);   // 町丁目名を tip へ（estat 中は gint 市区町村 tip でなくこれ＝紛らわしさ解消）
			renderer.set("overlayHover", m.overlay || null);   // ホバー中の町丁目境界を太線で（選択マスクとは別スロット＝両立）
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
		say(t("Loading geopbf: $1 …", name));
		const pbf = await geopbf(name, { gint: false }).catch(err => { console.warn("geopbf", err); return null; });
		if (!pbf || !pbf.features || !pbf.features.length) { say(t("geopbf load failed: $1", name)); return; }
		estatActive = false;   // 識別対象を geopbf 経路（main側）へ切り替え
		overlayFeatures = pbf.features;
		overlayOrigin = bboxCenter(overlayFeatures).center;
		renderer.set("overlay", buildGeoJSONOverlay(overlayFeatures, overlayOrigin));
		renderer.set("overlayHi", null);
		say(t("geopbf: $1\n$2 features — click to identify", name, overlayFeatures.length));
		requestDraw();
	}
	// ホバー tip：estat 経路の時だけ、指先の町丁目名を worker から取り tip へ（gint 市区町村 tip の代わり）。
	// 返り true＝estat が tip を担当したので呼び出し側は gint ホバーを出さない（紛らわしさ解消・本人裁定2026-08-14）。
	function hoverAt(clientX, clientY) {
		if (!estatActive) return false;
		const st = cameraState(cam, size.w, size.h);
		const ll = unproject(st, clientX * dpr, clientY * dpr);
		if (!ll) return false;   // 投影不能＝gint へ
		// bbox短絡は廃止＝毎ホバーきっちり点in面で識別（worker findHit）。ミス（町丁目外＝他市区町村上）は
		// hovertip name:null で返り、呼び出し側が gint ホバーへフォールバックする（本人指摘2026-08-14
		// 「bboxを使うとバグが残る・identifyをきちっと」＝移動点→identifyの正しさを最優先）。
		estatWorker().postMessage({ type: "hovertip", lon: ll[0], lat: ll[1] });   // 結果 hovertip は onmessage が tip＋境界へ
		return true;
	}
	function identifyAt(clientX, clientY) {
		if (!estatActive && !overlayFeatures) return;
		const st = cameraState(cam, size.w, size.h);
		const ll = unproject(st, clientX * dpr, clientY * dpr);
		if (!ll) return;
		if (estatActive) { estatWorker().postMessage({ type: "identify", lon: ll[0], lat: ll[1] }); return; }   // 結果は onmessage が描く
		const hit = overlayFeatures.findIndex(f => pointInFeature(ll[0], ll[1], f.geometry));
		renderer.set("overlayHi", hit >= 0 ? buildGeoJSONOverlay([overlayFeatures[hit]], overlayOrigin) : null);   // ヒット地物だけ別 stencil で強調
		if (hit >= 0) {
			const p = overlayFeatures[hit].properties || {};
			const kv = Object.entries(p).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join("\n");
			say(`identify ✔ #${hit}\n${kv || "(no props)"}`);
		} else say(t("identify: no hit"));
		requestDraw();
	}
	// e-Stat 小地域（estat/{調査年}/{code}.geojsonl・gzip）：worker が fetch→gunzip→parse→ジオメトリ生成→transfer。
	// opts（派生アプリ用・省略時は従来挙動）: moveCamera:false=loaded時のカメラ直書きを抑止 / quiet=sayパネル抑止 / onLoaded(r)
	async function loadEstat(codes, year = "2020", style = null, opts = {}) {
		estatOpts = opts;
		if (!opts.quiet) say(t("Loading e-Stat small areas ($1 municipalities)…", codes.length));
		estatWorker().postMessage({ type: "load", codes, year, style, interiorOnly: !!opts.interiorOnly });   // interiorOnly＝census2020限定で内側メッシュのみ（既定=全ユニーク辺＝凍結デモ AI 経路）
	}
	// 小地域 KEY_CODE（9/11桁）でハイライト → {key,bbox,count}｜ヒットなし・estat未ロードは null
	function highlightKey(key) {
		if (!estatActive) return Promise.resolve(null);
		return new Promise(r => { highlightWait = r; estatWorker().postMessage({ type: "highlight", key: String(key) }); });
	}
	function clearOverlay() {   // overlay/estat 層を消す（identify 対象も外す）＝派生アプリ（census2020 leaveCity）の受け口
		estatActive = false; overlayFeatures = null;
		renderer.set("overlay", null); renderer.set("overlayHi", null); renderer.set("overlayHover", null);
		say(""); requestDraw();
	}
	const setIdentifyHandler = fn => { identifyHandler = fn; };   // 派生アプリの identify 受け口（null で従来 say へ復帰）
	// 選択地物（市区町村ポリゴン等）を「周辺マスク」で表示＝統一ルール（選択=マスク/ホバー=線）。geom=null で解除。
	// overlayHi スロットを使う＝町丁目選択マスクと同じ器（1度に1つ＝現在の選択の外を暗く）。
	function setSelectionMask(geom, opts = {}) {   // opts.color＝マスクの色と濃さ（既定＝HI_MASK の薄い黒）
		if (!geom) { renderer.set("overlayHi", null); return; }
		const feats = [{ geometry: geom }];
		// 線は描かない（lineWidth 0）＝マスク（外側の暗み）の縁だけが境界を示す。フル解像度の生線を半透明で
		// 重ねると頂点キャップが数珠（チリチリ）になる上、gint 側の境界線と二重になる（本人指摘2026-08-14）。
		// ranges:true＝feature 毎のレンジ＋外接円を同梱＝描画側の球体カリングが効く（国のような地球規模の面で
		// 裏半球の形が手前へ punch するのを断つ・2026-09-23）。小さな市区町村では実質 no-op（1 feature 分の円）。
		renderer.set("overlayHi", buildGeoJSONOverlay(feats, bboxCenter(feats).center, { lineColor: [0, 0, 0, 0], lineWidth: 0, ranges: true }), opts.color ? { mask: true, color: opts.color } : HI_MASK);
	}
	return { identifyAt, hoverAt, isEstatActive: () => estatActive, setSelectionMask, loadOverlay, loadEstat, clearOverlay, highlightKey, setIdentifyHandler, destroy: () => estatW?.terminate() };   // destroy＝map.destroy() から（worker外し漏れゼロの掟）
}
