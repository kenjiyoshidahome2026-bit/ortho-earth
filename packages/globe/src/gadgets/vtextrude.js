// ベクタタイルの押し出し（MapLibre の fill-extrusion を vector source で・段 8①・2026-09-26）の main 側。中身は vtextrude-worker.js・幾何は vtmesh.js。
// 既存の経路（geojson の押し出し＝model.js・PLATEAU・3D Tiles・renderworker・renderer）は触らない＝メッシュ経路（setMesh / meshVis）の「使う側」を一つ足すだけ。
//   選び＝core selectLOD（基図と同じ選び）を MapLibre の vector source と同じ尺で（512px タイルを丸めた z＝tilePx 512√2）・source の min/maxzoom（上は過拡大）・
//         範囲（TileJSON の bounds・地域の基図の配信圏）・遠景の打ち切り（最細の z −2 より粗い物は取らない・枚数の上限・予算を見て遠い方から落とす）。
//   取得＝main が requester で（transformRequest・addProtocol の読み口）・PMTiles は core の生バイトの口。生バイトは worker が預かる（出し入れの予算は main）。
//   置き換え＝vtmesh.retainTiles（子が全部揃うまで祖先を出す＝穴もダブりも出さない）。出し入れと出しズームは rAF ごと（フライト中も）・取得と組み立てだけフライト中は止める。
//   送る速さ＝main で 1 フレーム 1 件に絞って setMesh（renderworker の背圧に頼らない）。新しいメッシュは伏せて送り、選びが出すと決めた時に meshVis で出す。
//   ズームの式＝止まった時に曲線の鍵（vtmesh.paintZoomKey）を見て、変わった層だけ出ているタイルから組み直す（幾何は worker に残す＝高さと色だけ）。
//   メッシュ＝1 タイル・1 層・1 本（名前 vtx:<層 id>:<z/x/y>#0）・drape（どこでも地表の標高へ）・keep2d（真上からも屋根）・伏せ枠なし・半透明は BLEND。
// 問い合わせ＝worker に残した「描いた地物」から、光線の地面の区間で候補を絞り、屋根と壁の画面の投影で当てる（MapLibre の押し出しの当て方）。
import { selectLOD, fetchPMTilesRaw, pmtilesInfo, isRasterTileType, evalExpr } from "@ortho-earth/core";
import { retainTiles, paintZoomKey, filterZoom, hasZoom, tileKey } from "../vtmesh.js";
import { hitExtrusion } from "../extrude-ml.js";   // 当たり＝geojson の押し出しと同じ（屋根と壁・奥行き）

const R2D = 180 / Math.PI;
const tileBbox = (z, x, y) => { const n = 2 ** z, lat = v => R2D * Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))); return [x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)]; };
const hits = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
const evalIn = (e, z) => evalExpr(e, { zoom: z, props: {}, geom: null, vars: {}, origin: "ml" });
const inZoom = (L, z) => (L.minzoom == null || z >= L.minzoom) && (L.maxzoom == null || z < L.maxzoom);
const meshBytes = d => d.pos.byteLength + d.nrm.byteLength + d.idx.byteLength + d.uv.byteLength + d.col.byteLength;

