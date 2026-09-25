// GeoParquet の視野追従（部分読み）＝大きな .parquet を全量変換せず、視野に触れる row group だけ Range で読んで描く（2026-09-20・Phase B）。
//   入口：app.js の ?g=（URL）とドロップ（File）。閾値（PARQUET_STREAM_BYTES）以下は従来の全量経路（fromGeoParquet → gint）。
//   読む：相方の worker（parquet-worker.js）が footer（geopbf/parquet）→ select({bbox})（bbox 覆域列の統計）→ row group の列チャンクだけ Range。
//         WKB → 幾何だけの GeoPBF 断片の組み立て・点の列出し・属性列・IDB キャッシュ（URL|ETag|row group）も worker＝main は塞がない。
//   描く：面・線＝row group ごとの GeoPBF 断片 → gint の追加層（map.addGint・interactive:false）。点だけ＝gint を経由せず
//         経緯度の列 → 単位球 xyz → 同一フレームの点オーバーレイ（points-gl.js）。MultiPoint は worker が点に展開（rows は元の行）。
//   属性：列のまま（本人裁定 9/20）。ホバー/クリックで (row group, 行) を引き、その row group の属性列を初回だけ読んで tip に出す。
//         識別は main の JS（層ごとの query＝pbf.identifyAt／点は最寄り）＝カーソル層は既定のまま。
//   色分け：数値列を選ぶと、そのレンジ（row group 統計の min/max＝データを読まずに決まる）で 5 段の色。面＝その 1 列だけ properties に載せて
//         gint の paint 式（interpolate/get）・点＝点ごとの RGBA。列は状況表示の select か ?color=<列> で。
//   予算：常駐は budgetBytes（既定 64MB・row group の圧縮サイズで数える）。視野の中心に近い row group から載せ、超えた分は
//         「ズームインで残り N」と状況表示に出す。視野から外れた row group は外す。統計の無いファイルは「統計なし＝全読み」と明示。
import { geopbf } from "geopbf";
import { ellipsoidOn } from "@ortho-earth/core";
import { tr } from "../i18n.js";
import pointsUrl from "./points-gl.js?url";   // worker が import() する URL（依存ゼロのモジュール）

const D2R = Math.PI / 180, WORLD_PX = 256;
const MB = n => (n / 1e6).toFixed(n >= 1e7 ? 0 : 1);
const HOVER_POINTS_MAX = 60000;   // これ以下の点数ならホバーでも最寄りを探す（それ以上はクリックだけ）
const RAMP = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];   // 5 段（viridis の要約）
const NA_RGBA = [160, 160, 160, 140];
const hex2rgb = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const RAMP_RGB = RAMP.map(hex2rgb);
const rampAt = t => { const x = Math.max(0, Math.min(1, t)) * (RAMP_RGB.length - 1), k = Math.min(RAMP_RGB.length - 2, Math.floor(x)), f = x - k; const a = RAMP_RGB[k], b = RAMP_RGB[k + 1]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; };

