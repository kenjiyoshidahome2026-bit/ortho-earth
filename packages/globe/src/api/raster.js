// 画像タイル層（map.raster＝台帳・render worker への指示・地域パックのカタログと ?r= の同期・独自スキームの読み口・四隅の動画）
// ＝createGlobe から切り出した（globe.js の分割 ⑨・2026-10-15）。中身は切り出す前と同じ。createGlobe の他の所が使う物は戻り値で返す。
//   live＝createGlobe の変数（let・この呼び出しより後で宣言される定数）を読み書きする口（getter／setter）。その他＝createGlobe の中の定数・関数（中身は createGlobe と共有）
import { expandTemplate, wmsTemplate } from "@ortho-earth/core";
import { sanitizeHTML } from "geopbf/sanitize";

export function installRaster(map, live, {
	LOW_MEM, REGION_RASTERS, TILE_BIAS, URL_OWN, opts, ownDestroy, rasterBootQ, requestDraw, requester, t, wPost
}) {
	// ── 画像タイル層（メルカトル XYZ ラスタ）＝v1 base.js/Layers の後継（2026-09-21）。本体は render worker（ortho-core/raster）。
	// ここは台帳（id→spec/opts/info）と指示（rasterAdd/Remove/Set）・ローカル容器（gpkg/mbtiles）のプロバイダ worker・
	// カタログ（地域パック rasters＝外から定義）と ?r= の同期。外から定義できる口＝三つ：地域パック（REGION.rasters）／
	// URL（?xyz= ?pm= ?r=）／公開 API（map.raster.add＝自前契約の URL テンプレ・ラスタ PMTiles・MessagePort プロバイダ）。
	const rasterReg = new Map();   // id → { spec, opts, info, error, worker, attrHTML, _res, _rej }
	ownDestroy.push(() => { for (const r of rasterReg.values()) { r.worker?.terminate(); r.port?.close(); r._rej?.(new Error("destroyed")); } rasterReg.clear(); });   // 提供側 worker（main 所有）
	const rasterCbs = new Set();
	const rasterStatWait = new Map(); let rasterStatSeq = 0;
	const rasterChanged = () => { live.attrZone = null; requestDraw(); for (const cb of rasterCbs) { try { cb(); } catch (e) { console.error("[raster] onChange", e); } } };
	const imageAttrs = new Map();   // 四隅で貼った画像（覆う＝オーバーレイ）の出典 id → 消毒済み HTML（画像層の出典と同じ欄に並べる）
	const rasterAttrHTML = () => [...rasterReg.values()].map(r => r.attrHTML).concat([...imageAttrs.values()]).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join("・");
	const hostOf = u => { try { return new URL(String(u).replace(/^pmtiles:\/\//, "")).host; } catch { return null; } };
	function onRasterInfo(id, info) {
		const rec = rasterReg.get(id); if (!rec) return;
		rec.info = info;
		// 出典＝ソースの自己申告（PMTiles/MBTiles の metadata・カタログの宣言）を消毒して出す。無ければホスト名（無出典で他人の絵を出さない）
		rec.attrHTML = info?.attribution ? sanitizeHTML(String(info.attribution)) : (rec.spec?.url ? hostOf(rec.spec.url) : rec.spec?.pmtiles ? hostOf(rec.spec.pmtiles) : (info?.name ? sanitizeHTML(String(info.name)) : null));
		rec._res?.(info); rec._res = rec._rej = null;
		rasterChanged();
	}
	function onRasterError(id, error) {
		const rec = rasterReg.get(id); if (!rec) return;
		rec.error = error;
		if (rec._rej) { rasterReg.delete(id); rec.worker?.terminate(); rec._rej(new Error(error)); rec._res = rec._rej = null; rasterChanged(); }
		else console.warn("[raster]", id, error);
	}
	const catalogSpec = c => ({ url: c.url, tileSize: c.tileSize || 256, minZoom: c.minZoom, maxZoom: c.maxZoom, bbox: c.bbox || null, subdomains: c.subdomains, tms: c.tms,
		name: c.key ? t(c.key) : (c.name || c.id),
		attribution: c.attribution ? (c.attribution.href ? `<a href="${c.attribution.href}" target="_blank" rel="noopener">${c.attribution.key ? t(c.attribution.key) : c.attribution.text}</a>` : (c.attribution.key ? t(c.attribution.key) : c.attribution.text)) : null });
	// ?r=<id,id…>＝今の選択（基図＋重ね）を URL の search に写す（hash＝視点とは別の静的パラメータ）。埋め込み（target）ではホストの URL に触れない
	const rasterSyncURL = () => {
		if (opts.target || !URL_OWN) return;   // 埋め込み・URL の持ち主でない地図は書かない
		try {
			const sel = map.raster.selected(), ids = [sel.base, ...sel.overs].filter(Boolean);
			const u = new URL(location.href);
			if (ids.length) u.searchParams.set("r", ids.join(",")); else u.searchParams.delete("r");
			if (u.href !== location.href) history.replaceState(history.state, "", u.href);
		} catch { /* 履歴 API 不可の環境＝無害 */ }
	};
	// 独自スキームの画像タイル（addProtocol・#37）＝port プロバイダの契約（raster-src.js）で main から画像を渡す：
	// info を 1 通 → 要求 { id, z, x, y } に読み口で本体を取り、ImageBitmap にして返す（transfer）。中断 { id, abort } は読み口の AbortController へ
	function serveProtocolRaster(port, tpl, spec) {
		const acs = new Map();
		const subs = typeof spec.subdomains === "string" ? spec.subdomains.split("") : spec.subdomains || null;
		port.postMessage({ type: "info", info: { tileSize: spec.tileSize || 256, minZoom: spec.minZoom ?? 0, maxZoom: spec.maxZoom ?? 18, bbox: spec.bbox || null, attribution: spec.attribution || null, name: spec.name || null } });
		port.onmessage = async e => {
			const { id, z, x, y, abort } = e.data || {};
			if (abort) { acs.get(id)?.abort(); acs.delete(id); return; }
			const ac = new AbortController(); acs.set(id, ac);
			try {
				const rq = requester.resolve(expandTemplate(tpl, z, x, y, subs, !!spec.tms, spec.matrixIds, spec.tileSize || 256), "Tile");
				// 独自スキームは MapLibre と同じく type:"image" で頼む（maplibre-cog-protocol は "image" だけを受ける・公式例の門 2 巡目）。返りは画像・ImageBitmap・ImageData・Blob・ArrayBuffer のどれでも
				const d = rq.load ? await rq.load("image", ac) : await (await requester.fetch(rq.url, "Tile", { signal: ac.signal })).arrayBuffer();
				const bitmap = await protocolBitmap(d);
				port.postMessage({ id, bitmap }, bitmap ? [bitmap] : []);
			} catch (err) { if (!ac.signal.aborted) port.postMessage({ id, bitmap: null, error: String(err?.message || err) }); }
			finally { acs.delete(id); }
		};
	}
	// 独自の読み口（addProtocol）が type:"image" に返す物→ImageBitmap（画像・ImageBitmap・ImageData・canvas・Blob・ArrayBuffer のどれでも）。画像タイル層と raster-dem（陰影・段彩）で共有（2026-09-30）
	async function protocolBitmap(d) {
		const bmOpts = { premultiplyAlpha: "none", colorSpaceConversion: "none" };
		return d == null ? null
			: typeof ImageBitmap !== "undefined" && d instanceof ImageBitmap ? d
			: (typeof HTMLImageElement !== "undefined" && d instanceof HTMLImageElement) || (typeof ImageData !== "undefined" && d instanceof ImageData) || (typeof HTMLCanvasElement !== "undefined" && d instanceof HTMLCanvasElement) || (typeof OffscreenCanvas !== "undefined" && d instanceof OffscreenCanvas) ? await createImageBitmap(d, bmOpts)
			: d instanceof Blob ? await createImageBitmap(d, bmOpts)
			: (d.byteLength ?? 0) > 0 ? await createImageBitmap(new Blob([d]), bmOpts) : null;
	}
	// 四隅の動画（#49）＝覆いのオーバーレイ（imagequad の組み込み・注記の下）へ毎コマ差し替え。動画を使うまで chunk も overlay も作らない
	const videoGet = async () => live.videoCtl ??= (await import("../gadgets/videoquad.js")).createVideoQuads({ overlay: () => map.overlay({ builtin: "imagequad" }, { name: "videoquad" }), maxSide: LOW_MEM ? 1024 : 2048 });
	ownDestroy.push(() => live.videoCtl?.clear());
	map.raster = {
		catalog: REGION_RASTERS,
		// add(id, spec, opts)：spec＝{ url:"…/{z}/{x}/{y}.png", minZoom, maxZoom, bbox, attribution, subdomains, tms, headers }｜{ pmtiles:"…" }｜{ file: File(.gpkg/.mbtiles), table? }｜{ port: MessagePort }
		//                     ｜{ image: Blob|ImageBitmap, corners: [[lon,lat]×4 左上→右上→右下→左下], name? }（四隅で貼る＝MapLibre の image source 相当・2026-09-21）
		//                     ｜{ video: HTMLVideoElement|URL|[URL…], corners }（四隅の動画＝MapLibre の video source 相当・#49）＝地面に焼かず覆う（基図の上・注記の下）。戻り＝{ getVideo, play, pause, seek, setCoordinates }
		//                     opts＝{ order:"under"|"over", opacity, visible, hideFills（under 既定 true）, minZoom, maxZoom（表示域） }。戻り＝ソースの自己申告（info）
		async add(id, spec, o = {}) {
			if (rasterReg.has(id) || live.videoCtl?.get(id)) map.raster.remove(id);
			if (spec?.canvas) return (await videoGet()).add(id, { canvas: spec.canvas, corners: spec.corners, opacity: o.opacity ?? 1, animate: spec.animate !== false });   // 四隅の canvas（MapLibre の canvas source・C3）＝動画と同じ覆い
			if (spec?.video) {   // 四隅の動画＝毎コマ差し替える覆いの口（gadgets/videoquad.js・遅延 chunk）
				const v = spec.video, isEl = typeof HTMLVideoElement !== "undefined" && v instanceof HTMLVideoElement;
				return (await videoGet()).add(id, { video: isEl ? v : null, urls: isEl ? null : v, corners: spec.corners, opacity: o.opacity ?? 1 });
			}
			const rec = { spec, opts: { tileBias: TILE_BIAS, ...o }, info: null, error: null, worker: null, attrHTML: null, _res: null, _rej: null };   // tileBias＝目盛り "mercator" で画像タイルの z も MapLibre と同じに
			rasterReg.set(id, rec);
			let wireSpec = spec, transfer = spec && spec.port ? [spec.port] : [];   // 外部プロバイダ（MessagePort）＝そのまま render worker へ transfer
			// 取得の前の手入れ（#37）：URL の型紙は worker が組む＝ヘッダ/credentials はソース単位で一度だけ決める。独自スキーム＝main が読み口で取って port で渡す
			if (spec && (spec.url || spec.wms) && !spec.pmtiles && !/\.pmtiles(\?|#|$)|^pmtiles:/i.test(spec.url || "")) {
				const tpl = spec.url || wmsTemplate(spec.wms), rq = requester.resolve(tpl, "Tile");
				if (rq.load) { const ch = new MessageChannel(); serveProtocolRaster(ch.port1, rq.url, spec); wireSpec = { port: ch.port2, name: spec.name || null, attribution: spec.attribution || null }; transfer = [ch.port2]; rec.port = ch.port1; }
				else if (rq.url !== tpl || rq.headers || rq.credentials) wireSpec = { ...spec, wms: undefined, url: rq.url, headers: rq.headers ? { ...(spec.headers || {}), ...rq.headers } : spec.headers, credentials: rq.credentials ?? spec.credentials };
			}
			let iiifMaps = null, iiifAttr = null, iiifFallback = null;
			if (spec?.iiif) {   // 基準点の注記（Georeference Annotation・#177）＝main で読んで解き、画像と写像は worker が持つ
				try { ({ maps: iiifMaps, attribution: iiifAttr, fallback: iiifFallback } = await live.iiifOpen(spec.iiif, spec.attribution)); }
				catch (err) { if (rasterReg.get(id) === rec) rasterReg.delete(id); throw err; }
			}
			if (spec && (spec.file || spec.image || spec.iiif)) {   // ローカル容器／四隅で貼る画像／IIIF の古地図＝プロバイダ worker（main 所有・入れ子 worker 禁止）→ port を render worker へ＝タイルは worker→worker
				const w = spec.iiif
					? new Worker(new URL("../worker.js", import.meta.url), { type: "module", name: "iiif" })   // 基準点で歪みを直した IIIF の画像＝タイルに焼く（iiif-worker.js・#177）
					: spec.image
					? new Worker(new URL("../worker.js", import.meta.url), { type: "module", name: "imagequad" })   // 四隅の画像＝射影変換でタイルに焼く（imagequad-worker.js）
					: new Worker(new URL("../worker.js", import.meta.url), { type: "module", name: "rastertiles" });
				rec.worker = w;
				const ch = new MessageChannel();
				const opened = new Promise((res, rej) => {
					w.onmessage = e => { const d = e.data || {}; if (d.type === "opened") res(d.info); else if (d.type === "error") rej(Object.assign(new Error(d.error), { vectorLayers: d.vectorLayers })); };
					w.onerror = e => rej(new Error(e.message || "raster provider worker error"));
				});
				if (spec.iiif) w.postMessage({ type: "open", maps: iiifMaps, name: spec.name || null, attribution: iiifAttr, fallbackAttribution: iiifFallback, port: ch.port1 }, [ch.port1]);
				else if (spec.image) w.postMessage({ type: "open", image: spec.image, corners: spec.corners, name: spec.name || null, attribution: spec.attribution || null, maxSide: LOW_MEM ? 2048 : 4096, port: ch.port1 }, [ch.port1]);   // 省メモリ機＝長辺 2048（RGBA＋ミップ ≈21MB・4096 だと ≈85MB＝Air3 jetsam の轍）
				else w.postMessage({ type: "open", file: spec.file, table: spec.table || null, port: ch.port1 }, [ch.port1]);
				try { await opened; } catch (err) { w.terminate(); if (rasterReg.get(id) === rec) rasterReg.delete(id); throw err; }
				if (rasterReg.get(id) !== rec) { w.terminate(); throw new Error("removed while opening"); }
				const opened_ = await opened.catch(() => null);   // 開いた時の情報（iiif＝info.json の attribution・ホスト名まで決まった出典）
				wireSpec = { port: ch.port2, name: spec.name || spec.file?.name || (spec.iiif ? "iiif" : "image"), attribution: (spec.iiif ? opened_?.attribution ?? iiifAttr : spec.attribution) || null }; transfer = [ch.port2];
			}
			const done = new Promise((res, rej) => { rec._res = res; rec._rej = rej; });
			wPost({ type: "set", cmd: "rasterAdd", prop: id, data: { spec: wireSpec, opts: rec.opts } }, transfer);
			rasterChanged();
			return done;
		},
		remove(id) { if (live.videoCtl?.remove(id)) { requestDraw(); return true; } const rec = rasterReg.get(id); if (!rec) return false; rasterReg.delete(id); rec.worker?.terminate(); rec.port?.close(); rec._rej?.(new Error("removed")); wPost({ type: "set", cmd: "rasterRemove", prop: id }); rasterChanged(); return true; },
		set(id, o) { if (live.videoCtl?.get(id)) return o.opacity != null ? live.videoCtl.setOpacity(id, o.opacity) : true; const rec = rasterReg.get(id); if (!rec) return false; Object.assign(rec.opts, o); wPost({ type: "set", cmd: "rasterSet", prop: id, data: o }); rasterChanged(); return true; },
		list: () => [...rasterReg].map(([id, r]) => ({ id, info: r.info, spec: r.spec, opts: r.opts, error: r.error })),
		info: id => rasterReg.get(id)?.info ?? null,
		stats: () => new Promise(res => { const sid = ++rasterStatSeq; rasterStatWait.set(sid, res); wPost({ type: "rasterStats", id: sid }); setTimeout(() => { if (rasterStatWait.delete(sid)) res(null); }, 5000); }),
		onChange(cb) { rasterCbs.add(cb); return () => rasterCbs.delete(cb); },
		// カタログ（地域パック）から：基図（under）はラジオ＝1 枚（null＝ベクタ地図に戻す）／重ね（over）はトグル。?r= を同期
		async select(cid) {
			const c = cid ? REGION_RASTERS.find(x => x.id === cid && (x.order || "under") !== "over") : null;
			if (cid && !c) throw new Error(`raster: unknown base "${cid}"`);
			if (!c) { map.raster.remove("base"); rasterSyncURL(); return null; }
			const info = await map.raster.add("base", catalogSpec(c), { order: "under", opacity: c.opacity ?? 1, hideFills: true, catalogId: c.id });
			rasterSyncURL(); return info;
		},
		async toggle(cid, on) {
			const c = REGION_RASTERS.find(x => x.id === cid && x.order === "over");
			if (!c) throw new Error(`raster: unknown overlay "${cid}"`);
			const id = "ov:" + c.id, has = rasterReg.has(id), want = on == null ? !has : !!on;
			if (want === has) return has;
			if (want) await map.raster.add(id, catalogSpec(c), { order: "over", opacity: c.opacity ?? 0.7, hideFills: false, catalogId: c.id }); else map.raster.remove(id);
			rasterSyncURL(); return want;
		},
		selected: () => ({ base: rasterReg.get("base")?.opts?.catalogId ?? null, overs: [...rasterReg].filter(([id]) => id.startsWith("ov:")).map(([, r]) => r.opts.catalogId).filter(Boolean) }),
	};
	{	// 起動待ち行列の解放＝初フレーム後（render worker 初期化前の set は捨てられる）
		const off = map.onFrame(() => { off(); live.rasterBoot = fn => fn(); for (const fn of rasterBootQ.splice(0)) fn(); });
	}
	return { onRasterInfo, onRasterError, rasterStatWait, rasterAttrHTML, imageAttrs, rasterChanged, protocolBitmap };
}
