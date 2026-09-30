// COPC（Cloud Optimized Point Cloud）の読み手 worker（#178）。main（gadgets/copc.js）が選んだ節だけを Range で取って LAZ を解き、原点相対の点にして返す。
//   開く  { type:"open", id, src: URL | Blob, headers?, ell } → { type:"opened", id, info, root: { nodes, pages } }
//   頁    { type:"page", id, rid, page: { offset, byteSize } } → { type:"page", id, rid, nodes, pages }
//   節    { type:"node", id, rid, node, N, heightOffset } → { type:"node", id, rid, n, pos(Float32・原点相対), origin, rgb(Uint8×3|null), intensity(Uint16), cls(Uint8), elev(Float32・m) }
// 解読＝laz-perf 0.0.7 の ChunkDecoder（WASM・Apache-2.0・本人裁定）＝この worker を初めて使う時に一度だけ起こす（起動の重さは 0）。
// 座標＝WKT（LASF_Projection 2112）→ geopbf/proj の crsFromWKT（TM・メルカトル・LCC・Albers・経緯度）→ 経緯度。高さ＝z（鉛直の単位）
//   ＋楕円体高なら N（main が節の中心で EGM96 から引いて渡す）を引いて標高へ（この地図の標高はジオイド基準）・鉛直の CRS がジオイド系を申告していればそのまま。
// 世界座標＝meshdecode の geoWorld（建物メッシュ・3D Tiles の点と同じ式・楕円体表示も）。
import { createLazPerf } from "laz-perf";
import lazWasmUrl from "laz-perf/lib/web/laz-perf.wasm?url";
import { openSource } from "geopbf/cog/source";
import { crsFromWKT, parseWKTTree } from "geopbf/proj";
import { geoWorld, setDecodeEnv, earthW } from "./meshdecode.js";
import { parseHeader, listVlrs, parseCopcInfo, parseHierarchyPage, readRecords, nodeBounds } from "./copc-format.js";

let LP = null;
const lazPerf = () => LP ??= createLazPerf({ locateFile: () => new URL(lazWasmUrl, self.location.href).href });
const sets = new Map();   // id → { src, hdr, info, crs, vUnit, ellipsoidal }
const D2R = Math.PI / 180;
// 節ページの項に選びの材料を足す：c＝境界球の中心（世界座標）・r＝半径（世界単位）・spacingM＝その節の点の間隔（m）・ll＝中心の経緯度（main が EGM96 の N を引く）
function withSpheres(set, page) {
	const { info, ll, vUnit, lonlat } = set, EW = earthW(), w = [0, 0, 0], k = lonlat ? 111320 : vUnit;
	for (const n of page.nodes) {
		const b = nodeBounds(info, n.key), c = ll([(b[0] + b[3]) / 2, (b[1] + b[4]) / 2]), size = b[3] - b[0];
		geoWorld(c[0] * D2R, c[1] * D2R, ((b[2] + b[5]) / 2 * vUnit) / EW, w);
		n.c = [w[0], w[1], w[2]]; n.r = size * Math.sqrt(3) / 2 * k / EW; n.ll = c; n.spacingM = info.spacing / 2 ** n.key[0] * k;
	}
	return page;
}

// 鉛直：COMPD_CS／COMPOUNDCRS の鉛直側（VERT_CS・VERTCRS）＝ジオイド系（標高）と見る・単位はその UNIT。無ければ楕円体高・単位は水平と同じ
function verticalOf(wkt) {
	const t = parseWKTTree(wkt);
	const find = (n, re) => { if (!n || typeof n !== "object") return null; if (re.test(n.name)) return n; for (const a of n.args || []) { const r = find(a, re); if (r) return r; } return null; };
	const unitOf = n => { const u = (n?.args || []).filter(a => a && typeof a === "object" && /^(UNIT|LENGTHUNIT)$/.test(a.name)).pop(); return u && typeof u.args[1] === "number" ? u.args[1] : null; };
	const v = find(t, /^(VERT_CS|VERTCRS|VERTICALCRS)$/);
	const horiz = find(t, /^(PROJCS|PROJCRS)$/);
	const ellipsoidalV = v && /ellipsoid/i.test(JSON.stringify(v));
	return { orthometric: !!v && !ellipsoidalV, unit: (v && unitOf(v)) || (horiz && unitOf(horiz)) || 1, name: v && typeof v.args[0] === "string" ? v.args[0] : null };
}

