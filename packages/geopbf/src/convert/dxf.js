// convert/dxf.js ── DXF（ASCII・AutoCAD 図面交換形式）→ GeoPBF。依存ゼロ・読み専用（DWG とバイナリ DXF は対象外）。
//   const { header, layers, counts } = readDxf(u8);           // 一覧（ヘッダ・レイヤ表・エンティティ種別の数）
//   const { pbf, stats } = await fromDxf(u8, { crs: 6677 }); // 変換。crs＝EPSG 番号（epsg.js の表）か WKT 文字列。省略時は座標が経緯度の範囲なら経緯度とみなす
// エンティティ: POINT / LINE / LWPOLYLINE（bulge＝円弧）/ POLYLINE+VERTEX（2D/3D・メッシュは飛ばす）/ CIRCLE / ARC / ELLIPSE / SPLINE（de Boor・fit 点だけなら折線）/
//   TEXT / MTEXT（点＋text）/ SOLID / 3DFACE（面）/ INSERT（ブロック参照＝BLOCKS を展開・拡縮/回転/入れ子・列/行配置）。HATCH 等は数えて飛ばす（stats.skipped）。
// 閉じた折線・CIRCLE・全周 ELLIPSE は既定で Polygon（opts.closedAsPolygon=false で LineString）。円弧は 5° 刻み（最少 4 分割）で折線化。
// 属性: layer / type（DXF 名）/ color（ACI・256=BYLAYER はレイヤ表の色）/ linetype / handle / text / height / rotation / block（INSERT 由来）。
// 単位: $INSUNITS（1 inch 2 feet 4 mm 5 cm 6 m …）を投影座標（メートル）へ自動換算（opts.unitScale で上書き）。文字コードは UTF-8 → 読めなければ Shift_JIS（opts.encoding で指定可）。
import { GeoPBF } from "../pbf-base.js";
import { crsFromWKT } from "./proj.js";
import { epsgToWKT } from "./epsg.js";
import { decodeText } from "./table.js";
import { resolveDatum, datumStats } from "./datum.js";
import { mercToLonLat } from "../modules/mercator.js";

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const D2R = Math.PI / 180;
const ARC_STEP = 5 * D2R;   // 円弧の折線化＝5° 刻み
const UNIT_M = { 0: 1, 1: 0.0254, 2: 0.3048, 3: 1609.344, 4: 0.001, 5: 0.01, 6: 1, 7: 1000, 8: 2.54e-5, 9: 2.54e-8, 10: 0.9144, 14: 0.1, 21: 0.1 };   // $INSUNITS → m

/** DXF テキスト → [code, value] の列（value は文字列のまま・数値化は使う側） */
export function* dxfPairs(text) {
	const lines = text.split(/\r?\n/);
	for (let i = 0; i + 1 < lines.length; i += 2) {
		const code = parseInt(lines[i], 10);
		if (Number.isNaN(code)) continue;
		yield [code, lines[i + 1].trim()];
	}
}

// ───────────────────────────── 構文木（セクション → エンティティ） ─────────────────────────────
function parseDxf(text) {
	const header = {}, layers = new Map(), blocks = new Map(), entities = [];
	let section = null, cur = null, curOwner = null, varName = null, blockName = null;
	const push = (e) => { if (curOwner) curOwner.push(e); };
	const flush = () => { if (cur && cur.type !== "BLOCK" && cur.type !== "LAYER") push(cur); cur = null; };   // BLOCK/LAYER は器＝エンティティ列へは積まない
	for (const [code, value] of dxfPairs(text)) {
		if (code === 0) {
			if (value === "SECTION") { section = "?"; continue; }
			if (value === "ENDSEC") { flush(); section = null; curOwner = null; continue; }
			if (value === "EOF") break;
			if (section === "?") { continue; }
			if (section === "HEADER") continue;
			if (section === "TABLES") { flush(); cur = value === "LAYER" ? { type: "LAYER" } : null; continue; }
			if (section === "BLOCKS") {
				flush();
				if (value === "BLOCK") { cur = { type: "BLOCK" }; curOwner = null; continue; }
				if (value === "ENDBLK") { curOwner = null; blockName = null; continue; }   // flush 済み（直上）
				cur = { type: value }; continue;
			}
			if (section === "ENTITIES") { flush(); cur = { type: value }; curOwner = entities; continue; }
			continue;
		}
		if (section === "?" && code === 2) { section = value; if (section === "ENTITIES") curOwner = entities; continue; }
		if (section === "HEADER") {
			if (code === 9) { varName = value; continue; }
			if (!varName) continue;
			(header[varName] ??= {})[code] = value;
			continue;
		}
		if (!cur) continue;
		if (cur.type === "LAYER") { if (code === 2) { cur.name = value; layers.set(value, cur); } else if (code === 62) cur.color = +value; else if (code === 6) cur.ltype = value; continue; }
		if (cur.type === "BLOCK") {
			if (code === 2) { blockName = value; cur.name = value; blocks.set(value, cur); cur.entities = []; curOwner = cur.entities; }
			else if (code === 10) cur.x = +value; else if (code === 20) cur.y = +value;
			continue;
		}
		addField(cur, code, value);
	}
	flush();
	return { header, layers, blocks, entities };
}

