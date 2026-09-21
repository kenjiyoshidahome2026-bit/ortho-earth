// ── POI台帳（施設の点・z14+）＝uploader で焼いた poi/14/x/y を「寄った時だけ」読み、rank で解禁（docs/poi-ledger.md §11）。
// landmark 名札と同じ経路に相乗り：施設チップの傘（9xxx 合成コード＝isFacility 真）・現テーマ色・案A で同名 dedup。
// アイコン化は後段＝まず名札で「見える」を取る。線/面/地名/交通は optbv のまま（施設の点だけ自前台帳）。
// app.js から動作を変えずに移設（2026-09-22）。app に残るのは配線＝読み込みの号令・ラベルへの注入・編集ガジェットの口。
import { geopbf } from "geopbf";
import { lonLatToTile } from "@ortho-earth/core";

export const POI_CODE = 9102;                                  // landmark(9101) の隣。9xxx 帯は空き＝施設チップ傘下に自動で入る
const POI_SRC_ANNO = 1;                                        // 出典の pos-src=注記＝権威位置（基図を上書きしてよい）＝schema.SRC.ANNO
const poiZAppear = rank => 14 + (255 - rank) * 3 / 255;        // rank 大＝早く出る（255→z14 / 中位→z15 / 小→z17）＝§11.5 の解禁段

// 自前fetch：404を例外でなく「空(null)」として静かに返す（geopbf(name) は PBFIO が404を毎回コンソールに吐く＝
// 空タイルの海で洪水になる）。bucketは生gzipで返す（Content-Encoding無し）＝自前gunzip。返り＝Uint8Array／null。
async function poiFetch(url) {
	const r = await fetch(url);
	if (!r.ok) return null;
	let buf = new Uint8Array(await r.arrayBuffer());
	if (buf[0] === 0x1f && buf[1] === 0x8b) buf = new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
	return buf;
}

// ── §12 手差分（サーバー正本 poi/overrides.json）＝ベクターファイル(タイル)と分離した bucket 管理（本人裁定2026-08-10）。
// 表示は実行時パッチ＝タイル在庫の上へ即座に被せる（焼き直し待ちにしない・編集ガジェットの setOvr でも即反映）。
// 意味論の正典＝uploader/src/poi/schema.js applyOverrides（match=名前完全一致∧300m最近傍・id昇順fold・
// moveは pos-src を手管理へ）。ここはその実行時版（表示形 {anchor,n,r,s}）＝tests/t-poioverrides.mjs が同値を機械検証。
const POI_SRC_MANUAL = 3;                                      // 出典 pos-src=手管理（編集）＝権威位置（schema.SRC.MANUAL）
export const poiOvrDist = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(b[1] * Math.PI / 180), (a[1] - b[1]) * 111320);
export function applyPoiOvr(list, ovrRecs, tileLoaded) {
	const out = list.map(p => ({ ...p }));   // コピー＝poiTiles のキャッシュを壊さない
	for (const o of [...(ovrRecs || [])].sort((a, b) => a.id - b.id)) {
		if (o.op === "add") {   // 追加＝手管理の権威点。読み込んでいる z14 タイル圏だけ出す（全国の add を毎回積まない）
			if (!tileLoaded || tileLoaded(o.ll)) out.push({ anchor: o.ll, n: o.n, r: o.r ?? 120, s: (POI_SRC_MANUAL << 4) | POI_SRC_MANUAL });
			continue;
		}
		let bi = -1, bd = 300;
		for (let i = 0; i < out.length; i++) {
			if (out[i].n !== o.n) continue;
			const d = poiOvrDist(out[i].anchor, o.ll);
			if (d < bd) { bd = d; bi = i; }
		}
		if (bi < 0) continue;   // 対象なし（焼き込み済/未ロード地域）＝no-op＝冪等
		if (o.op === "del") out.splice(bi, 1);
		else if (o.op === "move") { out[bi].anchor = o.to; out[bi].s = (POI_SRC_MANUAL << 4) | (out[bi].s & 0x0F); }
		else if (o.op === "rename") out[bi].n = o.to;
	}
	return out;
}

