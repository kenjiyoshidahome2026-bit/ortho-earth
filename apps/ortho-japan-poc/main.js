// ortho-japan PoC — 地理院 optimal_bvmap を球面に直描き（M2: タイルストリーミング＋LOD＋ラベル）。
import {
	evalExpr, parseRGBA, cameraState, unproject,
} from "ortho-japan";
import { createGeopbf, geopbf } from "geopbf";
import { parse as loadParse } from "@loaders.gl/core";          // PLATEAU 3D Tiles スパイク（A）
import { Tiles3DLoader } from "@loaders.gl/3d-tiles";           // b3dm/Draco/RTC を一括デコード
createGeopbf("https://api.ortho-earth.com");   // bucket 基盤（標高と同じ）。読み出しはキー不要
import style from "./style-mono.js";
import { createThemes, defaultLayerState, CHOME_MINZOOM, RAILTR_MINZOOM } from "./themes.js";
import { createOverlay } from "./overlay.js";
import { createTerrain } from "./terrain.js";
import { createPipeline } from "./pipeline.js";
import { d3diff } from "./d3diff.js";

const TILE_URL = (z, x, y) => `https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/${z}/${x}/${y}.pbf`;
const TILE = 512, D2R = Math.PI / 180, R2D = 180 / Math.PI;

const canvas = document.getElementById("c");
const labelCanvas = document.getElementById("labels");
const logEl = document.getElementById("log");
const EARTH_M = 6371000, TERR_EXAG = 1.0;   // 標高は実スケール（誇張しない＝地形を歪めない）。ラベル・地形・建物で共有

const bg = style.layers.find(L => L.type === "background");
const land = bg ? parseRGBA(evalExpr(bg.paint?.["background-color"] ?? "#fff", { zoom: 10, props: {}, geom: null, vars: {} })) : [0.96, 0.96, 0.95, 1];
const clear = [0.03, 0.04, 0.07, 1];   // 宇宙（球の外側）

let dpr = Math.min(2, window.devicePixelRatio || 1);

// --- render worker：GL を OffscreenCanvas で worker に置く。main は set/draw を postMessage する薄いプロキシ ---
// transfer 後は main から canvas.width を触れないので、論理サイズ(size)を main が自前で持つ。
const size = { w: Math.round(window.innerWidth * dpr), h: Math.round(window.innerHeight * dpr) };
canvas.width = size.w; canvas.height = size.h;             // transfer 前に初期サイズ
labelCanvas.width = size.w; labelCanvas.height = size.h;
const offscreen = canvas.transferControlToOffscreen();
const labelOffscreen = labelCanvas.transferControlToOffscreen();
const renderWorker = new Worker(new URL("./renderworker.js", import.meta.url), { type: "module" });
// scene worker → render worker の直結パイプ（main を経由しない geometry）。両端を各 worker へ渡す。
const sceneChan = new MessageChannel();
const gintSyncChan = new MessageChannel();   // render worker → gint worker：海岸線を地図フレームに従属（スライド消滅）
renderWorker.postMessage({ type: "init", canvas: offscreen, labelCanvas: labelOffscreen, elevBase: TERR_EXAG / EARTH_M, scenePort: sceneChan.port2, gintSyncPort: gintSyncChan.port1 }, [offscreen, labelOffscreen, sceneChan.port2, gintSyncChan.port1]);
// 薄いプロキシ：有線(関数呼び)を無線(postMessage)に載せ替え。set/draw 統一済なので pipeline/terrain/overlay は無改造。
// draw は worker 側で「cam を記録するだけ」に受け、実描画は worker 自前 rAF が最新 cam で回す（worker-driven）。
const renderer = {
	set: (cmd, data, prop) => renderWorker.postMessage({ type: "set", cmd, data, prop }),
	draw: (cam, opts) => renderWorker.postMessage({ type: "draw", cam, opts }),
};

let needsDraw = true, readySig = "", lastLabels = [], sceneOrigin = null;
let basemapHidden = false;                 // z<BASEMAP_MINZOOM で基図(GSI)を止めてるか（全球ビュー＝海岸線のみ）
const BASEMAP_MINZOOM = 4;                 // これ未満は基図の詳細を描かない（海岸線 gint で十分／main負荷を断つ）
let moving = false, settleT = null;
// 移動中は幾何を再結合しない（タイルのポップ＝チラチラ防止）。停止後に再結合。
// PLATEAU LOD2 データ登録簿：寄ると自動で出す。bbox は自動トリガ用の緩い矩形（実描画は被覆マスクが実フットプリントに沿わせる）。
const PLATEAU_SETS = [
	{ name: "札幌中央区", base: "https://assets.cms.plateau.reearth.io/assets/16/06e56d-a2d4-4fe4-ac91-b2762b96e033/01100_sapporo-shi_city_2020_citygml_7_op_bldg_3dtiles_01101_chuo-ku_lod2/", bbox: [141.28, 43.01, 141.40, 43.10] },
];
const PLATEAU_AUTO_Z = 14;                 // これ以上寄ると自動ロード
let plateauLoaded = null, plateauBusy = false;
const plateauCache = new Map();            // base URL → デコード済みメッシュ（fetch/Draco解凍/RTE/マスクの結果）。再訪は即描画

