// ベクタタイルの押し出しの worker（段 8①・2026-09-26・main は gadgets/vtextrude.js）。役の名は "vtextrude"（worker.js の役表）。
// main が取ったタイルの生バイト（MVT）を預かり、層ごとに「解読 → filter → 輪の分類と枠で切る → earcut（幾何のキャッシュ）→ 高さと色 → メッシュ」を返す。
// 幾何は層×タイルで残す＝paint が変わっただけ（ズームの式・setPaintProperty）なら高さと色を付け直すだけ（earcut をやり直さない）。filter が変わった時だけ作り直す。
// 式は core の評価器を MapLibre の出自（origin "ml"）で＝基図・geojson の層と同じ意味。worker は core の index を読まない（循環 worker の轍＝tileworker.js の注記）。
// 生バイトの出し入れは main が決める（予算と LRU は main）＝ここは言われた物を持つだけ。無い時は miss を返す（main が取り直す）。
import { decodeMVT } from "@ortho-earth/core/decode";
import { evalExpr, truthy } from "@ortho-earth/core/expr";
import { parseRGBA, isColor } from "@ortho-earth/core/color";
import { classifyRings, tessellatePolygon, buildMesh, tileToLonLat } from "./vtmesh.js";

const raw = new Map();       // "sid|z/x/y" → Uint8Array（MVT）
const decoded = new Map();   // "sid|z/x/y|source-layer" → 解読済みの層（小さな LRU＝同じタイルを複数の層が使う時だけ効く）
const DECODED_MAX = 8;
const geoCache = new Map();  // "lid|z/x/y" → { fkey, geos: [{ fi, xy, starts, sgn, tris, wall }], feats: [{ id, props }], styles: Map<fi, {h, base}> }

const ML = "ml";
const ctxOf = (zoom, f, id) => ({ zoom, props: f.props, geom: "Polygon", vars: {}, origin: ML, id });
const num = (e, ctx, dflt) => { if (e == null) return dflt; const v = evalExpr(e, ctx); return typeof v === "number" && Number.isFinite(v) ? v : dflt; };   // ML の評価エラー＝既定値
const color = (e, ctx) => { const v = e == null ? "#000000" : evalExpr(e, ctx); return isColor(v) ? parseRGBA(v) : [0, 0, 0, 1]; };
const idOf = (f, promoteId, sourceLayer) => {
	const k = promoteId == null ? null : typeof promoteId === "string" ? promoteId : promoteId[sourceLayer];
	return k != null ? f.props[k] : f.id;
};

function layerOf(sid, key, sourceLayer) {
	const dk = `${sid}|${key}|${sourceLayer}`;
	let L = decoded.get(dk);
	if (L) { decoded.delete(dk); decoded.set(dk, L); return L; }
	const buf = raw.get(`${sid}|${key}`);
	if (!buf) return undefined;
	L = buf.byteLength ? (decodeMVT(buf, new Set([sourceLayer]))[sourceLayer] ?? null) : null;
	decoded.set(dk, L);
	while (decoded.size > DECODED_MAX) decoded.delete(decoded.keys().next().value);
	return L;
}

self.onmessage = e => {
	const m = e.data;
	try {
		if (m.kind === "put") { raw.set(`${m.sid}|${m.key}`, m.ab ? new Uint8Array(m.ab) : new Uint8Array(0)); self.postMessage({ id: m.id, ok: true }); return; }
		if (m.kind === "drop") {   // 生バイトを捨てる（main の LRU）
			raw.delete(`${m.sid}|${m.key}`);
			for (const k of [...decoded.keys()]) if (k.startsWith(`${m.sid}|${m.key}|`)) decoded.delete(k);
			return;
		}
		if (m.kind === "dropLayer") { for (const k of [...geoCache.keys()]) if (k.startsWith(m.lid + "|")) geoCache.delete(k); return; }
		if (m.kind === "dropTile") { geoCache.delete(`${m.lid}|${m.key}`); return; }
		if (m.kind === "build") { build(m); return; }
		if (m.kind === "query") { self.postMessage({ id: m.id, hits: query(m) }); return; }
		self.postMessage({ id: m.id, error: `unknown kind ${m.kind}` });
	} catch (err) { self.postMessage({ id: m.id, error: err?.message || String(err) }); }
};