// エンティティの属性・座標を積む（10/20/30 と 11..13/21..23・42 bulge・繰り返し可能なものは配列）
function addField(e, code, value) {
	const n = +value;
	switch (code) {
		case 8: e.layer = value; return;
		case 5: e.handle = value; return;
		case 6: e.ltype = value; return;
		case 62: e.color = n; return;
		case 420: e.trueColor = n; return;
		case 2: e.name = value; return;
		case 1: e.text = (e.text ?? "") + value; return;
		case 3: e.text3 = (e.text3 ?? "") + value; return;
		case 70: e.flags = n; return;
		case 71: e.n71 = n; return;   // SPLINE degree / INSERT columns
		case 72: e.n72 = n; return;   // SPLINE knots / INSERT rows
		case 73: e.n73 = n; return;   // SPLINE control count / ARC/ELLIPSE? (unused)
		case 74: e.n74 = n; return;   // SPLINE fit count
		case 90: e.n90 = n; return;   // LWPOLYLINE vertex count
		case 40: (e.v40 ??= []).push(n); return;   // radius / ratio / knots / text height
		case 41: (e.v41 ??= []).push(n); return;   // scale x / ellipse start / weights
		case 42: (e.v42 ??= []).push(n); (e.bulgeAt ??= [])[(e.xs?.length ?? 1) - 1] = n; return;   // bulge（直前の頂点に付く）/ scale y / ellipse end
		case 43: e.v43 = n; return;
		case 44: e.v44 = n; return; case 45: e.v45 = n; return;   // INSERT の列/行間隔
		case 50: e.a50 = n; return; case 51: e.a51 = n; return;   // 角度
		case 10: (e.xs ??= []).push(n); return; case 20: (e.ys ??= []).push(n); return; case 30: (e.zs ??= []).push(n); return;
		case 11: (e.x1s ??= []).push(n); return; case 21: (e.y1s ??= []).push(n); return; case 31: (e.z1s ??= []).push(n); return;
		case 12: e.x2 = n; return; case 22: e.y2 = n; return;
		case 13: e.x3 = n; return; case 23: e.y3 = n; return;
		case 210: e.nx = n; return; case 220: e.ny = n; return; case 230: e.nz = n; return;
		default: return;
	}
}

