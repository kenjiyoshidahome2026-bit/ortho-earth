// vector source の描く層（MapLibre の fill／line／circle／symbol を vector source で・段 8⑤・2026-09-27）の main 側。中身は vtdraw-worker.js・前処理は vtops.js。
// 本人の裁定「別の流れ・基図の上」：基図の配管（core の pipeline）は触らない。利用者の層は renderer の "user" の枠へ＝基図の塗りと線の上・注記は基図と同じ衝突。
//   選び＝段 8①（vtextrude.js）と同じ作法：core selectLOD を MapLibre の vector source の尺で（tilePx 512√2）・source の min/maxzoom・範囲・遠景の打ち切り・予算。
//   取得＝main が requester で（transformRequest・addProtocol の読み口）・PMTiles は core の生バイトの口。生バイトは組み役の worker が預かる。
//   組み＝(source, タイル) ごとにその source の描く層をまとめて（解読 1 回）。op の li は層の順の鍵（vtops.liOf）＝利用者の層どうしの順番は source をまたいでも正確。
//   結合＝core の scene worker をもう 1 本（md:false＝CPU 結合の mergeTiles）。出すタイルの集合（retainTiles）・隠す層（hidden＝li）で結合し、
//         返った scene を呼び手（globe）が render worker の "user" の枠へ中継する（main は transfer で渡すだけ）。結合は 1 本ずつ・間引き・フライト中も出し入れは続く。
//   注記＝層ごとに、出しているタイルの注記の和を呼び手へ（render worker が標高を付けて基図の注記と同じ衝突へ）。
//   ズームの式＝止まった時に曲線の鍵（vtmesh.paintZoomKey・layout も）を見て、変わった source を出ているタイルから組み直す（0.25 刻みの z で組む）。
//   feature-state（#109・押し出し 8①b と同じ作法）＝置き場は呼び手（globe の vtxFS）・ここは読むだけ。状態が変わった地物を含むタイルに印（touchFS）＝そのタイルだけ組み直す。
//         paint に ["feature-state"] がある層だけが読む（filter は読まない＝MapLibre と同じ）。タイルごとに「含む地物の id」（ids）を worker から受け取って持つ。
import { selectLOD, fetchPMTilesRaw, pmtilesInfo, isRasterTileType, evalExpr, getGlobalState } from "@ortho-earth/core";
import { retainTiles, paintZoomKey, filterZoom, hasZoom, tileKey } from "../vtmesh.js";
import { liOf, styleZoomProps, quantZoom } from "../vtops.js";

const R2D = 180 / Math.PI;
const tileBbox = (z, x, y) => { const n = 2 ** z, lat = v => R2D * Math.atan(Math.sinh(Math.PI * (1 - 2 * v / n))); return [x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)]; };
const hits = (a, b) => !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
const evalIn = (e, z) => evalExpr(e, { zoom: z, props: {}, geom: null, vars: {}, origin: "ml" });
const inZoom = (L, z) => (L.minzoom == null || z >= L.minzoom) && (L.maxzoom == null || z < L.maxzoom);
const sceneBuffers = s => { const b = []; for (const L of s.layers) { if (L.kind === "fill") b.push(L.pos.buffer, L.col.buffer, L.idx.buffer); else { b.push(L.P1.buffer, L.P2.buffer, L.col.buffer, L.half.buffer); if (L.off) b.push(L.off.buffer); } } return b; };
const opsBuffers = ops => { const b = []; for (const op of ops) for (const a of op.kind === "fill" ? [op.pos, op.col, op.idx] : [op.P1, op.P2, op.col, op.half, op.off]) if (a) b.push(a.buffer); return b; };
const SUBS = [0, 1, 2];
export const usesFS = L => JSON.stringify(L?.paint ?? null).includes('"feature-state"');   // paint が feature-state を読むか（layout・filter は読まない＝MapLibre と同じ）