// 現在地＋ズームで登録簿を引き、範囲に入れば自動ロード／離れれば解放。onMove から毎回呼ぶがガードで実質タダ。
function autoPlateau() {
	const lon = cam.center[0], lat = cam.center[1];
	const hit = cam.zoom >= PLATEAU_AUTO_Z ? PLATEAU_SETS.find(s => lon >= s.bbox[0] && lon <= s.bbox[2] && lat >= s.bbox[1] && lat <= s.bbox[3]) : null;
	if (hit && plateauLoaded !== hit.name && !plateauBusy) {
		plateauBusy = true; plateauLoaded = hit.name;
		console.log("[plateau] 自動ロード →", hit.name);
		loadPlateau(hit.base).catch(e => { console.warn("[plateau] 自動ロード失敗", e); plateauLoaded = null; }).finally(() => { plateauBusy = false; });
	} else if (!hit && plateauLoaded && !plateauBusy) {
		console.log("[plateau] 範囲外→解放", plateauLoaded);
		plateauLoaded = null; renderer.set("plateauMesh", null); needsDraw = true;
	}
}

function onMove() {
	moving = true; needsDraw = true;
	autoPlateau();                                                                    // 寄る/離れるで PLATEAU を自動ロード/解放（ガードで実質タダ）
	renderer.draw(cam, { skipBase: false, noTerrain: cam.zoom < BASEMAP_MINZOOM });   // 入力の瞬間に最新camをworkerへ（全球=z<4は地形オフ＝白い地球＋海岸線のみ）
	// 海岸線(gint)は render worker が draw 後に従属で駆動＝ここから直接送らない（地図と同cam/同フレーム＝スライド消滅）。
	clearTimeout(settleT);
	settleT = setTimeout(() => { moving = false; needsDraw = true; gintWorker.postMessage({ type: "drawn" }); }, 150);   // 停止後に identify(picking)
}

// データパイプライン（tile/scene worker）。実装は pipeline.js。
// tiles＝LOD管理（update/labels）、requestMerge＝結合要求（scene worker が結合→render worker へ直行）。
const { tiles, requestMerge } = createPipeline({ style, tileUrl: TILE_URL, requestDraw: () => { needsDraw = true; }, scenePort: sceneChan.port1 });

// 透視カメラ：center(注視点lon/lat), zoom(web-mercator float), pitch/bearing(rad)
const MAXPITCH = 65 * D2R;   // 半透明の山と割り切り、独立峰をドラマチックに立てる。隠れ線は「透けている」で説明可
const atmo = [0.5, 0.66, 0.96, 0.3];   // 大気色 rgb + 強さ（さりげなく）
const bldColor = [0.83, 0.83, 0.82];    // 建物色（静かなグレー）
// cam＝幾何のみ（center/zoom/pitch/bearing/dpr）＝毎フレームの draw payload（将来の worker 境界）。
// 色（clear/land/atmo/bldColor）は静的なので setView で一度きりアップロード＝hot path から追い出す。
const cam = { center: [139.767, 35.681], zoom: 3, pitch: 0, bearing: 0, dpr };   // 起動＝世界ビュー（海岸線を最初から描画）。街区は zoom:16 に戻せば従来通り
renderer.set("view", { clear, land, atmo, bldColor });
// 海：水レイヤ(WA)をビュー一律にゲート＝cam.zoom<13 では描かない（＝紙の海・まだら無し）、z13+で一律点火。
renderer.set("sea", { li: style.layers.findIndex(L => L.id === "water"), minzoom: 8 });