// { lid, sid, key, z, x, y, layer（正規化済み＝エンジンの目盛り）, fzoom（filter の zoom）, zoom（paint の zoom）, promoteId, ell }
function build(m) {
	const { lid, sid, key, z, x, y, layer } = m, sl = layer["source-layer"];
	const L = layerOf(sid, key, sl);
	if (L === undefined) { self.postMessage({ id: m.id, miss: true }); return; }
	if (!L || !L.features.length) { geoCache.delete(`${lid}|${key}`); self.postMessage({ id: m.id, empty: true }); return; }
	const E = L.extent || 4096;
	const fkey = JSON.stringify(layer.filter ?? null) + "@" + m.fzoom + "|" + JSON.stringify(m.promoteId ?? null);
	let G = geoCache.get(`${lid}|${key}`);
	if (!G || G.fkey !== fkey || G.sl !== sl) {
		const geos = [], feats = [];
		for (let i = 0; i < L.features.length; i++) {
			const f = L.features[i];
			if (f.type !== "Polygon" || !f.geom) continue;
			const id = idOf(f, m.promoteId, sl);
			if (layer.filter != null && !truthy(evalExpr(layer.filter, ctxOf(m.fzoom, f, id)))) continue;
			const fi = feats.length;
			feats.push({ id, props: f.props });
			for (const rings of classifyRings(f.geom)) { const g = tessellatePolygon(rings, E); if (g) geos.push({ fi, ...g }); }
		}
		G = { fkey, sl, geos, feats, E, styles: new Map() };
		geoCache.set(`${lid}|${key}`, G);
	}
	const P = layer.paint || {};
	const op = Math.max(0, Math.min(1, num(P["fill-extrusion-opacity"], { zoom: m.zoom, props: {}, geom: null, vars: {}, origin: ML }, 1)));   // 層単位（データ駆動しない＝MapLibre と同じ）
	const grad = P["fill-extrusion-vertical-gradient"] !== false;
	const styles = new Map();
	for (let fi = 0; fi < G.feats.length; fi++) {
		const f = G.feats[fi], ctx = ctxOf(m.zoom, f, f.id);
		const h = num(P["fill-extrusion-height"], ctx, 0), base = Math.max(0, num(P["fill-extrusion-base"], ctx, 0));
		if (!(h > base)) continue;
		const c = color(P["fill-extrusion-color"], ctx);
		styles.set(fi, { h, base, grad, rgba: [c[0] * 255, c[1] * 255, c[2] * 255, Math.round(Math.max(0, Math.min(1, (c[3] ?? 1) * op)) * 255)] });
	}
	G.styles = styles;
	const r = buildMesh(G.geos, fi => styles.get(fi) ?? null, { z, x, y, extent: G.E }, { ell: m.ell });
	if (!r) { self.postMessage({ id: m.id, empty: true }); return; }
	const blend = [...styles.values()].some(s => s.rgba[3] < 255);
	const t = r.mesh;
	self.postMessage({ id: m.id, mesh: t, blend, stats: { ...r.stats, features: styles.size } }, [t.pos.buffer, t.nrm.buffer, t.idx.buffer, t.uv.buffer, t.col.buffer]);
}

// 当たりの候補＝足元の外接矩形が bbox（経緯度）に掛かる「描いた地物」。{ lid, keys: [z/x/y…], bbox: [w,s,e,n] } → [{ key, id, props, rings（経緯度の輪の列）, h, base }]
function query({ lid, keys, bbox }) {
	const out = [];
	for (const key of keys) {
		const G = geoCache.get(`${lid}|${key}`);
		if (!G) continue;
		const [z, x, y] = key.split("/").map(Number);
		const byFi = new Map();
		for (const g of G.geos) { const s = G.styles.get(g.fi); if (!s) continue; let a = byFi.get(g.fi); if (!a) byFi.set(g.fi, a = []); a.push(g); }
		for (const [fi, gs] of byFi) {
			const s = G.styles.get(fi), polys = [];
			let w = Infinity, so = Infinity, ea = -Infinity, no = -Infinity;
			for (const g of gs) {
				const rings = [];
				for (let r = 0; r < g.starts.length - 1; r++) {
					const ring = [];
					for (let k = g.starts[r]; k < g.starts[r + 1]; k++) {
						const p = tileToLonLat(z, x, y, G.E, g.xy[k * 2], g.xy[k * 2 + 1]); ring.push(p);
						if (p[0] < w) w = p[0]; if (p[0] > ea) ea = p[0]; if (p[1] < so) so = p[1]; if (p[1] > no) no = p[1];
					}
					ring.push(ring[0]); rings.push(ring);
				}
				polys.push(rings);
			}
			if (ea < bbox[0] || w > bbox[2] || no < bbox[1] || so > bbox[3]) continue;
			const f = G.feats[fi];
			out.push({ key, id: f.id, props: { ...f.props }, polys, h: s.h, base: s.base });
		}
	}
	return out;
}
