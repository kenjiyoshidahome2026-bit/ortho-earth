// GeoParquet の視野追従（部分読み）＝大きな .parquet を全量変換せず、視野に触れる row group だけ Range で読んで描く（2026-09-20・Phase B）。
//   入口：app.js の ?g=（URL）とドロップ（File）。閾値（PARQUET_STREAM_BYTES）以下は従来の全量経路（fromGeoParquet → gint）。
//   読む：geopbf/parquet の openParquet（footer 1 本）→ select({bbox})（bbox 覆域列の統計）→ readRowGroup(g, { columns })（列チャンクだけ）。
//   描く：面・線＝row group ごとに幾何だけの GeoPBF 断片 → gint の追加層（map.addGint・interactive:false）。点だけ＝gint を経由せず
//         経緯度の列 → 単位球 xyz → 同一フレームの点オーバーレイ（points-gl.js）。
//   属性：列のまま（本人裁定 9/20）＝GeoPBF の properties に写さない。ホバー/クリックで (row group, 行) を引き、その row group の
//         属性列を初回だけ読んで tip に出す。識別は main の JS（層ごとの query＝pbf.identifyAt／点は最寄り）＝カーソル層は既定のまま。
//   予算：常駐は budgetBytes（既定 64MB・row group の圧縮サイズで数える）。視野の中心に近い row group から載せ、超えた分は
//         「ズームインで残り N」と状況表示に出す。視野から外れた row group は外す（PLATEAU の区の出し入れと同じ考え）。
//   前提：GeoParquet 1.1 の bbox 覆域列。統計の無いファイル（select が pruned:false）は「統計なし＝全読み」と明示して予算内で全部読む。
import { openParquet, parseWkb } from "geopbf/parquet";
import { GeoPBF } from "geopbf/pbf-base";
import { geopbf } from "geopbf";
import { ellipsoidOn } from "ortho-core";
import { tr } from "../i18n.js";
import pointsUrl from "./points-gl.js?url";   // worker が import() する URL（依存ゼロのモジュール）

const D2R = Math.PI / 180, WORLD_PX = 256;
const MB = n => (n / 1e6).toFixed(n >= 1e7 ? 0 : 1);
const HOVER_POINTS_MAX = 60000;   // これ以下の点数ならホバーでも最寄りを探す（それ以上はクリックだけ）

