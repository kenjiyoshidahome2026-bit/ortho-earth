// 検査表示（gadget.inspect・maplibre-gl-inspect 相当）・ファイルの取り込み（gadget.dropFile と画像タイルの容器）・編集（gadget.geoedit／edit）・
// デモ（gadget.demo）＝createGlobe から切り出した（globe.js の分割 ⑪・2026-10-15）。中身は切り出す前と同じ。createGlobe の他の所が使う物は戻り値で返す。
//   live＝createGlobe の変数（let・この呼び出しより後で宣言される定数）を読み書きする口（getter／setter）。その他＝createGlobe の中の定数・関数（中身は createGlobe と共有）
import { WORLD_PX, decodeTile, fetchMVT, fetchPMTilesRaw, isRasterTileType, loadTileFormat, lonLatToTile, parseRGBA, pmtilesInfo } from "@ortho-earth/core";
import { demo as demoGadget } from "../gadgets/demo-stub.ts";
import { dockStack } from "../gadgets/stack.ts";
import { dropFile as dropFileGadget } from "../gadgets/dropfile.ts";
import { editDocClear, editDocLoad, editDocSave } from "../gadgets/editdoc.ts";
import { edit as editGadget } from "../gadgets/edit.ts";
import { getLang } from "../i18n.js";
import { inspect as inspectGadget } from "../gadgets/inspect-stub.ts";
import type { Installing, ToolsDeps, ToolsLive, ToolsReturn } from "../types/install.ts";
import type { ToolsApi } from "../types/map.ts";
import type { VtxDesc } from "../types/scope.ts";
import type { GeoPBF as GeoPBFFull } from "geopbf";

/** 検査表示の層の台帳の 1 件（属性の名前＝型は空） */
type InspectLayer = { id: string; fields?: Record<string, string>; minzoom?: number; maxzoom?: number };