// ───────────────────────────── 幾何（図面座標） ─────────────────────────────
const arcPts = (cx, cy, r, a0, a1, ry = null, rot = 0) => {   // 中心角 a0→a1（rad・CCW）を折線化。ry があれば楕円（rot＝長軸の向き）
	const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) / ARC_STEP - 1e-9)), out = new Array(n + 1);   // 2π/5° は浮動小数で 72.000…1＝ceil で 73 になる罠
	const cr = Math.cos(rot), sr = Math.sin(rot);
	for (let i = 0; i <= n; i++) {
		const t = a0 + (a1 - a0) * i / n, ex = r * Math.cos(t), ey = (ry ?? r) * Math.sin(t);
		out[i] = ry === null ? [cx + ex, cy + ey] : [cx + ex * cr - ey * sr, cy + ex * sr + ey * cr];
	}
	return out;
};
// bulge 付き折線（bulge=tan(θ/4)・正＝CCW）
function bulgePolyline(pts, bulges, closed) {
	const out = [];
	const segs = closed ? pts.length : pts.length - 1;
	for (let i = 0; i < segs; i++) {
		const p = pts[i], q = pts[(i + 1) % pts.length], b = bulges?.[i] || 0;
		if (i === 0) out.push(p);
		if (!b || (p[0] === q[0] && p[1] === q[1])) { out.push(q); continue; }
		const th = 4 * Math.atan(b), dx = q[0] - p[0], dy = q[1] - p[1], chord = Math.hypot(dx, dy), r = chord / (2 * Math.sin(Math.abs(th) / 2));
		const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2, h = r * Math.cos(th / 2) * Math.sign(b);   // 中心は弦の垂直二等分線上
		const cx = mx - h * dy / chord, cy = my + h * dx / chord;
		const a0 = Math.atan2(p[1] - cy, p[0] - cx), a1 = a0 + th;
		const arc = arcPts(cx, cy, r, a0, a1); arc.shift(); arc[arc.length - 1] = q;   // 端は元の頂点そのもの
		out.push(...arc);
	}
	if (closed && (out[0][0] !== out[out.length - 1][0] || out[0][1] !== out[out.length - 1][1])) out.push(out[0]);
	return out;
}
// B スプライン（de Boor）。knots が無い/合わない時は clamped uniform
function splinePts(ctrl, degree, knots, closed) {
	const n = ctrl.length; if (n < 2) return ctrl;
	const p = Math.max(1, Math.min(degree || 3, n - 1));
	let U = knots && knots.length === n + p + 1 ? knots.slice() : null;
	if (!U) { U = []; for (let i = 0; i <= p; i++) U.push(0); for (let i = 1; i < n - p; i++) U.push(i); for (let i = 0; i <= p; i++) U.push(n - p); }
	const u0 = U[p], u1 = U[n], samples = Math.max(16, n * 8), out = [];
	const at = (u) => {
		let k = p; while (k < n - 1 && u >= U[k + 1]) k++;   // U[k] <= u < U[k+1]
		const d = []; for (let j = 0; j <= p; j++) d.push(ctrl[k - p + j].slice(0, 2));
		for (let r = 1; r <= p; r++) for (let j = p; j >= r; j--) {
			const i = k - p + j, den = U[i + p - r + 1] - U[i], a = den === 0 ? 0 : (u - U[i]) / den;
			d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
		}
		return d[p];
	};
	for (let i = 0; i <= samples; i++) out.push(at(i === samples ? u1 - 1e-12 * (u1 - u0) : u0 + (u1 - u0) * i / samples));
	out[samples] = at(u1 - 1e-9 * (u1 - u0)); out[samples] = [ctrl[n - 1][0], ctrl[n - 1][1]];   // 端点は制御点そのもの（clamped）
	if (closed) out.push(out[0]);
	return out;
}
const pts2 = (e) => (e.xs ?? []).map((x, i) => [x, e.ys?.[i] ?? 0]);
const ring = (r) => (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) ? r.concat([r[0]]) : r;

