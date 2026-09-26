// zoom の目盛り（2026-09-26・MapLibre 互換の計画＝maplibre-compat.md）。
// このエンジンの z は 256px 世界（ortho-core camera.js の WORLD_PX）＝MapLibre の z より 1 大きい（同じ縮尺で z が 1 段深い）。
// 起動時の旗 createGlobe({ zoomScale: "maplibre" }) を立てた地図は、公開面の「数」の zoom を MapLibre の z で受け渡しする
// （入力 +1・出力 −1）。文字列（URL hash・view 文字列）と台本の族はエンジン z のまま。旗が無ければ何も換算しない。
//
// ★このファイルは換算の唯一の正典。換算する所（起動オプション・外側の顔 mlfacade.js・ML 形の層と source の dz）は
//   必ずここの表と関数を使う。表に無い公開メンバーは検定（tests/zoomscale.mjs・t-mlcompat の実行時キー）で落ちる＝
//   新しいメソッドを足したら、ここで分類してから（zoom を運ばないなら "none"）。
//
// 分類：
//   "none"   zoom の数を運ばない
//   "in"     zoom の数を受け取る（旗なら +dz して素へ）
//   "out"    zoom の数を返す（旗なら −dz して利用者へ）
//   "io"     両方
//   "layer"  MapLibre 形の層・source を受け渡す（dz は層と source に登録＝normalizeMLLayer）
//   "event"  イベントの口（e.zoom を運ぶ物がある）
//   "gadget" / "raster" 下の表で個別に分類
//   "engine" zoom の数を運ぶがエンジン z のまま（文書に明記する例外）

export const ML_DZ = 1;   // エンジン z − MapLibre z
export const ZOOM_SCALES = ["ortho", "maplibre"];
// 旗つきの地図（外側の顔）から素の map へ戻る鍵。部品（geoedit・common/gintView・Marker の登録簿）は入口で `map[RAW] ?? map`＝エンジンの z で読む。
// Symbol.for＝別の包み（npm の geoedit 等）からも import なしで同じ鍵が引ける
export const RAW = Symbol.for("ortho-earth.map.raw");
// 数の換算（null・undefined は素通し＝「無指定」の意味を保つ）。dz＝公開の口の目盛り（旗なし 0・maplibre 1）
export const zIn = (z, dz) => z == null || !dz ? z : z + dz;    // 公開の口 → エンジン
export const zOut = (z, dz) => z == null || !dz ? z : z - dz;   // エンジン → 公開の口

// 地図（createGlobe が返す物）の公開メンバー。実行時の Object.getOwnPropertyNames(map) と globe.d.ts の OrthoJapanMap の両方が
// ここに載っていること（t-mlcompat と tests/zoomscale.mjs が検札する）。
export const MAP_MEMBERS = {
	// カメラ
	flyTo: "in", jumpTo: "in", easeTo: "in", setZoom: "in", getZoom: "out",
	fitBounds: "in", cameraForBounds: "io", fitZoomForBbox: "out",
	setMinZoom: "in", getMinZoom: "out", setMaxZoom: "in", getMaxZoom: "out", setZoomMin: "in", zoomMin: "out",
	view: "out",   // view.zoom だけ換算（view.hash は文字列＝エンジン z のまま・pitch/bearing はラジアンのまま）
	getCenter: "none", setCenter: "none", getPitch: "none", setPitch: "none", getBearing: "none", setBearing: "none",
	getBounds: "none", setMaxBounds: "none", getMaxBounds: "none", setPadding: "none", getPadding: "none",
	isMoving: "none", stop: "none", maxPitch: "none", setMaxPitch: "none", ellipsoidOn: "none",
	cam: "engine",   // 内部の生の状態（書き換え可能な物）＝換算しない
	// イベント
	on: "event", off: "event", once: "event",
	// MapLibre 形の層と source
	addSource: "layer", getSource: "layer", removeSource: "none", isSourceLoaded: "none",
	addLayer: "layer", getLayer: "layer", getLayers: "layer", removeLayer: "none", moveLayer: "none",
	setPaintProperty: "layer", getPaintProperty: "layer", setLayoutProperty: "layer", getLayoutProperty: "layer",
	setFilter: "layer", getFilter: "layer", setLayerZoomRange: "layer",
	setFeatureState: "none", removeFeatureState: "none", getStyle: "layer", setStyle: "layer",
	queryRenderedFeatures: "io",   // filter の ["zoom"]（入）・集約の expansionZoom（出）
	addImage: "none", removeImage: "none", hasImage: "none", listImages: "none", loadSprite: "none",
	setTerrain: "none", getTerrain: "none",   // raster-dem の minzoom/maxzoom は source の tile z＝MapLibre と同義
	setTransformRequest: "none", addProtocol: "none", removeProtocol: "none", fetchResource: "none",
	Marker: "none", Popup: "none",
	// gint（ネイティブ）
	addGint: "in", applyGintData: "in", paint: "in", paintTable: "none", queryAll: "none", clearUserGint: "none",
	userPbf: "none", gintFeatures: "none", onGintClick: "none", standupGint: "none",
	// 画像タイル・ガジェット
	raster: "raster", gadget: "gadget",
	// 3D・解析
	add3DTiles: "none", addI3S: "none", getHeight: "none", sunShadow: "none", setShadows: "none",
	viewshed: "none", lineOfSight: "none", clearViewshed: "none",
	// 投影・フレーム・描画
	project: "none", unproject: "none", projectLL: "none", unprojectXY: "none", makeProjector: "none", makeProjectorH: "none",
	onFrame: "none", requestDraw: "none", requestSnapshot: "none", setOpacity: "none", setEditClick: "none", pinRes: "none",
	overlay: "engine",   // worker の overlay 契約の cam はエンジン z
	// 台本の族（台本の書式＝hash 文字列に属する）
	playScenes: "engine", stopScenes: "none", sceneTimeline: "engine",
	// その他
	renderer: "none", mapEl: "none", destroy: "none", clock: "none", backend: "none", lang: "none", t: "none",
	// 地域パックが install で足すキーはここに載せない（globe は地域を知らない＝その地域パックの検定が自分の分を持つ）
};