// --- gint worker（知性の層）：14条など突合可能なエンティティを OffscreenCanvas で別workerに描く。
// MVT=描画(render worker)／Gint=知性(この worker)＝層分担。基図の上に重ね、pointer は透過して #c が受ける。
const gintCanvas = document.getElementById("gint");
gintCanvas.width = size.w; gintCanvas.height = size.h;
const gintOffscreen = gintCanvas.transferControlToOffscreen();
const gintWorker = new Worker(new URL("./gintworker.js", import.meta.url), { type: "module" });
gintWorker.postMessage({ type: "init", offscreen: gintOffscreen, dpr, syncPort: gintSyncChan.port2 }, [gintOffscreen, gintSyncChan.port2]);
// gint 描画スタイル（styleTable/lineWidth）。データ毎に差し替え（null=既定＝14条筆のオレンジ/シアン）。
let gintDrawOpts = null;
// gint 識別の有効/無効。14条筆=true（ホバー/クリックで突合）、世界海岸線=false（装飾＝ホバー不要）。
let gintInteractive = false;
// gint スタイルを worker へ保持させる（従属描画で使う）。データ毎に差し替え。
const sendGintStyle = () => gintWorker.postMessage({ type: "style", data: gintDrawOpts });
gintWorker.onmessage = e => {
	const d = e.data;
	if (d.action === "click")       console.log("[14条] 筆 fid=%s  lng=%s lat=%s", d.featureId, d.lng?.toFixed?.(6), d.lat?.toFixed?.(6));
	else if (d.action === "redraw") { needsDraw = true; gintWorker.postMessage({ type: "drawn" }); }   // context復帰等→地図を1枚描かせ従属で追随
};
canvas.addEventListener("pointerleave", () => gintWorker.postMessage({ type: "leave" }));
// 14条地図（法務省 登記所備付地図）を球へ。デコード済み pbf を受けて球へ配線する共通処理。
// 「座標値種別=図上測量」は測量手法のタグに過ぎず絶対位置の信頼性とは無相関と判明済み（系変換さえ合っていれば図上測量でも正確）
// →現状はバッジ判定に使わない。任意座標系の混入検知は変換パイプライン側（外れ値bbox比較）でやるべき課題として残す。
function applyGintData(pbf, label) {
	if (!pbf?.unPackGint) { console.error("[14条] gint デコード失敗 (%s)", label, pbf); return null; }
	gintDrawOpts = null;      // 14条筆は既定スタイルへ（海岸線グレーを引きずらない）
	gintInteractive = true;   // 筆はホバー/クリックで突合
	sendGintStyle();          // worker にスタイル(null=既定)を保持させる
	const g = pbf.unPackGint;
	console.log("[14条] %s unPackGint keys:", label, Object.keys(g), "| bbox:", g.bbox, "| polyStream:", g.polyStream?.length, "arcMeta:", g.arcMeta?.length);
	gintWorker.postMessage({ type: "set", cmd: "gint", data: g });
	// 視野をデータへ寄せる＝筆を確実に画面へ（初期は東京駅、moj のデータは離れた区にある）。onMove で基図＋gint 両方が追従。
	if (g.bbox && g.bbox.length === 4) cam.center = [(g.bbox[0] + g.bbox[2]) / 2, (g.bbox[1] + g.bbox[3]) / 2];
	onMove();
	console.log("[14条] %s ロード完了 → 中心 %o へ移動。筆をホバー/クリック", label, cam.center);
	return pbf;
}