async function open(m) {
	const fetchFn = m.headers ? (u, init = {}) => fetch(u, { ...init, headers: { ...(init.headers || {}), ...m.headers } }) : undefined;
	const src = await openSource(m.src, { headerBytes: 65536, ...(fetchFn ? { fetch: fetchFn } : {}) });
	let head = new Uint8Array(src.head);
	const hdr = parseHeader(head);
	if (!hdr.compressed && hdr.format < 6) throw new Error("copc: not a LAZ 1.4 point cloud");
	if (hdr.pointOffset > head.byteLength) head = new Uint8Array(await src.read(0, hdr.pointOffset));
	const vlrs = listVlrs(head, hdr.headerSize, hdr.vlrCount);
	const ci = vlrs.find(v => v.userId === "copc" && v.recordId === 1);
	if (!ci) throw new Error("copc: no COPC info VLR (not a Cloud Optimized Point Cloud — plain LAS/LAZ is not streamed)");
	const info = parseCopcInfo(head, ci.offset);
	let wktV = vlrs.find(v => v.userId === "LASF_Projection" && v.recordId === 2112);
	let wkt = wktV ? new TextDecoder().decode(head.subarray(wktV.offset, wktV.offset + wktV.length)).replace(/\0[\s\S]*$/, "") : null;
	if (!wkt && hdr.evlrCount) {   // WKT が EVLR にある物
		const tail = new Uint8Array(await src.read(hdr.evlrOffset, Math.min(src.size - hdr.evlrOffset, 1 << 20)));
		const ev = listVlrs(tail, 0, hdr.evlrCount, true).find(v => v.userId === "LASF_Projection" && v.recordId === 2112);
		if (ev) wkt = new TextDecoder().decode(tail.subarray(ev.offset, ev.offset + ev.length)).replace(/\0[\s\S]*$/, "");
	}
	if (!wkt) throw new Error("copc: no coordinate system (WKT VLR 2112) in the file");
	const crs = crsFromWKT(wkt);
	if (crs.kind === "other") throw new Error(`copc: coordinate system not supported (${crs.label}) — TM/UTM, Mercator, Lambert conformal conic, Albers and lon/lat are`);
	const ll = crs.toLonLat || (p => p);
	const vert = verticalOf(wkt);
	const set = { src, hdr, info, crs, ll, vUnit: vert.unit, orthometric: vert.orthometric, lonlat: crs.kind === "lonlat" || (crs.kind === "datum" && !/PROJ/i.test(wkt.slice(0, 20))) };
	sets.set(m.id, set);
	const corners = [[hdr.min[0], hdr.min[1]], [hdr.max[0], hdr.min[1]], [hdr.max[0], hdr.max[1]], [hdr.min[0], hdr.max[1]]].map(ll);
	const bbox = [Math.min(...corners.map(c => c[0])), Math.min(...corners.map(c => c[1])), Math.max(...corners.map(c => c[0])), Math.max(...corners.map(c => c[1]))];
	const rootBuf = new Uint8Array(await src.read(info.rootHierOffset, info.rootHierSize));
	return {
		info: { count: hdr.pointCount, format: hdr.format, hasRgb: hdr.format === 7 || hdr.format === 8, bbox, center: ll([info.center[0], info.center[1]]),
			zRange: [hdr.min[2] * vert.unit, hdr.max[2] * vert.unit], cube: { center: info.center, halfsize: info.halfsize }, spacing: info.spacing, unit: vert.unit,
			crs: crs.label, vertical: vert.orthometric ? (vert.name || "orthometric") : "ellipsoidal", size: src.size },
		root: withSpheres(set, parseHierarchyPage(rootBuf)),
	};
}

async function node(m) {
	const set = sets.get(m.id); if (!set) throw new Error("copc: not open");
	const { hdr, ll } = set, n = m.node.pointCount, L = hdr.recordLength;
	const [buf, lp] = await Promise.all([set.src.read(m.node.offset, m.node.byteSize), lazPerf()]);
	const cp = lp._malloc(m.node.byteSize), pp = lp._malloc(L), rec = new Uint8Array(n * L);
	try {
		lp.HEAPU8.set(new Uint8Array(buf), cp);
		const dec = new lp.ChunkDecoder();
		try { dec.open(hdr.format, L, cp); for (let i = 0; i < n; i++) { dec.getPoint(pp); rec.set(lp.HEAPU8.subarray(pp, pp + L), i * L); } }
		finally { dec.delete(); }
	} finally { lp._free(cp); lp._free(pp); }
	const r = readRecords(rec, n, hdr);
	const EW = earthW(), dz = (set.orthometric ? 0 : -(m.N || 0)) + (m.heightOffset || 0), vu = set.vUnit;
	const pos = new Float32Array(n * 3), elev = new Float32Array(n), w = [0, 0, 0];
	let origin = null;
	for (let i = 0; i < n; i++) {
		const [lon, lat] = ll([r.x[i], r.y[i]]), h = r.z[i] * vu + dz;
		geoWorld(lon * D2R, lat * D2R, h / EW, w);
		if (!origin) origin = [w[0], w[1], w[2]];
		pos[i * 3] = w[0] - origin[0]; pos[i * 3 + 1] = w[1] - origin[1]; pos[i * 3 + 2] = w[2] - origin[2];
		elev[i] = h;
	}
	let rgb = null;
	if (r.rgb) {   // LAS の RGB は 16bit が作法だが 8bit のまま入れる書き手もいる＝最大値で見分ける
		let mx = 0; for (let i = 0; i < r.rgb.length; i++) if (r.rgb[i] > mx) mx = r.rgb[i];
		const sh = mx > 255 ? 8 : 0; rgb = new Uint8Array(n * 3); for (let i = 0; i < rgb.length; i++) rgb[i] = r.rgb[i] >> sh;
	}
	return { n, pos, origin: origin || [0, 0, 0], rgb, intensity: r.intensity, cls: r.classification, elev };
}

self.onmessage = async e => {
	const m = e.data || {};
	try {
		if (m.ell !== undefined) setDecodeEnv({ ell: m.ell });
		if (m.type === "open") { const r = await open(m); self.postMessage({ type: "opened", id: m.id, ...r }); }
		else if (m.type === "page") { const s = sets.get(m.id); const b = new Uint8Array(await s.src.read(m.page.offset, m.page.byteSize)); self.postMessage({ type: "page", id: m.id, rid: m.rid, ...withSpheres(s, parseHierarchyPage(b)) }); }
		else if (m.type === "node") {
			const r = await node(m);
			self.postMessage({ type: "node", id: m.id, rid: m.rid, ...r }, [r.pos.buffer, r.elev.buffer, r.intensity.buffer, r.cls.buffer, ...(r.rgb ? [r.rgb.buffer] : [])]);
		}
		else if (m.type === "close") sets.delete(m.id);
	} catch (err) {
		self.postMessage({ type: "error", id: m.id, rid: m.rid, error: String(err && err.message || err) });
	}
};