// desc（source の記述子・globe が作る）＝{ tileUrl:(z,x,y)=>URL|null, pmtiles: URL|null, minzoom, maxzoom, bounds:[w,s,e,n]|null, coverage:[w,s,e,n]|null, promoteId, tag（同じ source かの印） }
// 呼び手の口：size()＝{ w, h }（device px）・hitEnv()＝今の視点の当たりの口（extrude-ml.js の env＝vtx/roof・地形の持ち上げ込み・奥行き＝clip の w）・
//             unprojectAt(x, y, 高さ m)→[lon, lat]|null（候補の区間）・isFlying()
export function createVTExtrude(map, { cam, size, dpr = 1, lowMem = false, tileBias = 1, requester, setMesh, meshVis, meshPort = null, requestDraw = () => {}, isFlying = () => false, hitEnv, unprojectAt, ell = false, fstate = new Map(), fsKey = (sl, id) => `${sl}\u0000${typeof id}:${id}` } = {}) {
	const MESH_BUDGET = (lowMem ? 96 : 256) * 2 ** 20, RAW_BUDGET = (lowMem ? 16 : 48) * 2 ** 20;
	const MAX_TILES = lowMem ? 24 : 48, MAX_FETCH = lowMem ? 3 : 6, MAX_BUILD = 4, TILE_PX = 512 * Math.SQRT2, RETRY_MS = 2000, TRIES = 3;
	const sources = new Map();   // sid → { sid, desc, sig, tiles: Map<key, T>, fetching }   T＝{ state: loading|ready|empty|failed, bytes, used, ac, tries, failedAt }
	const layers = new Map();    // id → { layer, sid, on, gen, zkey, fzOf, tiles: Map<key, LT> }   LT＝{ state: none|ready|empty|failed, ward, bytes, on, zkey, fz, gen, building, hMax, nFeat, used }
	const uploads = [];          // [{ id, key, gen, lt, data }]
	// feature-state（MapLibre の setFeatureState＝source・sourceLayer・id）の置き場は呼び手（globe）＝sid → Map<fsKey(sourceLayer, id), { id, state }>（層より先に置かれても残る）。
	// ここは読むだけ（組み立てと問い合わせ）＋変わった地物を含むタイルに印（touchFS）。paint の ["feature-state"] だけが読む（filter は読まない＝MapLibre と同じ）
	const usesFS = L => JSON.stringify(L.paint ?? null).includes('"feature-state"');
	let clock = 0, building = 0, rafU = 0, rafP = 0, lastUpd = 0, settledZoom = cam.zoom, moving = false;
	// 送り口＝PLATEAU と同じ専用のポート（meshPort）＝render worker は 1 件適用するたびに受け取りの印（drained）を返す。
	// 印の数で送る量を絞る（背圧：遅い端末で render worker の列が溜まらない＝層を外した時の解放も待たされない）・isSourceLoaded は「描画側に載った」まで待つ。
	// 上げる・出し入れ・解放は同じポート＝順番が崩れない。ポートが無い時（検定の偽物など）は従来の setMesh / meshVis
	const MAX_INFLIGHT_UP = 2;
	let pendingAcks = 0;
	if (meshPort) meshPort.onmessage = ev => { if (ev.data?.drained) { pendingAcks = Math.max(0, pendingAcks - 1); pump(); schedule(); } };
	const sendMesh = (name, data) => {
		if (!meshPort) { setMesh(name, data); return; }
		meshPort.postMessage({ meshData: data, name }, data ? [...new Set([data.pos.buffer, data.nrm.buffer, data.idx.buffer, data.uv?.buffer, data.col?.buffer].filter(Boolean))] : []);
		pendingAcks++; requestDraw();
	};
	const sendVis = (ward, on) => { if (!meshPort) { meshVis(ward, on); return; } meshPort.postMessage({ vis: !!on, name: ward }); requestDraw(); };

	// ── worker 2 本（タイルの鍵で振る＝同じタイルの層は同じ worker＝解読と幾何を共有）──
	const workers = [], waiting = new Map(); let rpcSeq = 0;
	const workerOf = k => {
		let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0;
		const i = Math.abs(h) % 2;
		if (!workers[i]) {
			const w = new Worker(new URL("../worker.js", import.meta.url), { type: "module", name: "vtextrude" });   // 入口 1 本（worker.js）＝役割は name
			w.onmessage = e => { const p = waiting.get(e.data.id); if (!p) return; waiting.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data); };
			w.onerror = e => console.error("[vtextrude] worker error", e.message);
			workers[i] = w;
		}
		return { w: workers[i], i };
	};
	const rpc = (w, msg, transfer = []) => new Promise((res, rej) => { const id = ++rpcSeq; waiting.set(id, { res, rej }); w.postMessage({ id, ...msg }, transfer); });

	const schedule = () => { if (!rafU) rafU = requestAnimationFrame(() => { rafU = 0; update(); }); };
	const onMove = () => { moving = true; if (performance.now() - lastUpd > 120) schedule(); else setTimeout(schedule, 130); };
	const onSettle = () => { moving = false; settledZoom = cam.zoom; schedule(); };
	map.on("move", onMove); map.on("settle", onSettle);

	const wardOf = (id, key) => `vtx:${id}:${key}`;
	const setOn = (lt, on) => { if (lt.on === on || !lt.bytes) return; lt.on = on; sendVis(lt.ward, on); };
	const dropMesh = lt => { if (lt.bytes) sendMesh(lt.ward, null); lt.bytes = 0; lt.on = false; };
	const srcReady = T => T && (T.state === "ready" || T.state === "empty" || (T.state === "failed" && T.tries >= TRIES));   // 諦めたタイル＝空として数える（祖先に居座らせない）

	// ── 選び ──
	function wantedOf(src) {
		const { desc } = src, { w, h } = size();
		let ts = selectLOD(cam, w, h, { minZ: desc.minzoom ?? 0, maxZ: desc.maxzoom ?? 22, tilePx: TILE_PX * dpr * tileBias });   // tileBias＝目盛り "mercator" でタイルの z を MapLibre と同じに（globe.js の TILE_BIAS）
		const area = desc.bounds || desc.coverage;
		if (area) ts = ts.filter(t => hits(tileBbox(t.z, t.x, t.y), area));
		if (!ts.length) return [];
		const fine = Math.max(...ts.map(t => t.z));
		ts = ts.filter(t => t.z >= fine - 2);
		const [cx, cy] = cam.center, cw = Math.cos(cy / R2D);
		const d2 = t => { const b = tileBbox(t.z, t.x, t.y), dx = Math.max(b[0] - cx, 0, cx - b[2]) * cw, dy = Math.max(b[1] - cy, 0, cy - b[3]); return dx * dx + dy * dy; };
		ts.sort((a, b) => d2(a) - d2(b));
		ts = ts.slice(0, MAX_TILES);
		// 予算を見た選び＝組んだタイルは実際のバイト・まだの物はこの source の中央値（無ければ 1MB）で見積もり、遠い方から落とす（近い 1 枚は必ず残す）
		const own = [...layers.values()].filter(s => s.sid === src.sid && s.on), known = [];
		for (const s of own) for (const lt of s.tiles.values()) if (lt.bytes) known.push(lt.bytes);
		known.sort((a, b) => a - b);
		const est = known.length ? known[known.length >> 1] : 2 ** 20;
		let acc = 0; const out = [];
		for (const t of ts) {
			let b = 0; for (const s of own) b += s.tiles.get(tileKey(t))?.bytes || est;
			if (out.length && acc + b > MESH_BUDGET) break;
			acc += b; out.push(t);
		}
		return out;
	}

	// ── 取得 ──
	function fetchTile(src, t, tries = 0) {
		const key = tileKey(t), T = { state: "loading", bytes: 0, used: clock, ac: new AbortController(), tries };
		src.tiles.set(key, T); src.fetching++;
		const { desc } = src, { w } = workerOf(`${src.sid}|${key}`);
		(async () => {
			let ab = null, enc = desc.encoding || "mvt";   // タイルの形式（#88）：XYZ＝source の encoding・PMTiles＝アーカイブのヘッダ（tileType）
			if (desc.pmtiles) { const info = await pmtilesInfo(desc.pmtiles); enc = info.tileType === "unknown" ? "mvt" : info.tileType; const u = await fetchPMTilesRaw(desc.pmtiles, t.z, t.x, t.y, T.ac.signal); ab = u ? u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) : null; }
			else {
				const url = desc.tileUrl?.(t.z, t.x, t.y);
				if (url) {
					const rq = requester ? requester.resolve(url, "Tile") : { url };
					if (rq.load) ab = await rq.load("arrayBuffer");
					else {
						const r = await fetch(rq.url, { signal: T.ac.signal, ...(rq.headers ? { headers: rq.headers } : {}), ...(rq.credentials ? { credentials: rq.credentials } : {}) });
						if (r.status !== 404 && r.status !== 204) { if (!r.ok) throw new Error(`HTTP ${r.status}`); ab = await r.arrayBuffer(); }   // 404/204＝そこに無い（空）
					}
				}
			}
			if (sources.get(src.sid) !== src || src.tiles.get(key) !== T) return;
			T.bytes = ab?.byteLength || 0;
			if (T.bytes) await rpc(w, { kind: "put", sid: src.sid, key, ab, enc }, [ab]);
			T.state = T.bytes ? "ready" : "empty";
		})().catch(err => {
			if (src.tiles.get(key) !== T) return;
			if (err?.name === "AbortError") { src.tiles.delete(key); return; }
			T.state = "failed"; T.tries = tries + 1; T.failedAt = performance.now();
			console.warn("[vtextrude] tile", src.sid, key, err?.message || err);
		}).finally(() => { src.fetching--; schedule(); });
	}

	// ── 組み立て ──
	function buildTile(id, s, t, lt) {
		const key = tileKey(t), gen = s.gen, zkey = s.zkey, fz = s.fzOf(t.z);
		lt.building = true; lt.gen = gen; building++;
		const { w } = workerOf(`${s.sid}|${key}`);
		lt.fsDirty = false;
		const fs = usesFS(s.layer) ? [...(fstate.get(s.sid) || new Map())].filter(([k]) => k.startsWith(s.layer["source-layer"] + "\u0000")).map(([, v]) => [v.id, v.state]) : null;
		rpc(w, { kind: "build", lid: id, sid: s.sid, key, z: t.z, x: t.x, y: t.y, layer: s.layer, fzoom: fz, zoom: settledZoom, promoteId: sources.get(s.sid)?.desc.promoteId ?? null, ell, fstate: fs, wantIds: usesFS(s.layer) }).then(r => {
			if (layers.get(id) !== s || s.gen !== gen || s.tiles.get(key) !== lt) return;
			if (r.miss) { sources.get(s.sid)?.tiles.delete(key); lt.gen = -1; return; }   // 生バイトが無い（捨てた後）＝取り直す
			lt.zkey = zkey; lt.fz = fz;
			if (r.empty) { dropMesh(lt); lt.state = "empty"; lt.hMax = 0; lt.nFeat = 0; lt.ids = null; return; }
			lt.hMax = r.stats.hMax; lt.nFeat = r.stats.features; lt.ids = r.ids ? new Set(r.ids) : null; lt.stated = r.stats.stated || 0;
			uploads.push({ id, key, gen, lt, data: { ...r.mesh, ward: lt.ward, drape: true, keep2d: true, tex: null, alphaMode: r.blend ? "BLEND" : "OPAQUE", alphaCutoff: 0.5, maskBbox: null, maskN: 0 } });
			pump();
		}).catch(err => { lt.state = lt.bytes ? "ready" : "failed"; console.warn("[vtextrude] build", id, key, err.message); })
			.finally(() => { lt.building = false; building--; schedule(); });
	}
	// 送る（1 フレーム 1 件）。初めてのメッシュは伏せて送る＝選びが出すと決めた時に meshVis で出す（祖先と子を同じ所に重ねない）。
	// 組み直し（ズームの式・paint）は出したまま差し替える（renderer の set は同じ名前を置き換える＝ちらつかない）
	function pump() {
		if (rafP || !uploads.length || pendingAcks >= MAX_INFLIGHT_UP) return;   // 背圧＝render worker が前の分を載せ終えるまで次を送らない
		rafP = requestAnimationFrame(() => {
			rafP = 0;
			const u = uploads.shift(), s = layers.get(u.id);
			if (s && s.gen === u.gen && s.tiles.get(u.key) === u.lt) {
				if (!u.lt.bytes) { sendVis(u.lt.ward, false); u.lt.on = false; }
				const bytes = meshBytes(u.data);   // 送る前に数える（配列は worker へ transfer＝送った後は長さ 0）
				sendMesh(`${u.lt.ward}#0`, u.data);
				u.lt.bytes = bytes; u.lt.state = "ready"; u.lt.used = clock;
				schedule();
			}
			pump();
		});
	}

	// ── 毎回の選び（rAF に畳む）──
	function update() {
		lastUpd = performance.now(); clock++;
		const flying = isFlying(), now = performance.now();
		for (const [sid, src] of sources) {
			const ls = [...layers.entries()].filter(([, s]) => s.sid === sid);
			const act = ls.filter(([, s]) => s.on && inZoom(s.layer, cam.zoom));
			const wanted = act.length ? wantedOf(src) : [];
			const wantedKeys = new Set(wanted.map(tileKey));
			if (!moving) for (const [, s] of act) s.zkey = paintZoomKey(s.layer.paint, settledZoom, evalIn);   // 止まった時だけズームの鍵を見直す（動いている間は組み直さない）
			if (!flying) for (const t of wanted) {   // 取得（フライト中は止める）
				const k = tileKey(t), T = src.tiles.get(k);
				if (T) { T.used = clock; if (T.state === "failed" && T.tries < TRIES && now - T.failedAt > RETRY_MS && src.fetching < MAX_FETCH) fetchTile(src, t, T.tries); continue; }
				if (src.fetching >= MAX_FETCH) break;
				fetchTile(src, t);
			}
			for (const [k, T] of src.tiles) if (T.state === "loading" && !wantedKeys.has(k)) T.ac.abort();   // 要らなくなった取得は止める
			for (const [id, s] of ls) {   // 層ごと：組み立て・置き換え・出し入れ
				if (!s.on || !inZoom(s.layer, cam.zoom)) { for (const lt of s.tiles.values()) setOn(lt, false); continue; }
				if (!flying) for (const t of wanted) {
					if (building >= MAX_BUILD) break;
					const k = tileKey(t), T = src.tiles.get(k);
					if (!srcReady(T)) continue;
					let lt = s.tiles.get(k);
					if (!lt) s.tiles.set(k, lt = { state: "none", ward: wardOf(id, k), bytes: 0, on: false, zkey: null, fz: null, gen: -1, building: false, hMax: 0, nFeat: 0, used: clock });
					lt.used = clock;
					if (T.state !== "ready") { if (lt.state !== "empty") { dropMesh(lt); lt.state = "empty"; } continue; }   // 空・諦めたタイル
					if (lt.building || uploads.some(u => u.lt === lt)) continue;
					if (lt.state === "none" || lt.state === "failed" || lt.gen !== s.gen || lt.zkey !== s.zkey || lt.fz !== s.fzOf(t.z) || lt.fsDirty) buildTile(id, s, t, lt);
				}
				const ready = k => { const lt = s.tiles.get(k); return !!lt && (lt.state === "ready" || lt.state === "empty"); };
				const show = retainTiles(wanted, ready, { minZ: src.desc.minzoom ?? 0 });
				for (const [k, lt] of s.tiles) { if (show.has(k)) lt.used = clock; setOn(lt, show.has(k)); }
			}
		}
		evict();
	}
	// 予算を超えたら、出していないメッシュから古い順に捨てる（出しているものは捨てない）。生バイトも同じ（今 wanted の物は捨てない）
	function evict() {
		let total = 0; const cand = [];
		for (const [id, s] of layers) for (const [k, lt] of s.tiles) { total += lt.bytes; if (lt.bytes && !lt.on && !lt.building) cand.push([lt.used, s, k, lt, id]); }
		cand.sort((a, b) => a[0] - b[0]);
		for (const [, s, k, lt, id] of cand) {
			if (total <= MESH_BUDGET) break;
			total -= lt.bytes; dropMesh(lt); s.tiles.delete(k);
			workerOf(`${s.sid}|${k}`).w.postMessage({ kind: "dropTile", lid: id, key: k });
		}
		for (const [sid, src] of sources) {
			let rawTotal = 0; const rc = [];
			for (const [k, T] of src.tiles) { rawTotal += T.bytes; if (T.state === "ready" && T.used < clock) rc.push([T.used, k, T]); }
			rc.sort((a, b) => a[0] - b[0]);
			for (const [, k, T] of rc) { if (rawTotal <= RAW_BUDGET) break; rawTotal -= T.bytes; src.tiles.delete(k); workerOf(`${sid}|${k}`).w.postMessage({ kind: "drop", sid, key: k }); }
		}
	}
	// 状態が変わった地物（fid＝undefined は全部）を含むタイルに印＝次の選びで組み直す（paint に ["feature-state"] がある層だけ・残したタイルも印＝出す時に直る）
	function touchFS(sid, sl, fid) {
		for (const s of layers.values()) {
			if (s.sid !== sid || (sl != null && s.layer["source-layer"] !== sl) || !usesFS(s.layer)) continue;
			for (const lt of s.tiles.values()) if ((lt.state === "ready" || lt.building) && (fid === undefined || !lt.ids || lt.ids.has(fid))) lt.fsDirty = true;   // 組み立て中＝古い状態で組んでいる＝着いた後にもう一度
		}
		schedule();
	}
	const sigOf = d => JSON.stringify([d.tag ?? null, d.pmtiles ?? null, d.minzoom ?? null, d.maxzoom ?? null, d.bounds ?? null, d.coverage ?? null, d.promoteId ?? null]);
	function dropSource(sid) {
		const src = sources.get(sid); if (!src) return;
		for (const [k, T] of src.tiles) { T.ac?.abort(); workerOf(`${sid}|${k}`).w.postMessage({ kind: "drop", sid, key: k }); }
		sources.delete(sid);
	}
	const ctl = {
		// 層を足す／置き換える（layer＝正規化済み＝エンジンの目盛り・desc＝source の記述子）。同じ source 名で中身が違えば取り直す
		set(id, layer, sid, desc) {
			let src = sources.get(sid);
			if (src && src.sig !== sigOf(desc)) { for (const [lid, s] of [...layers]) if (s.sid === sid && lid !== id) ctl.remove(lid); dropSource(sid); src = null; }
			if (!src) {
				src = { sid, desc: { ...desc }, sig: sigOf(desc), tiles: new Map(), fetching: 0 };
				sources.set(sid, src);
				const d = src.desc;
				if (d.pmtiles) pmtilesInfo(d.pmtiles).then(info => {
					if (isRasterTileType(info.tileType)) { console.warn(`[vtextrude] source "${sid}": PMTiles tile type "${info.tileType}" is raster — nothing to extrude`); d.pmtiles = null; d.tileUrl = () => null; }   // ベクタ（mvt／mlt）はヘッダの形式で解く（#88）
					d.minzoom ??= info.minZoom; d.maxzoom ??= info.maxZoom; d.bounds ??= info.bbox ?? null; schedule();
				}).catch(err => console.warn(`[vtextrude] source "${sid}": cannot read PMTiles`, err?.message || err));
			}
			const old = layers.get(id);
			if (old && old.sid !== sid) ctl.remove(id);
			const s = layers.get(id) || { sid, on: true, gen: 0, zkey: null, tiles: new Map() };
			s.layer = layer; s.sid = sid; s.gen++;
			const fz = hasZoom(layer.filter);
			s.fzOf = z => fz ? filterZoom(z, sources.get(sid)?.desc.maxzoom ?? 22, settledZoom) : 0;
			s.zkey = paintZoomKey(layer.paint, settledZoom, evalIn);
			layers.set(id, s);
			schedule();
		},
		remove(id) {
			const s = layers.get(id); if (!s) return;
			for (const lt of s.tiles.values()) dropMesh(lt);
			for (const w of workers) w?.postMessage({ kind: "dropLayer", lid: id });
			layers.delete(id);
			for (let i = uploads.length - 1; i >= 0; i--) if (uploads[i].id === id) uploads.splice(i, 1);
			if (![...layers.values()].some(x => x.sid === s.sid)) dropSource(s.sid);
		},
		setVisible(id, on) { const s = layers.get(id); if (!s || s.on === !!on) return; s.on = !!on; schedule(); },
		// 状態が変わった（setFeatureState / removeFeatureState）＝その地物を含むタイルだけ組み直す（幾何は残す＝高さと色だけ）。fid＝undefined は全部
		touchFS: (sid, sl, fid) => touchFS(sid, sl, fid),
		has: id => layers.has(id),
		// MapLibre の isSourceLoaded 相当：見えている層の wanted が全部「今の式で」組み上がって送り終わり、出しているか（組み直し待ち＝まだ）
		loaded(sid) {
			const src = sources.get(sid); if (!src) return true;
			if (moving || src.fetching || rafU || pendingAcks || uploads.some(u => layers.get(u.id)?.sid === sid)) return false;   // 止まるまで＝ズームの鍵を見直す前・描画側に載るまで
			for (const s of layers.values()) if (s.sid === sid && s.on && inZoom(s.layer, cam.zoom)) {
				const zk = paintZoomKey(s.layer.paint, settledZoom, evalIn);
				for (const t of wantedOf(src)) {
					const lt = s.tiles.get(tileKey(t));
					if (!lt || lt.building || (lt.state !== "ready" && lt.state !== "empty") || (lt.state === "ready" && !lt.on)) return false;
					if (lt.state === "ready" && (lt.gen !== s.gen || lt.zkey !== zk || lt.fz !== s.fzOf(t.z) || lt.fsDirty)) return false;
				}
			}
			return true;
		},
		// 当たり：geometry＝[x, y]（CSS px）か [[x0,y0],[x1,y1]]。take(層 id)＝問い合わせの layers。戻り＝[{ d: 奥行き, f: 地物 }]（近い順）＝問い合わせが geojson の押し出しと一つの列に並べる
		async query(geometry, take = () => true) {
			const box = Array.isArray(geometry?.[0]), pts = box ? [geometry[0], [geometry[1][0], geometry[0][1]], geometry[1], [geometry[0][0], geometry[1][1]]] : [geometry];
			const env = hitEnv(), out = [];
			const q = box ? { box: [Math.min(geometry[0][0], geometry[1][0]), Math.min(geometry[0][1], geometry[1][1]), Math.max(geometry[0][0], geometry[1][0]), Math.max(geometry[0][1], geometry[1][1])] } : { pt: geometry };
			for (const [id, s] of layers) {
				if (!s.on || !inZoom(s.layer, cam.zoom) || !take(id)) continue;
				const shown = [...s.tiles].filter(([, lt]) => lt.on && lt.bytes);
				if (!shown.length) continue;
				// 候補の区間＝画面の点の光線が地面（0m）と一番高い屋根の高さを通る所の外接矩形（＋余白）
				const hMax = Math.max(0, ...shown.map(([, lt]) => lt.hMax || 0)), ll = [];
				for (const [x, y] of pts) for (const hm of [0, hMax]) { const q = unprojectAt(x, y, hm); if (q) ll.push(q); }
				if (!ll.length) continue;
				let w = Math.min(...ll.map(q => q[0])), e = Math.max(...ll.map(q => q[0])), so = Math.min(...ll.map(q => q[1])), no = Math.max(...ll.map(q => q[1]));
				const pad = Math.max(2e-5, (e - w) * 0.1, (no - so) * 0.1); w -= pad; e += pad; so -= pad; no += pad;
				const byW = new Map();
				for (const [k] of shown) { const { w: wk, i } = workerOf(`${s.sid}|${k}`); if (!byW.has(i)) byW.set(i, { wk, keys: [] }); byW.get(i).keys.push(k); }
				const cands = (await Promise.all([...byW.values()].map(({ wk, keys }) => rpc(wk, { kind: "query", lid: id, keys, bbox: [w, so, e, no] }).then(r => r.hits)))).flat();
				for (const c of cands) {
					const d = hitExtrusion(c.polys, c.base, c.h, q, env);   // 屋根（光線を屋根の高さで受ける）と壁（四角を投影）・d＝当たった所の奥行き
					if (d == null) continue;
					out.push({ d, f: {
						type: "Feature", ...(c.id != null ? { id: c.id } : {}), properties: c.props, state: c.id != null ? { ...(fstate.get(s.sid)?.get(fsKey(s.layer["source-layer"], c.id))?.state || {}) } : {},
						geometry: c.polys.length === 1 ? { type: "Polygon", coordinates: c.polys[0] } : { type: "MultiPolygon", coordinates: c.polys },
						layer: { id, type: "fill-extrusion" }, source: s.sid, sourceLayer: s.layer["source-layer"],
					} });
				}
			}
			return out.sort((a, b) => a.d - b.d);
		},
		stats() {
			const o = {};
			for (const [id, s] of layers) { let shown = 0, bytes = 0, feats = 0; for (const lt of s.tiles.values()) { if (lt.on) { shown++; feats += lt.nFeat || 0; } bytes += lt.bytes; } o[id] = { tiles: s.tiles.size, shown, bytes, features: feats }; }
			return { layers: o, uploads: uploads.length, pendingAcks, building, sources: [...sources].map(([sid, src]) => ({ sid, tiles: src.tiles.size, fetching: src.fetching, states: [...src.tiles].map(([k, T]) => `${k}:${T.state}:${T.bytes}`) })),
				tiles: Object.fromEntries([...layers].map(([id, s]) => [id, [...s.tiles].map(([k, lt]) => `${k}:${lt.state}${lt.building ? "*" : ""}${lt.fsDirty ? "!" : ""}:${lt.bytes}:${lt.on ? "on" : "off"}${lt.stated ? ":st" + lt.stated : ""}`)])) };
		},
		destroy() {
			for (const id of [...layers.keys()]) ctl.remove(id);
			map.off("move", onMove); map.off("settle", onSettle);
			if (meshPort) { meshPort.onmessage = null; meshPort.close(); }
			for (const w of workers) w?.terminate();
			workers.length = 0; waiting.clear();
		},
	};
	return ctl;
}