// エンティティ → { geometry, props }（図面座標）。null＝対象外
function entityGeometry(e, ctx, opts) {
	const closedPoly = opts.closedAsPolygon !== false;
	const asClosed = (r) => closedPoly ? { type: "Polygon", coordinates: [ring(r)] } : { type: "LineString", coordinates: ring(r) };
	switch (e.type) {
		case "POINT": return { type: "Point", coordinates: [e.xs?.[0] ?? 0, e.ys?.[0] ?? 0] };
		case "LINE": return { type: "LineString", coordinates: [[e.xs?.[0] ?? 0, e.ys?.[0] ?? 0], [e.x1s?.[0] ?? 0, e.y1s?.[0] ?? 0]] };
		case "LWPOLYLINE": {
			const pts = pts2(e); if (pts.length < 2) return null;
			const closed = !!((e.flags ?? 0) & 1);
			const line = bulgePolyline(pts, e.bulgeAt, closed);
			return closed ? asClosed(line) : { type: "LineString", coordinates: line };
		}
		case "POLYLINE": {
			const f = e.flags ?? 0;
			if (f & (16 | 64)) { ctx.skip("POLYLINE(mesh)"); return null; }
			const vs = (e.vertices ?? []).filter(v => !((v.flags ?? 0) & (16 | 32 | 128)));
			const pts = vs.map(v => [v.xs?.[0] ?? 0, v.ys?.[0] ?? 0]); if (pts.length < 2) return null;
			const closed = !!(f & 1);
			const line = bulgePolyline(pts, vs.map(v => v.v42?.[0] ?? 0), closed);
			return closed ? asClosed(line) : { type: "LineString", coordinates: line };
		}
		case "CIRCLE": { const r = e.v40?.[0] ?? 0; if (!(r > 0)) return null; const c = arcPts(e.xs[0], e.ys[0], r, 0, 2 * Math.PI); c[c.length - 1] = c[0]; return asClosed(c); }
		case "ARC": { const r = e.v40?.[0] ?? 0; if (!(r > 0)) return null; let a0 = (e.a50 ?? 0) * D2R, a1 = (e.a51 ?? 360) * D2R; if (a1 <= a0) a1 += 2 * Math.PI; return { type: "LineString", coordinates: arcPts(e.xs[0], e.ys[0], r, a0, a1) }; }
		case "ELLIPSE": {
			const mx = e.x1s?.[0] ?? 1, my = e.y1s?.[0] ?? 0, r = Math.hypot(mx, my), ratio = e.v40?.[0] ?? 1;
			let a0 = e.v41?.[0] ?? 0, a1 = e.v42?.[0] ?? 2 * Math.PI; if (a1 <= a0) a1 += 2 * Math.PI;
			const full = Math.abs((a1 - a0) - 2 * Math.PI) < 1e-9;
			const c = arcPts(e.xs[0], e.ys[0], r, a0, a1, r * ratio, Math.atan2(my, mx));
			if (full) { c[c.length - 1] = c[0]; return asClosed(c); }
			return { type: "LineString", coordinates: c };
		}
		case "SPLINE": {
			const closed = !!((e.flags ?? 0) & 1);
			const ctrl = pts2(e);
			if (ctrl.length >= 2) return { type: "LineString", coordinates: splinePts(ctrl, e.n71 ?? 3, e.v40, closed) };
			const fit = (e.x1s ?? []).map((x, i) => [x, e.y1s?.[i] ?? 0]); if (fit.length >= 2) return { type: "LineString", coordinates: closed ? ring(fit) : fit };
			return null;
		}
		case "TEXT": case "MTEXT": case "ATTRIB": case "ATTDEF": return { type: "Point", coordinates: [e.xs?.[0] ?? 0, e.ys?.[0] ?? 0] };
		case "SOLID": case "3DFACE": case "TRACE": {
			const p = [[e.xs?.[0] ?? 0, e.ys?.[0] ?? 0], [e.x1s?.[0] ?? 0, e.y1s?.[0] ?? 0], [e.x2 ?? e.x1s?.[0] ?? 0, e.y2 ?? e.y1s?.[0] ?? 0], [e.x3 ?? e.x2 ?? 0, e.y3 ?? e.y2 ?? 0]];
			const order = e.type === "SOLID" || e.type === "TRACE" ? [0, 1, 3, 2] : [0, 1, 2, 3];   // SOLID は 1,2,4,3 の順で面
			const r = order.map(i => p[i]).filter((q, i, a) => i === 0 || q[0] !== a[i - 1][0] || q[1] !== a[i - 1][1]);
			return r.length >= 3 ? { type: "Polygon", coordinates: [ring(r)] } : null;
		}
		default: return null;
	}
}

const mapDeep = (c, f) => typeof c[0] === "number" ? f(c) : c.map(x => mapDeep(x, f));
const transform = (geom, f) => { geom.coordinates = mapDeep(geom.coordinates, f); return geom; };
const colorOf = (e, layers) => e.trueColor !== undefined ? "#" + e.trueColor.toString(16).padStart(6, "0") : (e.color !== undefined && e.color !== 256 ? e.color : (layers.get(e.layer)?.color ?? undefined));

