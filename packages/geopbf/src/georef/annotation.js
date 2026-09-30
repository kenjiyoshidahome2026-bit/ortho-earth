// Georeference Annotation（W3C Web Annotation・motivation "georeferencing"＝Allmaps の形・#177）の読み書き。
//   target.source＝IIIF の画像サービス（id・type ImageService2/3・width・height）・target.selector＝SvgSelector の多角形（resourceMask＝地図の枠）
//   body＝FeatureCollection：features[i].properties.resourceCoords（旧版 pixelCoords）＝画像の画素・geometry.coordinates＝経緯度
//   body.transformation＝{ type: polynomial | thinPlateSpline | projective | helmert, options: { order } }（無ければ polynomial 1 次）
// 1 枚でも AnnotationPage（items）でも配列でも受ける。依存なし。
import { fitTransform, lonLatToWorld, worldToLonLat, minPoints } from "./transform.js";

const arr = v => v == null ? [] : Array.isArray(v) ? v : [v];
const idOf = s => typeof s === "string" ? s : s?.id || s?.["@id"] || null;
// 画像の属する manifest（partOf を辿る：画像 → Canvas → Manifest）
const manifestOf = s => { for (const p of arr(s?.partOf)) { if (/Manifest/i.test(p?.type || p?.["@type"] || "")) return idOf(p); const q = manifestOf(p); if (q) return q; } return null; };
// SvgSelector の多角形（<polygon points="x,y x,y …">）→ [[x, y]…]
export function parseSvgPolygon(svg) {
	const m = /points\s*=\s*["']([^"']+)["']/i.exec(String(svg || ""));
	if (!m) return null;
	const n = m[1].trim().split(/[\s,]+/).map(Number);
	const pts = []; for (let i = 0; i + 1 < n.length; i += 2) if (Number.isFinite(n[i]) && Number.isFinite(n[i + 1])) pts.push([n[i], n[i + 1]]);
	return pts.length >= 3 ? pts : null;
}
const TYPES = { polynomial: "polynomial", polynomial1: "polynomial", polynomial2: "polynomial", polynomial3: "polynomial", thinplatespline: "thinPlateSpline", tps: "thinPlateSpline", projective: "projective", helmert: "helmert", straight: "helmert" };
function transformationOf(t) {
	const raw = typeof t === "string" ? t : t?.type;
	const k = String(raw || "polynomial").replace(/[\s_-]/g, "").toLowerCase(), type = TYPES[k] || "polynomial";
	const order = /^polynomial([123])$/.exec(k)?.[1] ?? t?.options?.order ?? t?.order ?? 1;
	return { type, order: type === "polynomial" ? Math.max(1, Math.min(3, +order || 1)) : null };
}

/** 注記（1 枚・ページ・配列）→ [{ image: { id, type, width, height }, gcps: [{ resource: [x, y], geo: [lon, lat] }], mask, transformation, id }] */
export function parseGeoreference(json) {
	const list = [];
	const visit = a => {
		if (!a || typeof a !== "object") return;
		if (Array.isArray(a)) return a.forEach(visit);
		if (a.type === "AnnotationPage" || Array.isArray(a.items)) return arr(a.items).forEach(visit);
		const target = a.target || {}, src = target.source || target;
		const image = { id: idOf(src), type: src?.type || src?.["@type"] || null, width: +src?.width || null, height: +src?.height || null, manifest: manifestOf(src) };   // manifest＝表示義務（requiredStatement）の在り処
		const body = a.body || {};
		const gcps = arr(body.features).map(f => ({ resource: f?.properties?.resourceCoords || f?.properties?.pixelCoords, geo: f?.geometry?.coordinates }))
			.filter(g => Array.isArray(g.resource) && Array.isArray(g.geo) && g.resource.every(Number.isFinite) && g.geo.slice(0, 2).every(Number.isFinite))
			.map(g => ({ resource: [+g.resource[0], +g.resource[1]], geo: [+g.geo[0], +g.geo[1]] }));
		const sel = arr(target.selector).find(s => /svg/i.test(s?.type || "")) || null;
		if (!image.id || !gcps.length) return;
		list.push({ id: a.id || null, image, gcps, mask: sel ? parseSvgPolygon(sel.value) : null, transformation: transformationOf(body.transformation || a.transformation) });
	};
	visit(json);
	return list;
}

