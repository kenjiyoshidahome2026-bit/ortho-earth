// gint（知性の層）＝14条筆・ドロップ GIS・AI 層などの「突合できるエンティティ」を球に載せる側の main 部。
// 単一スロットのユーザー層（applyGintData／clearUserGint）・多層（addGint＝spec §4）・admin0 独立層（世界の国ポリゴン）・
// bake-ahead worker・地形ドレープ（standupGint）・fid 塗り（paint）・層をまたぐ照会（queryAll）。
// app.js の一塊（旧 1143〜1809 行）を**動作を変えずに**ここへ移した（2026-09-17・mesh/manager.js と同じ作法）。契約の整理は別コミット。
//
// 作法＝クラスも継承も作らない。app の状態は env で受ける：
//   定数・道具 … canvas, mapEl, renderer, wPost, dbgHost, ASSET_BASE, WORLD_VT, LOW_MEM, noGint, ZOOM_MIN, ZOOM_MAX, cam（生成前に定義済み）
//   theme      … getter（テーマ切替で差し替わる台帳）
//   layers     … 多層の台帳 { map(=extGint), get/set active, nextId() }＝onmessage ルーティングより先に app が宣言する（遅着メッセージの TDZ 回避）
//   smallAreaHover … opts.smallAreaHover（census2020 限定の町丁目ホバー）
//   requestDraw(), onMove(), flyTo(...), loadBelowSea(), loadLakes() … 生成後に定義される関数は app 側でラップ
// 戻り値＝関数と、外（識別の ack・入力・render・overlay・公開面）が読み書きする状態のアクセサ（移設前の let を同名で覗く）。
import { WORLD_PX } from "@ortho-earth/core";
import { geopbf } from "geopbf";

const D2R = Math.PI / 180;

