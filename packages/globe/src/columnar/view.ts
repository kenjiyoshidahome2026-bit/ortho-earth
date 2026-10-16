// view.js ── 列チャンク層（main 側・#90）＝map.addColumnar(src, opts) の実体。旧 gadgets/parquet-view.js（GeoParquet の視野追従）を
// 「読み手を選ばない列チャンク層」に作り替えたもの。GeoParquet（URL/File）も GeoPBF（File/ArrayBuffer/GeoPBF）も同じ道：
//   worker（worker.js）が源を開いてチャンクの台帳（bbox・行数・バイト数）を返す → 視野に触れるチャンクを中心に近い順に予算内で読む →
//   worker が「列チャンク（GPU 向けの平たい配列）＋fid 表」を作って返す → 同一フレームのオーバーレイ（draw-gl.js）へ transfer。
//   最初の 1 枚までの時間＝「読み＋詰め替え」だけ（位相・Morton・VW は作らない）。
// スタイル＝paint/filter（gint と同じ語彙）。評価は worker（列のまま）→ 表だけ差し替え＝色分けで幾何は作り直さない。
// 識別＝worker（チャンク bbox で絞って点＝距離／線＝距離／面＝内外）。当たった行の属性はその時だけ読む。
// 予算と常駐＝常駐は budgetBytes（チャンクの圧縮／ワイヤのバイト数で数える）。視野から外れたチャンクは外す。「ズームインで残り N」を状況表示に出す。
const D2R = Math.PI / 180, WORLD_PX = 256;
const levelBuffersOf = levels => { const out = []; for (const L of levels) { if (L.lines) out.push(L.lines.pos.buffer, L.lines.feat.buffer); if (L.fills) out.push(L.fills.pos.buffer, L.fills.index.buffer, L.fills.feat.buffer); } return out; };
const MB = n => (n / 1e6).toFixed(n >= 1e7 ? 0 : 1);
const RAMP = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];   // 5 段（viridis の要約）＝色分けの列
const defaultT = (s, ...a) => String(s).replace(/ ##.*$/, "").replace(/\$(\d)/g, (_, i) => a[i - 1] ?? "");
let workerFactory = null;
export const setWorkerFactory = f => { workerFactory = f; };

export async function createColumnarView(map, src, opts = {}) {
	const t = opts.t ?? defaultT;
	const { budgetBytes = 64e6, signal, rAx = 1, fit = true, status: showStatus = true } = opts;
	let name = opts.name ?? (typeof src === "string" ? decodeURIComponent(src.split("/").pop() || "") : typeof src?.name === "function" ? src.name() : src?.name) ?? "";   // GeoPBF の name は関数
	// ── worker（読み手）と RPC ──
	const worker = (opts.workerFactory ?? workerFactory)?.("columnar") ?? new Worker(new URL("./worker.js", import.meta.url), { type: "module", name: "columnar" });
	let seq = 0; const waiting = new Map();
	worker.onmessage = e => {
		const d = e.data;
		if (d.id === undefined) { if (d.type === "levels" && loaded.has(d.g) && !destroyed) ov.post({ type: "levels", g: d.g, levels: d.levels }, levelBuffersOf(d.levels)); return; }   // 後から届く LOD の段
		const w = waiting.get(d.id); if (!w) return; waiting.delete(d.id); d.error ? w.rej(new Error(d.error)) : w.res(d);
	};
	worker.onerror = e => console.error("[columnar] worker error", e.message);
	const rpc = (msg, transfer) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); worker.postMessage({ id, ...msg }, transfer || []); });
	let wsrc = src, transfer = [];
	if (src && typeof src === "object" && !(src instanceof ArrayBuffer) && !(typeof Blob !== "undefined" && src instanceof Blob) && !(src instanceof Uint8Array)) {
		if (src.arrayBuffer instanceof ArrayBuffer) wsrc = src.arrayBuffer;   // GeoPBF オブジェクト（getter＝写し）
		else throw new Error("columnar: URL, File, ArrayBuffer or GeoPBF expected");
	}
	if (wsrc instanceof ArrayBuffer) transfer = [wsrc];
	let meta;
	const hint = opts.source ?? (src && typeof src === "object" && src.arrayBuffer instanceof ArrayBuffer ? "geopbf" : null);   // GeoPBF オブジェクト＝名指し
	try { ({ meta } = await rpc({ type: "open", src: wsrc, name, rAx, hint, chunkFeatures: opts.chunkFeatures, chunkVertices: opts.chunkVertices, lods: opts.lods, origin: opts.origin }, transfer)); }
	catch (err) { worker.terminate(); throw err; }
	if (opts.probe && !opts.probe(meta)) { worker.terminate(); return null; }   // 振り分けの規則（globe＝「弧の共有が多い塗り分けは gint」）＝この源はこの層で描かない
	name = meta.name || name || "layer";
	const total = meta.chunks.length, sizeBytes = meta.size || 0;
	const numericCols = meta.columns.filter(c => c.numeric).map(c => c.name);
	const pointOnly = meta.types.length > 0 && meta.types.every(x => /^(Multi)?Point$/.test(x));
	const mapEl = map.mapEl ?? map.getContainer?.();
	const ranges = { ...(meta.range || {}) };
	let color = opts.color && numericCols.includes(opts.color) ? opts.color : null;
	let userPaint = opts.paint ?? null, userFilter = opts.filter ?? null;

	// ── 状況表示（＋色分けの列選び）──
	let st = null, textEl = null, sel = null;
	if (showStatus && mapEl) {
		st = document.createElement("div");
		st.className = "pq-status";
		st.style.cssText = "position:absolute;left:50%;bottom:44px;transform:translateX(-50%);z-index:29;display:flex;gap:10px;align-items:center;padding:5px 12px;border-radius:9px;background:rgba(12,17,32,.8);color:#e7ecf5;font:12px/1.5 system-ui,sans-serif;white-space:nowrap;max-width:calc(100% - 24px)";
		st.innerHTML = `<span class="pq-text" style="overflow:hidden;text-overflow:ellipsis"></span>` + (numericCols.length ? `<label style="display:inline-flex;gap:4px;align-items:center;pointer-events:auto">${t("Color by")} <select class="pq-color" style="font:inherit;font-size:12px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#e7ecf5;padding:2px 4px;max-width:12em"></select></label>` : "");
		mapEl.appendChild(st);
		textEl = st.querySelector(".pq-text"); sel = st.querySelector(".pq-color");
		if (sel) {
			sel.innerHTML = `<option value="">${t("(none) ##color")}</option>` + numericCols.map(c => `<option value="${c.replace(/"/g, "&quot;")}"${c === color ? " selected" : ""}>${c.replace(/</g, "&lt;")}</option>`).join("");
			sel.addEventListener("change", () => setColor(sel.value || null), { signal });
		}
	}
	const status = (extra = "") => {
		if (!textEl) return;
		let read = 0, n = 0; for (const L of loaded.values()) { read += L.bytes; n++; }
		textEl.textContent = t("$1: $2/$3 chunks · $4 MB of $5 MB", name, n, total, MB(read), MB(sizeBytes)) + extra;
	};

	const drawUrl = opts.drawUrl ?? new URL("./draw-gl.js", import.meta.url).href;
	const ovName = opts.overlayName ?? `columnar-${++seqView}`;
	const ov = map.overlay(drawUrl, { name: ovName, opts: { perf: !!opts.perf, drape: opts.drape !== false, depth: opts.depth !== false, rAx } });   // drape＝地形に沿わせる（頂点の標高を worker の地形から）・depth＝シーンの深度で隠す（#47）
	const stats = { frameMs: null, chunksDrawn: 0, errors: [] };
	const probes = new Map(); let probeSeq = 0;   // pixels()（検定用）の待ち行列
	ov.onmessage = d => {
		if (d?.type === "perf") { stats.frameMs = d.ms; stats.chunksDrawn = d.chunks; }
		else if (d?.type === "error") { stats.errors.push(`${d.where}: ${d.error}`); console.error("[columnar] overlay", d.where, d.error); }
		else if (d?.type === "pixels") { const r = probes.get(d.id); if (r) { probes.delete(d.id); r(d); } }
	};
	const pixels = () => new Promise(res => { const id = ++probeSeq; probes.set(id, res); ov.post({ type: "probe", id }); });
	const tipSet = opts.tip === false ? null : (map.gadget?.tip?.() ?? null);
	const loaded = new Map();     // g → { n, rows: Int32Array（チャンク順 → 元の行）, bytes, cached, ms }
	const loading = new Set();
	let gen = 0, destroyed = false, deferredN = 0, rowsTotal = 0, cachedN = 0, shown = true, firstAt = 0;
	const t0 = performance.now();
	const chunkBytesOf = g => meta.chunks[g].bytes || 0;

	// 視野 bbox（approxViewBbox と同式＝z の正射スケール・対角余裕 1.5）
	const viewBbox = () => {
		const c = map.cam.center, z = map.cam.zoom, W = mapEl?.clientWidth || 1024, H = mapEl?.clientHeight || 768;
		const mpp = 156543.03392 * 0.819 / Math.pow(2, z), halfM = Math.max(W, H) * 1.5 * mpp;
		const dLat = halfM / 111320, dLon = dLat / Math.max(0.15, Math.cos(c[1] * D2R));
		return [c[0] - dLon, c[1] - dLat, c[0] + dLon, c[1] + dLat];
	};
	const chunkCenter = g => { const b = meta.chunks[g].bbox; return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null; };
	// 色分けの paint（列のレンジで 5 段）
	const rangeOf = async col => { if (!col) return null; if (ranges[col] === undefined) ranges[col] = (await rpc({ type: "range", name: col })).range; return ranges[col]; };
	const colorPaint = async () => {
		const r = await rangeOf(color); if (!r) return null;
		const [lo, hi] = r, stops = RAMP.flatMap((c, i) => [lo + (hi - lo) * i / (RAMP.length - 1), c]);
		const expr = hi > lo ? ["interpolate", ["linear"], ["get", color], ...stops] : RAMP[2];
		return { "fill-color": expr, "fill-opacity": 0.55, "line-color": expr, "line-opacity": 0.9, "line-width": 0.5, "circle-color": expr, "circle-radius": 2 };
	};
	let effPaint = null;   // worker へ渡す paint（userPaint が勝つ・無ければ色分け・無ければ null＝既定）
	const zoomDriven = () => !!effPaint && JSON.stringify([effPaint, userFilter]).includes('["zoom"');
	let lastEvalZoom = 0;
	const refreshPaint = async () => { effPaint = userPaint ?? await colorPaint(); };

	async function load(g) {
		loading.add(g);
		const myGen = gen;
		try {
			const r = await rpc({ type: "chunk", g, paint: effPaint, filter: userFilter, zoom: map.cam.zoom });
			if (destroyed || myGen !== gen) return;
			const c = r.chunk, rows = c.rows.slice();
			const tr = [c.rows.buffer, c.types.buffer, r.table.buffer];
			if (c.points) tr.push(c.points.pos.buffer, c.points.feat.buffer);
			tr.push(...levelBuffersOf(c.levels));
			ov.post({ type: "chunk", g, chunk: c, table: r.table }, [...new Set(tr)]);
			loaded.set(g, { n: c.n, rows, bytes: chunkBytesOf(g), cached: r.cached, ms: r.ms, msRead: r.msRead, msBuild: r.msBuild });
			if (r.cached) cachedN++;
			rowsTotal += c.n;
			if (!firstAt) firstAt = performance.now() - t0;
		} catch (err) { console.warn("[columnar] chunk", g, "failed:", err?.message || err); }
		finally { loading.delete(g); }
	}
	function unload(g) {
		const L = loaded.get(g); if (!L) return;
		rowsTotal -= L.n; loaded.delete(g);
		ov.post({ type: "remove", g }); rpc({ type: "unload", g }).catch(() => {});
	}
	async function update() {
		if (destroyed) return;
		const myGen = ++gen;
		if (zoomDriven() && Math.abs(map.cam.zoom - lastEvalZoom) >= 0.25) await repaint();   // ["zoom"] の式＝settle で再評価（gint と同じ 0.25）
		const bbox = viewBbox();
		const sel2 = await rpc({ type: "select", bbox });
		if (destroyed || myGen !== gen) return;
		const c = map.cam.center;
		const want = sel2.groups.slice().sort((a, b) => { const ca = chunkCenter(a), cb = chunkCenter(b); if (!ca || !cb) return a - b; return Math.hypot(ca[0] - c[0], ca[1] - c[1]) - Math.hypot(cb[0] - c[0], cb[1] - c[1]); });
		const keep = new Set(); let bytes = 0; deferredN = 0;
		for (const g of want) { if (bytes + chunkBytesOf(g) <= budgetBytes || keep.size === 0) { keep.add(g); bytes += chunkBytesOf(g); } else deferredN++; }
		for (const g of [...loaded.keys()]) if (!keep.has(g)) unload(g);
		const queue = [...keep].filter(g => !loaded.has(g) && !loading.has(g));
		const note = () => (deferredN ? " · " + t("zoom in to load $1 more", deferredN) : "");
		status(note());
		const lane = async () => { while (queue.length && gen === myGen && !destroyed) { await load(queue.shift()); status(note()); } };
		await Promise.all([lane(), lane()]);
		if (gen === myGen) status(note());
	}
	// paint / filter の変化＝読み込み済みチャンクの表だけ差し替え（幾何はそのまま）
	async function repaint() {
		lastEvalZoom = map.cam.zoom;
		const r = await rpc({ type: "paint", paint: effPaint, filter: userFilter, zoom: map.cam.zoom });
		if (destroyed) return;
		for (const [g, table] of r.tables) if (loaded.has(g)) ov.post({ type: "table", g, table }, [table.buffer]);
	}
	async function setColor(col) {
		color = col && numericCols.includes(col) ? col : null;
		if (sel && sel.value !== (color || "")) sel.value = color || "";
		await refreshPaint(); await repaint();
	}
	async function setPaint(paint, filter) {
		userPaint = paint ?? null; if (filter !== undefined) userFilter = filter ?? null;
		await refreshPaint(); await repaint();
	}
	async function setFilter(filter) { userFilter = filter ?? null; await repaint(); }

	// ── 識別（worker）：hover（60ms 間引き・飛行中は無し）／click ──
	const handlers = { hover: [], click: [], mouseenter: [], mouseleave: [] };
	const propsCache = new Map();
	const propsOf = async (g, row) => { const k = `${g}:${row}`; if (!propsCache.has(k)) { const r = await rpc({ type: "props", g, row }); if (propsCache.size > 2000) propsCache.clear(); propsCache.set(k, r.props ?? {}); } return propsCache.get(k); };
	const query = async (ll) => {
		if (!ll || !loaded.size) return null;
		const r = await rpc({ type: "identify", lon: ll[0], lat: ll[1] });
		if (r.hit === null || r.g === undefined) return null;
		return { g: r.g, f: r.f, row: r.row, fid: r.row, properties: await propsOf(r.g, r.row) };
	};
	const linesFor = p => { const out = []; for (const k of Object.keys(p)) { const v = p[k]; if (v === null || v === undefined) continue; out.push(`${k}: ${v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : v}`); if (out.length >= 30) break; } return out.length ? out : [t("(no attributes)")]; };
	let hoverKey = null, hoverT = 0, hoverBusy = false, downXY = null;
	const localXY = e => { const r = mapEl.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
	const showHit = async (h, isClick, ll) => {
		const key = h ? `${h.g}:${h.row}` : null;
		if (isClick) { if (h) for (const cb of handlers.click) cb({ fid: h.fid, row: h.row, properties: h.properties, lngLat: ll }); }
		if (key === hoverKey && !isClick) return;
		const prev = hoverKey; hoverKey = key;
		if (prev !== null && key !== prev) for (const cb of handlers.mouseleave) cb({ fid: +prev.split(":")[1] });
		if (h && key !== prev) for (const cb of handlers.mouseenter) cb({ fid: h.fid, properties: h.properties });
		for (const cb of handlers.hover) cb(h ? { fid: h.fid, properties: h.properties } : null);
		if (tipSet && (opts.tip !== undefined ? opts.tip : true)) tipSet(h ? (typeof opts.tip === "function" ? opts.tip(h.properties) : linesFor(h.properties)) : null);
	};
	const onMove = async e => {
		if (destroyed || e.buttons || !loaded.size || st?.contains(e.target) || opts.interactive === false) return;
		const now = performance.now(); if (now - hoverT < 60 || hoverBusy) return; hoverT = now;
		const [x, y] = localXY(e), ll = map.unprojectXY(x, y);
		hoverBusy = true; try { const h = await query(ll); if (!destroyed) await showHit(h, false, ll); } finally { hoverBusy = false; }
	};
	const onDown = e => { downXY = localXY(e); };
	const onClick = async e => { if (destroyed || !loaded.size || e.target.tagName !== "CANVAS") return; const [x, y] = localXY(e); if (downXY && Math.hypot(x - downXY[0], y - downXY[1]) >= 4) return; const ll = map.unprojectXY(x, y); hoverKey = null; await showHit(await query(ll), true, ll); };
	if (mapEl && opts.interactive !== false) {
		mapEl.addEventListener("pointermove", onMove, { signal, passive: true });
		mapEl.addEventListener("pointerdown", onDown, { signal, passive: true });
		mapEl.addEventListener("click", onClick, { signal });
	}

	// 初期表示＝データ全体へ寄ってから視野追従を始める（fit＝gint/layers.js の fitZoomForBbox と同式）
	if (fit && meta.bbox && meta.bbox.length === 4 && mapEl) {
		const b = meta.bbox, latC = (b[1] + b[3]) / 2;
		const thX = Math.max(1e-9, (b[2] - b[0]) * Math.cos(latC * D2R) * D2R), thY = Math.max(1e-9, (b[3] - b[1]) * D2R);
		const scale = 0.85 * Math.min(mapEl.clientWidth / thX, mapEl.clientHeight / thY);
		const z = Math.max(2, Math.min(17, Math.log2(scale / (WORLD_PX / (2 * Math.PI)))));
		map.flyTo((b[0] + b[2]) / 2, latC, z, 0, 0)?.catch?.(() => {});
	}
	const onSettle = () => { update(); };
	map.on("settle", onSettle);
	await refreshPaint();
	status(" · " + t("reading…"));
	const first = update();
	console.info(`[columnar] ${name}: ${meta.rows} rows, ${total} chunks (${meta.source}), ${MB(sizeBytes)} MB, ${pointOnly ? "points" : "geometry"}, numeric columns ${numericCols.length}${color ? ", color by " + color : ""}`);

	const h = {
		id: ovName, meta, ready: first.then(() => true), stats,
		get rows() { return meta.rows; }, get loaded() { return loaded.size; }, get deferred() { return deferredN; }, get cached() { return cachedN; }, pointOnly,
		get firstFrameMs() { return firstAt; },   // 最初のチャンクがオーバーレイへ渡るまで（open からの経過）
		get layers() { return loaded; },
		get color() { return color; }, setColor,
		setPaint, setFilter,
		setVisible(v) { shown = !!v; ov.post({ type: "vis", on: shown }); },
		get visible() { return shown; },
		query, on: (ev, cb) => { handlers[ev]?.push(cb); return h; },
		refresh: update, pixels,   // pixels()＝オーバーレイの実画素（検定用・premultiplied RGBA・下が先）
		metrics: () => rpc({ type: "metrics" }).then(r => r.metrics),
		dump: () => rpc({ type: "dump" }).then(r => r.dump),   // 診断（検定用）
		remove() {
			if (destroyed) return; destroyed = true; gen++;
			for (const g of [...loaded.keys()]) unload(g);
			ov.remove(); st?.remove(); tipSet?.(null); worker.terminate();
			map.off?.("settle", onSettle);
			if (mapEl) { mapEl.removeEventListener("pointermove", onMove); mapEl.removeEventListener("pointerdown", onDown); mapEl.removeEventListener("click", onClick); }
		},
	};
	h.destroy = h.remove;
	return h;
}
let seqView = 0;