/** DXF を開いて概要を返す（変換はしない） */
export function readDxf(src, opts = {}) {
	const text = typeof src === "string" ? src : decodeText(src instanceof Uint8Array ? src : new Uint8Array(src), opts.encoding);
	const d = parseDxf(text);
	const counts = {}; for (const e of d.entities) counts[e.type] = (counts[e.type] ?? 0) + 1;
	const h = d.header;
	const hv = (name, code) => h[name]?.[code];
	const fin = (x, y) => Number.isFinite(+x) && Number.isFinite(+y) && x !== undefined && y !== undefined ? [+x, +y] : null;
	const header = { acadver: hv("$ACADVER", 1) ?? null, insunits: hv("$INSUNITS", 70) !== undefined ? +hv("$INSUNITS", 70) : null, codepage: hv("$DWGCODEPAGE", 3) ?? null,
		extmin: fin(hv("$EXTMIN", 10), hv("$EXTMIN", 20)), extmax: fin(hv("$EXTMAX", 10), hv("$EXTMAX", 20)) };   // X/Y が揃って有限のときだけ（無ければ座標走査に落とす）
	return { header, layers: [...d.layers.values()].map(l => ({ name: l.name, color: l.color ?? null, ltype: l.ltype ?? null })), blocks: [...d.blocks.keys()], counts, entities: d.entities.length, _parsed: d };
}