export function createGintLayers(env) {
const { canvas, mapEl, renderer, wPost, dbgHost, ASSET_BASE, WORLD_VT, LOW_MEM, noGint, ZOOM_MIN, ZOOM_MAX, cam, layers, smallAreaHover, requestDraw } = env;
const extGint = layers.map;

// --- gint（知性の層）：14条など突合可能なエンティティ。1canvas統合＝render worker の GL コンテキストに
// 同居し、地図フレーム末尾の1パスとして同フレーム同カメラで描かれる（旧・別worker+OffscreenCanvasは撤去）。
// MVT=描画／Gint=知性＝層分担は不変。main からは renderer.set("gint"/"gintStyle"/"gintVis") と
// gintMove/gintClick/gintLeave/gintDrawn メッセージで操る。識別の返信は renderWorker.onmessage（上方）。
// gint 描画スタイル（styleTable/lineWidth）。データ毎に差し替え（null=既定＝14条筆のオレンジ/シアン）。
let gintDrawOpts = null;
// gint 識別の有効/無効。14条筆=true（ホバー/クリックで突合）、世界海岸線=false（装飾＝ホバー不要）。
let gintInteractive = false;
let gintHover = true;   // ホバー識別のゲート（interactive と別軸＝災害面はクリックは残しホバー処理だけ切る・本人裁定 2026-08-13）
// gint 表示状態（旧 #gint canvas の display 相当）。render() が visibleGintNow() と突き合わせ変更時だけ post。
let gintVisible = true;
// 地形沿い境界線(gintBld)が出ている層か＝視覚は draped 一本に統一し、gint層の2D視覚は平面でも出さない（識別は裏で生存）。二重線の解消。
let drapedOn = false;
// gint スタイルを render worker へ預ける（frame 末尾の gint パスが使う）。データ毎に差し替え。
const sendGintStyle = () => renderer.set("gintStyle", gintDrawOpts);
let gintHoverTip = null;   // ホバー tip 内容 setter（init末尾で map.gadget.tip() を一度だけ搭載＝全gint層で有効）
let lastHoverXY = null;    // 直近ホバー座標（estat が町丁目ミス＝市区町村外の時に gint ホバーへフォールバックする用）
let estatTipOwn = false;   // 町丁目tip表示中＝gint識別ackにtipを触らせない（gintLeaveのnull-ackで消える/古いmove-ackで上書きされるレース封じ）。census経路のみ立つ＝デモ不変
let gintClickHandler = null;   // gintクリックの派生アプリ受け口（map.onGintClick）。未登録なら従来の console のみ
canvas.addEventListener("pointerleave", () => {
	wPost({ type: "gintLeave" });
	// smallAreaHover（census2020限定）＝町丁目ホバーの太線/名前tipも掃除（ポインタが地図外へ出た時の残留防止）。
	// デモ（フラグ無し）は従来どおり gintLeave のみ＝凍結挙動不変。
	if (smallAreaHover) { estatTipOwn = false; renderer.set("overlayHover", null); gintHoverTip?.(null); requestDraw(); }
});
// 14条地図（法務省 登記所備付地図）を球へ。デコード済み pbf を受けて球へ配線する共通処理。
// 「座標値種別=図上測量」は測量手法のタグに過ぎず絶対位置の信頼性とは無相関と判明済み（系変換さえ合っていれば図上測量でも正確）
// →現状はバッジ判定に使わない。任意座標系の混入検知は変換パイプライン側（外れ値bbox比較）でやるべき課題として残す。
// bbox([lonMin,latMin,lonMax,latMax] deg)全体が画面に収まる zoom。正射の中心近傍は px ≈ scale×角(rad)。
// zの定義は camera.js の radPerDevPx＝2π/(2^z·WORLD_PX·dpr)＝256px世界 → CSS px/rad = 2^z·256/(2π)。
// v1 gint の 40.74(=256/(2π)) 規約と同目盛り（2026-07-26 の256統一でズレ解消）。
// 経度側だけ cos(lat) で実角へ。15% マージン。
// fit用bbox＝経度幅>300°は±180跨ぎ（ZCTAのアリューシャン等）とみなし、素朴min/max（全球幅＝中心0°
// ＝アフリカ沖へ飛ぶ誤り）を捨てて再計測する。v1の処方（gishub main.js）の移植＝fid別bbox中心の
// 球面平均で真の重心経度を取り、重心基準の周期正規化で幅を測り直す。フィーチャは encode 時に
// antimeridianFeature で±180分割済み＝fid別bbox自体は跨がない（半幅拡張が正しく効く根拠）。
// 返る経度は±180を超え得る＝flyTo/wrapLon が周期を受ける。fid別bbox不在（点のみ等）は素のまま。
function fitBboxOf(g) {
	const b = g?.bbox;
	if (!b || b.length !== 4) return null;
	if (b[2] - b[0] <= 300) return b;
	let sx = 0, sy = 0, n = 0;
	const cs = [];
	for (const m of [g.polyBboxByFid, g.lineBboxByFid]) {
		if (!m) continue;
		for (const bb of m.values()) {   // gint整数単位＝(lon+180)*1e7 / (lat+90)*1e7
			// 縫い目を跨いで切断された feature（MultiPolygon の片が両側）は fid 別 bbox 自体が経度全幅＝中心 0° に化ける
			//（geoedit で縫い目を跨ぐ円を取り込むと経度 0・z2.5 へ飛ぶ＝本人報告 2026-09-15「初期画面遷移にバグ」）。
			// 全幅級（≥180°）は「中心 180°・半幅 0」の点として重心へ寄与させる（幅は他の fid が決める）
			const wide = bb[2] - bb[0] >= 1800000000;
			const lng = wide ? 180 : (bb[0] + bb[2]) / 2e7 - 180, lat = (bb[1] + bb[3]) / 2e7 - 90;
			cs.push([lng, lat, wide ? 0 : (bb[2] - bb[0]) / 2e7, (bb[3] - bb[1]) / 2e7]);   // 中心＋半幅
			sx += Math.cos(lng * D2R); sy += Math.sin(lng * D2R);
			n++;
		}
	}
	if (!n) return b;
	const cl = Math.atan2(sy, sx) / D2R;   // 重心経度（緯度は素のmin/maxが正しいので触らない）
	let w = Infinity, e = -Infinity, s = Infinity, nn = -Infinity;
	for (const [lng, lat, hw, hh] of cs) {
		let dl = lng - cl; dl -= Math.round(dl / 360) * 360;   // 重心基準 [-180,180)
		if (dl - hw < w) w = dl - hw; if (dl + hw > e) e = dl + hw;
		if (lat - hh < s) s = lat - hh; if (lat + hh > nn) nn = lat + hh;
	}
	return [cl + w, s, cl + e, nn];
}
function fitZoomForBbox(b) {
	const latC = (b[1] + b[3]) / 2;
	const thX = Math.max(1e-9, (b[2] - b[0]) * Math.cos(latC * D2R) * D2R);
	const thY = Math.max(1e-9, (b[3] - b[1]) * D2R);
	const W = mapEl?.clientWidth || innerWidth, H = mapEl?.clientHeight || innerHeight;
	const scale = 0.85 * Math.min(W / thX, H / thY);
	return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.log2(scale / (WORLD_PX / (2 * Math.PI)))));
}
function applyGintData(pbf, label, moveCamera = true, opts = {}) {
	if (!pbf?.unPackGint) { console.error("[gint] decode failed (%s)", label, pbf); return null; }
	// gint 単一スロットのユーザー層（14条筆/ドロップGISファイル/AI層）＝世界海岸線と相互切替。pbf 保持＝ホバーで getFeature(id).properties を引く。
	// style/minZoom は層の属性としてここに預ける（スロット再適用(applyUserSlot)がズーム跨ぎの度に走るため、外に置くと切替で剥がれる）
	// opts.fillMaxEdges＝この層だけ塗り上限を上げる（フル解像度の行政界コロプレス等・既定 2M の暴走止めを個別解除）。
	// opts.lowFill＝fillOff のままでも低ズーム帯（z<outlineZoom）の単色ベタ塗りだけ生かす（geoedit 大規模モード）。
	if (opts.fillMaxEdges != null) pbf.unPackGint.fillMaxEdges = opts.fillMaxEdges;   // 0＝塗らない（輪郭だけ）
	if (opts.lowFill) pbf.unPackGint.lowFill = true;
	// opts.onReady＝この層の焼きが表示束に着地した瞬間の通知（geoedit 大規模モードの g再送＝編集コミットが
	// 「旧座標の絵が消えた」タイミングを知るための口）。層差し替えで焼きが捨てられた時は呼ばれない＝呼び出し側がタイムアウトで保険。
	userGint = { g: pbf.unPackGint, label, pbf, style: opts.style ?? null, minZoom: opts.minZoom ?? USER_GINT_MINZ, interactive: opts.interactive !== false, hover: opts.hover !== false, drapeFill: !!opts.drapeFill, tip: opts.tip ?? null, onReady: opts.onReady ?? null,
		// bakeMeta＝焼きに運ぶ表示レンジ。minZoom 未指定＝エンジンがデータ範囲から自動導出（狭域は 13〜14 等）。指定＝自動値を上書き
		// （以前は {} 固定で opts.minZoom が焼きへ届かず、d.ts の「minZoom で下げられる」が嘘だった＝SDK ドッグフード 2026-09-10 で発覚）
		bakeMeta: opts.minZoom != null ? { minZoom: opts.minZoom } : {} };   // tip＝ホバーtipの持参整形（筆層＝町丁目tipと排他の主導権も取る・census2020限定）
	// bake-ahead：メタ/tier梯子を bake worker で焼き切ってから搭載（render worker はテクスチャ搭載のみ＝
	// ロード時の同期ベイクで地図が固まらない）。焼き上がりの onDone で sent を立てて再調停＝そこで点火。
	cancelBake("user");
	bakeUser();
	// moj 等はデータ全体へ fit（初期は東京駅、moj のデータは離れた区にある）。ドロップは呼び出し側が flyTo で寄る＝moveCamera=false。
	if (moveCamera) { const b = fitBboxOf(pbf.unPackGint); if (b) env.flyTo((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, fitZoomForBbox(b)); }   // ±180跨ぎ耐性（fitBboxOf＝v1アフリカ飛びバグの根治移植）
	gintSlot = null;           // 内容が変わった＝再適用を強制
	updateGintSlot();          // z≥USER_GINT_MINZ ならユーザー層を表示（z<USER_GINT_MINZ は世界海岸線のまま＝世界図の文脈）
	env.onMove();
	// moj筆(opts.drape)＝地形沿い境界線を自動発火（0=実標高ぴったり）。非drape層へ切替時は前の draped を消す（層と一蓮托生）。
	if (opts.drape) standupGint(DRAPE_LIFT_M, { auto: true }); else { renderer.set("gintBld", null); drapedOn = false; requestDraw(); }
	console.log(`[gint] ${label} loaded (minZoom=${opts.minZoom ?? "auto (from data extent; none for point-only data)"}${LOW_MEM ? `; low-memory device sleeps the layer below z${userGint.minZoom}` : ""})`);   // %s 書式は CDP 越しに展開されない＝テンプレ文字列で   // 旧文言「z<7 shows world coastline」は admin0 二層化前の名残＝通常機では z<7 でも描く
	return pbf;
}

// moj は geopbf の name 慣習(bucket/GIS/pbf/…)でなく bucket/moj/{code}.pbf に置かれた別棚なので、
// URL を直叩きして buffer を geopbf に食わせる（gint:true で unPackGint 生成）。
dbgHost.__moj = async (code = "13118") => {
	const url = `https://api.ortho-earth.com/bucket/moj/${code}.pbf`;
	const res = await fetch(url);
	if (!res.ok) { console.error("[moj14] fetch failed %s -> HTTP %s", url, res.status); return; }
	let buf = await res.arrayBuffer();
	const head = new Uint8Array(buf, 0, 2);   // bucket は gzip 圧縮で置かれる。name 慣習の load は自動 gunzip するが直叩きは生バイト＝手動で解凍。
	if (head[0] === 0x1f && head[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
	const pbf = await geopbf(buf, { gint: true, name: `moj/${code}` });
	applyGintData(pbf, code, true, { drape: true });   // 14条筆＝地形沿い境界線を自動発火
};
// 任意の File/URL（例: aigidなど第三者が公共座標系→WGS84まで変換済みのGeoJSON）を直接デコードして球へ。
// bucket 変換パイプラインを経由せず動作検証したい時用。
dbgHost.__mojFile = async (fileOrUrl, name = "moj/local") => {
	const pbf = await geopbf(fileOrUrl, { gint: true, name });
	return applyGintData(pbf, name, true, { drape: true });   // 14条筆＝地形沿い境界線を自動発火
};
// 動作確認用ショートカット：public/moj-local/ に置いた aigid変換済みGeoJSONをワンコマンドでロード。
dbgHost.__sapporo = async () => {
	const res = await fetch(ASSET_BASE + "moj-local/01101-aigid.geojson");   // moj-localはデプロイ除外＝開発専用
	const file = new File([await res.blob()], "01101_aigid.geojson");
	return dbgHost.__mojFile(file, "moj/01101_aigid");
};
// 荒川区（任意座標系のみ）を、大字/丁目名でe-Stat小地域に位置合わせしたラバーシート結果でロード。
// 回転はシェイプ推定せず地名の対応だけで平行移動+等方スケール（現地調査の代替ではなく表示用近似）。
dbgHost.__arakawaFit = async () => {
	const res = await fetch(ASSET_BASE + "moj-local/13118-rubbersheet.geojson");
	const file = new File([await res.blob()], "13118_rubbersheet.geojson");
	return dbgHost.__mojFile(file, "moj/13118_rubbersheet");
};
// コロプレス塗り（gint draw spec.md）動作確認用：現在のユーザー層(gint)へ paint/filter を適用。
// 式は main で一度だけ評価（buildFidStyle）→ fid スタイル表を worker へ＝restyle はテクスチャ更新1回。
// 例: __paint({ 'fill-color': ['interpolate', ['linear'], ['get','R2'], 0,'#ffeeee', 5000,'#990000'] })
//     __paint({ 'fill-color': ['match', ['get','市区町村名'], '青葉区', '#cc000080', '#00000010'] })
//     __paint(null)＝解除（従来の stencil 単色塗りへ）。ortho-core は動的 import＝初期バンドル不変。
// fid 整列の feature 配列（式評価の入力）。identify の tip と同じ真実源＝getProperties(fid)。
// ※ .geojson は壊れ geometry の feature をスキップして配列を「詰める」＝fid とズレる（札幌 aigid で実証）。
//    式評価に .geojson を使ってはならない。読めない props は {}＝既定値評価（§6-4）。
const fidFeaturesOf = (pbf) => {
	const n = pbf?.fmap?.length ?? 0;
	if (!n) return null;
	const out = new Array(n);
	for (let i = 0; i < n; i++) {
		let p = {};
		try { p = pbf.getProperties(i) ?? {}; } catch (e) { /* 壊れ feature＝既定値へ */ }
		let gt = null; try { gt = pbf.getType(i) ?? null; } catch (e) { /* 型不明 */ }
		out[i] = { properties: p, geometry: gt ? { type: gt } : null };   // type だけ（座標は積まない）＝paint の ["geometry-type"]/circle-color 選択と呼び手の型別処理用（2026-09-11）
	}
	const skipped = n - (pbf.geojson?.features?.length ?? n);
	if (skipped > 0) console.info("[paint] %d of %d fids missing from .geojson (corrected via fid-aligned read)", skipped, n);
	return out;
};
const gintFidFeatures = () => fidFeaturesOf(userGint?.pbf);
// fid ズレ診断用：指定 fid だけ赤・他は薄灰でテーブル直書き（式評価を迂回＝純粋に fid 空間を見る）。
// 使い方: __paintFid(100) → 赤い筆をクリック → console の [gint] fid=… が 100 なら一致、±k ならズレ量 k。
dbgHost.__paintFid = (...fids) => {
	const feats = gintFidFeatures();
	if (!feats) { console.warn("[paintFid] user gint layer not loaded"); return; }
	const n = feats.length, u32 = new Uint32Array(n * 4);
	for (let i = 0; i < n; i++) { u32[i * 4] = 0x88888830; u32[i * 4 + 2] = (8 << 24) | (6 << 8) | 1; }
	for (const f of fids) if (f >= 0 && f < n) u32[f * 4] = 0xcc0000cc;
	sendGintPaint({ table: u32, count: n });
	requestDraw();
	for (const f of fids) console.log("[paintFid] fid=%d props=%o", f, feats[f]?.properties);
};
// fid → properties（クリックで出た fid の中身を確認する。identify と同じ getFeature 直読み）
dbgHost.__paintProps = (fid) => userGint?.pbf?.getFeature(fid)?.properties;
// gint ユーザー層（moj筆/ドロップ図形）を地形に沿わせる＝各頂点が自分の標高に乗る（buildDrapedGeometry・ポリゴン/線/点）。
// liftM=null で解除。auto=読み込み時の自動発火（moj）＝静かめ。平面↔地形は elevScaleEff で連続モーフ（renderer 側・show3dゲートなし）。
const DRAPE_MAX_EDGES = 4000000;   // 地形沿い線化の辺数上限。moj一区は数十万〜百万級＝通す。全国級(admin_all)の暴走だけ止める安全弁
// リフト＝地形からわずかに浮かせる高さ(m)。0だと「頂点間の直線の辺」が「頂点間で膨らむ地形面」の下に潜り、
// チルト時に深度で地形に負けて消える（真俯瞰は地形メッシュ無効で0でも見えていた）。数mで膨らみを越えて安定。
const DRAPE_LIFT_M = 2;
async function standupGint(liftM = 0, { auto = false } = {}) {
	if (liftM == null) { renderer.set("gintBld", null); drapedOn = false; requestDraw(); if (!auto) console.log("[standup] cleared"); return; }
	const feats = userGint?.pbf?.geojson?.features;
	if (!feats?.length) { renderer.set("gintBld", null); drapedOn = false; requestDraw(); if (!auto) console.warn("[standup] gint user layer not loaded = run await __sapporo() etc. first"); return; }
	let edges = 0;
	for (const f of feats) {
		const g = f?.geometry;
		if (g?.type === "Polygon") for (const r of g.coordinates) edges += r.length;
		else if (g?.type === "MultiPolygon") for (const p of g.coordinates) for (const r of p) edges += r.length;
		else if (g?.type === "LineString") edges += g.coordinates.length;
		else if (g?.type === "MultiLineString") for (const l of g.coordinates) edges += l.length;
		if (edges > DRAPE_MAX_EDGES) break;
	}
	if (edges > DRAPE_MAX_EDGES) { renderer.set("gintBld", null); drapedOn = false; requestDraw(); console.warn("[standup] ⚠ edges %d > limit %d = skipping terrain drape (huge layer). raise DRAPE_MAX_EDGES to allow", edges, DRAPE_MAX_EDGES); return; }
	const { buildDrapedGeometry } = await import("@ortho-earth/core");
	const b = userGint.pbf.unPackGint.bbox;                       // 表示CRS(経緯度)の bbox＝RTE の origin に使う
	const origin = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
	// CRS サニティ：geojson の座標が bbox(経緯度)から大きく外れていたら局所座標系＝線だけズレる（gint表示は変換済で正しい）
	const s = feats.find(f => f?.geometry?.coordinates)?.geometry?.coordinates?.flat(Infinity);
	if (s && (s[0] < b[0] - 1 || s[0] > b[2] + 1 || s[1] < b[1] - 1 || s[1] > b[3] + 1))
		console.warn("[standup] ⚠ geojson coords (%o,%o) outside bbox [%o..%o] = possibly local CRS. convert CRS if lines misalign", s[0].toFixed?.(3), s[1].toFixed?.(3), b[0].toFixed?.(2), b[2].toFixed?.(2));
	// 色は fid 塗り表（paintTable）があれば線色でグループ化＝田/畑等の色分けをドレープへ運ぶ（census筆・2026-08-27）。
	// 表が無い/数が合わない/色数過多（>8＝rendererのバッチ上限）は従来どおり単色＝層の持参色（style1=線色 rgb）。
	// moj/ドロップは style 無し＝既定オレンジ（14条筆の系統色）、AI層は plan の色。
	const st = userGint?.style?.styleTable;
	const defCol = st && st.length >= 8 ? [st[4], st[5], st[6]] : [1.0, 0.55, 0.15];
	const u2rgb = u => [(u >>> 24) / 255, ((u >>> 16) & 255) / 255, ((u >>> 8) & 255) / 255];   // packRGBA＝R<<24|G<<16|B<<8|A
	let batches = null;
	const tbl = gintPaintLast?.table;
	if (tbl && gintPaintLast.count === feats.length) {
		const groups = new Map();   // 線色u32（無ければ塗り色）→ feature配列
		for (let i = 0; i < feats.length; i++) {
			const u = (tbl[i * 4 + 1] || tbl[i * 4] || 0) >>> 0;
			let g = groups.get(u); if (!g) groups.set(u, g = []);
			g.push(feats[i]);
		}
		if (groups.size > 1 && groups.size <= 8) {
			batches = [];
			for (const [u, sub] of groups) {
				const geo = buildDrapedGeometry(sub, origin, { liftM });
				if (geo.lines || geo.points) batches.push({ lines: geo.lines, points: geo.points, color: u ? u2rgb(u) : defCol });
			}
			if (!batches.length) batches = null;
		}
	}
	if (!batches) {
		const geo = buildDrapedGeometry(feats, origin, { liftM });
		if (geo.lines || geo.points) batches = [{ lines: geo.lines, points: geo.points, color: defCol }];
	}
	const has = !!batches;
	renderer.set("gintBld", has ? { origin, batches } : null);
	drapedOn = has;   // draped が出た層＝gint層の2D視覚は消す（二重線解消・識別は裏で生存）
	requestDraw();
	const nl = (batches ?? []).reduce((a, b) => a + (b.lines ? b.lines.pos.length / 6 : 0), 0);
	const np = (batches ?? []).reduce((a, b) => a + (b.points ? b.points.pos.length / 3 : 0), 0);
	console.log("[standup] %s: features %d -> lines %d, points %d, batches %d (lift %dm)%s", auto ? "auto" : "manual", feats.length, nl, np, batches?.length ?? 0, liftM, has ? "" : " = zero generated");
}
dbgHost.__standup = (liftM = DRAPE_LIFT_M) => standupGint(liftM);   // 手動ノブ（実験）。既定=DRAPE_LIFT_M。null で解除・大きくすると浮く
// 重複可視化＝登記データの品質監査プローブ。通常塗りをせず winding 和の異常画素だけを色分け：
//   マゼンタ＝別筆同士の重なり（fid不定） / 橙＝同一筆の多重登記 / シアン＝向き矛盾の重なり（正味0）
// __paintOverlap() で点灯・__paintOverlap(false) か __paint(null) で解除。
dbgHost.__paintOverlap = (on = true) => {
	if (!on) { sendGintPaint(null); requestDraw(); return; }
	const feats = gintFidFeatures();
	if (!feats) { console.warn("[paintOverlap] user gint layer not loaded"); return; }
	const n = feats.length, u32 = new Uint32Array(n * 4);
	for (let i = 0; i < n; i++) u32[i * 4 + 2] = (8 << 24) | (6 << 8) | 1;   // 塗り透明・visible（ID経路の起動条件として表は必要）
	sendGintPaint({ table: u32, count: n, overlap: true });
	requestDraw();
	console.log("[paintOverlap] auditing %d parcels: magenta=overlap of distinct parcels / orange=duplicate registration of same parcel / cyan=winding contradiction", n);
};
// fid ズレ診断の決定版：偶数fid=赤／奇数fid=青の市松塗り（場所に依らず全面に出る＝見逃し不能）。
// どの筆でもクリック → console の [gint] fid=… の偶奇と色が一致するか：赤=偶数/青=奇数なら一致、逆なら±1ズレ。
dbgHost.__paintParity = () => {
	const n = userGint?.pbf?.fmap?.length ?? 0;
	if (!n) { console.warn("[paintParity] user gint layer not loaded = run await __sapporo() etc. first"); return; }
	const u32 = new Uint32Array(n * 4);
	for (let i = 0; i < n; i++) {
		u32[i * 4] = (i & 1) ? 0x0044cc90 : 0xcc000090;   // 奇数=青 / 偶数=赤
		u32[i * 4 + 2] = (8 << 24) | (6 << 8) | 1;
	}
	sendGintPaint({ table: u32, count: n });
	requestDraw();
	console.log("[paintParity] checkerboard applied to %d parcels (even=red/odd=blue). if no color shows, check the [gint] idFill caps console line", n);
};
// 任意の bucket GeoPBF を gint ユーザー層としてロード（例: __gload('admin_all')＝行政界コロプレスの土台。
// 全国級なので minZoom=3＝ズームアウトしても海岸線に切り替わらない）。
dbgHost.__gload = async (name, opts = {}) => {
	const pbf = await geopbf(name, { gint: true }).catch(e => { console.error("[gload]", e); return null; });
	if (!pbf) return null;
	return applyGintData(pbf, name, true, { minZoom: 3, ...opts });
};
// 移動中描画予算のノブ（実測用）。__budget(Infinity)=移動中も常時描画 / __budget()=既定250kへ戻す。
// ?perf=1 の [perf] 行の gpuGint ms を見ながらズーム操作で実測 → 既定値の再裁定に使う。
dbgHost.__budget = (n) => {
	gintDrawOpts = { ...(gintDrawOpts || {}), moveBudget: n ?? undefined };
	sendGintStyle(); requestDraw();
	console.log("[budget] moveBudget=%s", n ?? "default(250k)");
};
async function paintGint(paint, filter = null) {
	if (!paint) { sendGintPaint(null); requestDraw(); return; }
	const feats = gintFidFeatures();   // fid 整列（.geojson は詰めズレするため使わない）
	if (!feats) { console.warn("[paint] user gint layer not loaded (load via __moj etc. first)"); return; }
	const { buildFidStyle } = await import("@ortho-earth/core");
	const { u32, count } = buildFidStyle(paint, feats, { filter, zoom: cam.zoom });
	sendGintPaint({ table: u32, count });
	requestDraw();
	console.log(`[paint] applied to ${count} features`);
}
dbgHost.__paint = paintGint;
// ── gint 多層（gint draw spec §4 の顔・2026-09-09）───────────────────────────
// map.addGint(pbf, opts) ＝**追加**であって置換ではない（§10.2＝applyGintData 系の単一スロット動詞とは別系統・混ぜない）。
// 層の属性（minZoom/maxZoom/style）は層ごと（§10.3「スタック全体の設定」を作らない）。カーソルは常に1層（§4.1）＝
// 追加した層が既定でアクティブ（「今載せたデータを見たい」）・activate() で移す・remove() で残る最後の層へ落ちる。
// 両バックエンド対応（gpu/gint.js＋gl/gint/embed.js の addLayer・2026-09-09 に GL2 も整合）。
// この段階の制約（栞に記録）: ①ベイクは render worker 同期（bakeBase）＝大きい層は bake-ahead 統合が将来課題
// ②tip の自動表示は無し（on('hover') で受けてアプリが描く） ③query/queryAll は未実装。
function addGint(pbf, opts = {}) {
	if (!pbf?.unPackGint) { console.error("[addGint] invalid source (unPackGint missing) = pass geopbf(…, {gint:true})"); return null; }
	const seq = layers.nextId(), id = "gl" + seq;
	let g = pbf.unPackGint;
	if (opts.fillMaxEdges != null) g.fillMaxEdges = opts.fillMaxEdges;   // 0＝塗らない（輪郭だけ）も通す（旧 truthy 判定は 0 を捨てていた）
	if (opts.lowFill) g.lowFill = true;
	// ack は待ち行列（初回 ready ＋ setData の再ロード完了を同じ経路で受ける）
	const ackQ = [];
	const nextAck = () => new Promise(res => ackQ.push(res));
	const ready = nextAck();
	const handlers = { hover: [], click: [], mouseenter: [], mouseleave: [] };   // mouseenter/leave＝MapLibre 同名の糖衣（hover の縁で発火）
	let lastHovFid = null;
	let lastPaint = null, lastFilter = null, zoomDriven = false, lastEvalZoom = null;   // ③ zoom×data-driven 合成＝settle 再評価（式は snapshot 評価・§6-3 の逃げ道を自動化）
	let labelOpt = opts.label ?? null;   // ② ラベル（text-field 相当）＝{ field, size?, color?, halo?, haloW?, sort?, minZoom?, maxZoom? }
	let lastTable = null;                // 直近の fid 表（setPaint の評価結果）＝ラベルの filter 連動が visible ビット(bit0)を読む
	const fstates = new Map();           // fid → feature-state（['feature-state', key] の実体・maplibre 同名）
	// text-field＝§6 の式全域（evalExpr）＋文字列リテラル＋関数(props→string)。式は get/match/case/concat/to-string…
	const evalText = (fld, pr, evalExpr, fid) => typeof fld === "function" ? fld(pr)
		: Array.isArray(fld) ? evalExpr(fld, { zoom: cam.zoom, props: pr ?? {}, geom: "", vars: {}, state: fstates.get(fid) })
		: typeof fld === "string" ? fld : null;
	const anchorOf = fid => {   // ラベル錨＝面/線は bbox 中心（gint整数→経緯度）・点は geometry 直参照
		const bb = g.polyBboxByFid?.get(fid) ?? g.lineBboxByFid?.get(fid);
		if (bb) return [(bb[0] + bb[2]) / 2e7 - 180, (bb[1] + bb[3]) / 2e7 - 90];
		try { const gm = pbf.getFeature(fid)?.geometry; if (gm?.type === "Point") return gm.coordinates.slice(0, 2); } catch { /* 壊れfeature */ }
		return null;
	};
	const refreshLabels = async () => {
		if (!labelOpt?.field) { h.labelCount = 0; renderer.set("gintLabels", { list: null }, undefined, id); return 0; }
		const { evalExpr } = await import("@ortho-earth/core");
		const lb = labelOpt, n = pbf.fmap?.length ?? 0, list = [];
		for (let i = 0; i < n; i++) {
			if (lastTable && !(lastTable[i * 4 + 2] & 1)) continue;   // filter 連動＝fid 表の visible ビット（bit0）を尊重（paint/filter 未設定＝全通し）
			let pr = {}; try { pr = pbf.getProperties(i) ?? {}; } catch { /* 壊れfeature */ }
			const txt = evalText(lb.field, pr, evalExpr, i);
			if (txt == null || txt === "") continue;
			const a = anchorOf(i);
			if (!a) continue;
			list.push({ anchor: a, text: String(txt), ...(lb.size ? { size: lb.size } : {}), ...(lb.color ? { color: lb.color } : {}),
				...(lb.halo ? { halo: lb.halo } : {}), ...(lb.haloW != null ? { haloW: lb.haloW } : {}), ...(lb.sort != null ? { sort: lb.sort } : {}) });
		}
		renderer.set("gintLabels", { list, minZoom: lb.minZoom ?? opts.minZoom ?? null, maxZoom: lb.maxZoom ?? opts.maxZoom ?? null }, undefined, id);
		h.labelCount = list.length;   // 検定/デバッグ窓（t-gintlayers＝filter 連動・式全域の物差し）
		requestDraw();
		return list.length;
	};
	const props = fid => { try { return (fid != null ? pbf.getFeature(fid)?.properties : null) ?? null; } catch { return null; } };
	// tip＝層の属性（§10.3）: true＝全属性の既定整形／fn＝持参整形（props→行配列）／無指定＝出さない（on('hover') でアプリが描く）
	const tipFmt = opts.tip === true ? pr => Object.entries(pr).map(([k, v]) => `${k}: ${v}`) : (typeof opts.tip === "function" ? opts.tip : null);
	const h = {
		id, ready, order: opts.order ?? null, _seq: seq,
		_ack: d => { if (d.error) { console.warn("[addGint] %s: %s (legacy build without addLayer)", id, d.error); ackQ.shift()?.(false); } else if (d.cmd === "gint" || d.cmd === "gintBaked") ackQ.shift()?.(true); },   // gintAdd の ack は消費しない（ロード ack だけが待ち行列を進める）
		_hover: d => {
			const f = d.featureId != null ? { fid: d.featureId, properties: props(d.featureId) } : null;
			for (const cb of handlers.hover) cb(f);
			const nf = f?.fid ?? null;   // mouseenter/leave＝当たりの縁だけ発火（MapLibre 移住者の耳に馴染む形）
			if (nf !== lastHovFid) {
				if (lastHovFid != null) for (const cb of handlers.mouseleave) cb({ fid: lastHovFid });
				if (nf != null) for (const cb of handlers.mouseenter) cb(f);
				lastHovFid = nf;
			}
			if (tipFmt && gintHoverTip && !estatTipOwn) { const lines = f?.properties ? tipFmt(f.properties) : null; gintHoverTip(lines?.length ? lines : null); }
		},
		_zoomReeval: z => {   // settle 毎に呼ばれる（③）：['zoom'] を含む paint は 0.5z 動いたら再評価（restyle は安い＝§8.1）
			if (zoomDriven && lastPaint && Math.abs(z - (lastEvalZoom ?? z)) >= 0.5) h.setPaint(lastPaint, lastFilter);
		},
		_click: d => { for (const cb of handlers.click) cb({ fid: d.featureId, properties: props(d.featureId), lngLat: [d.lng, d.lat] }); },
		on: (ev, cb) => { handlers[ev]?.push(cb); return h; },
		query: ll => {   // 明示照会（§4＝interactive に依らず常に効く・main 同期 JS レイキャスト＝エンジン往復なし）
			const fid = pbf.identifyAt?.(ll[0], ll[1]);
			return fid == null ? null : { fid, properties: props(fid) };
		},
		setPaint: async (paint, filter = lastFilter) => {   // 式は main で一度だけ評価→fid 表（§3 restyle 哲学＝再構築ゼロ）。filter 省略＝現 filter 維持
			lastPaint = paint ?? null; lastFilter = filter ?? null;
			zoomDriven = !!paint && JSON.stringify(paint).includes('["zoom"'); lastEvalZoom = cam.zoom;
			if (!paint) { lastTable = null; renderer.set("gintPaint", null, undefined, id); if (labelOpt?.field) await refreshLabels(); requestDraw(); return; }
			const feats = fidFeaturesOf(pbf);
			if (!feats) { console.warn("[addGint] %s: no features for paint", id); return; }
			const { buildFidStyle } = await import("@ortho-earth/core");
			const { u32, count } = buildFidStyle(paint, feats, { filter: lastFilter, zoom: cam.zoom, states: fstates });
			lastTable = u32;
			renderer.set("gintPaint", { table: u32, count }, undefined, id);
			if (labelOpt?.field) await refreshLabels();   // filter/式の変化にラベルも追随（await＝setFilter/setPaint の解決時に labelCount 確定）
			requestDraw();
		},
		setFeatureState: (fid, st) => {   // 一時状態（hover/選択…）＝['feature-state', key] の実体（maplibre 同名・restyle は §8.1 のとおり安い）
			if (st == null) fstates.delete(fid);
			else fstates.set(fid, { ...fstates.get(fid), ...st });
			if (!h._fsQ) { h._fsQ = true; queueMicrotask(() => { h._fsQ = false; if (lastPaint) h.setPaint(lastPaint, lastFilter); }); }   // 連打（hover毎）を1フレームに束ねる
		},
		removeFeatureState: fid => { if (fid == null) fstates.clear(); else fstates.delete(fid); if (lastPaint) h.setPaint(lastPaint, lastFilter); },
		setFilter: f => {   // ③ 単独動詞（maplibre 同名）＝visibility ビットの再評価（paint 未設定は預かり＝次の setPaint で効く）
			lastFilter = f ?? null;
			if (lastPaint) return h.setPaint(lastPaint, lastFilter);
			console.warn("[addGint] %s: setFilter takes effect after paint is set (filter kept)", id);
			return Promise.resolve();
		},
		setData: (newPbf, o2 = {}) => {   // ④ データ差し替え（handle/イベント/paint は生存＝MapLibre の source setData 相当）
			if (!newPbf?.unPackGint) { console.error("[addGint] setData: invalid source"); return Promise.resolve(false); }
			pbf = newPbf; g = pbf.unPackGint;
			if (opts.fillMaxEdges != null) g.fillMaxEdges = opts.fillMaxEdges;   // 0＝塗らない（輪郭だけ）も通す（旧 truthy 判定は 0 を捨てていた）
			if (opts.lowFill) g.lowFill = true;
			if (o2.minZoom !== undefined) opts.minZoom = o2.minZoom;
			if (o2.maxZoom !== undefined) opts.maxZoom = o2.maxZoom;
			const p = nextAck();
			cancelBake(id);
			bakeAndSend(id, g, { minZoom: opts.minZoom ?? null, maxZoom: opts.maxZoom ?? null, precision: g.precision ?? null }, null, id);
			if (lastPaint) p.then(ok2 => { if (ok2) h.setPaint(lastPaint, lastFilter); });
			refreshLabels();
			return p;
		},
		setOrder: n => { h.order = n; renderer.set("gintOrder", n, undefined, id); requestDraw(); },   // ④ moveLayer 相当（実行時の重ね順）
		setLabel: o => { labelOpt = o ?? null; return refreshLabels(); },   // ② text-field の付け替え（null=消す）。await で labelCount 確定
		style: o => { renderer.set("gintStyle", o, undefined, id); requestDraw(); },   // 描画スタイル（fillColor/lineWidth/styleTable 等＝層の drawStyle）
		setVisible: v => { renderer.set("gintVis", !!v, undefined, id); requestDraw(); },
		activate: () => { layers.active = id; renderer.set("gintActivate", null, undefined, id); },
		remove: () => { cancelBake(id); extGint.delete(id); if (layers.active === id) layers.active = null; if (tipFmt) gintHoverTip?.(null); renderer.set("gintRemove", null, undefined, id); requestDraw(); },
	};
	extGint.set(id, h);
	renderer.set("gintAdd", { order: opts.order ?? null }, undefined, id);   // order＝重ね順（小さいほど下・未指定=追加順）＝トグル順に依らない決定的 z-order
	// bake-ahead（①）＝メタ/tier 梯子を bake worker で焼き切って gintBaked（テクスチャ搭載のみ）＝
	// render worker の同期ベイクで地図フレームを塞がない。worker 不成立/失敗は同期経路へ自動フォールバック
	//（legacyGintSend が layer と meta を運ぶ）。ready はどちらの ack でも解決。
	bakeAndSend(id, g, { minZoom: opts.minZoom ?? null, maxZoom: opts.maxZoom ?? null, precision: g.precision ?? null }, null, id);
	if (opts.style) h.style(opts.style);
	if (labelOpt?.field) refreshLabels();   // ② ラベル（text-field）＝基図注記と同じ衝突/フェード/標高投影
	layers.active = id;   // エンジンは addLayer で自動アクティブ（§4.1）＝main のゲートも同期
	if (opts.interactive === false) { layers.active = null; renderer.set("gintActivate", null, undefined, null); }   // 明示不干渉＝カーソルを既定層へ返す
	requestDraw();
	return h;
}
// 層をまたぐ照会（§4 queryAll）＝手前の層から（追加の逆順）。fid は層内添字＝**必ず {layer, fid} の対で返す**（§10.2）。
// 追加層の後ろに既定スロットのユーザー層（layer:null＝v1 橋渡し）も足す＝census 型の併用期に片方が消えない。
function queryAllGint(ll) {
	const hits = [];
	const front = [...extGint.values()].sort((a, b) => ((b.order ?? b._seq) - (a.order ?? a._seq)) || (b._seq - a._seq));   // 手前（上）の層から＝order 降順・同値は追加の逆順
	for (const h of front) {
		const f = h.query(ll);
		if (f) hits.push({ layer: h, fid: f.fid, feature: f });
	}
	const ufid = userGint?.pbf?.identifyAt?.(ll[0], ll[1]);
	if (ufid != null) hits.push({ layer: null, fid: ufid, feature: { fid: ufid, properties: userGint.pbf.getFeature(ufid)?.properties ?? null } });
	return hits;
}
// 世界海岸線（Natural Earth 10m）を球へ。uploader で事前変換済みの GeoPBF を bucket 名慣習
// （GIS/pbf/ne_10m_coastline）から load＝初回も zip レンジ取得→shp デコードを払わない（gunzip 直読み→GintBUF 焼き→IDB）。
// 2回目以降は IDB 直行＝ネットワークを待たない（ETag 確認は裏で回し新版は次回反映＝激遅会場回線でも即表示）。
// bucket に無い間だけ従来の生 zip 経路（api proxy→shp デコード）へフォールバック。
// coastline は native な線＝lineStream（styleId=1＝既定 #00B4D8）。fillColor 既定透明＝縁だけ＝「線だけ」。
// maxZoom:7 で z≤7 に点火＝低ズームの世界図専用。
// VW ランクは GintBUF に焼込済＝10m を間引かず全密度で描く（弦が短く球面に吸い付く＝110m の崩壊が起きない）。
// admin0（NE admin_0_countries）＝ズームアウトで自動ロード＝__admin0() を叩かず「最初から描画」。
// ※旧名 coast＝ne_coastline（線）時代の遺物。実体は 2026-08-30 から国ポリゴン＝海岸線+国境線（共有arcの位相で
//   海岸線は境界メタに、国境は共有arcとして同居）。名前も admin0 へ改めた（本人裁定 2026-09-09）。
// 【従来経路（GL2）のみ】gint 単一スロットの調停：ユーザー層と admin0 を z=USER_GINT_MINZ で相互切替。
// スロットは単一＝同時表示不可なので「今どちらが載っているか(gintSlot)」を持ち、変更時だけ post。
// ※小域ユーザー層は checkZoomRange が bbox から minZoom を自動採用＝実表示はさらに絞られる（例:筆データ z≥10）。
// ── coast/user 二層化（2026-09-09・本人裁定「coast は紛らわしいので admin 層に」）──────────
// admin0（NE admin_0_countries＝海岸線+国境線）は**独立層**（map.addGint・order 最下・minZoom/maxZoom は
// 層の属性＝エンジンが裁く）＝単一スロットは user 専用＝スロット舞踏は消滅。両バックエンド対応
//（gl/gint 脱シングルトン済み）。従来スロット調停（?a0slot=1 配下）は 2026-09-09 に退場（git 履歴が正）。
let admin0Layer = null;   // 独立層ハンドル
let admin0Vis = true;     // 独立層の表示台帳（変更時だけ post＝毎フレーム送らない）
const USER_GINT_MINZ = 7;
const WORLD_BAND_Z = env.worldBandZ ?? 6.5;   // 世界帯の上限＝湖・海面下の陸が見える範囲（app.js BASEMAP_MINZOOM と同値＝地域の申告が無い器は上限まで）
const ADMIN0_Z = 9;         // 世界海岸線の表示・ロード上限＝これ未満で出す（maxZoom9 と対）
const WORLD_ADMIN0_MINZ = 2.5;   // world 時の coast 下限＝これ未満は線なしの純粋な地球（本人裁定 2026-09-01）
const WORLD_TIP_MAXZ = 5.5;     // 国名ホバー tip の上限＝これ以上は出さない・跨いだら消す（本人裁定 2026-09-02「z>5.5で消して」＝基図接近帯は注記の領分）
let worldTipOn = false;         // 国名 tip 表示中ラッチ＝ズームだけで跨いだ時（ホバーイベントが来ない）に消すため
let admin0Gint = null;      // 世界の国ポリゴン(admin_0_countries)の gint ペイロード（初回ロードでキャッシュ＝再取得しない）
let admin0Pbf = null;       // 同・GeoPBF 原本（properties 参照＝国名 identify 用に生存）
let userGint = null;       // ユーザー層 { g, label }（14条/ドロップ）
let gintSlot = null;       // 現在スロットの占有者 "admin0" | "user"（null=未確定＝次の update で必ず post）
let admin0Loading = false;
// 飛行中の海岸線抑制：両端が coast 表示条件外（z≥ADMIN0_Z）なら、van Wijk の弧が中間で低ズームへ潜っても
// 世界海岸線を出さない＝通過するだけの一瞬のために重い海岸線を描いて動的解像度を落とすのを防ぐ。
// より重要なのはメモリ：長距離フライトは弧が大きく潜り loadAdmin0（NE10m を fetch→GintBUF→GPU、
// しかも永久キャッシュ）を誘発する＝両端が高ズームの飛行では丸ごと払わせない。着地で解除→再評価。
let suppressAdmin0 = false;
// スロット搭載の送信済み台帳：データ本体は「スロットにつき1回」だけ worker へ送り（クローン数十MB級）、
// 以後の交替は "gintSlot" の軽量コマンド＝worker 側のベイク済み束（テクスチャ/LOD梯子/台帳）を差し替えるだけ。
// 旧・毎交替 set() は z7 跨ぎのたびフルベイク＋梯子リセット＝「LOD/カリング不在の窓」（nps_all 実測で
// 定常の42倍＝451万辺/フレーム）に落ちていた。内容差し替え時は sent を折って再送させる。

// --- gint bake worker（bake-ahead）---------------------------------------------------------
// メタ/tier梯子の全ベイクを専用 worker で焼き、完成品を transfer で render worker へ中継する。
// render worker は uploadBaked（テクスチャ搭載のみ）＝ロード時の同期ベイク（nps_all 級で数百ms、
// タブレットは秒級）が地図フレームを塞がない。ベイク中は現表示（海岸線）を描いたまま＝焼き上がりで点火。
// worker 不成立/ベイク失敗は従来の同期経路（renderer.set("gint", raw, key)）へフォールバック。
let bakeWorker = null, bakeSeq = 0;
const bakePending = new Map();   // id → { key, raw, meta, onDone, cancelled }
const legacyGintSend = p => { renderer.set("gint", (p.layer != null || Object.keys(p.meta ?? {}).length) ? { ...p.raw, ...p.meta } : p.raw, p.key, p.layer); p.onDone?.(); };   // 層指名 or meta あり（user の minZoom）＝meta を同期経路にも運ぶ
function ensureBakeWorker() {
	if (bakeWorker !== null) return bakeWorker;
	try { bakeWorker = new Worker(new URL("../worker.js", import.meta.url), { type: "module", name: "gintbake" }); }
	catch (e) { console.warn("[gint] bake worker start failed = using sync path", e); return (bakeWorker = false); }
	bakeWorker.onmessage = e => {
		const d = e.data, p = bakePending.get(d.id);
		if (!p) return;
		bakePending.delete(d.id);
		if (p.cancelled) return;   // 焼いている間に層が差し替え/撤去された＝結果を捨てる
		if (d.kind === "error") { console.warn("[gint] bake failed = using sync path:", d.message); legacyGintSend(p); return; }
		if (d.kind !== "done") return;
		// 完成品をゼロコピー中継（TypedArray の underlying buffer を transfer。共有 buffer は Set で重複除去）
		const bufs = new Set();
		const collect = o => { for (const v of Object.values(o ?? {})) if (ArrayBuffer.isView(v)) bufs.add(v.buffer); };
		collect(d.gint); collect(d.artifacts?.base); collect(d.artifacts?.boundary);
		if (d.artifacts?.pivot?.px) bufs.add(d.artifacts.pivot.px.buffer);
		for (const t of d.tiers ?? []) if (t.metaU32) bufs.add(t.metaU32.buffer);
		wPost({ type: "set", cmd: "gintBaked", prop: p.key, ...(p.layer != null ? { layer: p.layer } : {}),
			data: { gint: d.gint, artifacts: d.artifacts, tiers: d.tiers, ...p.meta } }, [...bufs]);
		p.onDone?.();
	};
	bakeWorker.onerror = err => {   // worker 自体が死んだ＝保留全件を同期経路で救済し、以後は使わない
		console.warn("[gint] bake worker error = sync path from now on", err?.message ?? err);
		for (const p of bakePending.values()) if (!p.cancelled) legacyGintSend(p);
		bakePending.clear();
		bakeWorker.terminate(); bakeWorker = false;
	};
	return bakeWorker;
}
const cancelBake = key => { for (const p of bakePending.values()) if (p.key === key) p.cancelled = true; };
// raw（unPackGint 一式）を焼いて key スロットへ搭載。onDone は「render worker に届いた」後の再調停用。
// clone は bake worker への1回だけ（main の原本は identify の properties 参照用に生存）。
function bakeAndSend(key, raw, meta, onDone, layer = null) {
	const w = ensureBakeWorker();
	const p = { key, raw, meta, onDone, cancelled: false, layer };
	if (!w) return legacyGintSend(p);
	const id = ++bakeSeq;
	bakePending.set(id, p);
	w.postMessage({ id, data: {
		arcBuffer: raw.arcBuffer, arcMeta: raw.arcMeta, polyStream: raw.polyStream, lineStream: raw.lineStream,
		pointBuffer: raw.pointBuffer, point: raw.point, polyCompBbox: raw.polyCompBbox, fillMaxEdges: raw.fillMaxEdges, lowFill: raw.lowFill } });
}
// 海岸線のベイク発火（初回ロード後と、LOW_MEM で束を破棄した後の再入の両方から）。
// ユーザー層のベイク発火（applyGintData の初回と、LOW_MEM で束を破棄した後の再入の両方から）。
// 進行フラグは userGint オブジェクト自身に持つ＝層差し替え（新オブジェクト）で自然にリセット。
function bakeUser() {
	if (!userGint || userGint.sent || userGint.baking) return;
	userGint.baking = true;
	const g = userGint.g;
	bakeAndSend("user", g, userGint.bakeMeta ?? {}, () => {
		if (userGint?.g !== g) return;   // 焼いている間に別の層へ差し替わった＝結果は捨てられている（cancelBake）
		userGint.baking = false; userGint.sent = true;
		gintSlot = null; updateGintSlot(); requestDraw();
		userGint.onReady?.();   // 焼き着地の通知（geoedit 大規模編集コミット＝隠し解除の合図）
		// 預かり paint の着色はここでやらない＝applyUserSlot（user 束が実際に活性になる瞬間）で flush。
		// ここで送ると z<USER_GINT_MINZ（ドリル飛行中の点灯等）は海岸線束が活性のまま＝paint が海岸線束へ
		// 迷子になり、z 跨ぎで user 束に載った時は無着色＝既定オレンジ（maff 筆の緑が出ない実測 2026-08-18）。
	});
}
// gint paint（fidスタイル表）の送達＝スロット事情の吸収。paint はエンジン側で「アクティブ束」に
// 着地するため、user 層のベイク完了前（海岸線表示中）に送ると海岸線束へ迷子になり、点火後も無着色に
// なる（AI層が paint をロード直後に適用するケース）。未 sent の間は預かり、bakeUser の onDone
//（gintSlot 適用後＝user がアクティブ）で着色する。null（解除）も同じ経路＝順序が保たれる。
function sendGintPaint(p) {
	gintPaintLast = p;   // standupGint（地形ドレープ）が fid 色でバッチを組むための最新表（null=解除も記録）
	// 未ベイクに加え「user スロットが非活性（海岸線表示中＝z<USER_GINT_MINZ 等）」も預かる＝
	// アクティブ束が user でない間に送ると海岸線束へ着地して失われる（applyUserSlot が flush）。
	if (userGint && (!userGint.sent || gintSlot !== "user")) { userGint.pendingPaint = p; return; }
	renderer.set("gintPaint", p);
}
let gintPaintLast = null;   // 最後に要求された fid→RGBA 表（層差し替えで features 数が合わなくなれば standupGint 側が無視）
// admin0 の描画スタイル（テーマ台帳 coastLine を読む＝キー名は配色データ互換で coastLine のまま）。
// moveBudget=Infinity＋outlineZoom=0＝移動中もズーム帯でも常に正表現（本人裁定 2026-09-01「リソースは余裕・
// gintの見せ場」）。既定のままだと admin0（国境込み）は①移動中の描画予算 ②outlineZoom ヒステリシスの
// 2つの柵で境界メタへ縮退し、共有arc＝国境そのものが（ドラッグ中だけ）消えて見えた。admin0 は tier 梯子が
// 効く長arc層＝移動中の実コストは軽い。
// 旧 noDepth:true（地形深度に参加しない＝常に最前面）は「チルト中は内陸の長arcが端点標高しか見ず地形に潜り、
// ドラッグで国境だけ消えた」対策の暫定だった。2026-09-21 エンジン側で根治（gint 線 VS の地形適応細分＝長辺を
// 地形メッシュ1セル刻みのサブ区間に割って面へ乗せる）＝国境も海岸線と同じく地形に沿い、尾根の向こうは隠線。
function admin0DrawStyle() {
	const t = new Float32Array(256 * 4);
	t.set(env.theme.coastLine);        // style0 = ポリゴン辺（admin0 の海岸線+国境線）
	t.set(env.theme.coastLine, 4);     // style1 = 折れ線（admin0 では未使用）
	return { styleTable: t, lineWidth: 0.75, moveBudget: Infinity, outlineZoom: 0 };
}
// admin0 独立層の生成（WebGPU 経路）。ペイロードは fillOff 強制済みの admin0Gint（国ポリゴンはアウトライン専用）
// ＝addGint へはダック（unPackGint=admin0Gint・識別面は原本 admin0Pbf）で渡す。interactive:false＝
// カーソルは触らない（国名 tip は main 同期 identify のまま）。order:-10＝常に最下（user 層や多層の下）。
// 層へ渡すダック（unPackGint＝fillOff 強制済みペイロード・識別面は原本 admin0Pbf を都度引く＝解像度の差し替えに追随）
const admin0Duck = () => ({ unPackGint: admin0Gint, fmap: admin0Pbf.fmap,
	getProperties: i => admin0Pbf.getProperties(i), getFeature: f => admin0Pbf.getFeature(f),
	identifyAt: (...a) => admin0Pbf.identifyAt(...a) });
function ensureAdmin0Layer() {
	if (admin0Layer || !admin0Gint || !admin0Pbf) return;
	admin0Layer = addGint(admin0Duck(),
	{ order: -10, interactive: false, minZoom: WORLD_VT ? WORLD_ADMIN0_MINZ : null, maxZoom: 9, style: admin0DrawStyle() });
	admin0Vis = true;
}
function syncAdmin0Vis() {   // 飛行中抑制（suppressAdmin0）だけが層の表示を折る（ズーム域はエンジンが裁く）
	if (!admin0Layer) return;
	const v = !suppressAdmin0;
	if (v !== admin0Vis) { admin0Vis = v; admin0Layer.setVisible(v); }
}
function applyUserSlot() {
	if (!userGint) return;
	if (!userGint.sent) { bakeUser(); return; }   // 未ベイク（初回/LOW_MEM退避後）＝焼き上がりの onDone が再調停する（それまで海岸線のまま）
	renderer.set("gintSlot", "user");
	gintDrawOpts = userGint.style;           // 層の持参スタイル（AI層=styleTable、null=既定＝14条筆のオレンジ/シアン。海岸線グレーは引きずらない）
	gintInteractive = userGint.interactive;  // 筆/図形/AI層はホバー/クリックで突合
	gintHover = userGint.hover !== false;    // 災害面は hover:false＝ホバー処理オフ（クリックは interactive で生存）
	if (!gintHover) gintHoverTip?.(null);    // 前層の残り tip を消す
	if (userGint.pendingPaint !== undefined) {   // ベイク中/海岸線スロット中に預かった paint を、user 束が活性のこの瞬間に着色（迷子の根治）
		renderer.set("gintPaint", userGint.pendingPaint);
		delete userGint.pendingPaint;
	}
	sendGintStyle(); gintSlot = "user"; requestDraw();
}
// gint ユーザー層（14条筆/ドロップ）を丸ごと撤去＝clearGint(dropFile) の一本化。
// 本体・地形沿い境界線(gintBld)・識別(gintInteractive)/tip を落とし、スロットを再調停（該当ズームなら海岸線へ戻す）。
function clearUserGint() {
	userGint = null; gintSlot = null;
	cancelBake("user");                   // 焼き途中の結果は捨てる（届いても中継しない）
	renderer.set("gint", null, "user");   // user 束を GPU 資産ごと破棄（次フレームの地図再描画が残像ごと消す）
	renderer.set("gintBld", null); drapedOn = false;   // 地形沿い境界線も一蓮托生
	gintInteractive = false;
	gintHoverTip?.(null);            // ホバー tip を消す
	requestDraw();
	updateGintSlot();                // スロット空化の掃除（admin0 は独立層＝触らない）
}
// ズームでスロットの中身を選ぶ。onMove から毎回呼ばれるが post は変更時だけ＝安い。海岸線は初回のみ遅延取得。
function updateGintSlot() {
	// 海面下の陸地・湖＝見える帯（世界帯 z<6.5＝whK 連動・app の BASEMAP_MINZOOM と同値）に入った時に一度だけ取得（wdepr/lakes＝gint と独立・自己ガード）。
	// 旧＝z<9 で取得＝列島ビュー（z6.6）の起動で見えない 0.9MB を読んでいた（2026-09-22 本人裁定で見える帯へ）。飛行中は app 側が待たせる（着地で再評価）。
	if (WORLD_VT && cam.zoom < WORLD_BAND_Z) { env.loadBelowSea(); env.loadLakes(); if (!env.flying) loadWorldLines(); }   // 河川・海洋境界線も同じ帯（飛行の通過点では読まない）
	// 国名 tip はズームだけで z5.5 を跨いでも消す（ホバーイベントが来ない＝出しっぱなしになる件の根治 2026-09-02）
	if (worldTipOn && cam.zoom >= WORLD_TIP_MAXZ) { gintHoverTip?.(null); worldTipOn = false; }
	if (noGint) return;   // ?nogint=1＝admin0 ロードもスロット適用もしない（gint パスは空データ＝実質ゼロコスト）
	// admin0＝独立層（スロット外）：ロード発火・層生成・飛行抑制の同期。表示のズーム域はエンジンが裁く
	if (cam.zoom < ADMIN0_Z && !admin0Loading && !admin0Gint && !suppressAdmin0) loadAdmin0("50m");
	else if (!LOW_MEM && admin0Res === "50m" && !admin0Loading && !suppressAdmin0 && !env.flying && cam.zoom >= ADMIN0_FINE_Z && cam.zoom < ADMIN0_Z) loadAdmin0("10m");   // 国境が大きく見える帯で細密版へ
	ensureAdmin0Layer();
	syncAdmin0Vis();
	// LOW_MEM＝user 層が非表示帯（z<minZoom）の間は束を眠らせない＝破棄（iOS jetsam 対策・旧 admin0 スロット
	// 活性時の退避の後継）。再入は applyUserSlot→bakeUser の非ブロッキング再ベイク＝焼き上がりで点火。
	if (LOW_MEM && userGint?.sent && cam.zoom < userGint.minZoom) {
		renderer.set("gint", null, "user"); userGint.sent = false;
		if (gintSlot === "user") { renderer.set("gintSlot", null); gintSlot = null; requestDraw(); }   // 台帳もエンジンと同期＝再入時に applyUserSlot が必ず発火（ここを怠ると「一度ズームアウトすると user 層が戻らない」）
	}
	// 単一スロット＝user 専用。LOW_MEM は表示帯（z≥minZoom）でだけ適用＝スリープと対（範囲外で適用すると
	// applyUserSlot→bakeUser が焼き直し、直後のスリープが落とす「焼いては捨てる」空回りになる）
	if (userGint && (!LOW_MEM || cam.zoom >= userGint.minZoom)) { if (gintSlot !== "user") applyUserSlot(); }
	else if (!userGint && gintSlot != null) { renderer.set("gintSlot", null); gintSlot = null; requestDraw(); }   // user 撤去後の掃除
}
// 世界の国ポリゴン（Natural Earth admin_0_countries）を取得しキャッシュ（表示可否は updateGintSlot が決める）。
// 旧・海岸線(ne_coastline 線)から置換（本人裁定 2026-08-30「admin0_countriesの方が国の認識ができる」）：
// 国ポリゴンの辺＝海岸線＋国境線が1データで出る（隣国の共有arcは gint 境界メタが一本化）うえ、
// 「国」という実体を gint が持つ＝国名 identify・国別 fid 彩色への口が開く（MVT=描画/Gint=知性の分担）。
// 解像度の二段（2026-09-22 本人裁定）：最初は 50m 版（列島ビューの起動＝z6.6 で外国の海岸線・国境を描くのに足りる・約 0.5MB）、
// z7〜9 の帯（国境が大きく見える）に寄った時に 10m 版（2.6MB）を読み、同じ層へ setData で差し替える（手綱・イベント・識別は生存・
// 新しい焼き上がりまで旧い線が残る＝消えない）。旧＝起動で 10m を読んでいた。LOW_MEM（モバイル）は従来どおり 50m だけ。
const ADMIN0_FINE_Z = 7;
let admin0Res = null;   // 搭載中の解像度 "50m" | "10m"
// 走っている読み込みを外から待てるようにする（旧＝読み込み中は素通りで return＝起動直後に呼ぶ口が空を掴んだ・
// world の地図ボタン 2026-09-23）。自動の梯子（updateGintSlot）は従来どおり戻りを無視して呼ぶだけ。
let admin0Job = null;
const loadAdmin0 = (res = "50m") => admin0Job || (res === admin0Res ? Promise.resolve()
	: (admin0Job = loadAdmin0Now(res).finally(() => { admin0Job = null; })));
async function loadAdmin0Now(res = "50m") {
	if (admin0Loading || res === admin0Res) return; admin0Loading = true;
	// bucket 未収録の間は zip フォールバック（S3→shpデコード）だが geopbf が URL キーで IDB キャッシュする＝初回のみ。
	const NAME = `ne_${res}_admin_0_countries`;
	console.log(`[admin0] loading Natural Earth ${res} admin_0_countries (bucket GeoPBF -> GintBUF)…`);
	let pbf = await geopbf(NAME).catch(e => { console.warn("[admin0] bucket load failed", e); return null; });
	if (!pbf?.unPackGint) {
		console.warn("[admin0] no geopbf in bucket -> falling back to raw zip (S3 -> shp decode)");
		pbf = await geopbf(`https://naturalearth.s3.amazonaws.com/${res}_cultural/${NAME}.zip`, { name: NAME }).catch(e => { console.error("[admin0] geopbf", e); return null; });
	}
	const g = pbf?.unPackGint;
	admin0Loading = false;
	if (!g) { console.error("[admin0] GintBUF decode failed", pbf); return; }
	admin0Pbf = pbf;   // 原本を identify 用に生存（国名 NAME_JA ホバー/クリック）＝層のダックはこの変数を都度引く
	admin0Res = res;
	admin0Gint = {   // maxZoom:9＝z≤9 で点火＝低ズームの世界図専用（worker が範囲外をカリング）
		arcBuffer: g.arcBuffer, arcMeta: g.arcMeta,
		polyStream: g.polyStream, lineStream: g.lineStream,
		pointBuffer: g.pointBuffer, point: g.point, polyCompBbox: g.polyCompBbox,
		maxZoom: 9,
		fillMaxEdges: 0,   // fillOff 強制＝国ポリゴンはアウトライン専用（低ズームのベタ塗り切替に入れない。塗りはハイプソの領分）
	};
	if (admin0Layer) { admin0Layer.setData(admin0Duck()); console.log(`[admin0] upgraded to ${res}`); return; }
	// 着地＝独立層を生成（addGint が bake-ahead で焼く＝地図は止まらない）
	ensureAdmin0Layer(); syncAdmin0Vis();
	console.log(`[admin0] loaded ${res} as independent layer (z<9 = engine-gated)`);
}
dbgHost.__admin0 = res => loadAdmin0(res);   // 手動リロード用
// ── 世界の線＝河川・海洋境界線（NE 10m）＝世界帯（z<WORLD_BAND_Z）の独立層（本人 2026-09-23「河川・湖・海洋境界線はエンジンの世界層側で持つ」・湖は既に renderer の lakes スロット）──
// 出し方は equal（apps/equal/src/layers.js の rivers/maritime）と同じ物差し：出すズーム＝NE の min_zoom（止まるたびに評価し直す）・
// 河川の太さ＝scalerank の 3 段・湖の中の中心線は描かない。bucket に無ければ NE S3 の生 zip（geopbf が shp を焼く＝初回だけ重い・IDB に残る）。
// LOW_MEM（モバイル）は読まない＝「動く・落ちない」が大前提の器に線を足さない。
let worldLinesState = 0;   // 0=未 1=読込中 2=搭載 3=見送り
const WORLD_LINES = [
	{ name: "ne_10m_rivers_lake_centerlines", dir: "10m_physical", order: -9,
		paint: { "line-color": "#86aecb", "line-width": ["step", ["to-number", ["coalesce", ["get", "scalerank"], ["get", "SCALERANK"], 8]], 1.2, 5, 0.9, 8, 0.6] },
		filter: ["all", ["!", ["in", "Lake Centerline", ["to-string", ["coalesce", ["get", "featurecla"], ["get", "FEATURECLA"], ""]]]],
			["<=", ["to-number", ["coalesce", ["get", "min_zoom"], ["get", "MIN_ZOOM"], 6]], ["zoom"]]] },
	{ name: "ne_10m_admin_0_boundary_lines_maritime_indicator", dir: "10m_cultural", order: -9,
		paint: { "line-color": "rgba(143,169,187,0.85)", "line-width": 0.6 },
		filter: ["<=", ["to-number", ["coalesce", ["get", "min_zoom"], ["get", "MIN_ZOOM"], 4]], ["zoom"]] },
];
async function loadWorldLines() {
	if (worldLinesState || LOW_MEM) { worldLinesState ||= 3; return; }
	worldLinesState = 1;
	for (const def of WORLD_LINES) {
		let pbf = await geopbf(def.name).catch(() => null);
		if (!pbf?.unPackGint) pbf = await geopbf(`https://naturalearth.s3.amazonaws.com/${def.dir}/${def.name}.zip`, { name: def.name }).catch(e => { console.warn("[world-lines]", def.name, e); return null; });
		if (!pbf?.unPackGint) continue;
		const h = addGint(pbf, { order: def.order, interactive: false, minZoom: WORLD_ADMIN0_MINZ, maxZoom: WORLD_BAND_Z, fillMaxEdges: 0 });
		if (!h) continue;
		h.setVisible(false);            // 絞る（min_zoom）まで出さない
		h.style({ fillColor: [0, 0, 0, 0] });
		await h.ready;
		await h.setPaint(def.paint, def.filter);
		h.setVisible(true);
		console.log(`[world-lines] ${def.name}: ${pbf.fmap?.length ?? 0} features (z<${WORLD_BAND_Z})`);
	}
	worldLinesState = 2;
}
dbgHost.__worldLines = () => worldLinesState;   // 検定窓
dbgHost.__a0 = () => ({ layer: !!admin0Layer, vis: admin0Vis, slot: gintSlot });   // 二層化の検定窓（slot は user 専用＝"admin0" は現れない）
dbgHost.__gintFix = "cullv2+skysolar 2026-09-02b";   // ビルド世代の目印（コンソールで __gintFix ＝ undefined なら古いコードが動いている）
// 遅延ロードの門番は updateGintSlot（z<9 で海岸線 未取得なら一度だけ取得）＝高ズーム固定の埋め込みは一生読まない
//（PLATEAUスイッチと同じ思想＝見えない機能のための通信をしない。既定の世界ビュー起動時に updateGintSlot が即発火＝体験は不変）。



return {
	// 動詞
	applyGintData, clearUserGint, addGint, queryAllGint, standupGint, paintGint, sendGintPaint, fitZoomForBbox, gintFidFeatures, updateGintSlot,
	// 世界の国の形を用意して原本を返す（スポットライト／輪郭＝国を指す口が使う・2026-09-23）。既定＝**今載っている解像度**（無ければ 50m）＝
	// 指す口のために 10m を新たに読み込まない（旧＝既定 10m で、他国 hover のたびに 10m へ差し替わり毎フレームの gint が重くなって
	// 動的解像度が降段した・本人指摘 2026-09-23）。細密版へは updateGintSlot の梯子（z≥7）が従来どおり上げる
	ensureAdmin0: async (res = admin0Res || "50m") => { await loadAdmin0(res); return admin0Pbf; }, admin0DrawStyle,
	// 定数
	ADMIN0_Z, WORLD_TIP_MAXZ,
	// 状態のアクセサ（外が読む／書く。移設前の let と同じ意味）
	get interactive() { return gintInteractive; },
	get hover() { return gintHover; },
	get visible() { return gintVisible; }, set visible(v) { gintVisible = v; },
	get drapedOn() { return drapedOn; },
	get hoverTip() { return gintHoverTip; }, set hoverTip(fn) { gintHoverTip = fn; },
	get lastHoverXY() { return lastHoverXY; }, set lastHoverXY(v) { lastHoverXY = v; },
	get estatTipOwn() { return estatTipOwn; }, set estatTipOwn(v) { estatTipOwn = v; },
	get clickHandler() { return gintClickHandler; }, set clickHandler(fn) { gintClickHandler = fn; },
	get worldTipOn() { return worldTipOn; }, set worldTipOn(v) { worldTipOn = v; },
	get suppressAdmin0() { return suppressAdmin0; }, set suppressAdmin0(v) { suppressAdmin0 = v; },
	get userGint() { return userGint; },
	get admin0Layer() { return admin0Layer; },
	get admin0Vis() { return admin0Vis; },
	get admin0Pbf() { return admin0Pbf; },
};
}