// map.gadget の各ガジェット。全ガジェット共通の表示帯 opts.zoom:[a,b] は旗なら両端 +dz（外側の顔の gadget 代理が一括で）。
// ここは「それ以外に zoom を運ぶか」＝"none"｜"layer"（MapLibre 形の層 object＝中で PUBLIC_DZ が換算）｜
// { opts: [zoom を運ぶ opts のキー], arg?: その opts が第何引数か（既定 0）}。"view[2]"＝配列 view の 3 番目（[lon, lat, z]）。
export const GADGET_MEMBERS = {
	heatmap: "layer", cluster: "layer", symbols: "layer", extrude: "layer",
	zoom: { opts: ["zoomMin", "zoomMax"] }, home: { opts: ["view[2]"] }, japan: { opts: ["view[2]"] },
	spotlight: { opts: ["maxZoom"], arg: 1 }, globe: { opts: ["maxZoom"] }, viewshed: { opts: ["minZoom"] }, sunshadow: { opts: ["minZoom"] },
	demo: "engine",   // 台本の族（zoomMin は hash の z と比べる）
	offline: "none",  // zmaxDefault はタイルの z
	search: "none", compass: "none", full: "none", shot: "none", measure: "none", profile: "none", contextmenu: "none",
	legend: "none", palette: "none", hint: "none", qr: "none", print: "none", cpos: "none", mesh: "none", plateau: "none",
	dropFile: "none", model: "none", tip: "none", pop: "none", clock: "none", tiles3d: "none",
	// 実行時にだけ在るガジェット（d.ts に無い＝t-mlcompat の実行時キーが拾う）。中でエンジン z を使う物（equal・anno・cog・stac・geoedit）は
	// 素の map（func.apply(map)）で動く＝利用者の opts に zoom が無い限り換算は要らない（段 2 で opts を見直す）
	equal: "none", equalHere: "none", equalStart: "none", solar: "none", explain: "none", close: "none", anno: "none",
	cog: "none", stac: "none", raster: "none", outline: "none", geoedit: "none", edit: "none",
};

// map.raster（spec の minZoom/maxZoom は source の tile z＝換算しない・opts の minZoom/maxZoom は表示窓＝換算する）
export const RASTER_MEMBERS = {
	add: "in", set: "in", list: "out", info: "none", remove: "none", onChange: "none", select: "none", toggle: "none",
	catalog: "none", stats: "none", selected: "none",   // 地域パックのカタログ（minZoom/maxZoom は tile z）・統計・選択中
};

// addGint の手綱（手綱は包まない＝作る時に dz を受け取り中で換算する）。先頭が "_" のキーは内部＝検札の対象外。
export const HANDLE_MEMBERS = {
	id: "none", ready: "none", order: "none", on: "none", query: "none",
	setPaint: "in", setFilter: "in", setData: "in", setLabel: "in", style: "in",
	setFeatureState: "none", removeFeatureState: "none", setOrder: "none", setVisible: "none", activate: "none", remove: "none",
};

// 旗を読む（未知の値は投げる＝打ち間違いを黙って既定へ落とさない）
export function zoomScaleOf(opts) {
	const s = opts?.zoomScale ?? "ortho";
	if (!ZOOM_SCALES.includes(s)) throw new Error(`zoomScale: "${s}" is not one of ${ZOOM_SCALES.join(" | ")}`);
	return s;
}