/** 読んだ 1 枚 → 注記（Allmaps の形・書き出し） */
export function toGeoreferenceAnnotation(g) {
	const mask = g.mask || (g.image.width && g.image.height ? [[0, 0], [g.image.width, 0], [g.image.width, g.image.height], [0, g.image.height]] : null);
	const svg = mask ? `<svg width="${g.image.width || ""}" height="${g.image.height || ""}"><polygon points="${mask.map(p => p.join(",")).join(" ")}" /></svg>` : null;
	return {
		"@context": ["http://iiif.io/api/extension/georef/1/context.json", "http://iiif.io/api/presentation/3/context.json"],
		type: "Annotation", ...(g.id ? { id: g.id } : {}), motivation: "georeferencing",
		target: { type: "SpecificResource", source: { id: g.image.id, type: g.image.type || "ImageService3", ...(g.image.width ? { width: g.image.width, height: g.image.height } : {}) }, ...(svg ? { selector: { type: "SvgSelector", value: svg } } : {}) },
		body: { type: "FeatureCollection", transformation: { type: g.transformation?.type || "polynomial", ...(g.transformation?.type === "polynomial" || !g.transformation ? { options: { order: g.transformation?.order || 1 } } : {}) },
			features: g.gcps.map(p => ({ type: "Feature", properties: { resourceCoords: p.resource }, geometry: { type: "Point", coordinates: p.geo } })) },
	};
}

/**
 * 1 枚の写像：画像の画素 ⇄ メルカトルの世界座標（0..1・y 下向き＝タイルの z/x/y と同じ）。両向きを別々に当てはめる（TPS に閉じた逆は無い）。
 * @returns {{ toResource(w: [x, y]): [px, py], toWorld(p: [px, py]): [x, y], mask: [[x, y]…], worldBox: [x0, y0, x1, y1], bbox: [w, s, e, n], residuals: number[] }}
 *   residuals＝基準点の順写像の残差（メートル・その緯度の地表で）
 */
export function georefMapping(g) {
	const t = g.transformation || { type: "polynomial", order: 1 };
	const need = minPoints(t.type, t.order || 1);
	const tt = g.gcps.length >= need ? t : { type: g.gcps.length >= 3 ? "polynomial" : "helmert", order: 1 };   // 点が足りない＝型を下げる（Allmaps と同じく落とさない）
	const R = g.gcps.map(p => p.resource), W = g.gcps.map(p => lonLatToWorld(p.geo));
	const toWorld = fitTransform(R, W, tt), toResource = fitTransform(W, R, tt);
	const mask = g.mask || (g.image.width && g.image.height ? [[0, 0], [g.image.width, 0], [g.image.width, g.image.height], [0, g.image.height]] : null);
	let box = null;
	if (mask) {   // 枠の辺を細かく写して外接箱（曲がる変換＝辺の途中が膨らむ）
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (let i = 0; i < mask.length; i++) {
			const a = mask[i], b = mask[(i + 1) % mask.length];
			for (let k = 0; k < 16; k++) { const f = k / 16, [x, y] = toWorld([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
		}
		box = [x0, y0, x1, y1];
	}
	const lat = g.gcps.reduce((s, p) => s + p.geo[1], 0) / g.gcps.length, mPerWorld = 40075016.686 * Math.cos(lat * Math.PI / 180);
	const res = R.map((p, i) => { const q = toWorld(p); return Math.hypot(q[0] - W[i][0], q[1] - W[i][1]) * mPerWorld; });
	const bbox = box ? [...worldToLonLat([box[0], box[3]]), ...worldToLonLat([box[2], box[1]])] : null;
	return { toResource, toWorld, mask, worldBox: box, bbox, residuals: res, transformation: tt };
}
