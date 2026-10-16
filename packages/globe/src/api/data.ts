// データを載せる口＝シーン台本の再生・URL の data と公開のフィーチャーサービス（#176）・列チャンク層（map.addColumnar）・three.js（map.addThree）・
// map.addData・セルと集約（map.addCells 等）＝createGlobe から切り出した（globe.js の分割 ⑤・2026-10-15）。中身は切り出す前と同じ。
// createGlobe の他の所が使う物（scenes・readGeoData・remoteUrl・setSrcAttr・列チャンクの判定・source の読み込みと視野追従）は戻り値で返す。
//   live＝createGlobe の変数（let・この呼び出しより後で宣言される定数）を読み書きする口（getter／setter）。その他＝createGlobe の中の定数・関数（中身は createGlobe と共有）
import arcsUrl from "../gadgets/arcs-gl.js?url";
import { createScenePlayer } from "../scenes/player.js";
import { evalExpr } from "@ortho-earth/core";
import { geopbf, geopbfCachePrune, geopbfCached } from "geopbf";
import { gunzipText } from "../gadgets/dropfile.ts";
import { normSplat } from "../splat.js";
import pointsUrl from "../gadgets/points-gl.js?url";
import { sanitizeHTML } from "geopbf/sanitize";
import screengridUrl from "../gadgets/screengrid-draw.js?url";
import { tr } from "../i18n.js";
import tripsUrl from "../gadgets/trips-gl.js?url";
import type { Feature, FeatureCollection } from "geopbf";
import type { FeatureService } from "geopbf/featureservice";
import type { CellCache } from "../featureservice.d.ts";
import type { Bbox, CellsLayerHandle, DataLayerHandle, MapLibreLayer, OverlayHandle } from "../../globe.d.ts";
import type { DataDeps, DataLive, DataReturn, FsFollowEntry, Installing, IntakeCtx } from "../types/install.ts";
import type { DataApi } from "../types/map.ts";
import type { UserSource } from "../types/scope.ts";

/** dev の検証窓のオーバーレイの段（dbgHost.__overlay） */
type OverlayStages = Record<string, { stage?: string; error?: string }>;
/** three のオーバーレイの知らせ（失敗＝{ type:"error", error }） */
type OverlayMsg = { type?: string; error?: string } | null | undefined;