export async function createParquetView(map, src, { name, budgetBytes = 64e6, color: color0 = null, signal } = {}) {
	const t = tr();
	name ??= (typeof src === "string" ? decodeURIComponent(src.split("/").pop() || "") : src?.name) || "parquet";
	// ── worker（読み手）と RPC ──
	const worker = new Worker(new URL("../worker.js", import.meta.url), { type: "module", name: "parquet" });   // 入口 1 本（worker.js）＝役割は name（gadgets/parquet-worker.js）
	let seq = 0; const waiting = new Map();
	worker.onmessage = e => { const d = e.data, w = waiting.get(d.id); if (!w) return; waiting.delete(d.id); d.error ? w.rej(new Error(d.error)) : w.res(d); };
	worker.onerror = e => console.error("[parquet] worker error", e.message);
	const rpc = (msg, transfer) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); worker.postMessage({ id, ...msg }, transfer || []); });
	let meta;
	try { ({ meta } = await rpc({ type: "open", src })); } catch (err) { worker.terminate(); throw err; }
	const geom = meta.geometry;
	if (!geom) { worker.terminate(); throw new Error(t("Not a GeoParquet file (no geo metadata)")); }
	if (geom.encoding !== "WKB") { worker.terminate(); throw new Error(t("Only WKB geometry is supported ($1)", geom.encoding)); }
	const crs = geom.crs === undefined ? "CRS84(default)" : geom.crs === null ? "CRS84" : (geom.crs.id ? `${geom.crs.id.authority}:${geom.crs.id.code}` : geom.crs.name || "?");
	if (!/CRS84|4326/.test(crs)) { worker.terminate(); throw new Error(t("GeoParquet: CRS is not lon/lat ($1)", crs)); }
	const pointOnly = geom.types.length > 0 && geom.types.every(x => /^(Multi)?Point$/.test(x));
	const cov = geom.covering;
	const rgs = meta.rowGroups, total = rgs.length, sizeBytes = meta.size || 0;
	const numericCols = meta.columns.filter(c => c.numeric && meta.range[c.name]).map(c => c.name);
	let color = color0 && numericCols.includes(color0) ? color0 : null;
	const mapEl = map.mapEl;

	// ── 状況表示（＋色分けの列選び）──
	const st = document.createElement("div");
	st.className = "pq-status";
	st.style.cssText = "position:absolute;left:50%;bottom:44px;transform:translateX(-50%);z-index:29;display:flex;gap:10px;align-items:center;padding:5px 12px;border-radius:9px;background:rgba(12,17,32,.8);color:#e7ecf5;font:12px/1.5 system-ui,sans-serif;white-space:nowrap;max-width:calc(100% - 24px)";
	st.innerHTML = `<span class="pq-text" style="overflow:hidden;text-overflow:ellipsis"></span>` + (numericCols.length ? `<label style="display:inline-flex;gap:4px;align-items:center;pointer-events:auto">${t("Color by")} <select class="pq-color" style="font:inherit;font-size:12px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#e7ecf5;padding:2px 4px;max-width:12em"></select></label>` : "");
	mapEl.appendChild(st);
	const textEl = st.querySelector(".pq-text"), sel = st.querySelector(".pq-color");
	if (sel) {
		sel.innerHTML = `<option value="">${t("(none) ##color")}</option>` + numericCols.map(c => `<option value="${c.replace(/"/g, "&quot;")}"${c === color ? " selected" : ""}>${c.replace(/</g, "&lt;")}</option>`).join("");
		sel.addEventListener("change", () => setColor(sel.value || null), { signal });
	}
	const status = (extra = "") => {
		let read = 0, n = 0; for (const L of loaded.values()) { read += L.bytes; n++; }
		textEl.textContent = t("GeoParquet $1: $2/$3 row groups · $4 MB of $5 MB", name, n, total, MB(read), MB(sizeBytes)) + extra;
	};

	const ov = pointOnly ? map.overlay(pointsUrl, { name: "parquet-points" }) : null;
	const rAx = ellipsoidOn() ? 1 - 1 / 298.257223563 : 1;
	const tipSet = map.gadget.tip();
	const loaded = new Map();     // g → { layer?, pbf?, n, rows: Int32Array(fid→行), lon?, lat?, bytes, attrs: object|null }
	const loading = new Set();
	let gen = 0, destroyed = false, deferredN = 0, rowsTotal = 0, cachedN = 0;

	// 視野 bbox（app.js の approxViewBbox と同式＝z の正射スケール・対角余裕 1.5）
	const viewBbox = () => {
		const c = map.cam.center, z = map.cam.zoom;
		const mpp = 156543.03392 * 0.819 / Math.pow(2, z), halfM = Math.max(mapEl.clientWidth, mapEl.clientHeight) * 1.5 * mpp;
		const dLat = halfM / 111320, dLon = dLat / Math.max(0.15, Math.cos(c[1] * D2R));
		return [c[0] - dLon, c[1] - dLat, c[0] + dLon, c[1] + dLat];
	};
	const rgCenter = g => { const s = rgs[g].stats; if (!cov || !s[cov.xmin]) return null; return [(s[cov.xmin].min + s[cov.xmax].max) / 2, (s[cov.ymin].min + s[cov.ymax].max) / 2]; };
	// 色分けの物差し（列のレンジ）と paint 式（面）
	const range = () => (color && meta.range[color]) || null;
	const paintFor = () => {
		const r = range(); if (!r) return null;
		const [lo, hi] = r, stops = RAMP.flatMap((c, i) => [lo + (hi - lo) * i / (RAMP.length - 1), c]);
		const expr = hi > lo ? ["interpolate", ["linear"], ["get", color], ...stops] : RAMP[2];
		return { "fill-color": expr, "fill-opacity": 0.55, "line-color": expr, "line-opacity": 0.9, "line-width": 0.5 };   // CSS px（2026-09-26・旧 1 device px と同じ見た目）
	};
	const rgbaFor = vals => {
		const r = range(), out = new Uint8Array(vals.length * 4);
		for (let i = 0; i < vals.length; i++) {
			const v = vals[i];
			if (!r || !Number.isFinite(v)) { out.set(NA_RGBA, i * 4); continue; }
			const c = rampAt(r[1] > r[0] ? (v - r[0]) / (r[1] - r[0]) : 0.5);
			out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = 235;
		}
		return out;
	};

	// 点：単位球 xyz（quakes-worker の toGpu と同式・h=0）
	const toPos = (lon, lat) => {
		const n = lon.length, pos = new Float32Array(n * 3);
		for (let k = 0; k < n; k++) {
			const a = lon[k] * D2R, b = lat[k] * D2R;
			let sb = Math.sin(b), cb = Math.cos(b);
			if (rAx !== 1) { const w = Math.hypot(cb, rAx * sb); sb = rAx * sb / w; cb = cb / w; }
			pos[k * 3] = cb * Math.cos(a); pos[k * 3 + 1] = sb; pos[k * 3 + 2] = cb * Math.sin(a);
		}
		return pos;
	};

	async function load(g) {
		loading.add(g);
		const myGen = gen;
		try {
			if (pointOnly) {
				const r = await rpc({ type: "rg", g, mode: "points", color });
				if (destroyed || myGen !== gen) return;
				const pos = toPos(r.lon, r.lat), rgba = color && r.vals ? rgbaFor(r.vals) : null;
				ov.post({ type: "layer", q: g, n: r.lon.length, pos, rgba }, [pos.buffer, ...(rgba ? [rgba.buffer] : [])]);
				loaded.set(g, { n: r.lon.length, rows: r.rows, lon: r.lon, lat: r.lat, bytes: rgs[g].bytes, attrs: null });
				if (r.cached) cachedN++;
			} else {
				const r = await rpc({ type: "rg", g, mode: "geom", color });
				const pbf = await geopbf(new Uint8Array(r.bytes), { gint: true, name: `${name}#${g}${color ? ":" + color : ""}` });
				if (destroyed || myGen !== gen) return;
				const layer = map.addGint(pbf, { order: 40, interactive: false });   // カーソルは既定層のまま＝識別は main の query（下）
				const paint = paintFor(); if (paint) layer.setPaint(paint);
				loaded.set(g, { layer, pbf, n: r.rows.length, rows: r.rows, bytes: rgs[g].bytes, attrs: null });
				if (r.cached) cachedN++;
			}
			rowsTotal += loaded.get(g)?.n ?? 0;
		} catch (err) { console.warn("[parquet] row group", g, "failed:", err?.message || err); }
		finally { loading.delete(g); }
	}
	function unload(g) {
		const L = loaded.get(g); if (!L) return;
		rowsTotal -= L.n;
		if (L.layer) L.layer.remove(); else ov?.post({ type: "remove", q: g });
		loaded.delete(g);
	}
	async function update() {
		if (destroyed) return;
		const myGen = ++gen;
		const bbox = viewBbox();
		const sel2 = await rpc({ type: "select", bbox });
		if (destroyed || myGen !== gen) return;
		const c = map.cam.center;
		const want = sel2.groups.slice().sort((a, b) => { const ca = rgCenter(a), cb = rgCenter(b); if (!ca || !cb) return a - b; return Math.hypot(ca[0] - c[0], ca[1] - c[1]) - Math.hypot(cb[0] - c[0], cb[1] - c[1]); });
		const keep = new Set(); let bytes = 0; deferredN = 0;
		for (const g of want) { if (bytes + rgs[g].bytes <= budgetBytes || keep.size === 0) { keep.add(g); bytes += rgs[g].bytes; } else deferredN++; }
		for (const g of [...loaded.keys()]) if (!keep.has(g)) unload(g);
		const queue = [...keep].filter(g => !loaded.has(g) && !loading.has(g));
		const note = () => (sel2.pruned ? "" : " · " + t("no bbox statistics = reading everything")) + (deferredN ? " · " + t("zoom in to load $1 more", deferredN) : "");
		status(note());
		const lane = async () => { while (queue.length && gen === myGen && !destroyed) { await load(queue.shift()); status(note()); } };
		await Promise.all([lane(), lane()]);
		if (gen === myGen) status(note());
	}
	// 色分けの列を替える＝断片を焼き直す（面は properties が変わる・点は RGBA が変わる）
	function setColor(col) {
		color = col && numericCols.includes(col) ? col : null;
		if (sel && sel.value !== (color || "")) sel.value = color || "";
		gen++;
		for (const g of [...loaded.keys()]) unload(g);
		update();
	}

	// ── 識別（main の JS）：面・線＝層ごとの query（pbf.identifyAt）／点＝最寄り（画面 px）──
	const linesFor = async (g, row) => {
		const L = loaded.get(g); if (!L) return null;
		if (!L.attrs) { const r = await rpc({ type: "attrs", g }); if (!loaded.has(g)) return null; L.attrs = r.attrs; }   // 属性列は初回だけ（列のまま持つ）
		const out = [];
		for (const k of Object.keys(L.attrs)) { const v = L.attrs[k]?.[row]; if (v === null || v === undefined) continue; out.push(`${k}: ${v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : v}`); if (out.length >= 30) break; }
		return out.length ? out : [t("(no attributes)")];
	};
	const hitAt = (x, y) => {
		const ll = map.unprojectXY(x, y);
		if (pointOnly) {
			const pr = map.makeProjector(); let best = null, bd = 64;   // 8px
			for (const [g, L] of loaded) for (let k = 0; k < L.n; k++) { const s = pr(L.lon[k], L.lat[k]); if (s[2] < 0) continue; const d = (s[0] - x) ** 2 + (s[1] - y) ** 2; if (d < bd) { bd = d; best = { g, row: L.rows[k] }; } }
			return best;
		}
		if (!ll) return null;
		for (const [g, L] of loaded) { const fid = L.pbf.identifyAt?.(ll[0], ll[1]); if (fid != null && fid >= 0) return { g, row: L.rows[fid] }; }
		return null;
	};
	let hoverKey = null, hoverT = 0;
	const localXY = e => { const r = mapEl.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
	const showHit = async (h) => {
		const key = h ? `${h.g}:${h.row}` : null;
		if (key === hoverKey) return;
		hoverKey = key;
		if (!h) { tipSet(null); return; }
		const lines = await linesFor(h.g, h.row);
		if (hoverKey === key) tipSet(lines);
	};
	const onMove = e => {
		if (destroyed || e.buttons || !loaded.size || st.contains(e.target)) return;
		if (pointOnly && rowsTotal > HOVER_POINTS_MAX) return;   // 大量の点はクリックだけ
		const now = performance.now(); if (now - hoverT < 60) return; hoverT = now;
		const [x, y] = localXY(e); showHit(hitAt(x, y));
	};
	let downXY = null;
	const onDown = e => { downXY = localXY(e); };
	const onClick = e => { if (destroyed || !loaded.size || e.target.tagName !== "CANVAS") return; const [x, y] = localXY(e); if (downXY && Math.hypot(x - downXY[0], y - downXY[1]) >= 4) return; hoverKey = null; showHit(hitAt(x, y)); };
	mapEl.addEventListener("pointermove", onMove, { signal, passive: true });
	mapEl.addEventListener("pointerdown", onDown, { signal, passive: true });
	mapEl.addEventListener("click", onClick, { signal });

	// 初期表示＝データ全体へ寄ってから視野追従を始める（fit＝gint/layers.js の fitZoomForBbox と同式）
	if (geom.bbox && geom.bbox.length === 4) {
		const b = geom.bbox, latC = (b[1] + b[3]) / 2;
		const thX = Math.max(1e-9, (b[2] - b[0]) * Math.cos(latC * D2R) * D2R), thY = Math.max(1e-9, (b[3] - b[1]) * D2R);
		const scale = 0.85 * Math.min(mapEl.clientWidth / thX, mapEl.clientHeight / thY);
		const z = Math.max(2, Math.min(17, Math.log2(scale / (WORLD_PX / (2 * Math.PI)))));
		map.flyTo((b[0] + b[2]) / 2, latC, z, 0, 0).catch(() => {});
	}
	map.on("settle", () => { update(); });
	status(" · " + t("reading…"));
	update();
	console.info(`[parquet] ${name}: ${meta.numRows} rows, ${total} row groups, ${MB(sizeBytes)} MB, ${pointOnly ? "points → overlay" : "geometry → gint fragments"}, covering ${cov ? "yes" : "no"}, numeric columns ${numericCols.length}${color ? ", color by " + color : ""}`);

	return {
		meta, get rows() { return meta.numRows; }, get loaded() { return loaded.size; }, get deferred() { return deferredN; }, get cached() { return cachedN; }, pointOnly,
		get layers() { return loaded; },   // 検証用（g → { layer?, pbf?, n, rows, … }）
		get color() { return color; }, setColor,
		refresh: update,
		metrics: () => rpc({ type: "metrics" }).then(r => r.metrics),
		destroy() {
			if (destroyed) return; destroyed = true; gen++;
			for (const g of [...loaded.keys()]) unload(g);
			ov?.remove(); st.remove(); tipSet(null); worker.terminate();
			mapEl.removeEventListener("pointermove", onMove); mapEl.removeEventListener("pointerdown", onDown); mapEl.removeEventListener("click", onClick);
		},
	};
}