// desc＝vtextrude.js と同じ source の記述子（globe の vtxDescOf）。呼び手の口：size()＝{ w, h }（device px）・sendScene(scene, transfer)・sendLabels(id, list|null, meta)・isFlying()
// fstate＝feature-state の置き場（sid → Map<fsKey(sourceLayer, id), { id, state }>・押し出しと同じ物）
export function createVTDraw(map, { cam, size, dpr = 1, lowMem = false, tileBias = 1, requester, sendScene, sendLabels, requestDraw = () => {}, isFlying = () => false, fstate = new Map(), fsKey = (sl, id) => `${sl}\u0000${typeof id}:${id}` } = {}) {
	const OPS_BUDGET = (lowMem ? 48 : 128) * 2 ** 20, RAW_BUDGET = (lowMem ? 16 : 48) * 2 ** 20;
	const MAX_TILES = lowMem ? 24 : 48, MAX_FETCH = lowMem ? 3 : 6, MAX_BUILD = 4, TILE_PX = 512 * Math.SQRT2, RETRY_MS = 2000, TRIES = 3, MERGE_MS = 120, MERGE_FS_MS = 32;   // MERGE_FS_MS＝状態の変化を待っている間の間引き（#109 段 4：ホバーの移りで 2 枚目の結合が 120ms 待たされていた＝実測の外れ値 150〜190ms）
	const sources = new Map();   // sid → { sid, desc, sig, gen, zsig, pz, tiles: Map<key, T>, built: Map<key, B>, fetching, show: Set<key> }
	//   T＝{ state: loading|ready|empty|failed, bytes, used, ac, tries, failedAt }   B＝{ state: none|ready, gen, zsig, fz, ops（持っているか）, bytes, labels, origin, z, ver, building, used, ids（Set<fsKey>|null）, fsDirty }
	const layers = new Map();    // id → { id, layer, sid, on, key（層の順の鍵）, fs（paint が feature-state を読むか） }
	const retired = new Set();   // 外した層の順の鍵＝その li は常に隠す（組み直しが済む前の古い op を出さない・鍵は使い回さない）
	let clock = 0, building = 0, rafU = 0, lastUpd = 0, settledZoom = cam.zoom, moving = false, maxKey = -1;
	// 計器（#109 段 4・?hud=1）＝直近の値：組み立ての往復（解読・組み立て）・結合・最後に状態を変えてから描く側へ渡すまで（fsMs）。描く側の上げとフレームは含まない
	const tm = { builds: 0, rttMs: 0, decodeMs: 0, buildMs: 0, mergeMs: 0, fsMs: null, fsT0: 0 };
	const warned = new Set();
	const warnOnce = (k, msg) => { if (!warned.has(k)) { warned.add(k); console.warn(msg); } };

	// ── 組み役 worker（タイルの鍵で振る）──
	const NB = lowMem ? 1 : 2, workers = [], waiting = new Map(); let rpcSeq = 0;
	const workerOf = k => {
		let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0;
		const i = Math.abs(h) % NB;
		if (!workers[i]) {
			const w = new Worker(new URL("../worker.js", import.meta.url), { type: "module", name: "vtdraw" });   // 入口 1 本（worker.js）＝役割は name
			w.onmessage = e => { const p = waiting.get(e.data.id); if (!p) return; waiting.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data); };
			w.onerror = e => console.error("[vtdraw] worker error", e.message);
			workers[i] = w;
		}
		return { w: workers[i], i };
	};
	const rpc = (w, msg, transfer = []) => new Promise((res, rej) => { const id = ++rpcSeq; waiting.set(id, { res, rej }); w.postMessage({ id, ...msg }, transfer); });

	// ── 結合役＝core の scene worker（md:false＝CPU 結合）。render worker への口の代わりに main が端を持つ ──
	let merger = null;
	const mg = { seq: 0, inflight: false, want: false, sig: null, planSig: null, lastAt: 0, t0: 0, timer: 0, sent: 0, recv: 0 };   // planSig＝直近に見た計画の署名（計器の fsDone）・t0＝結合を出した時刻
	const mergerW = () => {
		if (merger) return merger;
		const w = new Worker(new URL("../worker.js", import.meta.url), { type: "module", name: "ortho:scene" });
		const ch = new MessageChannel();
		w.postMessage({ type: "connect", port: ch.port1 }, [ch.port1]);
		ch.port2.postMessage({ type: "mode", md: false });   // CPU 結合（mergeTiles）＝render worker の常駐プールには触らない
		ch.port2.onmessage = e => { if (e.data?.type === "scene") { mg.recv++; sendScene(e.data.scene, sceneBuffers(e.data.scene)); requestDraw(); fsDone(); } };
		w.onmessage = e => { if (e.data?.type === "merged") { mg.inflight = false; mg.lastAt = performance.now(); tm.mergeMs = mg.lastAt - mg.t0; if (mg.want) { mg.want = false; mergeMaybe(); } fsDone(); } };
		w.onerror = e => console.error("[vtdraw] merge worker error", e.message);
		return merger = { w, port: ch.port2 };
	};
	const mkey = (sid, k) => `${k}/${sid}`;   // z/x/y を先頭に（core の coveredTiles が z/x/y で読む＝祖先の鍵と重ならない）

	const schedule = () => { if (!rafU) rafU = requestAnimationFrame(() => { rafU = 0; update(); }); };
	const onMove = () => { moving = true; if (performance.now() - lastUpd > 120) schedule(); else setTimeout(schedule, 130); };
	const onSettle = () => { moving = false; settledZoom = cam.zoom; schedule(); };
	map.on("move", onMove); map.on("settle", onSettle);
	const srcReady = T => T && (T.state === "ready" || T.state === "empty" || (T.state === "failed" && T.tries >= TRIES));
	const layersOf = sid => [...layers.values()].filter(s => s.sid === sid);
	const fzOf = (src, z) => layersOf(src.sid).some(s => hasZoom(s.layer.filter)) ? filterZoom(z, src.desc.maxzoom ?? 22, settledZoom) : z + 1;

	// ── 選び（段 8①と同じ）──
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
		// 予算を見た選び＝組んだタイルは実際のバイト・まだの物はこの source の中央値（無ければ 256KB）で見積もり、遠い方から落とす（近い 1 枚は必ず残す）
		const known = [...src.built.values()].filter(B => B.bytes).map(B => B.bytes).sort((a, b) => a - b);
		const est = known.length ? known[known.length >> 1] : 2 ** 18;
		let acc = 0; const out = [];
		for (const t of ts) { const b = src.built.get(tileKey(t))?.bytes || est; if (out.length && acc + b > OPS_BUDGET) break; acc += b; out.push(t); }
		return out;
	}

	// ── 取得（段 8①と同じ）──
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
			console.warn("[vtdraw] tile", src.sid, key, err?.message || err);
		}).finally(() => { src.fetching--; schedule(); });
	}

	// ── 組み立て（source × タイル）──
	// 組み立てに添える feature-state＝{ source-layer: [[id, state], …] }（読む層の source-layer だけ）。前と同じ地物の集合（gen・fz が同じ）なら、そのタイルが含む地物の分だけ
	function fsFor(src, B, gen, fz) {
		const sls = new Set(layersOf(src.sid).filter(s => s.fs).map(s => s.layer["source-layer"]));
		const M = sls.size ? fstate.get(src.sid) : null;
		if (!M?.size) return null;
		const only = B.ids && B.gen === gen && B.fz === fz ? B.ids : null, out = {};
		let n = 0;
		for (const [k, v] of M) {
			const sl = k.slice(0, k.indexOf("\u0000"));
			if (!sls.has(sl) || (only && !only.has(k))) continue;
			(out[sl] ||= []).push([v.id, v.state]); n++;
		}
		return n ? out : null;
	}
	function buildTile(src, t, B) {
		const key = tileKey(t), gen = src.gen, zsig = src.zsig, fz = fzOf(src, t.z), pz = src.pz, sid = src.sid;
		B.building = true; building++;
		const fs = fsFor(src, B, gen, fz), t0 = performance.now();
		B.fsDirty = false;   // 組み立て中に状態が変わったら touchFS がまた立てる＝着いた後にもう一度
		const ls = layersOf(sid).map(s => ({ id: s.id, layer: s.layer, key: s.key }));
		rpc(workerOf(`${sid}|${key}`).w, { kind: "build", gs: getGlobalState(), sid, key, z: t.z, x: t.x, y: t.y, layers: ls, fz, pz, promoteId: src.desc.promoteId ?? null, fs }).then(r => {
			if (sources.get(sid) !== src || src.built.get(key) !== B) { if (r.ops?.length) {/* 捨てる（transfer 済みの配列は GC） */} return; }
			if (r.miss) { src.tiles.delete(key); B.gen = -1; return; }   // 生バイトが無い（捨てた後）＝取り直す
			tm.builds++; tm.rttMs = performance.now() - t0; tm.decodeMs = r.stats?.decodeMs ?? 0; tm.buildMs = r.stats?.buildMs ?? 0;
			B.gen = gen; B.zsig = zsig; B.fz = fz; B.used = clock; B.labels = r.labels || {}; B.ver++;
			B.ids = r.ids ? new Set(Object.entries(r.ids).flatMap(([sl, a]) => a.map(id => fsKey(sl, id)))) : null;   // このタイルが含む地物（feature-state を読む層の分）＝touchFS がどのタイルを組み直すか
			for (const k of r.warn || []) warnOnce(`${sid}:${k}`, `[vtdraw] source "${sid}": ${k} is not supported yet on vector sources`);
			const mk = mkey(sid, key);
			if (r.ops.length) { mergerW().w.postMessage({ type: "tile", key: mk, ops: r.ops, buildings: null }, opsBuffers(r.ops)); B.ops = true; B.bytes = r.bytes; B.origin = r.origin; B.z = t.z; }
			else { if (B.ops) mergerW().w.postMessage({ type: "evict", keys: [mk] }); B.ops = false; B.bytes = 0; }
			B.state = "ready";
		}).catch(err => { B.state = B.state === "ready" ? "ready" : "failed"; console.warn("[vtdraw] build", sid, key, err.message); })
			.finally(() => { B.building = false; building--; schedule(); });
	}
	const emptyB = () => ({ state: "none", gen: -1, zsig: null, fz: null, ops: false, bytes: 0, labels: {}, origin: null, z: 0, ver: 0, building: false, used: clock, ids: null, fsDirty: false });

	// ── 毎回の選び（rAF に畳む）──
	function update() {
		lastUpd = performance.now(); clock++;
		for (const s of layers.values()) if (s.key == null) s.key = ++maxKey;   // setOrder が呼ばれなかった層＝末尾（保険）
		const flying = isFlying(), now = performance.now();
		for (const [, src] of sources) {
			const act = layersOf(src.sid).filter(s => s.on && inZoom(s.layer, cam.zoom));
			const wanted = act.length ? wantedOf(src) : [];
			const wantedKeys = new Set(wanted.map(tileKey));
			if (!moving) {   // 止まった時だけズームの鍵を見直す（動いている間は組み直さない）
				src.zsig = layersOf(src.sid).map(s => s.id + "=" + paintZoomKey(styleZoomProps(s.layer), settledZoom, evalIn)).join(";");
				src.pz = quantZoom(settledZoom);
			}
			if (!flying) for (const t of wanted) {   // 取得（フライト中は止める）
				const k = tileKey(t), T = src.tiles.get(k);
				if (T) { T.used = clock; if (T.state === "failed" && T.tries < TRIES && now - T.failedAt > RETRY_MS && src.fetching < MAX_FETCH) fetchTile(src, t, T.tries); continue; }
				if (src.fetching >= MAX_FETCH) break;
				fetchTile(src, t);
			}
			for (const [k, T] of src.tiles) if (T.state === "loading" && !wantedKeys.has(k)) T.ac.abort();   // 要らなくなった取得は止める
			if (!flying) for (const t of wanted) {
				if (building >= MAX_BUILD) break;
				const k = tileKey(t), T = src.tiles.get(k);
				if (!srcReady(T)) continue;
				let B = src.built.get(k);
				if (!B) src.built.set(k, B = emptyB());
				B.used = clock;
				if (B.building) continue;
				if (T.state !== "ready") { if (B.state !== "ready" || B.ops || B.gen !== src.gen) { if (B.ops) mergerW().w.postMessage({ type: "evict", keys: [mkey(src.sid, k)] }); Object.assign(B, { state: "ready", ops: false, bytes: 0, labels: {}, gen: src.gen, zsig: src.zsig, fz: fzOf(src, t.z), ids: null }); B.ver++; } B.fsDirty = false; continue; }   // 空・諦めたタイル
				if (B.state !== "ready" || B.gen !== src.gen || B.zsig !== src.zsig || B.fz !== fzOf(src, t.z) || B.fsDirty) buildTile(src, t, B);
			}
			const ready = k => src.built.get(k)?.state === "ready";
			src.show = act.length ? retainTiles(wanted, ready, { minZ: src.desc.minzoom ?? 0 }) : new Set();
			for (const k of src.show) { const B = src.built.get(k); if (B) B.used = clock; }
		}
		mergeMaybe();
		labelsMaybe();
		evict();
		fsDone();
	}
	// 状態の変化が描く側へ渡り終えたか（印も組み立ても無く、結合が今の計画で送り終わっている）＝計器の fsMs を刻む
	function fsDone() {
		if (!tm.fsT0 || mg.inflight || mg.timer || mg.want || mg.sent !== mg.recv || mg.planSig !== mg.sig) return;
		for (const src of sources.values()) for (const B of src.built.values()) if (B.fsDirty || B.building) return;
		tm.fsMs = performance.now() - tm.fsT0; tm.fsT0 = 0;
	}

	// ── 結合（署名が変わった時だけ・1 本ずつ・間引き）──
	const hiddenLi = () => {
		const h = [];
		for (const s of layers.values()) if (!s.on || !inZoom(s.layer, cam.zoom)) for (const sub of SUBS) h.push(liOf(s.key, sub));
		for (const k of retired) for (const sub of SUBS) h.push(liOf(k, sub));
		return h;
	};
	function mergePlan() {
		const order = [], parts = [];
		for (const [sid, src] of [...sources].sort((a, b) => a[0] < b[0] ? -1 : 1)) for (const k of [...src.show].sort()) {
			const B = src.built.get(k); if (!B?.ops) continue;
			order.push({ key: mkey(sid, k), origin: B.origin, z: B.z }); parts.push(`${sid}|${k}:${B.ver}`);
		}
		const hidden = hiddenLi();
		return { order, hidden, sig: parts.join(",") + "#" + hidden.join(",") };
	}
	function mergeMaybe() {
		if (!merger && !layers.size) return;
		const plan = mergePlan();
		mg.planSig = plan.sig;
		if (plan.sig === mg.sig) return;
		if (mg.inflight || mg.timer) { mg.want = true; return; }
		const wait = (tm.fsT0 ? MERGE_FS_MS : MERGE_MS) - (performance.now() - mg.lastAt);
		if (wait > 0) { mg.timer = setTimeout(() => { mg.timer = 0; mergeMaybe(); }, wait); return; }
		// 原点＝カメラに近いタイル（頂点は原点からの差で f32＝近くほど正確）
		const [cx, cy] = cam.center;
		let origin = plan.order[0]?.origin || [0, 0], best = Infinity;
		for (const o of plan.order) { const d = (o.origin[0] - cx) ** 2 + (o.origin[1] - cy) ** 2; if (d < best) { best = d; origin = o.origin; } }
		mg.sig = plan.sig; mg.inflight = true; mg.sent++; mg.t0 = performance.now();
		mergerW().w.postMessage({ type: "merge", slot: "user", sig: ++mg.seq, order: plan.order, origin, hidden: plan.hidden.length ? plan.hidden : null });
	}

	// ── 注記（層ごと・出しているタイルの和）──
	const labelSig = new Map();   // id → 署名
	function labelsMaybe() {
		for (const s of layers.values()) {
			if (s.layer.type !== "symbol") continue;
			const src = sources.get(s.sid), on = s.on && !!src;
			const keys = on ? [...src.show].sort() : [];
			const sig = on ? keys.map(k => `${k}:${src.built.get(k)?.ver ?? 0}`).join(",") : "off";
			if (labelSig.get(s.id) === sig) continue;
			labelSig.set(s.id, sig);
			const list = []; for (const k of keys) { const ls = src.built.get(k)?.labels?.[s.id]; if (ls) for (const L of ls) list.push(L); }
			sendLabels(s.id, list.length ? list : null, { minZoom: s.layer.minzoom ?? null, maxZoom: s.layer.maxzoom ?? null });
		}
	}

	// ── 予算：出していないタイルの op から古い順に捨てる（結合役も同時）・生バイトも同じ（今 wanted の物は捨てない）──
	function evict() {
		let total = 0; const cand = [];
		for (const [sid, src] of sources) for (const [k, B] of src.built) { total += B.bytes; if (!src.show.has(k) && !B.building && B.used < clock) cand.push([B.used, src, k, B, sid]); }
		cand.sort((a, b) => a[0] - b[0]);
		const drop = [];
		for (const [, src, k, B, sid] of cand) { if (total <= OPS_BUDGET) break; total -= B.bytes; if (B.ops) drop.push(mkey(sid, k)); src.built.delete(k); }
		if (drop.length) mergerW().w.postMessage({ type: "evict", keys: drop });
		for (const [sid, src] of sources) {
			let rawTotal = 0; const rc = [];
			for (const [k, T] of src.tiles) { rawTotal += T.bytes; if (T.state === "ready" && T.used < clock) rc.push([T.used, k, T]); }
			rc.sort((a, b) => a[0] - b[0]);
			for (const [, k, T] of rc) { if (rawTotal <= RAW_BUDGET) break; rawTotal -= T.bytes; src.tiles.delete(k); workerOf(`${sid}|${k}`).w.postMessage({ kind: "drop", sid, key: k }); }
		}
	}
	const sigOf = d => JSON.stringify([d.tag ?? null, d.pmtiles ?? null, d.minzoom ?? null, d.maxzoom ?? null, d.bounds ?? null, d.coverage ?? null, d.promoteId ?? null]);
	function dropSource(sid) {
		const src = sources.get(sid); if (!src) return;
		for (const [k, T] of src.tiles) { T.ac?.abort(); workerOf(`${sid}|${k}`).w.postMessage({ kind: "drop", sid, key: k }); }
		const keys = [...src.built].filter(([, B]) => B.ops).map(([k]) => mkey(sid, k));
		if (keys.length && merger) merger.w.postMessage({ type: "evict", keys });
		sources.delete(sid);
	}
	const touchSource = sid => { const src = sources.get(sid); if (src) src.gen++; schedule(); };   // その source を組み直す（層の足し引き・paint・filter・順の鍵）
	// 状態が変わった地物（fid＝undefined は全部・sl＝null は全部の source-layer）を含むタイルに印＝次の選びで組み直す。
	// feature-state を読む層がその source-layer に無ければ何もしない（色は変わらない）。組み立て中のタイルにも印＝古い状態で組んでいる＝着いた後にもう一度
	function touchFS(sid, sl, fid) {
		const src = sources.get(sid); if (!src) return;
		if (!layersOf(sid).some(s => s.fs && (sl == null || s.layer["source-layer"] === sl))) return;
		const k = fid === undefined || sl == null ? null : fsKey(sl, fid);
		let hit = false;
		for (const B of src.built.values()) if ((B.state === "ready" || B.building) && (k == null || !B.ids || B.ids.has(k))) { B.fsDirty = true; hit = true; }
		if (hit) tm.fsT0 = performance.now();   // 直近の変化から（マウスを止めてから色が揃うまで＝連打の途中は数えない）
		schedule();
	}

	const ctl = {
		// 層を足す／置き換える（layer＝正規化済み＝エンジンの目盛り・desc＝source の記述子）。同じ source 名で中身が違えば取り直す
		set(id, layer, sid, desc) {
			let src = sources.get(sid);
			if (src && src.sig !== sigOf(desc)) { for (const [lid, s] of [...layers]) if (s.sid === sid && lid !== id) ctl.remove(lid); dropSource(sid); src = null; }
			if (!src) {
				src = { sid, desc: { ...desc }, sig: sigOf(desc), gen: 0, zsig: "", pz: quantZoom(settledZoom), tiles: new Map(), built: new Map(), fetching: 0, show: new Set() };
				sources.set(sid, src);
				const d = src.desc;
				if (d.pmtiles) pmtilesInfo(d.pmtiles).then(info => {
					if (isRasterTileType(info.tileType)) { console.warn(`[vtdraw] source "${sid}": PMTiles tile type "${info.tileType}" is raster — nothing to draw (use a raster layer)`); d.pmtiles = null; d.tileUrl = () => null; }   // ベクタ（mvt／mlt）はヘッダの形式で解く（#88）＝未登録の形式は decodeTile が一度だけ警告して空
					d.minzoom ??= info.minZoom; d.maxzoom ??= info.maxZoom; d.bounds ??= info.bbox ?? null; schedule();
				}).catch(err => console.warn(`[vtdraw] source "${sid}": cannot read PMTiles`, err?.message || err));
			}
			const old = layers.get(id);
			if (old && old.sid !== sid) ctl.remove(id);
			const s = layers.get(id) || { id, sid, on: true, key: null };   // 順の鍵は呼び手の setOrder が振る（同じ手番で呼ぶ＝組み立ては rAF の後）
			s.layer = layer; s.sid = sid; s.fs = usesFS(layer);
			layers.set(id, s);
			src.zsig = layersOf(sid).map(x => x.id + "=" + paintZoomKey(styleZoomProps(x.layer), settledZoom, evalIn)).join(";");
			touchSource(sid);
		},
		remove(id) {
			const s = layers.get(id); if (!s) return;
			layers.delete(id); retired.add(s.key);
			if (labelSig.has(id)) { labelSig.delete(id); sendLabels(id, null, {}); }
			if (!layersOf(s.sid).length) dropSource(s.sid); else touchSource(s.sid);
			schedule();
		},
		setVisible(id, on) { const s = layers.get(id); if (!s || s.on === !!on) return; s.on = !!on; schedule(); },   // 結合で隠すだけ（組み直さない）
		// 状態が変わった（setFeatureState / removeFeatureState）＝その地物を含むタイルだけ組み直す。fid＝undefined は全部
		touchFS: (sid, sl, fid) => touchFS(sid, sl, fid),
		// 層の順（MapLibre の順に並べた vtdraw の層 id）。鍵が今の順で増えていれば新しい層にだけ間の鍵を振る＝他の source は組み直さない。
		// moved＝moveLayer で動いた層（古い鍵を退かせて間の鍵を振り直す）。並びが崩れていたら全部振り直す（鍵は使い回さない）
		setOrder(ids, moved = null) {
			if (moved != null && layers.has(moved)) { const s = layers.get(moved); retired.add(s.key); s.key = null; touchSource(s.sid); }
			const have = ids.filter(id => layers.get(id)?.key != null).map(id => layers.get(id).key);
			const ok = have.every((k, i) => i === 0 || k > have[i - 1]);
			if (!ok) { for (const id of ids) { const s = layers.get(id); if (!s) continue; if (s.key != null) retired.add(s.key); s.key = null; touchSource(s.sid); } }
			for (let i = 0; i < ids.length; i++) {
				const s = layers.get(ids[i]); if (!s || s.key != null) continue;
				let lo = -1; for (let j = i - 1; j >= 0; j--) { const k = layers.get(ids[j])?.key; if (k != null) { lo = k; break; } }
				let hi = null; for (let j = i + 1; j < ids.length; j++) { const k = layers.get(ids[j])?.key; if (k != null) { hi = k; break; } }
				let k = hi == null ? Math.max(lo, maxKey) + 1 : (lo + hi) / 2;
				while (retired.has(k) && hi != null) k = (k + hi) / 2;
				if (hi != null && hi - lo < 1e-6) { maxKey = Math.max(maxKey, ...[...layers.values()].map(x => x.key ?? -1)); for (const id of ids) { const x = layers.get(id); if (x) { if (x.key != null) retired.add(x.key); x.key = ++maxKey; touchSource(x.sid); } } return; }   // 間が詰まりすぎ＝全部振り直す
				s.key = k; if (k > maxKey) maxKey = k; touchSource(s.sid);
			}
			schedule();
		},
		has: id => layers.has(id),
		// MapLibre の isSourceLoaded 相当：見えている層の wanted が全部「今の式で」組み上がり、結合が送り終わっているか
		loaded(sid) {
			const src = sources.get(sid); if (!src) return true;
			if (moving || src.fetching || rafU || mg.inflight || mg.timer || mg.want || mg.sent !== mg.recv) return false;
			if (!layersOf(sid).some(s => s.on && inZoom(s.layer, cam.zoom))) return true;
			for (const t of wantedOf(src)) {
				const B = src.built.get(tileKey(t));
				if (!B || B.building || B.state !== "ready" || B.gen !== src.gen || B.zsig !== src.zsig || B.fz !== fzOf(src, t.z) || B.fsDirty) return false;   // fsDirty＝状態の組み直し待ち
			}
			return mergePlan().sig === mg.sig;
		},
		// 計器（?hud=1）：直近の組み立て・結合・状態の反映の時間（ms）と、出しているタイルの数と op のバイト
		timing() {
			let shown = 0, bytes = 0;
			for (const src of sources.values()) { shown += src.show.size; for (const k of src.show) bytes += src.built.get(k)?.bytes || 0; }
			return { builds: tm.builds, rttMs: tm.rttMs, decodeMs: tm.decodeMs, buildMs: tm.buildMs, mergeMs: tm.mergeMs, fsMs: tm.fsMs, pending: !!tm.fsT0, shown, bytes };
		},
		// 問い合わせ用：その source の出しているタイル（"z/x/y"）
		shownTiles(sid) { const src = sources.get(sid); return src ? [...src.show].map(k => ({ key: k, z: +k.split("/")[0] })) : []; },
		stats() {
			return { layers: Object.fromEntries([...layers].map(([id, s]) => [id, { sid: s.sid, key: s.key, on: s.on }])), retired: [...retired], merge: { ...mg, timer: !!mg.timer }, building,
				sources: [...sources].map(([sid, src]) => ({ sid, gen: src.gen, fetching: src.fetching, show: [...src.show], tiles: [...src.tiles].map(([k, T]) => `${k}:${T.state}:${T.bytes}`), built: [...src.built].map(([k, B]) => `${k}:${B.state}${B.building ? "*" : ""}${B.fsDirty ? "!" : ""}:${B.ops ? B.bytes : 0}:g${B.gen}${B.ids ? ":ids" + B.ids.size : ""}`) })) };
		},
		destroy() {
			for (const id of [...layers.keys()]) ctl.remove(id);
			map.off("move", onMove); map.off("settle", onSettle);
			clearTimeout(mg.timer);
			for (const w of workers) w?.terminate();
			if (merger) { merger.port.onmessage = null; merger.port.close(); merger.w.terminate(); merger = null; }
			workers.length = 0; waiting.clear();
		},
	};
	return ctl;
}