export function installData(map: Installing<DataApi>, live: DataLive, {
	BUILTIN_DATA_KINDS, CAM_ZOOM_MIN, ELL_ON, LOW_MEM, REGION_BLD_LABELS, ac, applyCamView, applyViewLayers, cam, canvas, dbgHost, flightCtl, flyView,
	gint, gpuBackend, hostWorker, meshMgr, meshOn, onMove, opts, overlays, ownDestroy, pluginHost, requestDraw, requester, saveView, setGSrc, switchTheme,
	themeBootV, themeFixed, viewHash
}: DataDeps): DataReturn {
	// ── 共有シーン台本(type:"scenes")の再生 ── 落とした .scenes（または ?scene=URL）を demo プレーヤーで自動上演する（demo/scene-format.md）。
	// demo は起動時に1度マウント済み（index.html）＝その1インスタンスに load() で台本を差し替える（下の demo ラッパが手綱 demoHandle を掴む）。
	// --- シーン再生＝scenes/player.js（上映・停止・タイムライン・黒幕・フェード・待ちパネル）。ここは配線だけ＝app の状態は getter、関数はラップ。
	const scenes = createScenePlayer({ mapEl: live.mapEl, LOW_MEM, gpuBackend, meshOn, meshMgr, flightCtl, CAM_ZOOM_MIN, themeFixed, bldLabels: REGION_BLD_LABELS,
		get themeName() { return live.themeName; }, get elevBusy() { return live.elevBusy; },
		onMove: () => onMove(), flyView: (...args) => flyView(...args), applyCamView: v => applyCamView(v), applyViewLayers: v => applyViewLayers(v), switchTheme: n => switchTheme(n), viewHash: () => viewHash(), saveView: () => saveView() });
	// ?scene=<URL>＝共有シーン台本の URL ロード（ドロップと同じ道＝取得→type 判定→playScene）。相対URL可（同梱サンプル等）。
	// gzip（.scenes.gz や gzip 中身）も可＝中身の印(1f 8b)で判定して解凍（サーバが Content-Encoding で解く場合は素通り）。
	// demo ガジェットは index.html が少し遅れて搭載する＝居るまで小さく待つ（最大10秒・居なければ諦めて警告）。
	// 外部 URL の門（?g= / ?scene= 共用）：gh:user/repo[@ref]/path 短縮形→GitHub raw・https 限定（開発時のみ localhost の http 可）・
	// ".." で別リポジトリへ滑るのを封じる。相対 URL は同一オリジン（同梱サンプル等）。通らなければ null（console.warn 済み）。
	const remoteUrl = (spec: string, tag: string) => {
		const gh = /^gh:([\w.-]+)\/([\w.-]+)(?:@([\w.-]+))?\/(.+)$/.exec(spec);   // ref に / は不可（path との曖昧を避ける）
		if (gh && [gh[1], gh[2], gh[3] || "", ...gh[4].split("/")].some(x => x === "." || x === "..")) { console.warn(`[${tag}] bad gh: path`, spec); return null; }
		let u;
		try { u = new URL(gh ? `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3] || "HEAD"}/${gh[4]}` : spec, location.href); }
		catch { console.warn(`[${tag}] bad URL`, spec); return null; }
		const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
		if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal)) { console.warn(`[${tag}] https only`, u.href); return null; }
		return u;
	};
	{
		const sceneSpec = new URLSearchParams(location.search).get("scene");
		const sceneUrl = sceneSpec ? remoteUrl(sceneSpec, "scene") : null;   // ?g= と同じ門（https 限定・gh: 短縮形・credentials 無し）
		if (sceneUrl) fetch(sceneUrl, { credentials: "omit" }).then(async r => {
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const buf = new Uint8Array(await r.arrayBuffer());
			if (buf.byteLength > 8e6) throw new Error("too large");   // 台本は JSON＝8MB で十分（敵入力の巨大確保よけ）
			return JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b) ? await gunzipText(buf) : new TextDecoder().decode(buf));
		}).then(obj => {
			if (obj?.type !== "scenes") { console.warn(`[scene] type is not "scenes" = not playing`, sceneUrl); return; }
			const arm = (tries: number): unknown => scenes.demoHandle ? scenes.playScene(obj) : (tries < 100 ? setTimeout(() => arm(tries + 1), 100) : console.warn("[scene] demo never mounted = gave up on ?scene="));
			arm(0);
		}).catch(err => console.warn("[scene] failed to fetch ?scene=", sceneUrl, err));
	}
	// ?at=lon,lat[,heading[,scale]]＝?g= の glb/gltf をどこに置くか（3D 模型は地理座標を持たない。省略＝画面中心）。他形式は読まない
	const modelAt = (): IntakeCtx => { const v = (new URLSearchParams(location.search).get("at") || "").split(",").map(Number); return Number.isFinite(v[0]) && Number.isFinite(v[1]) ? { at: [v[0], v[1]], heading: v[2] || 0, scale: v[3] || 1 } : {}; };
	// ?g=<URL>＝GeoPBF の URL ロード（ドロップと同じ一本道＝取得→loadUserFile）。gh:user/repo[@ref]/path 短縮形は
	// GitHub raw へ展開（ref 省略=HEAD・コミットSHA固定も可）。https 限定（開発時のみ localhost の http 可）・
	// credentials 無し＝他人の置き場を読むだけの姿勢。読めたら出所（ホスト名）を出典 #attr へ常時表示＝
	// 他人の作品を当ドメインで再生する時の看板（docs/geopbf §11 の作法とセット）。
	// ── URL の data と公開のフィーチャーサービス（#176）──
	// 本人裁定（2026-09-30 再）＝「token/key が付いている時だけ新しい道・従来に対して影響なし・オプション機能が過去の資産を壊さない」：
	//   直の取得（requester＝transformRequest を通す・proxy へ URL を送らない）に切り替えるのは、URL に鍵の問い合わせ（token・key…）が
	//   付いている時だけ（directOK）。それ以外の URL は（transformRequest を渡した頁でも）従来どおり geopbf(URL)
	//   （proxy 確認・URL の IDB 控えもそのまま）。bucket の名前（http でない文字列）も従来どおり。
	//   フィーチャーサービスの URL は従来「未対応の形式」で落ちていた＝足し算（読めるようにするだけ）。
	const SECRET_Q = /[?&](token|key|apikey|api_key|access_token|accesstoken|sig|signature|auth)=/i;
	const directOK = (url: string) => SECRET_Q.test(url);
	// サービスの形（…/FeatureServer/N・…/MapServer/N・…/collections/{id}）＝件数が WHOLE_MAX 以下なら丸ごと・超えたら視野追従（gint へ・本人裁定）
	const fsMod = () => import("../featureservice.js");
	const SERVICE_HINT = /\/(?:FeatureServer|MapServer)\/\d+|\/collections\/[^/?#]+/i;   // 形のあたり（確定は geopbf の parseServiceUrl）＝当たらない URL は読み口の chunk を読まない
	const svcOpen = new Map<string, Promise<FeatureService | null>>();   // url → Promise<svc|null>（1 頁 1 回・失敗は次に取り直す）
	// 控えの掃除（本人 2026-09-30「掃除する機能は絶対に必要」）＝鍵の接頭辞 FS1:: だけ（他の控えには触らない）。頁で最初にサービスを開く時に一度：
	// 置いてから 30 日を超えた物・2,000 件／256MB を超えた分（最後に使ったのが古い順）を消す。map.clearFeatureServiceCache()＝全部
	const FS_PREFIX = "FS1::", FS_PRUNE = { maxAge: 30 * 864e5, maxEntries: 2000, maxBytes: 256 * 2 ** 20 };
	let fsPruned: Promise<unknown> | null = null;
	const pruneFsCache = () => fsPruned ??= geopbfCachePrune({ prefix: FS_PREFIX, ...FS_PRUNE }).then(r => { if (r?.removed) console.info(`[featureservice] cache: removed ${r.removed}, kept ${r.kept} (${(r.bytes / 2 ** 20).toFixed(1)} MB)`); return r; }).catch(err => { console.warn("[featureservice] cache prune", err); return null; });
	const openSvc = (url: string): Promise<FeatureService | null> => {
		if (!/^https?:\/\//i.test(url) || !SERVICE_HINT.test(url)) return Promise.resolve(null);
		pruneFsCache();
		if (!svcOpen.has(url)) {
			const p = fsMod().then(m => m.parseServiceUrl(url) ? m.openService(url, { fetch: ((u, init) => requester.fetch(u as string, "Source", init)) as typeof fetch }) : null);
			p.catch(() => svcOpen.delete(url)); svcOpen.set(url, p);
		}
		return svcOpen.get(url)!;
	};
	// 控え（本人 2026-09-30「一度読んだ Feature は IDB で GeoPBF/GintBUF として使い回す」）＝鍵はサービス・版・部分（"all" か枡）＝geopbf の IDB（同じ棚）。
	// 版の無いサービス（OGC・MapServer）は 1 日で読み直す・版のあるもの（ArcGIS の lastEditDate）は 30 日（版が替われば鍵が替わる）。
	// GeoPBF は Feature.id を持たない＝置く時に属性へ写し、引く時に戻す（視野追従の重複落とし・MapLibre の feature-state が id で当てる）
	const FS_ID = "ortho:fsid";   // ortho:mlid と同じ名前空間
	const fsAge = (svc: FeatureService) => svc.version != null ? 30 * 864e5 : 864e5;
	const stampIds = (fs: Feature[]) => fs.map(f => f.id == null ? f : { ...f, properties: { ...(f.properties || {}), [FS_ID]: f.id } });
	const unstampIds = (fs: Feature[]) => fs.map(f => { const p = f.properties; if (!p || p[FS_ID] == null) return f; const { [FS_ID]: id, ...rest } = p; return { ...f, id: id as Feature["id"], properties: rest }; });
	const fsCacheGet = async (svc: FeatureService, part: string, gint = false) => geopbfCached(svc.cacheKey(part), { gint, maxAge: fsAge(svc), name: `fs/${svc.name || "layer"}` }).catch(() => null);
	const fsCachePut = (svc: FeatureService, part: string, features: Feature[], gint = false) => features.length ? geopbf({ type: "FeatureCollection", features: stampIds(features) }, { gint, name: `fs/${svc.name || "layer"}`, cacheKey: svc.cacheKey(part) }) : Promise.resolve(null);
	const fsCellCache = (svc: FeatureService): CellCache => ({   // 視野追従の枡
		get: async key => { const pbf = await fsCacheGet(svc, key); return pbf ? unstampIds(pbf.geojson?.features || []) : null; },
		put: (key, fc) => fsCachePut(svc, key, fc.features),
	});
	// 丸ごと＝控えがあれば網に出ない。gint＝GintBUF も欲しい（?g= の利用者の枠＝焼き直さず GPU へ）
	const svcWhole = async (svc: FeatureService, gint = false) => {
		const hit = await fsCacheGet(svc, "all", gint);
		if (hit) return { features: unstampIds(hit.geojson?.features || []), pbf: hit, cached: true };
		const { WHOLE_MAX } = await fsMod(), fc = await svc.readAll({ max: WHOLE_MAX });
		if (fc.truncated) console.warn(`[featureservice] ${svc.url}: first ${WHOLE_MAX} of ${svc.count ?? "?"} features only (fill/line/circle layers follow the view instead)`);
		const pbf = fc.truncated ? (gint && fc.features.length ? await geopbf({ type: "FeatureCollection", features: fc.features }, { gint: true, name: `fs/${svc.name || "layer"}` }) : null)
			: await fsCachePut(svc, "all", fc.features, gint).catch(err => { console.warn("[featureservice] cache", err); return null; });
		return { features: fc.features, pbf, cached: false };
	};
	const svcAttrHTML = (svc: FeatureService | null | undefined) => svc?.attribution ? sanitizeHTML(svc.attribution) : (() => { try { return new URL(svc!.url).host; } catch { return null; } })();   // 宣言が無ければホスト名＝無出典で他人のデータを出さない
	const urlFileName = async (u: string, blob: Blob) => {   // 拡張子の無い URL（…/data・…?f=geojson）＝中身の頭で JSON か GeoPBF かを決める
		let n = "data"; try { n = decodeURIComponent(new URL(u).pathname.split("/").pop() || "data"); } catch { /* 相対は上で解いてある */ }
		if (/\.[a-z0-9]{2,8}$/i.test(n)) return n;
		const head = (await blob.slice(0, 64).text()).trimStart();
		return n + (head[0] === "{" || head[0] === "[" ? ".geojson" : ".geopbf");
	};
	const readGeoData: DataReturn["readGeoData"] = async d => {
		if (typeof d === "string" && /^https?:\/\//i.test(d)) {
			const svc = await openSvc(d);
			if (svc) return { type: "FeatureCollection", features: (await svcWhole(svc)).features };   // サービス＝丸ごと（上限 WHOLE_MAX・控えがあれば網に出ない＝押し出し・集約・模様・熱の層はこの道。視野追従は fill/line/circle の層だけ＝sourceData）
			if (!directOK(d)) return (await geopbf(d, { gint: false }))?.geojson;   // 従来の道（鍵も手入れも無い URL）
			const r = await requester.fetch(d, "Source");
			if (!r.ok) throw new Error(`HTTP ${r.status} ${d}`);
			const blob = await r.blob();
			return (await geopbf(new File([blob], await urlFileName(d, blob)), { gint: false }))?.geojson;
		}
		if (typeof d === "string" || d instanceof Blob) return (await geopbf(d, { gint: false }))?.geojson;
		return d;
	};
	// 出典の欄（vtxAttrs の "src:<sid>"）＝geojson source の attribution（MapLibre の宣言）かサービスの出典（copyrightText・OGC の license）
	const setSrcAttr = (sid: string, html: string | null | undefined) => { const k = "src:" + sid, cur = live.vtxAttrs.get(k) ?? null; if ((html ?? null) === cur) return; if (html) live.vtxAttrs.set(k, html); else live.vtxAttrs.delete(k); live.attrZone = null; requestDraw(); };
	const fsFollow: DataReturn["fsFollow"] = new Map();   // sid → { url, fc, follow }（視野追従の source）
	const dropFollow = (sid: string) => { const e = fsFollow.get(sid); if (e) { e.follow?.destroy(); fsFollow.delete(sid); } };
	// fill/line/circle の層の data（gintDataOf）：サービスで件数が多い＝視野追従（動いて止まったら足りない枡を読み、source を組み直す）
	const sourceData = async (sid: string, d: unknown, sp?: UserSource) => {
		const svc = typeof d === "string" ? await openSvc(d) : null;
		if (!svc) { dropFollow(sid); setSrcAttr(sid, null); return readGeoData(d); }   // サービスでない＝従来どおり（出典の欄も触らない）
		let e: FsFollowEntry | null | undefined = fsFollow.get(sid);
		if (e && e.url !== d) { dropFollow(sid); e = null; }
		if (!e) { e = { url: d as string, fc: null, follow: null }; fsFollow.set(sid, e); }
		setSrcAttr(sid, sp?.attribution ? sanitizeHTML(String(sp.attribution)) : svcAttrHTML(svc));
		const m = await fsMod();
		if (svc.count != null && svc.count <= m.WHOLE_MAX) return e.fc ??= { type: "FeatureCollection", features: (await svcWhole(svc)).features };
		e.follow ??= m.followView(svc, { map, cache: fsCellCache(svc), onData: fc => { if (fsFollow.get(sid) !== e) return; e.fc = fc; live.remountSource(sid).catch(err => console.warn(`[featureservice] source "${sid}"`, err)); },
			onStatus: s => s === "zoom-in" && console.info(`[featureservice] source "${sid}": too many features in view (${svc.url}) — zoom in to load`) });
		return e.fc ?? { type: "FeatureCollection", features: [] };
	};
	dbgHost.__fsFollow = () => [...fsFollow].map(([sid, e]) => ({ sid, url: e.url, n: e.fc?.features?.length ?? 0, stats: e.follow?.stats() ?? null }));   // 検定の窓
	// ?g= がフィーチャーサービス（#176）＝件数が WHOLE_MAX 以下は丸ごと（ドロップと同じ本道）・超えたら視野追従（利用者の gint 枠を読むたびに差し替え＝識別が効く）。
	// 取得は requester（transformRequest＝鍵）。出典の行＝サービスの宣言（copyrightText・OGC の license）かホスト名。引きすぎの間は「寄れば読む」を添える
	async function loadServiceG(svc: FeatureService, u: URL) {
		const m = await fsMod(), name = svc.name || u.host, t = tr();
		const credit = t("Map data: $1", svc.attribution || u.host);   // 文字として入れる（HTML にしない）
		setGSrc(credit);
		if (svc.count != null && svc.count <= m.WHOLE_MAX) {   // 丸ごと＝控え（GeoPBF＋GintBUF）があれば網に出ず焼き直さず GPU へ
			const w = await svcWhole(svc, true), pbf = w.pbf;
			live.gFollow?.destroy(); live.gFollow = null; live.annoCtl?.clear(); live.czmlCtl?.clear();
			if (!pbf?.unPackGint) { gint.clearUserGint(); return null; }
			gint.applyGintData(pbf, name, false, { drape: true });
			live.editDocHook?.(pbf, name);
			const bb = pbf.unPackGint.bbox;
			if (!themeBootV && bb?.length === 4) map.fitBounds(bb as Bbox, { padding: 40, maxZoom: 16 });
			console.info("[g] feature service", svc.url, `${pbf.length} features (whole${w.cached ? ", from the local cache" : ""})`);
			return pbf;
		}
		if (!themeBootV && svc.bbox) map.fitBounds(svc.bbox as Bbox, { padding: 40, maxZoom: 14 });   // まず全体へ（引きすぎなら「寄れば読む」の札・寄れば読む）
		const follow = live.gFollow = m.followView(svc, {
			map, cache: fsCellCache(svc),
			onData: async fc => {
				if (live.gFollow !== follow) return;
				const pbf = fc.features.length ? await geopbf(fc, { gint: true, name: `drop/${name}` }).catch(err => { console.warn("[g] geopbf", err); return null; }) : null;
				if (live.gFollow !== follow) return;
				if (pbf?.unPackGint) gint.applyGintData(pbf, name, false, { drape: true }); else gint.clearUserGint();
			},
			onStatus: st => { if (live.gFollow === follow) setGSrc(st === "zoom-in" ? `${credit} · ${t("Zoom in to load features")}` : credit); },
		});
		console.info("[g] feature service", svc.url, `${svc.count ?? "?"} features (following the view)`);
		return follow.ready;
	}
	// 列チャンク層（src/columnar・#90・2026-10-15 に旧 @ortho-earth/columnar を吸収）＝GeoPBF と GeoParquet を gint を通さず描く（読み→詰め替え→GPU 直行・最初の 1 枚が速い）。
	// GeoParquet は大きさに依らず常にこちら（旧 8MB の分かれ道は無し）。GeoPBF は大きさで自動＝COLUMNAR_BYTES を超えたら列チャンク層・以下は gint
	//（位相・識別の精度・ドレープ・編集はそのまま）。?columnar=1|0 で強制／opts.columnarBytes で閾値。編集ボタンは編集の時だけ gint（geoedit）へ載せ替える。
	// 本体（worker の読み手・オーバーレイ）は動的 import＝GeoParquet や大きな GeoPBF を受けた時だけ降りてくる（起動の束には 0 バイト）。
	// 段 0 の物差し（scripts/perf-columnar.mjs・headless SwiftShader・2026-09-27＝相対比較用）：最初の 1 枚まで gint→列チャンク
	//   20k 筆 1.5MB：457→75ms・60k 筆 4.4MB：1174→70ms・150k 筆 11MB：1257→98ms・100 万点 32MB：1307→255ms＝列チャンクは大きさに依らず 0.1 秒級。
	//   境目は 1.5MB より下。4MB は「gint の位相・ドレープ・精密な識別・編集を小さなファイルには残す」側の落とし所（本人裁定で動かす口＝opts.columnarBytes）
	const COLUMNAR_BYTES = opts.columnarBytes ?? 4e6;
	const columnarQ = () => new URLSearchParams(location.search).get("columnar");   // ?columnar=1＝常に列チャンク層／0＝常に gint
	const columnarOn = (bytes: number) => { const q = columnarQ(); return q === "1" ? true : q === "0" ? false : bytes > COLUMNAR_BYTES; };
	// 大きさの門を越えても「弧の共有が多い塗り分けデータ（admin1・行政地図）は gint」（本人 2026-09-27）＝読み手の走査が返す share（先頭チャンクの標本：
	// 別の feature に既に出た頂点の割合・1 feature あたりの頂点数）で決める。既定＝share.ratio ≥ 0.3 かつ 頂点数 ≥ 40（長い共有弧）かつ 64MB 以下なら gint。
	// opts.columnarRule(meta, bytes) → true＝列チャンク層 で差し替え可（meta.share が物差し）
	const columnarProbe: DataReturn["columnarProbe"] = bytes => meta => columnarQ() === "1" ? true : opts.columnarRule ? !!opts.columnarRule(meta, bytes) : !(meta.share && meta.share.ratio >= 0.3 && meta.share.meanVertices >= 40 && bytes <= 64e6);
	ownDestroy.push(() => { live.columnarCtl?.remove(); live.columnarCtl = null; });
	const columnarView: DataReturn["columnarView"] = async (src, name, o = {}) => {
		live.annoCtl?.clear(); gint.clearUserGint(); live.columnarCtl?.remove(); live.columnarCtl = null;
		const m = await import("../columnar/index.ts");
		const color = new URLSearchParams(location.search).get("color");   // ?color=<数値列>＝色分けの初期列（状況表示の select でも替えられる）
		try { live.columnarCtl = await m.createColumnarView(map, src, { name, color, signal: ac.signal, t: tr(), workerFactory: hostWorker, rAx: ELL_ON ? 1 - 1 / 298.257223563 : 1, perf: !!(opts as { perf?: unknown }).perf || new URLSearchParams(location.search).get("perf") === "1", ...o }); }
		catch (err) {   // 文面は gadget の t()（トーストへ）。zstd＝ブラウザに解凍器が無い時の言い換え
			console.error("[columnar] view failed", name, err);
			if (/zstd/i.test((err as Error | null)?.message || "")) throw new Error(tr()("zstd-compressed GeoParquet cannot be read in a browser (re-write it with gzip or snappy)."));
			throw err;
		}
		if (!live.columnarCtl) return null;   // probe（振り分けの規則）が断った＝呼び手が gint の道へ
		dbgHost.__columnar = dbgHost.__parquet = live.columnarCtl;   // dev の検証窓（loaded/deferred/stats・旧名 __parquet も残す）
		return { length: live.columnarCtl.rows, columnar: live.columnarCtl };   // dropFile のトースト用（地物数の代わりに行数）
	};
	// ?g= の読み込み（説明は loadServiceG の上）＝列チャンク層の口（columnarOn・columnarView・columnarProbe）の宣言の後で走らせる（TS 化 段 4：宣言の前の使用を避けた・走る順の違いは外から見えない）
	{
		const gSpec = new URLSearchParams(location.search).get("g");
		const u = gSpec ? remoteUrl(gSpec, "g") : null;   // 門は ?scene= と共用（remoteUrl）
		if (u) (async () => {
			try {
				const name = decodeURIComponent(u.pathname.split("/").pop() || "") || "map.geopbf";
				let pbf;
				const svc = await openSvc(u.href);   // フィーチャーサービスの形＝拡張子の判定より前（…/query?f=geojson を "query" という名のファイルと見て落ちていた）
				if (svc) return void await loadServiceG(svc, u);
				if (/\.(parquet|geoparquet)$/i.test(u.pathname) && columnarOn(Infinity)) {   // GeoParquet＝列チャンク層が URL のまま開く（footer → 視野の row group だけ Range・#90）
					pbf = await columnarView(u.href, name, { fit: !themeBootV, probe: columnarProbe(0) });
					if (!pbf) {   // 規則が gint と言った（塗り分け）＝全量を取って従来の道（64MB まで）
						const r = await fetch(u, { credentials: "omit" }); if (!r.ok) throw new Error(`HTTP ${r.status}`);
						if (+r.headers.get("content-length")! > 64e6) throw new Error("too large for gint");
						pbf = await live.loadUserFile(new File([await r.blob()], name), { fit: !themeBootV, gint: true });
					}
				} else {
					const r = directOK(u.href) ? await requester.fetch(u.href, "Source", { credentials: "omit" }) : await fetch(u, { credentials: "omit" });   // 鍵か手入れがある時だけ requester（#176）・他は従来どおり
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					if (+(r.headers?.get?.("content-length") ?? 0) > 256e6) throw new Error("too large");   // 正気上限（敵入力の巨大確保よけ・GitHub raw は 100MB 上限）
					pbf = await live.loadUserFile(new File([await r.blob()], name), { ...modelAt(), fit: !themeBootV });   // URL に視点（#…）があればそれが勝つ＝寄せない（共有した傾き・画角を保つ・2026-09-21）
				}
				if (!pbf) return console.warn("[g] decode failed", u.href);
				const attr = live.mapEl.querySelector("#attr");   // 出所の常時表示（instruments 非搭載ページは console のみ）＝従来どおり（サービスの行だけ setGSrc）
				if (attr && !attr.querySelector(".g-src")) {
					const line = document.createElement("div");
					line.className = "g-src";
					line.textContent = tr()("Map data: $1", u.host);
					attr.append(line);
				}
				console.info("[g] loaded", u.href, `${pbf.length ?? "?"} features`);
			} catch (err) { console.warn("[g] failed to fetch ?g=", u.href, err); }
		})();
	}
	// 公開の口（1.4.0〜）：map.addColumnar(src, opts) → 列チャンク層の手綱（setPaint/setFilter/setVisible/query/on/remove）。src＝URL・File・ArrayBuffer・GeoPBF
	map.addColumnar = async (src, o = {}) => {
		const m = await import("../columnar/index.ts");
		return m.createColumnarView(map, src, { t: tr(), workerFactory: hostWorker, rAx: ELL_ON ? 1 - 1 / 298.257223563 : 1, status: false, ...o });
	};
	// three.js を render worker の中で描く口（deck.gl 差分 PR-3・2026-10-11・gadgets/three-draw.js）：
	//   map.addThree({ three: URL（three.module.js・利用者が持ち込む＝repo の依存にしない）, module: URL（export setup(THREE, scene, h) / update?(dt, h) / onMessage?(d, h) / dispose?(h)）,
	//                  origin: [lon, lat, hM]（既定＝今の中心・シーンの ENU m の原点＝RTE）, depth: true（地形・建物に隠れる）, params, name, above })
	//   → 手綱＝{ post(data)（利用者の onMessage へ）, pick(x, y), ready（Promise）, remove() }。既存の customgl（MapLibre の custom 層・main の canvas・深度なし）はそのまま残す
	map.addThree = ({ three, module, origin, depth = true, params, name = "three", above = false } = {} as Parameters<DataApi["addThree"]>[0]) => {
		if (!three) throw new Error("addThree: three (URL of three.module.js) is required");
		const abs = (u: string | undefined) => u == null ? u : new URL(u, location.href).href;
		const h = map.overlay({ builtin: "three" }, { name, above, opts: { three: abs(three), module: abs(module), origin: origin || [cam.center[0], cam.center[1], 0], depth, params } }) as OverlayHandle & { ready: Promise<OverlayHandle> };
		h.ready = new Promise((res, rej) => {
			const prev = h.onmessage;
			h.onmessage = d => { if ((d as OverlayMsg)?.type === "error") { h.onmessage = prev; rej(new Error((d as OverlayMsg)!.error)); } else prev?.(d); };
			const poll = () => { const st = (dbgHost.__overlay as OverlayStages | undefined)?.[name]; if (st?.stage === "failed") { rej(new Error(st.error)); return; } if (!overlays.has(name)) { rej(new Error("removed")); return; } if (st?.stage === "ready") res(h); else setTimeout(poll, 100); };
			poll();
		});
		return h;
	};
	// H3 のセル（@ortho-earth/h3・deck.gl 差分 PR-2・2026-10-11）：map.addH3(cells | points, { id, res, weight, paint, extrude, outline }) → 手綱（setData/setPaint/setRes/remove）。
	// セル id → 面・点 → セルへの集約（count/sum/mean/min/max）を GeoJSON にして addSource/addLayer（fill か fill-extrusion）へ＝描画・当たりは既存の層経路。本体（h3-js）は遅延 import
	map.addH3 = async (src, o = {}) => {
		const m = await import("@ortho-earth/h3");
		// TODO(ts): @ortho-earth/h3 の型（H3Map の addLayer の層＝Record・H3Layer の geojson は null あり・evalExpr の形）が公開の型（MapLibreLayer・CellsLayerHandle）と食い違う＝h3 の型を揃える
		return m.createH3Layer(map as unknown as Parameters<typeof m.createH3Layer>[0], src as Parameters<typeof m.createH3Layer>[1], { evalExpr, ...o } as Parameters<typeof m.createH3Layer>[2]) as Promise<unknown> as Promise<CellsLayerHandle>;
	};
	// deck.gl の Layer（配列＋accessor）の相当（差分 PR-4・2026-10-12・src/adddata.js）：map.addData(data, { kind, …accessors, id, before, above, paint })
	//   kind "points"（getPosition／getColor [r,g,b,a 0〜255]／getRadius px）→ points-gl、"arcs"（getSourcePosition／getTargetPosition／getSourceColor／getTargetColor／getWidth px／getHeight 弦長比）→ arcs-gl
	//     ＝同一フレームの overlay（RTE・統一 picking＝map.on(ev, id, cb)・queryRenderedFeatures({ layers:[id] })・h.pick）。main で accessor を評価して typed array に焼き worker へ transfer
	//   "polygons"（getPolygon）／"paths"（getPath）／"columns"（getPosition＋getRadius m）＋ getFillColor／getLineColor／getLineWidth／getElevation m → GeoJSON の addSource/addLayer（fill／line／fill-extrusion＝H3 と同じ既存の層経路）
	//   "trips"（getPath [[lon,lat,h?]…]／getTimestamps／getColor／getWidth・currentTime・trailLength・fadeTrail・clock）→ trips-gl（PR-6）＝h.setCurrentTime / setTrail / animate({ from, to, speed, loop }) / useClock
	//   点・弧・軌跡の共通（PR-6）：getFilterValue＋h.setFilter([lo, hi])（GPU の範囲フィルタ）、h.brush(true, r)／h.setBrush(x, y, r)（ポインタのブラシ）、h.setMask(polygon)（多角形のマスク）、points の transition: { duration }（setData で位置・色・半径を混ぜる）
	//   → 手綱 { id, kind, ready, setData(data), setProps(accessors), setVisible(on), pick(x, y), remove() }。setData は差分でなく全焼き（deck.gl と同じ）。data＝配列・GeoJSON FeatureCollection（位置の既定＝geometry）・iterable
	let dataSeq = 0;
	map.addData = (data, o = {}) => {
		const { kind = "points", id, before, above = false, paint, ...acc } = o;
		if (!BUILTIN_DATA_KINDS.includes(kind)) {   // plugin の kind（registry.dataKinds・PR-F0）＝{ create(map, data, opts) → 手綱 }。知らない kind は投げる（黙って points にしない）
			const ext = pluginHost.registry.dataKinds.get(kind);
			if (kind === "splat") {   // F8：予約された kind＝契約（src/splat.js の SplatData か .ply/.splat/.spz の URL）はここで検める。描く段（ソート・楕円・深度）は plugin の "splat"
				data = normSplat(data);
				if (!ext || typeof ext.create !== "function") throw new Error(`addData: kind "splat" is a reserved contract (capabilities()["data.splat"] is "spec"); install a plugin that registers map.registry.dataKinds "splat" (see PLUGINS.md)`);
			}
			if (!ext || typeof ext.create !== "function") throw new Error(`addData: unknown kind "${kind}" (builtin: ${BUILTIN_DATA_KINDS.join("/")}; plugins register via map.registry.dataKinds)`);
			return ext.create(map, data, { ...o, id: id ?? `data${++dataSeq}` } as Parameters<typeof ext.create>[2]) as DataLayerHandle;   // plugin の手綱（PLUGINS.md の契約＝addData の手綱の形）
		}
		const name = id ?? `data${++dataSeq}`;
		let props = acc, cur = data, removed = false;
		const modP = import("../adddata.js");
		const h = { id: name, kind } as DataLayerHandle;
		if (kind === "points" || kind === "arcs" || kind === "trips") {
			const ov = map.overlay(kind === "points" ? pointsUrl : kind === "arcs" ? arcsUrl : tripsUrl, { name, above });
			const style: Record<string, unknown> = {}; if (acc.radius != null) style.size = acc.radius; if (acc.width != null) style.width = acc.width; if (acc.height != null) style.height = acc.height; if (acc.segments != null) style.segments = acc.segments;
			if (acc.trailLength != null) style.trail = acc.trailLength; if (acc.fadeTrail != null) style.fade = acc.fadeTrail;
			if (acc.color) style.color = [(acc.color as number[])[0] / 255, (acc.color as number[])[1] / 255, (acc.color as number[])[2] / 255, ((acc.color as number[])[3] ?? 255) / 255];   // accessor の無い層の色（deck.gl と同じ 0〜255）
			if (Object.keys(style).length) ov.post({ type: "style", ...style });
			if (kind === "trips") { if (acc.currentTime != null) ov.post({ type: "time", t: acc.currentTime }); if (acc.clock) ov.post({ type: "clock", on: true }); }
			const transOf = () => props.transition ? (typeof props.transition === "object" ? props.transition : { duration: +(props.transition as number) }) : null;
			const bake = async () => {
				const m = await modP; if (removed) return;
				if (kind === "points") { const b = m.bakePoints(cur, props); h.n = b.n; ov.post({ type: "layer", q: "d", n: b.n, pos: b.pos, rgba: b.rgba, size: b.size, f: b.f, origin: b.origin, transition: transOf() }, [b.pos.buffer]); }
				else if (kind === "arcs") { const b = m.bakeArcs(cur, props); h.n = b.n; ov.post({ type: "layer", q: "d", n: b.n, src: b.src, dst: b.dst, theta: b.theta, rgba: b.rgba, rgba2: b.rgba2, width: b.width, height: b.height, f: b.f, origin: b.origin }, [b.src.buffer, b.dst.buffer]); }
				else { const b = m.bakeTrips(cur, props); h.n = b.n; h.timeRange = [b.tMin, b.tMax]; ov.post({ type: "layer", q: "d", nv: b.nv, ni: b.ni, pos: b.pos, oth: b.oth, side: b.side, time: b.time, id: b.id, index: b.index, rgba: b.rgba, width: b.width, f: b.f, origin: b.origin, trips: b.trips, tMin: b.tMin, tMax: b.tMax }, [b.pos.buffer, b.oth.buffer, b.index.buffer]); }
			};
			h.ready = bake();
			h.setData = d => { cur = d; return (h.ready = bake()); };
			h.setProps = p => { props = { ...props, ...p }; return (h.ready = bake()); };
			h.setVisible = on => { ov.post({ type: "vis", q: "d", on: !!on }); return h; };
			h.pick = (x, y, r) => ov.pick(x, y, r);
			// GPU の範囲フィルタ・ブラシ・マスク（deck.gl の DataFilter／Brushing／Mask の各 Extension 相当・PR-6）
			h.setFilter = range => { ov.post({ type: "filter", q: "d", range: range || null }); return h; };
			h.setBrush = (x, y, r) => { ov.post(x == null ? { type: "brush" } : { type: "brush", x, y, r: r ?? acc.brushRadius ?? 60 }); return h; };
			let brushOff: (() => void) | null = null;
			h.brush = (on = true, r) => {   // ポインタに追従するブラシ（CSS px）。off でポインタを離れた時は消す
				brushOff?.(); brushOff = null;
				if (!on) { h.setBrush!(null); return h; }
				const mv = (e: PointerEvent) => { const rc = canvas.getBoundingClientRect(); h.setBrush!(e.clientX - rc.left, e.clientY - rc.top, (r ?? acc.brushRadius ?? 60) as number); }, lv = () => h.setBrush!(null);
				live.mapEl.addEventListener("pointermove", mv, { passive: true }); live.mapEl.addEventListener("pointerleave", lv, { passive: true });
				brushOff = () => { live.mapEl.removeEventListener("pointermove", mv); live.mapEl.removeEventListener("pointerleave", lv); };
				return h;
			};
			h.setMask = async (polygon, o2 = {}) => { const m = await modP; const mk = polygon ? m.rasterMask(polygon, o2) : null; ov.post(mk ? { type: "mask", ...mk } : { type: "mask" }, mk ? [mk.data.buffer] : []); return h; };
			if (acc.filterRange) h.setFilter(acc.filterRange as [number, number]); if (acc.mask) h.setMask(acc.mask); if (acc.brush) h.brush(true, acc.brushRadius as number | undefined);
			if (kind === "trips") {   // 時刻（deck.gl の currentTime / trailLength）
				h.setCurrentTime = t => { ov.post({ type: "time", t }); return h; };
				h.setTrail = (len, fade) => { ov.post({ type: "style", trail: len, ...(fade != null ? { fade } : {}) }); return h; };
				h.animate = (o2 = {}) => { ov.post(o2 === false || o2.on === false ? { type: "animate", on: false } : { type: "animate", from: o2.from ?? h.timeRange?.[0] ?? 0, to: o2.to ?? h.timeRange?.[1] ?? 1, speed: o2.speed ?? 1, loop: o2.loop !== false }); return h; };
				h.useClock = (on = true) => { ov.post({ type: "clock", on }); return h; };
			}
			h.remove = () => { removed = true; brushOff?.(); ov.remove(); };
			h.overlay = ov;
			return h;
		}
		const ids = [name, name + "-line"];
		const specs = () => {
			const ext = kind === "columns" || props.getElevation !== undefined, gf = props.getFillColor !== undefined, gl = props.getLineColor !== undefined, gw = props.getLineWidth !== undefined;
			const out: MapLibreLayer[] = [];
			if (kind !== "paths") out.push(ext
				? { id: name, type: "fill-extrusion", source: name, paint: { "fill-extrusion-color": gf ? ["get", "_fill"] : "#3182bd", "fill-extrusion-opacity": 0.85, "fill-extrusion-height": props.getElevation !== undefined ? ["get", "_h"] : (props.elevation ?? 100) as number, "fill-extrusion-base": 0, ...(paint || {}) } }
				: { id: name, type: "fill", source: name, paint: { "fill-color": gf ? ["get", "_fill"] : "rgba(49,130,189,0.6)", ...(paint || {}) } });
			if (kind === "paths" || (gl && !ext)) out.push({ id: kind === "paths" ? name : name + "-line", type: "line", source: name, paint: { "line-color": gl ? ["get", "_line"] : "#1f3b73", "line-width": gw ? ["get", "_lw"] : (props.lineWidth ?? 1.5) as number, ...(kind === "paths" ? (paint || {}) : {}) } });
			return out;
		};
		let mounted = false;
		const bake = async () => {
			const m = await modP; if (removed) return;
			const gj = m.toGeoJSON(cur, kind, props); h.n = gj.features.length;
			if (!mounted) { map.addSource(name, { type: "geojson", data: gj }); for (const sp of specs()) await map.addLayer(sp, before); mounted = true; }
			else await map.getSource(name)?.setData(gj);
		};
		h.ready = bake();
		h.setData = d => { cur = d; return (h.ready = bake()); };
		h.setProps = p => { props = { ...props, ...p }; return (h.ready = bake()); };
		h.setVisible = on => { for (const i of ids) if (map.getLayer(i)) map.setLayoutProperty(i, "visibility", on ? "visible" : "none"); return h; };
		h.pick = async (x, y) => map.queryRenderedFeatures([x, y], { layers: ids.filter(i => map.getLayer(i)) });
		h.remove = () => { removed = true; for (const i of ids) if (map.getLayer(i)) map.removeLayer(i); if (map.getSource(name)) map.removeSource(name); };
		return h;
	};
	// セル・等高線・画面格子（deck.gl の GridLayer／GeohashLayer／QuadkeyLayer／S2Layer／ContourLayer／ScreenGridLayer 相当・差分 PR-5・2026-10-12・src/cells/）：
	//   map.addCells(cells | points, { kind:"grid"|"mesh"|"geohash"|"quadkey"|"s2", res|"auto", weight, paint, extrude, outline })＝id → 多角形・点 → セルの集約（count/sum/mean/min/max）→ fill／fill-extrusion（H3 と同じ既存の層経路）
	//   map.addContour(points, { cellSize, thresholds | bands, weight, agg, smooth, paint })＝格子の場 → 等値線（line）／等値帯（fill）
	//   map.addScreenGrid(points, { cellPx, colorRange, weight, agg })＝画面に固定の格子（overlay・毎フレーム投影して数える・統一 picking で count）
	//   map.addAggregate(src, { kind:"h3"|…|"screen"|"contour", … })＝振り分け。本体は遅延 import（純 JS・依存ゼロ）
	const cellsMod = () => import("../cells/layer.ts");
	map.addCells = async (src, o = {}) => (await cellsMod()).createCellsLayer(map, src, { evalExpr, ...o });
	map.addContour = async (src, o = {}) => (await cellsMod()).createContourLayer(map, src, { evalExpr, ...o });
	map.addScreenGrid = async (src, o = {}) => (await cellsMod()).createScreenGrid(map, src, { ...o, screengridUrl });
	map.addAggregate = async (src, o = {}) => (await cellsMod()).addAggregate(map, src, { evalExpr, ...o }, { screengrid: screengridUrl });
	return { scenes, readGeoData, remoteUrl, setSrcAttr, columnarOn, columnarView, columnarProbe, sourceData, dropFollow, fsFollow };
}
