// The Cesium examples gate (stage 0): the pure part. A run (run.mjs) records one side of one example; grade() compares the facade (ortho) with real CesiumJS (ref).
//   level null = real Cesium does not run it here (out of the count) · 0 = ours does not run · 1 = runs · 2 = same answers · 3 = same picture
// The answers: the counts (entities, data sources, primitives, imagery layers), the camera, and nothing reported unsupported.
// The picture: the screenshots cut into a grid of cells, the mean colour of each cell compared (the widgets are the real ones on both sides, so they match too).
import { decodePng } from "../mlexamples/compare.mjs";
export { decodePng };

// first cut, to tune by eye on the contact sheet
export const THRESH = { camRel: 0.02, camAbs: 50, angDeg: 2, cellTol: 40, cellMin: 0.8, gridW: 16, gridH: 12 };

// mean colours of a gridW × gridH cut of the picture
export function cells(img, T = THRESH) {
	const out = [], cw = img.w / T.gridW, ch = img.h / T.gridH;
	for (let gy = 0; gy < T.gridH; gy++) for (let gx = 0; gx < T.gridW; gx++) {
		let r = 0, g = 0, b = 0, n = 0;
		for (let y = Math.floor(gy * ch); y < Math.floor((gy + 1) * ch); y += 2) for (let x = Math.floor(gx * cw); x < Math.floor((gx + 1) * cw); x += 2) {
			const o = (y * img.w + x) * 4; r += img.rgba[o]; g += img.rgba[o + 1]; b += img.rgba[o + 2]; n++;
		}
		out.push([r / n, g / n, b / n]);
	}
	return out;
}
export function pictureMatch(a, b, T = THRESH) {
	if (!a || !b || a.length !== b.length) return null;
	let ok = 0;
	for (let i = 0; i < a.length; i++) if (Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1], a[i][2] - b[i][2]) <= T.cellTol) ok++;
	return { ok, n: a.length };
}

// the error text with URLs, numbers and quoted bits masked (one line per cause)
export const normError = e => String(e).replace(/https?:\/\/\S+/g, "<url>").replace(/(['"`])[^'"`]{1,80}\1/g, "$1…$1").replace(/\d+(\.\d+)?/g, "N").slice(0, 140);

const D2R = Math.PI / 180;
// the distance between two camera positions ({lng, lat, height} in degrees and metres), on a sphere: enough for a tolerance
export function camDist(a, b) {
	const R = 6371008.8, x = Math.sin((b.lat - a.lat) * D2R / 2) ** 2 + Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin((b.lng - a.lng) * D2R / 2) ** 2;
	const ground = 2 * (R + Math.min(a.height, b.height)) * Math.asin(Math.min(1, Math.sqrt(x)));
	return Math.hypot(ground, a.height - b.height);
}
const angDiff = (a, b) => { const d = ((a - b) % 360 + 540) % 360 - 180; return Math.abs(d); };

export function runsWhy(rec, shared) {
	if (!rec) return "no record";
	if (rec.harnessError) return `harness error: ${rec.harnessError}`;
	const exc = (rec.exceptions || []).filter(e => !shared?.has(e));
	if (exc.length) return `exception: ${exc[0]}`;
	if (!rec.ran) return "never finished loading";
	if (rec.expectViewer !== false && !rec.viewers) return "no viewer";
	return null;
}

export function grade(R, O, T = THRESH) {
	const out = { name: R?.name ?? O?.name, level: 0, reasons: [], blockers: [], unsupported: O?.unsupported || [] };
	const shared = new Set((R?.exceptions || []).filter(e => O?.exceptions?.includes(e)));
	const rw = runsWhy(R, shared);
	if (rw) { out.level = null; out.refWhy = rw; return out; }
	if (!R.viewers) { out.level = null; out.refWhy = "no viewer (not a globe example)"; return out; }
	const ow = runsWhy(O, shared);
	if (ow) { out.reasons.push(ow); out.blockers.push(ow.startsWith("exception: ") ? `exception: ${normError(ow.slice(11))}` : ow); return out; }
	out.level = 1;
	const why = [], checks = out.checks = {};
	checks.unsupported = !out.unsupported.length;
	if (!checks.unsupported) { why.push(`unsupported: ${out.unsupported.map(u => u.what).join(", ")}`); out.blockers.push(...out.unsupported.map(u => `unsupported: ${u.what}`)); }
	checks.renderErrors = !(O.renderErrors || []).length;
	if (!checks.renderErrors) { why.push(`render error: ${O.renderErrors[0]}`); out.blockers.push(`render error: ${normError(O.renderErrors[0])}`); }
	for (const k of ["entities", "dataSources", "primitives", "imageryLayers"]) {
		const a = R.counts?.[k] ?? 0, b = O.counts?.[k] ?? 0;
		checks[k] = a === b;
		if (a !== b) { why.push(`${k} ${a}/${b}`); out.blockers.push(`${k} differ`); }
	}
	if (R.camera && O.camera) {
		const d = camDist(R.camera, O.camera), tol = Math.max(T.camAbs, T.camRel * Math.max(1, R.camera.height));
		const da = Math.max(angDiff(R.camera.heading, O.camera.heading) * Math.cos(R.camera.pitch * D2R), angDiff(R.camera.pitch, O.camera.pitch));   // heading is loose looking straight down
		checks.camera = d <= tol && da <= T.angDeg;
		if (!checks.camera) { why.push(`camera (Δ ${Math.round(d)} m · Δangle ${da.toFixed(1)}°)`); out.blockers.push("camera differs"); }
	}
	if (why.length) { out.reasons.push(...why); }
	else out.level = 2;
	const pm = out.picture = pictureMatch(R.cells, O.cells, T);
	if (pm && out.level === 2) {
		if (pm.ok / pm.n >= T.cellMin) out.level = 3;
		else { out.reasons.push(`picture ${pm.ok}/${pm.n} cells`); out.blockers.push("picture differs"); }
	}
	return out;
}

// the blockers of examples ours does not bring as far as real Cesium, counted once per example
export function rankBlockers(graded) {
	const c = new Map();
	for (const g of graded) {
		if (g.level == null || g.level >= 3) continue;
		for (const b of new Set(g.blockers)) { const e = c.get(b) || { blocker: b, n: 0, examples: [] }; e.n++; e.examples.push(g.name); c.set(b, e); }
	}
	return [...c.values()].sort((a, b) => b.n - a.n || a.blocker.localeCompare(b.blocker));
}