export async function createParquetView(map, src, { name, budgetBytes = 64e6, signal } = {}) {
	const t = tr();
	name ??= (typeof src === "string" ? decodeURIComponent(src.split("/").pop() || "") : src?.name) || "parquet";
	const pq = await openParquet(src);
	const geom = pq.geometry;
	if (!geom) throw new Error(t("Not a GeoParquet file (no geo metadata)"));
	if (geom.encoding !== "WKB") throw new Error(t("Only WKB geometry is supported ($1)", geom.encoding));
	const crs = geom.crs === undefined ? "CRS84(default)" : geom.crs === null ? "CRS84" : (geom.crs.id ? `${geom.crs.id.authority}:${geom.crs.id.code}` : geom.crs.name || "?");
	if (!/CRS84|4326/.test(crs)) throw new Error(t("GeoParquet: CRS is not lon/lat ($1)", crs));
	const pointOnly = geom.types.length > 0 && geom.types.every(x => /^(Multi)?Point$/.test(x));
	const precision = pq.keyValue["geopbf:precision"] ? +pq.keyValue["geopbf:precision"] : 6;
	const cov = geom.covering;   // { xmin: "bbox.xmin", … } | null
	const covNames = new Set(cov ? Object.values(cov) : []);
	const attrCols = pq.columns.filter(c => c.name !== geom.name && !c.unsupported && !covNames.has(c.name)).map(c => c.name);
	const rgs = pq.rowGroups, total = rgs.length, sizeBytes = pq.source.size || 0;
	const mapEl = map.mapEl;

	// 状況表示（出典の上・小さく）
	const st = document.createElement("div");
	st.className = "pq-status";
	st.style.cssText = "position:absolute;left:50%;bottom:44px;transform:translateX(-50%);z-index:29;pointer-events:none;padding:5px 12px;border-radius:9px;background:rgba(12,17,32,.78);color:#e7ecf5;font:12px/1.5 system-ui,sans-serif;white-space:nowrap;max-width:calc(100% - 24px);overflow:hidden;text-overflow:ellipsis";
	mapEl.appendChild(st);
	const status = (extra = "") => {
		let read = 0, n = 0; for (const L of loaded.values()) { read += L.bytes; n++; }
		st.textContent = t("GeoParquet $1: $2/$3 row groups · $4 MB of $5 MB", name, n, total, MB(read), MB(sizeBytes)) + extra;
	};

	const ov = pointOnly ? map.overlay(pointsUrl, { name: "parquet-points" }) : null;
	const rAx = ellipsoidOn() ? 1 - 1 / 298.257223563 : 1;
	const tipSet = map.gadget.tip();
	const loaded = new Map();     // g → { layer?, n, rows: Int32Array(fid→行), lon?, lat?, bytes, attrs: Map|null }
	const loading = new Set();
	let gen = 0, destroyed = false, deferredN = 0, rowsTotal = 0;

	// 視野 bbox（app.js の approxViewBbox と同式＝z の正射スケール・対角余裕 1.5）
	const viewBbox = () => {
		const c = map.cam.center, z = map.cam.zoom;
		const mpp = 156543.03392 * 0.819 / Math.pow(2, z), halfM = Math.max(mapEl.clientWidth, mapEl.clientHeight) * 1.5 * mpp;
		const dLat = halfM / 111320, dLon = dLat / Math.max(0.15, Math.cos(c[1] * D2R));
		return [c[0] - dLon, c[1] - dLat, c[0] + dLon, c[1] + dLat];
	};
	const rgCenter = g => { const s = rgs[g].stats; if (!cov || !s[cov.xmin]) return null; return [(s[cov.xmin].min + s[cov.xmax].max) / 2, (s[cov.ymin].min + s[cov.ymax].max) / 2]; };

	// 点：単位球 xyz（quakes-worker の toGpu と同式・h=0）
	const toPos = (lon, lat, n, rows) => {
		const pos = new Float32Array(n * 3);
		for (let k = 0; k < n; k++) {
			const i = rows[k], a = lon[i] * D2R, b = lat[i] * D2R;
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
				let lon, lat;
				if (cov) { const m = await pq.readRowGroup(g, { columns: [cov.xmin, cov.ymin] }); lon = m.get(cov.xmin); lat = m.get(cov.ymin); }   // 点の bbox＝座標そのもの＝WKB を解かない
				else {
					const m = await pq.readRowGroup(g, { columns: [geom.name] }), wk = m.get(geom.name);
					lon = new Array(wk.length); lat = new Array(wk.length);
					for (let i = 0; i < wk.length; i++) { const gm = wk[i] ? parseWkb(wk[i], {}) : null; const c = gm?.type === "Point" ? gm.coordinates : gm?.type === "MultiPoint" ? gm.coordinates[0] : null; lon[i] = c ? c[0] : null; lat[i] = c ? c[1] : null; }
				}
				if (destroyed || myGen !== gen) return;
				const rows = []; for (let i = 0; i < lon.length; i++) if (typeof lon[i] === "number" && typeof lat[i] === "number") rows.push(i);
				const idx = Int32Array.from(rows), n = idx.length;
				const pos = toPos(lon, lat, n, idx);
				ov.post({ type: "layer", q: g, n, pos }, [pos.buffer]);
				loaded.set(g, { n, rows: idx, lon: Float64Array.from(idx, i => lon[i]), lat: Float64Array.from(idx, i => lat[i]), bytes: rgs[g].bytes, attrs: null });
			} else {
				const m = await pq.readRowGroup(g, { columns: [geom.name] }), wk = m.get(geom.name);
				if (!wk) throw new Error(`row group ${g}: geometry column unreadable`);
				const f = new GeoPBF({ name: `${name}#${g}`, precision });
				f.setHead([], []);   // 幾何だけ＝属性は列のまま（読むのは tip のとき）
				const rows = [], ctx = { vertices: 0 };
				await f.setBodyAsync(async () => { for (let i = 0; i < wk.length; i++) { const gm = wk[i] ? parseWkb(wk[i], ctx) : null; if (!gm) continue; f.setFeature({ type: "Feature", properties: {}, geometry: gm }); rows.push(i); } });
				f.close();
				const pbf = await geopbf(new Uint8Array(f.arrayBuffer), { gint: true, name: `${name}#${g}` });
				if (destroyed || myGen !== gen) return;
				const layer = map.addGint(pbf, { order: 40, interactive: false });   // カーソルは既定層のまま＝識別は main の query（下）
				loaded.set(g, { layer, pbf, n: rows.length, rows: Int32Array.from(rows), bytes: rgs[g].bytes, attrs: null });
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
		const bbox = viewBbox(), sel = pq.select({ bbox });
		const c = map.cam.center;
		const want = sel.groups.slice().sort((a, b) => { const ca = rgCenter(a), cb = rgCenter(b); if (!ca || !cb) return a - b; return Math.hypot(ca[0] - c[0], ca[1] - c[1]) - Math.hypot(cb[0] - c[0], cb[1] - c[1]); });
		const keep = new Set(); let bytes = 0; deferredN = 0;
		for (const g of want) { if (bytes + rgs[g].bytes <= budgetBytes || keep.size === 0) { keep.add(g); bytes += rgs[g].bytes; } else deferredN++; }
		for (const g of [...loaded.keys()]) if (!keep.has(g)) unload(g);
		const queue = [...keep].filter(g => !loaded.has(g) && !loading.has(g));
		const note = () => (sel.pruned ? "" : " · " + t("no bbox statistics = reading everything")) + (deferredN ? " · " + t("zoom in to load $1 more", deferredN) : "");
		status(note());
		const lane = async () => { while (queue.length && gen === myGen && !destroyed) { await load(queue.shift()); status(note()); } };
		await Promise.all([lane(), lane()]);
		if (gen === myGen) status(note());
	}

	// ── 識別（main の JS）：面・線＝層ごとの query（pbf.identifyAt）／点＝最寄り（画面 px）──
	const linesFor = async (g, row) => {
		const L = loaded.get(g); if (!L) return null;
		L.attrs ??= await pq.readRowGroup(g, { columns: attrCols });   // 属性列は初回だけ（列のまま持つ）
		const out = [];
		for (const k of attrCols) { const v = L.attrs.get(k)?.[row]; if (v === null || v === undefined) continue; out.push(`${k}: ${v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : v}`); if (out.length >= 30) break; }
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
		if (destroyed || e.buttons || !loaded.size) return;
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
	console.info(`[parquet] ${name}: ${pq.numRows} rows, ${total} row groups, ${MB(sizeBytes)} MB, ${pointOnly ? "points → overlay" : "geometry → gint fragments"}, covering ${cov ? "yes" : "no"}`);

	return {
		pq, get rows() { return pq.numRows; }, get loaded() { return loaded.size; }, get deferred() { return deferredN; }, pointOnly,
		get layers() { return loaded; },   // 検証用（g → { layer?, pbf?, n, rows, … }）
		refresh: update,
		destroy() {
			if (destroyed) return; destroyed = true; gen++;
			for (const g of [...loaded.keys()]) unload(g);
			ov?.remove(); st.remove(); tipSet(null);
			mapEl.removeEventListener("pointermove", onMove); mapEl.removeEventListener("pointerdown", onDown); mapEl.removeEventListener("click", onClick);
		},
	};
}