export function installTools(map: Installing<ToolsApi>, live: ToolsLive, {
	BASEMAP_MINZOOM, BASE_SOURCE, CAM_ZOOM_MIN, HOME_VIEW, REGION_HOME, WORLD_VT, ZOOM_MIN, ac, baseSidNow, baseSrcSpec, cam, canvas, clearImages, evXY,
	flightCtl, flyTo, flyView, gint, glidePathView, loadUserFile, meshMgr, mlLayers, mlSources, mlVisible, opts, remergeBase, renderer, requestDraw,
	registerGadget, requester, scenes, setAutoBld, size, t, unprojectAt, vtxDescOf
}: ToolsDeps): ToolsReturn {
	// ── 検査表示（maplibre-gl-inspect 相当・#174）＝ベクタタイルの全 source-layer を層ごとの色で描き、カーソルの下の地物の属性を出す ──────────
	// ここは地図の内側の 2 つだけ（本体の UI・札・色・層の出し入れは gadgets/inspect.js＝遅延 chunk）：
	//   ① 層の台帳（段 2）＝source ごとの source-layer 一覧。出所の順：TileJSON の vector_layers → PMTiles の metadata → どちらも無ければ画面の中心のタイルを
	//      解いて層名を集める（地域の基図＝style が使わない層も・本人裁定 2026-09-30「タイルの全層」）。解いて集めた分は視点が変わるたびに足す（z で層が変わる）。
	//      出すのは vector と geojson の source だけ＝世界の帯（z<6.5 の Natural Earth＝gint の内部層）は出さない（本人裁定＝maplibre-gl-inspect と同じ範囲）
	//   ② 下地（段 3）＝基図の全層・自動の建物・注記・世界の帯（内部層・世界の色）・利用者の他の層・画像タイル層を伏せ、陸を背景色に。
	//      どれも「結合から外す／表示の旗／view の値」だけ＝基図を焼き直さない（restyleBase は使わない）。控えて、戻すと元の絵
	const inspectFound = new Map<string, Map<string, InspectLayer>>();   // sid → Map<層名, { id, fields }>（タイルを解いて集めた分＝足すだけ）
	const inspectTried = new Map<string, Set<string>>();   // sid → Set<"z/x/y">（解いたタイル＝同じ所は取り直さない）
	const inspectTileLayers = async (sid: string, desc: VtxDesc, isBase: boolean) => {   // 画面の中心のタイルを 1 枚解いて層名を集める（全層＝need なし）
		const c = cam.center, lon = ((c[0] + 540) % 360) - 180, lat = Math.max(-85, Math.min(85, c[1]));
		// どのタイルか＝いま描いているタイル（基図＝lastTileOrder・vector の描く層＝その source の出しているタイル）のうち中心を含む一番細かい物。まだ描いていなければ今のズームの 1 つ上（512px のタイル）
		let t: number[] | null = null;
		for (const o of (isBase ? live.lastTileOrder : live.vtdCtl?.shownTiles(sid)) || []) { const [tz, tx, ty] = o.key.split("/").map(Number), [cx, cy] = lonLatToTile(lon, lat, tz); if (cx === tx && cy === ty && (!t || tz > t[0])) t = [tz, tx, ty]; }
		if (!t) { const tz = Math.max(desc.minzoom ?? 0, 0, Math.min(desc.maxzoom ?? 22, Math.floor(cam.zoom) - 1)); t = [tz, ...lonLatToTile(lon, lat, tz)]; }
		const [z, x, y] = t, key = `${z}/${x}/${y}`;
		const tried = inspectTried.get(sid) ?? new Set(); inspectTried.set(sid, tried);
		if (tried.has(key)) return; tried.add(key);
		let data: Awaited<ReturnType<typeof fetchMVT>> | ReturnType<typeof decodeTile> | null = null;
		try {
			if (desc.pmtiles) {
				const b = await fetchPMTilesRaw(desc.pmtiles, z, x, y), info = b ? await pmtilesInfo(desc.pmtiles) : null;
				if (b && info && !isRasterTileType(info.tileType)) { await loadTileFormat(info.tileType); data = decodeTile(b, null, info.tileType); }
			} else {
				const url = desc.tileUrl?.(z, x, y); if (!url) return;
				const rq = requester.forTiles()(url, "Tile");
				data = rq?.load ? await fetchMVT(rq.url, null, null, null, await rq.load() as ArrayBuffer | null, desc.encoding || "mvt")
					: await fetchMVT(rq?.url ?? url, null, null, rq ? { headers: rq.headers, credentials: rq.credentials } : null, null, desc.encoding || "mvt");
			}
		} catch (err) { tried.delete(key); console.warn(`[inspect] cannot read tile ${key} of "${sid}"`, err); return; }
		const m = inspectFound.get(sid) ?? new Map(); inspectFound.set(sid, m);
		for (const [name, L] of Object.entries(data || {})) {
			if (name === "__empty" || m.has(name)) continue;
			const fields: Record<string, string> = {}; for (const f of (L?.features || []).slice(0, 64)) for (const k of Object.keys(f.props || {})) fields[k] ??= "";   // 属性の名前（型は申告が無い＝空）
			m.set(name, { id: name, fields });
		}
	};
	const inspectSources = async () => {   // → [{ id, type:"vector"|"geojson", layers:[{ id, fields, minzoom?, maxzoom? }]|null, from:"tilejson"|"pmtiles"|"tiles"|null }]（出す順＝基図→足した順）
		const base = BASE_SOURCE.kind !== "none" && !mlSources.has(baseSidNow()) ? baseSidNow() : null;
		const ids = [...(base ? [base] : []), ...[...mlSources].filter(([, sp]) => sp?.type === "vector" || sp?.type === "geojson").map(([id]) => id)];
		const out = await Promise.all(ids.map(async sid => {
			const sp = (sid === base ? baseSrcSpec(sid) : mlSources.get(sid))!;
			if (sp.type === "geojson") return { id: sid, type: "geojson", layers: null, from: null };
			const desc = await vtxDescOf(sid, sp).catch(err => { console.warn(`[inspect] source "${sid}"`, err); return null; });
			if (!desc) return null;
			let vl: InspectLayer[] | null = (sid === base ? live.EXT?.src?.vectorLayers : desc.vectorLayers) ?? null, from: string | null = vl?.length ? "tilejson" : null;
			if (!vl?.length && desc.pmtiles) { vl = (await pmtilesInfo(desc.pmtiles).catch(() => null))?.vectorLayers ?? null; from = vl?.length ? "pmtiles" : null; }
			if (!vl?.length) { await inspectTileLayers(sid, desc, sid === base); vl = [...(inspectFound.get(sid)?.values() ?? [])]; from = "tiles"; }
			return { id: sid, type: "vector", layers: vl, from };
		}));
		return out.filter(Boolean);
	};
	let inspectSaved: { autoBld: boolean; layers: string[]; rasters: string[] } | null = null;   // 伏せる前の姿（自動の建物・利用者の層の表示・画像タイル層の表示）
	const inspectView = {
		get on() { return live.inspectHide; },
		// on＝伏せる（background＝陸の色）。何度呼んでも控えは最初の 1 回（背景色だけ替わる）
		set(on: boolean, { background = "#fff" }: { background?: string } = {}) {
			if (on) {
				const bgc = parseRGBA(background) ?? [1, 1, 1, 1];
				live.inspectReapply = () => renderer.set("view", { land: bgc, worldHypsoZ: 0, graticule: false, night: false });   // 世界の色（ハイプソ・湖・海面下・罫線）は退場ズーム 0＝外来 style と同じ・夜面なし
				if (!live.inspectHide) {
					live.inspectHide = true;
					const layers: string[] = [], rasters: string[] = [];
					for (const [id, v] of [...mlLayers]) if (v.kind !== "custom" && mlVisible(v)) { layers.push(id); map.setLayoutProperty(id, "visibility", "none"); }   // 利用者の層（外来 style の vector/geojson/画像の層も）。custom 層は layout を持たない＝そのまま
					for (const r of map.raster.list()) if (!mlLayers.has(r.id) && r.opts?.visible !== false) { rasters.push(r.id); map.raster.set(r.id, { visible: false }); }   // 画像タイル層（地域の写真・外来 style の画像・日影…）
					inspectSaved = { autoBld: live.autoBldHidden, layers, rasters };
					setAutoBld(true);
					gint.setInternalHidden(true); gint.hoverTip?.(null); gint.worldTipOn = false;
					remergeBase();
				}
				live.inspectReapply();
			} else if (live.inspectHide) {
				live.inspectHide = false; live.inspectReapply = () => {};
				const sv = inspectSaved!; inspectSaved = null;
				setAutoBld(sv.autoBld);
				gint.setInternalHidden(false);
				renderer.set("view", { land: live.land, worldHypsoZ: BASEMAP_MINZOOM, graticule: WORLD_VT, night: opts.night !== false });   // 起動の値（boot の set("view") と同じ）・陸は今のテーマの色
				for (const id of sv.rasters) map.raster.set(id, { visible: true });
				for (const id of sv.layers) if (mlLayers.has(id)) map.setLayoutProperty(id, "visibility", "visible");
				remergeBase();
			}
			requestDraw();
		},
	};
	registerGadget("inspect", (m, opts) => {   // 検査表示 … 層の台帳と下地の切り替え・座標の変換を注入。本体（inspect.js）は初回に import()＝初期バンドルから隔離
		return inspectGadget.call(m, { signal: ac.signal, ...opts, listSources: inspectSources, view: inspectView, canvas, evXY });   // 内側の口は利用者の opts より後＝上書きさせない（opts.sources＝公式の「明示の層」とは別名）
	});
	// ローカル容器（.gpkg/.mbtiles）の画像タイル＝"drop" 層として基図に（塗りは伏せる）。fallback＝タイル表が無ければ false（呼び手がベクタ本道へ）
	const rasterDropFile = async (file: File, fallback = false) => {
		live.annoCtl?.clear(); live.cogCtl?.clear();
		try {
			const info = await map.raster.add("drop", { file }, { order: "under", hideFills: true });
			if (info?.bbox) { const bb = info.bbox, cx = (bb[0] + bb[2]) / 2, cy = (bb[1] + bb[3]) / 2, wDeg = Math.max(1e-6, (bb[2] - bb[0]) * 1.3), hDeg = Math.max(1e-6, (bb[3] - bb[1]) * 1.3);
				flyTo(cx, cy, Math.max(3, Math.min(17, Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg))))), 0); }
			return { length: t("raster tiles z$1–$2", info?.minZoom ?? "?", info?.maxZoom ?? "?") };
		} catch (err) {
			if (fallback && /no tile table/.test(String((err as Error | null)?.message))) return false;
			throw err;
		}
	};
	registerGadget("dropFile", (m, opts) => {   // GISファイルのD&D取り込み … loadUserFile（上）を束ね注入（gint単一スロット＝置き換え）
		return dropFileGadget.call(m, { loadFile: loadUserFile, unprojectAt, clearGint: () => { live.gFollow?.destroy(); live.gFollow = null; live.annoCtl?.clear(); live.czmlCtl?.clear(); live.cogCtl?.clear(); live.modelCtl?.clear(); live.modelCtl?.clearExtrude(); clearImages(); map.raster.remove("drop"); gint.clearUserGint(); live.columnarCtl?.remove(); live.columnarCtl = null; live.editDocHook?.(null); }, playScene: scenes.playScene, busy: scenes.playingNow, yieldTo: () => live.editDropOwner, signal: ac.signal, ...opts });   // busy＝上映中はドロップ無視（デモ中はドロップ禁止）。消去は注釈レイヤも一緒に
	});
	registerGadget("geoedit", (host, opts) => {   // GeoPBF トポロジカル編集＝geoedit（npm）（packages/geoedit・MIT・2026-09-20 に分離・遅延chunk）… 公開面だけで動く＝ここは import と結線だけ。戻り値＝Promise<editor>
		// ホスト契約：言語（エディタは自前の 26 言語表）・左下ドック・クラウド保存パネル（japan の共通の器）を注入。搭載中はドロップをエディタが所有（dropFile は譲る）
		return Promise.all([import("geoedit"), import("../gadgets/cloud.ts")]).then(async ([m, cloud]) => {
			await m.setLang(getLang());
			// 公開の GeoPBF（globe.d.ts）は geopbf の GeoPBF の主要面の写し（SDK の d.ts を自足に保つ）＝userPbf() の戻りだけが EditorMap の求めより狭い。実行時は geopbf の GeoPBF そのもの
			return m.initEditor(host as typeof host & { userPbf(): GeoPBFFull | null }, { setDropOwner: on => { live.editDropOwner = !!on; }, dock: dockStack, cloudPanel: cloud.cloudPanel, ...opts });
		});
	});
	registerGadget("edit", (m, opts) => {   // 編集ボタン（左上スタック）… 押すと map.gadget.geoedit() を部品として搭載/解除。出現域は搭載側の zoom 宣言（site.js＝[2.5,99]）
		// 編集中の図形（2026-09-19 本人裁定）：japan は図形を一つ持つ（初めは空）。ドロップ/?g= で読んだもの・編集から戻したものがそれ＝
		// 専用の置き場（editdoc＝単独 geoedit の自動保存とは別）へ保存し、次に開いた時も続きから。編集＝geoedit に渡して部品として開き、
		// 右端の「×」（かこのボタン）で結果を受け取り置き換える。?g= で開いた時は ?g= が勝つ（前回分は復元しない＝上書きされる）
		let doc: { buf: ArrayBuffer; name: string } | null = null;   // { buf: GeoPBF の ArrayBuffer, name（.geopbf） }
		const asGeopbf = (name: string | undefined) => String(name || "edit").replace(/\.[^./]+$/, "") + ".geopbf";   // 中身は GeoPBF＝拡張子で変換を誤らせない
		live.editDocHook = (pbf, name, persist) => {
			if (!pbf) { doc = null; editDocClear(); return; }
			doc = { buf: pbf.arrayBuffer.slice(0), name: asGeopbf(name) };   // 編集ボタンが開く「今の図形」はいつでも（見ただけでも）
			if (persist === "save") editDocSave(doc.buf, doc.name);   // 次の起動へ持ち越すのは編集の結果だけ
			else if (persist !== "keep") editDocClear();              // 見ただけ＝置き場を空に
		};
		if (!new URLSearchParams(location.search).get("g")) editDocLoad().then(rec => {
			if (!rec?.buf || doc) return;
			if (!rec.edited) { editDocClear(); return; }   // 旧い置き場（見ただけで残っていた・印なし）は復元せず捨てる
			loadUserFile(new File([rec.buf], rec.name || "edit.geopbf"), { fit: false, persist: "keep" });
		});
		return editGadget.call(m, {
			mount: ({ onClose }) => { live.annoCtl?.clear(); live.modelCtl?.clearExtrude(); clearImages(); return map.gadget.geoedit({ data: doc?.buf ?? null, persist: false, adopt: false, onClose }); },   // 注釈の再生は外す＝エディタが同じ図形を描く（二重に見せない）
			onResult: async buf => {
				if (buf) await loadUserFile(new File([buf], doc?.name || "edit.geopbf"), { fit: false, persist: "save" });
				else { live.annoCtl?.clear(); live.modelCtl?.clearExtrude(); clearImages(); gint.clearUserGint(); live.editDocHook!(null); }   // 全部消して戻った＝編集中の図形も空へ
			},
			signal: ac.signal, ...opts,
		});
	});
	registerGadget("demo", (m, opts) => {   // デモ（発表の台本再生）… 台本の一行=共有URLハッシュ。flyView（球面フライト）・フライト中判定・PLATEAU先読み・現テーマ名（幕替わり判定）を注入
		// 終演の定位置＝地域が申告する「全体」（home.view の中心・home.span の縦横の度幅）を真俯瞰・北向きで画面に収める
		// （fitBbox と同じ視野幅の逆解き＝縦横どちらの画面でも収まる）。span の無い地域・地球儀は既定の起動視点へ
		const homeFit = () => {
			const [lon, lat, zoom] = HOME_VIEW, span = REGION_HOME?.span;
			if (!span) { flyTo(lon, lat, zoom, 0, 0); return; }
			const wDeg = span[0] * 1.15, hDeg = span[1] * 1.15;
			const z = Math.min(Math.log2(360 * size.w / (WORLD_PX * wDeg)), Math.log2(360 * size.h / (WORLD_PX * hDeg)));
			flyTo(lon, lat, Math.max(ZOOM_MIN, Math.min(7, z)), 0, 0);
		};
		scenes.demoHandle = demoGadget.call(m, { flyView, fadeView: scenes.fadeViewRun, glidePath: glidePathView, flightActive: () => flightCtl.active || scenes.fadeBusy,
			// 書き終わりの合図（自動上演の行送りゲート・裁定2026-08-12「非力機は書き終わるまで待つ」）＝可視の立ち上げ
			// (autoMesh発＝prefetchは含めない・ackはクレジット窓2で「ほぼ描き切り」)・標高タイル・基図sig（z<4は
			// mainスロット空でsigが恒久不一致＝地球儀シーンを堰き止めないよう z≥4 限定）。裏仕込み(prefetch)は幕を止めない。
			// 返り値＝進捗指紋の文字列（空=静か）：demo側は「指紋が動く間だけ」待つ＝止まった待ち（オフライン等）は打ち切れる。
			loadingActive: () => {
				const base = cam.zoom >= 4 && live.readySig !== live.mainDesired;
				// 待つのは「これから見える区」だけ＝demote（視界外の在庫化）・cancel 中の区は指紋に載せない。旧・全ロード中区の
				// 進捗を載せていたため、目の前の区が読み終わっても隣の在庫区のバッチ進捗が動き続けて上限（20s）まで幕が進まなかった
				//（本人報告 2026-09-08「途中で Plateau の読みが終わると再開しない」＝R2 焼きで本命が数秒で終わるようになり顕在化）
				const shown = meshMgr.visibleLoading();
				if (!shown.length && !live.elevBusy && !base) return "";
				return `A${shown.join(".")}|P${shown.map(n => { const p = meshMgr.progress.get(n); return p ? (p.done ?? p.scan ?? 0) : "-"; }).join(".")}|E${live.elevN}|B${base ? 1 : 0}`;
			},
			// 静穏窓フック（裁定2026-08-12）＝書き終わり直後の一拍で「残り台本に出ない」常駐区を降ろす（上の trim 参照）
			onQuiet: views => meshMgr.trimForScript(views),
			prefetchViews: meshMgr.prefetch, finale: homeFit, signal: ac.signal, zoomMin: CAM_ZOOM_MIN, ...opts });   // 手綱を掴む＝ドロップ/?scene= は playScene→demoHandle.start(落とした台本, bare) で別入り口再生（▶=組み込みは壊さない）。glidePath＝via連続ドリー／fadeView＝黒挟み遷移（fadeBusy を着地待ちに乗せる）
		return scenes.demoHandle;
	});
	return { rasterDropFile };
}