/** DXF → GeoPBF。opts: { crs（EPSG 番号か WKT）, ignoreCrs, unitScale, encoding, closedAsPolygon(既定 true), precision, name, description, license, attribution, tky2jgd, patchjgd } */
export async function fromDxf(src, opts = {}) {
	const t0 = now();
	const datum = await resolveDatum(opts);
	const r = readDxf(src, opts);
	const d = r._parsed;
	// POLYLINE の VERTEX…SEQEND を親へ畳む（ENTITIES と BLOCKS の両方）
	const fold = (list) => { const out = []; let poly = null; for (const e of list) { if (e.type === "POLYLINE") { poly = e; poly.vertices = []; out.push(e); continue; } if (e.type === "VERTEX") { if (poly) poly.vertices.push(e); continue; } if (e.type === "SEQEND") { poly = null; continue; } out.push(e); } return out; };
	d.entities = fold(d.entities); for (const b of d.blocks.values()) b.entities = fold(b.entities ?? []);
	// 座標系
	let crs, label, toLonLat = null;
	if (opts.crs === undefined || opts.crs === null || opts.crs === "") {
		const ext = r.header.extmin && r.header.extmax ? [...r.header.extmin, ...r.header.extmax] : null;
		let inRange = ext ? Math.abs(ext[0]) <= 180 && Math.abs(ext[2]) <= 180 && Math.abs(ext[1]) <= 90 && Math.abs(ext[3]) <= 90 : null;
		if (inRange === null) { let ok = true, seen = false; for (const e of d.entities) for (const [x, y] of pts2(e)) { seen = true; if (Math.abs(x) > 180 || Math.abs(y) > 90) { ok = false; break; } } inRange = seen ? ok : true; }
		if (!inRange && !opts.ignoreCrs) throw new Error(`dxf: 座標系が分からない（DXF は CRS を持たない・座標は経緯度の範囲外${r.header.extmin ? `＝範囲 ${r.header.extmin.join(",")}〜${r.header.extmax.join(",")}` : ""}）。crs に EPSG 番号（平面直角 IX＝6677 など）か WKT を渡す`);
		crs = { kind: "lonlat", label: inRange ? "assumed lon/lat (no CRS in DXF)" : "ignoreCrs" };
	} else if (typeof opts.crs === "number" || /^(EPSG:)?\d+$/i.test(String(opts.crs))) {
		const code = +String(opts.crs).replace(/^EPSG:/i, "");
		const wkt = epsgToWKT(code); if (!wkt) throw new Error(`dxf: EPSG:${code} は表に無い（経緯度・3857・平面直角 I〜XIX・UTM のみ）。WKT 文字列で渡す`);
		crs = code === 3857 || code === 3785 || code === 900913 ? { kind: "mercator", label: `EPSG:${code}` } : crsFromWKT(wkt, { datum });
	} else crs = crsFromWKT(String(opts.crs), { datum });
	label = crs.label;
	if (crs.kind === "other") throw new Error(`dxf: 座標系 ${label} を経緯度へ戻せない`);
	toLonLat = crs.kind === "mercator" ? mercToLonLat : crs.toLonLat ?? null;
	// 単位（投影座標のときだけ）
	const unit = opts.unitScale ?? (toLonLat && r.header.insunits !== null ? (UNIT_M[r.header.insunits] ?? 1) : 1);
	const project = toLonLat ? ([x, y]) => toLonLat([x * unit, y * unit]) : null;

	const ctx = { vertices: 0, skipped: {}, skip(t) { this.skipped[t] = (this.skipped[t] ?? 0) + 1; } };
	const keys = ["block", "color", "handle", "height", "layer", "linetype", "rotation", "text", "type"];
	const pbf = new GeoPBF({ name: opts.name ?? "dxf", precision: opts.precision ?? 6, description: opts.description, license: opts.license, attribution: opts.attribution });
	pbf.setHead(keys, []);
	let count = 0, inserts = 0;
	const emit = (e, xf, blockName, insertLayer) => {
		if (e.type === "INSERT") { expand(e, xf, insertLayer); return; }
		const geom = entityGeometry(e, ctx, opts);
		if (!geom) { if (!["VERTEX", "SEQEND", "ATTRIB", "ATTDEF"].includes(e.type)) ctx.skip(e.type); return; }
		if (xf) transform(geom, xf);
		if (project) transform(geom, project);
		mapDeep(geom.coordinates, c => { ctx.vertices++; return c; });
		const layer = blockName && (e.layer === "0" || e.layer === undefined) && insertLayer ? insertLayer : (e.layer ?? "0");
		const q = { layer, type: e.type };
		const col = colorOf(e, d.layers); if (col !== undefined) q.color = col;
		if (e.ltype && e.ltype.toUpperCase() !== "BYLAYER") q.linetype = e.ltype;
		if (e.handle) q.handle = e.handle;
		if (e.type === "TEXT" || e.type === "MTEXT" || e.type === "ATTRIB") { q.text = ((e.text3 ?? "") + (e.text ?? "")).replace(/\\P/g, "\n").replace(/\{\\[^;]*;|\}/g, ""); if (e.v40?.[0] !== undefined) q.height = e.v40[0] * unit; if (e.a50 !== undefined) q.rotation = e.a50; }
		if (blockName) q.block = blockName;
		pbf.setFeature({ type: "Feature", properties: q, geometry: geom }); count++;
	};
	const expand = (ins, outer, insertLayer, depth = 0) => {
		const b = d.blocks.get(ins.name); if (!b) { ctx.skip(`INSERT(${ins.name}?)`); return; }
		if (depth > 8) { ctx.skip("INSERT(nested>8)"); return; }
		inserts++;
		const sx = ins.v41?.[0] ?? 1, sy = ins.v42?.[0] ?? 1, rot = (ins.a50 ?? 0) * D2R, cr = Math.cos(rot), sr = Math.sin(rot);
		const bx = b.x ?? 0, by = b.y ?? 0, cols = Math.max(1, ins.flags ?? 1), rows = Math.max(1, ins.n71 ?? 1), cs = ins.v44 ?? 0, rs = ins.v45 ?? 0;   // INSERT: 70=列数 71=行数 44/45=間隔
		for (let ci = 0; ci < cols; ci++) for (let ri = 0; ri < rows; ri++) {
			const ox = (ins.xs?.[0] ?? 0) + ci * cs, oy = (ins.ys?.[0] ?? 0) + ri * rs;
			const local = ([x, y]) => { const lx = (x - bx) * sx, ly = (y - by) * sy; return [ox + lx * cr - ly * sr, oy + lx * sr + ly * cr]; };
			const xf = outer ? (p => outer(local(p))) : local;
			for (const e of b.entities) {
				if (e.type === "INSERT") expand(e, xf, e.layer === "0" ? insertLayer ?? ins.layer : e.layer, depth + 1);
				else emit(e, xf, ins.name, insertLayer ?? ins.layer);
			}
		}
	};
	pbf.setBody(() => { for (const e of d.entities) emit(e, null, null, null); });
	const t1 = now();
	pbf.close();
	await pbf.getPosition();
	const stats = { features: count, vertices: ctx.vertices, entities: r.entities, inserts, skipped: ctx.skipped, counts: r.counts, layers: r.layers.map(l => l.name), crs: label, assumedLonLat: crs.label.startsWith("assumed"),
		reprojected: !!project, unitScale: unit, insunits: r.header.insunits, acadver: r.header.acadver, datumApprox: !!crs.approx, datum: datumStats(datum), precision: opts.precision ?? 6, ms: { read: t1 - t0, encode: now() - t1, total: now() - t0 } };
	return { pbf, stats };
}