// decl＝地域宣言の poi { api, base, overrides }（packages/jp/src/region.js）・env＝{ viewBbox(cam) → [w,s,e,n], requestDraw() }。戻り＝{ load(cam), injectLabels(allLabels, ctx), patchedAll(), ver, … }。
export function createPoiLedger({ api: POI_API, base: POI_BASE, overrides: POI_OVR_NAME }, { viewBbox, requestDraw }) {
	const poiTiles = new Map();                                    // "x/y" → 地物配列 ／ "loading" ／ []（POI 無しタイル）
	const POI_BUST = Date.now();                                   // セッション毎の一意値＝マニフェストのHTTPキャッシュ回避／未整備時のフォールバック版
	let poiVer = 0;                                                // タイル到着ごとに ++＝labelGate が拾ってラベルのみ再構築（merge なし）
	let poiManifest = null, poiManReq = null, poiManState = "none";   // マニフェスト {v,tiles:Set,baked:Set}＋状態(none/loading/loaded/absent)。解決前はタイル要求しない（race404防止）
	const poiLog = /[?&]poilog=1/.test(location.search);           // ?poilog=1＝POI層の診断（在庫/表示/rank待ち/基図重複/上書き）
	const poiAll = /[?&]poiall=1/.test(location.search);           // ?poiall=1＝rank解禁と dedup を無効化＝全POIを z14+ で出す（評価用）
	const bump = () => { poiVer++; requestDraw(); };

	// タイル在庫マニフェストを一度だけ取得。無ければ（未焼き/旧焼き）フォールバック＝bbox全スキャン（自前fetchなので404は静か）。
	function loadPoiManifest() {
		if (poiManReq) return poiManReq;
		poiManState = "loading";
		return poiManReq = poiFetch(`${POI_BASE}poi/14/index.json?_=${POI_BUST}`).then(buf => {
			if (buf) { const j = JSON.parse(new TextDecoder().decode(buf)); if (j?.tiles) { poiManifest = { v: j.v, tiles: new Set(j.tiles), baked: new Set(j.baked || []) }; poiManState = "loaded"; if (poiLog) console.log(`[poi] manifest ${j.tiles.length} tiles v${j.v}, baked-in overrides ${poiManifest.baked.size}`); } }
			if (poiManState !== "loaded") poiManState = "absent";   // 無し/壊れ＝フォールバック（bboxスキャン）
			bump();                                                // 解決＝loadPOI を回して在庫ゲート/スキャン開始
		}).catch(() => { poiManState = "absent"; bump(); });
	}
	let poiOvr = null, poiOvrReq = null;   // {v,seq,recs}＝サーバー手差分（編集ガジェットが setOvr で差し替え）
	function loadPoiOverrides() {
		if (poiOvrReq) return poiOvrReq;
		return poiOvrReq = poiFetch(`${POI_BASE}${POI_OVR_NAME}?_=${POI_BUST}`).then(buf => {   // 未作成(404)＝null＝静かに
			if (!buf) return;
			poiOvr = JSON.parse(new TextDecoder().decode(buf));
			if (poiOvr?.recs?.length) { bump(); if (poiLog) console.log(`[poi] overrides ${poiOvr.recs.length} recs v${poiOvr.v}`); }
		}).catch(() => {});
	}
	// ロード済み全タイルの地物＋手差分パッチ＝表示とガジェット（対象選択）の共通フィード。
	// 焼き込み済みレコード（manifest.baked）は適用しない＝del/move が同名近傍の別施設を最近傍matchで
	// 誤爆する「再発火」を封じる（schema.js の⚠・t-poioverrides.mjs が検証）。タイルとbakedは同じ
	// マニフェスト便で届く（タイルURLは ?v=版）＝新旧が食い違わない。
	function poiPatchedAll() {
		const feats = [];
		for (const fs of poiTiles.values()) if (Array.isArray(fs)) feats.push(...fs);
		if (!poiOvr?.recs?.length) return feats;
		const recs = poiManifest?.baked?.size ? poiOvr.recs.filter(r => !poiManifest.baked.has(r.id)) : poiOvr.recs;
		if (!recs.length) return feats;
		return applyPoiOvr(feats, recs, ll => poiTiles.has(lonLatToTile(ll[0], ll[1], 14).join("/")));
	}
	function loadPOI(cam) {
		loadPoiManifest();
		loadPoiOverrides();
		if (poiManState === "loading") return;                    // マニフェスト解決待ち＝未存在タイルへの空振り404を防ぐ（race根治）
		const [w, s, e, n] = viewBbox(cam);
		const [x0, y0] = lonLatToTile(w, n, 14), [x1, y1] = lonLatToTile(e, s, 14);   // 北西→(minx,miny) 南東→(maxx,maxy)
		const ver = poiManifest ? poiManifest.v : POI_BUST;       // 版でキャッシュ制御（再焼きで自動失効）／フォールバックはセッション値
		for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
			for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
				const key = x + "/" + y;
				if (poiTiles.has(key)) continue;                  // 既取得（空タイル [] 含む）＝二度と要求しない
				if (poiManifest && !poiManifest.tiles.has(key)) { poiTiles.set(key, []); continue; }   // 在庫外＝要求しない
				poiTiles.set(key, "loading");
				poiFetch(`${POI_BASE}poi/14/${key}?v=${ver}`).then(async buf => {
					if (!buf) { poiTiles.set(key, []); return; }   // 404＝空＝静かに（コンソールを汚さない）
					const pbf = await geopbf(buf, { gint: false });   // バッファ直デコード（名前解決/fetch/IDBを通さない）
					const feats = pbf?.geojson?.features || [];
					poiTiles.set(key, feats.map(f => ({ anchor: f.geometry.coordinates, n: f.properties.n, r: f.properties.r, s: f.properties.s ?? 0 })));
					if (feats.length) { bump(); if (poiLog) console.log(`[poi] tile ${key} loaded ${feats.length} features`); }
				}).catch(() => poiTiles.set(key, []));
			}
	}
	// ラベル注入（施設チップON・z14+ で呼ばれる）：焼いた点を rank で解禁。同名は既存注記＋landmark に譲る（§11.2 案A＝d2 の実行時版）。
	// sort=4−rank/255＝rank 大ほど衝突に強い（§11.5 の二役）。ctx＝{ zoom, ink:{color,halo,haloW}, landmarkCode }。
	function injectLabels(allLabels, { zoom, ink, landmarkCode }) {
		if (!poiTiles.size) return;
		const { color, halo, haloW } = ink;
		// §12 実行時パッチ：サーバー手差分をタイル在庫の上へ被せてから注入（add/move/rename/del・冪等）
		const patched = poiPatchedAll();
		// 権威位置（注記由来 s>>4=ANNO＝寺社など・手管理 MANUAL＝編集で人が置いた点）のPOI名を集め、
		// 基図の同名注記を先に消す＝POIが基図を上書き（§1 の三十三間堂 274mズレの解決＝基図の間違った位置を
		// 台帳の正しい位置で置換）。landmark/POI自身は消さない。学校(KSJ位置)は非権威＝基図に譲る（基図もほぼ正確・§2）。
		const poiAuth = s => { const p = s >> 4; return p === POI_SRC_ANNO || p === POI_SRC_MANUAL; };
		const authNames = new Set();
		for (const p of patched) if (poiAuth(p.s) && (poiAll || zoom >= poiZAppear(p.r))) authNames.add(p.n);
		if (authNames.size) for (let i = allLabels.length - 1; i >= 0; i--) {
			const c = allLabels[i].code;
			if (c !== POI_CODE && c !== landmarkCode && authNames.has(allLabels[i].text)) allLabels.splice(i, 1);
		}
		const have = new Set(allLabels.map(L => L.text));   // タイル注記(上書き済)＋landmark に既出の名前は出さない（案A）
		let nAvail = 0, nShown = 0, nGated = 0, nDedup = 0;
		for (const p of patched) {
			nAvail++;
			if (!poiAll && zoom < poiZAppear(p.r)) { nGated++; continue; }   // rank解禁（?poiall=1で無効）
			const auth = poiAuth(p.s);                  // 権威＝基図を消した側＝必ず出す。非権威は基図/landmarkに譲る
			if (!poiAll && !auth && have.has(p.n)) { nDedup++; continue; }        // 案A dedup（?poiall=1で無効）
			allLabels.push({ text: p.n, code: POI_CODE, anchor: p.anchor, size: 13, sort: 4 - p.r / 255, color, halo, haloW });
			have.add(p.n); nShown++;   // 別タイルの同名（同じ名の学校）も1つに
		}
		if (poiLog) console.log(`[poi] z${zoom.toFixed(1)} -> shown ${nShown} / stock ${nAvail} (rank-gated ${nGated}, basemap-dup ${nDedup}, overriding ${authNames.size}, manual ${poiOvr?.recs?.length ?? 0})${poiAll ? " [poiall]" : ""}`);
	}
	return {
		load: loadPOI, injectLabels, patchedAll: poiPatchedAll,
		get ver() { return poiVer; },
		// 編集ガジェット（gadgets/poiedit.js・§12）への口：手差分の読み書きと器の在り処
		getOvr: () => poiOvr,
		setOvr: o => { poiOvr = o; bump(); },
		distM: poiOvrDist, apiBase: POI_API, ovrName: POI_OVR_NAME,
	};
}