// moj は geopbf の name 慣習(bucket/GIS/pbf/…)でなく bucket/moj/{code}.pbf に置かれた別棚なので、
// URL を直叩きして buffer を geopbf に食わせる（gint:true で unPackGint 生成）。
window.__moj = async (code = "13118") => {
	const url = `https://api.ortho-earth.com/bucket/moj/${code}.pbf`;
	const res = await fetch(url);
	if (!res.ok) { console.error("[14条] fetch 失敗 %s → HTTP %s", url, res.status); return; }
	let buf = await res.arrayBuffer();
	const head = new Uint8Array(buf, 0, 2);   // bucket は gzip 圧縮で置かれる。name 慣習の load は自動 gunzip するが直叩きは生バイト＝手動で解凍。
	if (head[0] === 0x1f && head[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
	const pbf = await geopbf(buf, { gint: true, name: `moj/${code}` });
	applyGintData(pbf, code);
};
// 任意の File/URL（例: aigidなど第三者が公共座標系→WGS84まで変換済みのGeoJSON）を直接デコードして球へ。
// bucket 変換パイプラインを経由せず動作検証したい時用。
window.__mojFile = async (fileOrUrl, name = "moj/local") => {
	const pbf = await geopbf(fileOrUrl, { gint: true, name });
	return applyGintData(pbf, name);
};
// 動作確認用ショートカット：public/moj-local/ に置いた aigid変換済みGeoJSONをワンコマンドでロード。
window.__sapporo = async () => {
	const res = await fetch("/moj-local/01101-aigid.geojson");
	const file = new File([await res.blob()], "01101_aigid.geojson");
	return window.__mojFile(file, "moj/01101_aigid");
};
// 荒川区（任意座標系のみ）を、大字/丁目名でe-Stat小地域に位置合わせしたラバーシート結果でロード。
// 回転はシェイプ推定せず地名の対応だけで平行移動+等方スケール（現地調査の代替ではなく表示用近似）。
window.__arakawaFit = async () => {
	const res = await fetch("/moj-local/13118-rubbersheet.geojson");
	const file = new File([await res.blob()], "13118_rubbersheet.geojson");
	return window.__mojFile(file, "moj/13118_rubbersheet");
};
// 世界海岸線（Natural Earth 10m・physical・S3）を球へ。gishub と同一経路＝生の .zip URL を geopbf に渡すだけ
// （server.fetch=api proxy で CORS 無し→shp デコード→既定で GintBUF を焼く）。coastline は native な線＝lineStream
// （styleId=1＝既定 #00B4D8）。fillColor 既定透明＝縁だけ＝「線だけ」。maxZoom:7 で z≤7 に点火＝低ズームの世界図専用。
// VW ランクは GintBUF に焼込済＝10m を間引かず全密度で描く（弦が短く球面に吸い付く＝110m の崩壊が起きない）。
// 世界海岸線（Natural Earth 10m）を起動時に自動ロード＝__coast() を叩かず「最初から描画」。
// カメラは動かさない＝ズームアウト（z≤7）した瞬間に海岸線が居る。14条筆と gint 単一スロット共有（相互置換）。
async function loadWorldCoast() {
	console.log("[coast] Natural Earth 10m coastline を読込中（S3→GeoPBF→GintBUF）…");
	const pbf = await geopbf("https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_coastline.zip", { name: "ne_10m_coastline" }).catch(e => { console.error("[coast] geopbf", e); return null; });
	const g = pbf?.unPackGint;
	if (!g) { console.error("[coast] GintBUF デコード失敗", pbf); return; }
	console.log("[coast] unPackGint keys:", Object.keys(g), "| lineStream:", g.lineStream?.length, "| bbox:", g.bbox);
	gintWorker.postMessage({ type: "set", cmd: "gint", data: {
		arcBuffer: g.arcBuffer, arcMeta: g.arcMeta,
		polyStream: g.polyStream, lineStream: g.lineStream,
		pointBuffer: g.pointBuffer, point: g.point, polyCompBbox: g.polyCompBbox,
		maxZoom: 8,
	} });
	// 海岸線＝lineStream＝styleId=1。紙＋淡青の色調に合わせ「薄い青灰グレー・細く」。
	const coastStyle = new Float32Array(256 * 4);
	coastStyle.set([1.0, 0.42, 0.208, 1.0]);          // style0 polygon（未使用）
	coastStyle.set([0.74, 0.77, 0.80, 1.0], 4);       // style1 = 海岸線 = 薄い青灰グレー #bcc4cc（alpha=1.0 のまま色だけ白寄せ）
	gintDrawOpts = { styleTable: coastStyle, lineWidth: 0.75 };
	gintInteractive = false;   // 海岸線は装飾＝ホバー/クリック識別なし
	sendGintStyle();   // worker にスタイルを保持させる（従属描画で使う）
	needsDraw = true;  // 地図を1枚描かせ→render worker が gint へ従属信号→海岸線が出る
	console.log("[coast] ロード完了。z≤7 で自動描画");
}
window.__coast = loadWorldCoast;   // 手動リロード用（通常は起動時に自動実行）

// --- PLATEAU LOD2 建物スパイク（A＝loaders.gl）：b3dm を Draco 解凍→ECEF→単位球へ変換→mesh pass で球に立てる ---
// ECEF(WGS84)→geodetic(lon,lat[rad],h)
function ecef2geo(x, y, z) {
	const a = 6378137, e2 = 0.00669437999014;
	const p = Math.hypot(x, y), lon = Math.atan2(y, x);
	let lat = Math.atan2(z, p * (1 - e2)), h = 0;
	for (let i = 0; i < 5; i++) { const s = Math.sin(lat), N = a / Math.sqrt(1 - e2 * s * s); h = p / Math.cos(lat) - N; lat = Math.atan2(z, p * (1 - e2 * N / (N + h))); }
	return [lon, lat, h];
}
// 手打ちデモ：読み込んで札幌中央区へカメラも寄せる（自動と違いカメラを動かす）。
window.__plateau = async (base, tiles) => {
	base = base || PLATEAU_SETS[0].base;
	await loadPlateau(base, tiles);
	cam.center = [141.354, 43.061]; cam.zoom = 15; cam.pitch = 45 * D2R; cam.bearing = 0;   // 札幌中央区・傾けて建物を見る
	plateauLoaded = PLATEAU_SETS[0].name;
	onMove();
	console.log("[plateau] 完了 → 札幌中央区 z15 tilt45°。右ドラッグで傾け調整");
};

// ロード本体（カメラは動かさない）：tileset → 葉タイル → デコード → RTE delta + 被覆マスク → renderer へ。
async function loadPlateau(base, tiles) {
	if (plateauCache.has(base)) { renderer.set("plateauMesh", plateauCache.get(base)); needsDraw = true; console.log("[plateau] キャッシュ命中（fetch/解凍スキップ）", base); return; }
	if (!tiles) {
		// REPLACE refine：親(粗)と子(詳細)が同じ場所を覆う→両方読むと重なって z-fight(マダラ)。
		// 子を持たない「葉」タイルだけ読む＝最詳細 LOD2 が重なりなしで並ぶ。
		const ts = await (await fetch(base + "tileset.json")).json();
		const leaves = [];
		(function walk(t) { if (!t) return; const ch = t.children || []; if (!ch.length) { if (t.content?.uri) leaves.push(t.content.uri); } else ch.forEach(walk); })(ts.root);
		tiles = leaves;
		console.log("[plateau] 葉タイル:", tiles.length, "枚");
	}
	console.log("[plateau] 読込", tiles.length, "tiles ←", base);
	const geo = [], outNrm = [], outIdx = []; let vbase = 0, minH = Infinity;
	for (const t of tiles) {
		try {
			const ab = await (await fetch(base + t)).arrayBuffer();
			const tile = await loadParse(ab, Tiles3DLoader, { "3d-tiles": { loadGLTF: true } });
			const rtc = tile.rtcCenter || tile.gltf?.extensions?.CESIUM_RTC?.center || [0, 0, 0];
			for (const m of (tile.gltf?.meshes || [])) for (const pr of (m.primitives || [])) {
				const P = pr.attributes?.POSITION?.value; if (!P) continue;
				const NRM = pr.attributes?.NORMAL?.value;
				const I = pr.indices?.value, n = P.length / 3, off = vbase;
				for (let i = 0; i < n; i++) {
					// local(Y-up)→ECEF：Yup→Zup(x,-z,y)＋RTC → geodetic(lon,lat,h) を一旦保持
					const ex = P[i*3] + rtc[0], ey = -P[i*3+2] + rtc[1], ez = P[i*3+1] + rtc[2];
					const g = ecef2geo(ex, ey, ez);
					if (g[2] < minH) minH = g[2];
					geo.push(g[0], g[1], g[2]);
					// 法線：glTF(Y-up local)→ortho は方向を (nx, ny, -nz)（Yup→Zup＋ECEF→ortho軸swap の合成）。符号は FS で視線側へ。
					if (NRM) outNrm.push(NRM[i*3], NRM[i*3+1], -NRM[i*3+2]); else outNrm.push(0, 1, 0);
				}
				if (I) for (let k = 0; k < I.length; k++) outIdx.push(I[k] + off);
				else for (let k = 0; k < n; k++) outIdx.push(off + k);
				vbase += n;
			}
		} catch (e) { console.warn("[plateau] tile 失敗", t, e.message); }
	}
	if (!outIdx.length) { console.error("[plateau] メッシュ0＝デコード/変換失敗"); return; }
	// 重複三角形（double-sided/coincident 面）除去＝マダラ(z-fight)の元を断つ。頂点位置(丸め)の3つ組で判定＝巻き順・頂点共有に非依存。
	const vkey = i => Math.round(geo[i*3] * 1e8) + "_" + Math.round(geo[i*3+1] * 1e8) + "_" + Math.round(geo[i*3+2] * 10);
	const seen = new Set(), dedupIdx = [];
	for (let k = 0; k < outIdx.length; k += 3) {
		const key = [vkey(outIdx[k]), vkey(outIdx[k+1]), vkey(outIdx[k+2])].sort().join("|");
		if (seen.has(key)) continue;
		seen.add(key); dedupIdx.push(outIdx[k], outIdx[k+1], outIdx[k+2]);
	}
	console.log("[plateau] dedup 面: %d → %d", outIdx.length/3, dedupIdx.length/3);
	outIdx.length = 0; for (const v of dedupIdx) outIdx.push(v);
	// bbox(deg)：基図建物マスクの範囲＋足元グリッドの範囲に使う。geo は rad なので deg へ。
	const M = geo.length / 3;
	let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
	for (let i = 0; i < M; i++) { const lo = geo[i*3], la = geo[i*3+1]; if (lo<minLon) minLon=lo; if (lo>maxLon) maxLon=lo; if (la<minLat) minLat=la; if (la>maxLat) maxLat=la; }
	const R2D = 180 / Math.PI, bbox = [minLon*R2D, minLat*R2D, maxLon*R2D, maxLat*R2D];
	// 足元の浮き対策：global minH で一律に持ち上げると ward の起伏で高地の建物が浮く／低い外れ頂点1つで全体が浮く。
	// 局所地面グリッド（セル毎の最低標高）を足元にして各頂点を置く＝建物ごとに接地。ground[cell]≤h なので radius≥1、基礎頂点は radius1。
	const GN = 256, ground = new Float32Array(GN*GN).fill(Infinity);
	const gLo = (maxLon-minLon)||1e-12, gLa = (maxLat-minLat)||1e-12;
	const cellOf = i => { let gx=(geo[i*3]-minLon)/gLo*GN|0, gy=(geo[i*3+1]-minLat)/gLa*GN|0; if(gx<0)gx=0;else if(gx>GN-1)gx=GN-1; if(gy<0)gy=0;else if(gy>GN-1)gy=GN-1; return gy*GN+gx; };
	for (let i = 0; i < M; i++) { const c = cellOf(i), h = geo[i*3+2]; if (h < ground[c]) ground[c] = h; }
	// RTE-lite：単位球の絶対座標は float32 だと建物1棟が~60段階に量子化される（半径6.37e6 vs 建物50m=8e-6、刻み~1.2e-7）
	// → 面が重なり z-fight＝淵マダラ／カメラで丸めが動き座標ちらつき。重心(origin)相対の delta を渡し精度を桁で戻す（本家Cesium と同じRTE）。
	const wpos = new Float64Array(geo.length);            // 単位球 絶対座標（float64 で正確に保持）
	let ox = 0, oy = 0, oz = 0;
	for (let i = 0; i < M; i++) {
		const lon = geo[i*3], lat = geo[i*3+1], cb = Math.cos(lat), r = 1 + (geo[i*3+2] - ground[cellOf(i)]) / EARTH_M;   // 局所足元からの高さ＝接地
		const x = cb*Math.cos(lon)*r, y = Math.sin(lat)*r, z = cb*Math.sin(lon)*r;
		wpos[i*3] = x; wpos[i*3+1] = y; wpos[i*3+2] = z; ox += x; oy += y; oz += z;
	}
	const origin = [ox / M, oy / M, oz / M];              // メッシュ重心＝画面上の錨（粗くて可、細部は delta が担う）
	const outPos = new Float32Array(geo.length);          // 重心相対 delta（float32 でフル精度）
	for (let i = 0; i < M; i++) {
		outPos[i*3] = wpos[i*3] - origin[0]; outPos[i*3+1] = wpos[i*3+1] - origin[1]; outPos[i*3+2] = wpos[i*3+2] - origin[2];
	}
	// 被覆マスク：bbox を N×N セルに割り、三角形が触れたセルを立てる。基図建物はこのマスクが立つ所（＝実フットプリント）
	// だけ伏せる＝矩形一枚(bbox)だと区の非矩形部や街区・公園まで伏せて空白地帯が出る問題を、セル単位で解消。
	const MASK_N = 256, mask = new Uint8Array(MASK_N * MASK_N);
	const spanLo = (maxLon - minLon) || 1e-12, spanLa = (maxLat - minLat) || 1e-12;
	for (let t = 0; t < outIdx.length; t += 3) {
		const a = outIdx[t], b = outIdx[t+1], c = outIdx[t+2];
		const lo0 = geo[a*3], lo1 = geo[b*3], lo2 = geo[c*3], la0 = geo[a*3+1], la1 = geo[b*3+1], la2 = geo[c*3+1];
		let cx0 = (Math.min(lo0,lo1,lo2) - minLon) / spanLo * MASK_N | 0, cx1 = (Math.max(lo0,lo1,lo2) - minLon) / spanLo * MASK_N | 0;
		let cy0 = (Math.min(la0,la1,la2) - minLat) / spanLa * MASK_N | 0, cy1 = (Math.max(la0,la1,la2) - minLat) / spanLa * MASK_N | 0;
		if (cx0 < 0) cx0 = 0; if (cy0 < 0) cy0 = 0; if (cx1 > MASK_N-1) cx1 = MASK_N-1; if (cy1 > MASK_N-1) cy1 = MASK_N-1;
		for (let y = cy0; y <= cy1; y++) { const row = y*MASK_N; for (let x = cx0; x <= cx1; x++) mask[row+x] = 255; }
	}
	let cov = 0; for (let i = 0; i < mask.length; i++) if (mask[i]) cov++;
	console.log("[plateau] verts=%d tris=%d minH=%sm origin=[%s] bbox=[%s] mask=%d/%d", M, outIdx.length/3, minH.toFixed(1), origin.map(v=>v.toFixed(4)).join(","), bbox.map(v=>v.toFixed(4)).join(","), cov, MASK_N*MASK_N);
	const meshData = { pos: outPos, nrm: new Float32Array(outNrm), idx: new Uint32Array(outIdx), origin, bbox, mask, maskN: MASK_N };
	plateauCache.set(base, meshData);                 // デコード結果をメモリ保持＝再訪でfetch/Draco解凍を丸ごと省略
	renderer.set("plateauMesh", meshData);
	needsDraw = true;
	console.log("[plateau] 完了", base);
}

function resize() {
	const w = window.innerWidth, h = window.innerHeight;
	size.w = Math.round(w * dpr); size.h = Math.round(h * dpr);
	// GL canvas：バッファサイズは worker が持つ（transfer 済）。main は CSS と論理サイズ(size)だけ。
	canvas.style.width = w + "px"; canvas.style.height = h + "px";
	renderWorker.postMessage({ type: "resize", width: size.w, height: size.h });
	// label canvas：worker が持つ（transfer 済）＝main は CSS だけ。バッファは resize メッセージで worker が更新。
	labelCanvas.style.width = w + "px"; labelCanvas.style.height = h + "px";
	gintCanvas.style.width = w + "px"; gintCanvas.style.height = h + "px";
	gintWorker.postMessage({ type: "resize", width: size.w, height: size.h });
	needsDraw = true;
}
window.addEventListener("resize", resize);

resize();

// --- 操作：左ドラッグ=パン / 右(or Shift/Ctrl)ドラッグ=チルト+方位 / ホイール=ズーム ---
let drag = null;
canvas.addEventListener("contextmenu", e => e.preventDefault());
canvas.addEventListener("pointerdown", e => {
	drag = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, tilt: e.button === 2 || e.shiftKey || e.ctrlKey };
	canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointerup", e => {
	if (drag && !drag.tilt && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) { overlay.identifyAt(e.clientX, e.clientY); if (gintInteractive) gintWorker.postMessage({ type: "click", x: e.clientX, y: e.clientY }); }   // 動いていない＝クリック→identify（基図overlay＋知性gint。海岸線=非interactiveは gint 識別しない）
	drag = null;
});
canvas.addEventListener("pointermove", e => {
	if (!drag) { if (gintInteractive) gintWorker.postMessage({ type: "move", x: e.clientX, y: e.clientY }); return; }   // ホバー→知性の層で筆を識別（海岸線=非interactiveはホバー無視）
	const dxp = e.clientX - drag.x, dyp = e.clientY - drag.y;
	if (drag.tilt) {
		cam.bearing += dxp * 0.006;
		cam.pitch = Math.max(0, Math.min(MAXPITCH, cam.pitch + dyp * 0.005));
	} else {
		// unproject でつかんだ地点をカーソル下に保つパン
		const st = cameraState(cam, size.w, size.h);
		const a = unproject(st, drag.x * dpr, drag.y * dpr), b = unproject(st, e.clientX * dpr, e.clientY * dpr);
		if (a && b) { cam.center[0] -= (b[0] - a[0]); cam.center[1] = Math.max(-85, Math.min(85, cam.center[1] - (b[1] - a[1]))); }
	}
	drag.x = e.clientX; drag.y = e.clientY;
	onMove();
});
// カーソル下の地点を固定したままカメラ変更を適用（ズーム/軸回転の中心＝マウス）。チルト時も unproject で正確。
function anchoredAt(clientX, clientY, mutate) {
	const st0 = cameraState(cam, size.w, size.h);
	const a = unproject(st0, clientX * dpr, clientY * dpr);
	mutate();
	if (a) {
		const st1 = cameraState(cam, size.w, size.h);
		const b = unproject(st1, clientX * dpr, clientY * dpr);
		if (b) { cam.center[0] += a[0] - b[0]; cam.center[1] = Math.max(-85, Math.min(85, cam.center[1] + a[1] - b[1])); }
	}
	onMove();
}
canvas.addEventListener("wheel", e => {
	e.preventDefault();
	if (e.metaKey) anchoredAt(e.clientX, e.clientY, () => { cam.bearing += e.deltaY * 0.01; });   // 軸回転(Cmd)。ctrl+wheelはトラックパッドのピンチ＝ズームに回す
	else anchoredAt(e.clientX, e.clientY, () => { cam.zoom = Math.max(2, Math.min(19, cam.zoom - e.deltaY * 0.002)); });  // ズーム（z2=地球全体〜z19。16超はベクタのオーバーズーム＝潰れず街路へ）
}, { passive: false });

// テーマ・チップ状態：静かな白黒の土台は常に全部見えている。チップは主題の「文字の表示」
// または「色の点火」を切り替えるだけ。すべて既取得データの再スタイル＝再取得・再デコードなし。
//   chimei/chikei … 文字（注記カテゴリ）の表示ON/OFF
//   rail/road/admin … 色の点火ON/OFF（OFFでも土台グレーは出ている）
const layerState = { ...defaultLayerState };   // UIトグル状態は main が保持・変更（チップで反転）
let styleSig = JSON.stringify(layerState);
const themes = createThemes(style);            // 分類（allowlist）は themes.js の純関数（layerState と zoom を引数で受ける）

// LOD選択 or テーマ状態(styleSig)が変わった時だけシーンを再結合。原点は安定化（プルプル防止）。
let zoomAtBuild = -1;
function swapScene(order) {
	const sig = order.map(o => o.key).join("|") + "#" + styleSig + "#z" + (cam.zoom >= CHOME_MINZOOM ? 1 : 0) + (cam.zoom >= RAILTR_MINZOOM ? 1 : 0);
	if (sig === readySig || !order.length) return;
	if (!sceneOrigin || Math.abs(sceneOrigin[0] - cam.center[0]) > 0.4 || Math.abs(sceneOrigin[1] - cam.center[1]) > 0.4)
		sceneOrigin = [cam.center[0], cam.center[1]];
	requestMerge("main", order, sceneOrigin, themes.hiddenLi(layerState, cam.zoom));   // 結合は scene worker（非同期）→ render worker へ直行
	lastLabels = themes.filterLabels(tiles.labels(order), layerState, cam.zoom).map(L => {
		// 都道府県は大きく薄い背景ラベルに（コピーしてキャッシュ側を壊さない）。他はそのまま。
		const o = L.code === 140 ? { ...L, size: L.size * 1.25, color: [L.color[0], L.color[1], L.color[2], L.color[3] * 0.5] } : L;
		o.elev = terrain.sampleElev(L.anchor[0], L.anchor[1]);   // 標高付与（傾き時に地物と一致）
		return o;
	});
	renderer.set("labels", lastLabels);   // ラベル集合を render worker へ（worker が地図と同じ draw で描画＝同期）
	readySig = sig; zoomAtBuild = cam.zoom;
}

// 粗い下地（base スロット）：移動中も常に敷き直して先端の空白・ちらつきを消す。低zで少数＝安く広い。
let baseSig = "";
function swapBase(coarseOrder) {
	const sig = coarseOrder.map(o => o.key).join("|") + "#" + styleSig;
	if (sig === baseSig || !coarseOrder.length) return;
	requestMerge("base", coarseOrder, [cam.center[0], cam.center[1]], themes.hiddenLi(layerState, cam.zoom));   // 下地も scene worker で結合
	baseSig = sig;
}

// チップ操作：状態を反転し、styleSig を更新して即再結合（再取得なし・一瞬）。
document.querySelectorAll(".chip").forEach(b => b.addEventListener("click", () => {
	const k = b.dataset.k; layerState[k] = !layerState[k];
	b.classList.toggle("on", layerState[k]);
	styleSig = JSON.stringify(layerState); readySig = ""; needsDraw = true;
}));

// コンパス兼リセット：3D（傾き or 回転）の時だけ表示。針は方位を指し、押すと水平・北向きへスッと戻る。
const resetBtn = document.getElementById("reset");
const resetSvg = resetBtn.querySelector("svg");
const shortBearing = () => ((cam.bearing + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;   // 最短回転へ正規化
function updateCompass() {
	const is3D = cam.pitch > 0.005 || Math.abs(shortBearing()) > 0.005;
	resetBtn.style.display = is3D ? "flex" : "none";
	if (is3D) resetSvg.style.transform = `rotate(${-cam.bearing * 180 / Math.PI}deg)`;
}
resetBtn.addEventListener("click", () => {
	const p0 = cam.pitch, b0 = shortBearing(), t0 = performance.now(), dur = 350;
	const step = () => {
		const k = Math.min(1, (performance.now() - t0) / dur), e = k * k * (3 - 2 * k);   // smoothstep
		cam.pitch = p0 * (1 - e); cam.bearing = b0 * (1 - e); onMove();
		if (k < 1) requestAnimationFrame(step);
		else { cam.pitch = 0; cam.bearing = 0; onMove(); }
	};
	requestAnimationFrame(step);
});

// 標高アトラス（altpbf 多解像度・R90/R10/R01）。実装は terrain.js。
// ensure() を毎フレーム呼び、sampleElev() でラベル標高を得る（傾き時に地物と一致）。
const terrain = createTerrain({ renderer, cam, size, requestDraw: () => { needsDraw = true; }, exag: TERR_EXAG, earthM: EARTH_M, apiUrl: "https://api.ortho-earth.com" });

function render() {
	// パン/チルト中（ズーム不変）は詳細も再結合。ズーム中はLODポップ回避で停止まで待つ。
	const zoomStable = Math.abs(cam.zoom - zoomAtBuild) < 0.12;
	// 地形アトラスもズーム中は再構築しない：cellRes/セル数が連続変化して全再ロード＆勾配密度の跳びで
	// 陰影がチラつくため。ズーム中は現アトラスを再投影（球面メッシュなので拡縮は追従）、停止後に再構築。
	renderer.draw(cam, { skipBase: !moving, noTerrain: cam.zoom < BASEMAP_MINZOOM });     // 先に最新camをworkerへ（全球=z<4は地形オフ）。海岸線は render worker が従属で追随
	// 全球ビュー（z<4）：基図(GSI)の詳細は不要＝タイル/結合/地形を止め、基図シーンを空に＝海岸線(gint)だけの軽い地球。
	// これで pan 中も main の毎フレーム負荷（tiles.update/merge/terrain）が消える。
	if (cam.zoom < BASEMAP_MINZOOM) {
		if (!basemapHidden) {
			const o = [cam.center[0], cam.center[1]];
			renderer.set("scene", { origin: o, layers: [] }, "main");
			renderer.set("scene", { origin: o, layers: [] }, "base");
			renderer.set("labels", []);
			readySig = ""; baseSig = ""; lastLabels = []; basemapHidden = true;   // 復帰時に再結合させる
		}
		updateCompass();
		logEl.textContent = `world  zoom=${cam.zoom.toFixed(1)}  基図・地形オフ・海岸線のみ`;
		return;
	}
	basemapHidden = false;
	if (!moving || zoomStable) terrain.ensure();
	const { order, coarseOrder, total } = tiles.update(cam, size.w, size.h);
	swapBase(coarseOrder);                          // 粗い下地は常に敷く（移動中も）＝先端の空白を無くす
	if (!moving || zoomStable) swapScene(order);
	updateCompass();                               // 3D時のみコンパス表示・針を方位に追従
	logEl.textContent = `tiles=${order.length}/${total}  labels=${lastLabels.length}  zoom=${cam.zoom.toFixed(1)} pitch=${(cam.pitch * 180 / Math.PI).toFixed(0)}°`;
}

// --- 統合スパイク：geopbf/e-Stat を overlay に描き、クリックで identify（実装は overlay.js）---
const overlay = createOverlay({ renderer, cam, size, dpr, requestDraw: () => { needsDraw = true; } });
window.__loadOverlay = overlay.loadOverlay;   // geopbf 名から（全球等）
window.__loadEstat = overlay.loadEstat;
window.__tokyo = () => overlay.loadEstat(Array.from({ length: 23 }, (_, i) => 13101 + i));   // 東京23区の小地域
window.__d3diff = () => d3diff(cam, size);   // d3 突合：japan(mat4) vs d3.geoOrthographic の逆/順/往復 残差を zoom 掃引で
// 初期 overlay なし（全球 land は検証用。__tokyo() や __loadOverlay(name) で任意に）

function frame() {
	if (needsDraw) { needsDraw = false; render(); }
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// 起動時に世界海岸線を自動ロード（最初から描画）。await せず発火＝基図の起動を妨げない。
loadWorldCoast();
