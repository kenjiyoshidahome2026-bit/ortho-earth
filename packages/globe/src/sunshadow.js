// 日影（#44・2026-09-23）＝建物の影を測定面へ投影して数える（model 役の worker で走る）。
//   建物＝3D Tiles（PLATEAU の台帳・任意の tileset）を 1 棟ずつ接地して読む（tiles3d-decode の ground:"terrain"＝高さは各棟の足元から）。
//   太陽＝真太陽時の式（日影規制と同じ流儀）：赤緯 δ・時角 H＝15°×(t−12) から高度 α と方位 A。
//   投影＝測定面の高さ h0 より上の頂点を、影の向き（太陽の反対）へ (h−h0)/tan α だけずらす。三角形ごとに升目へ塗り、同じ時刻の重なりは一度だけ数える。
//   出力＝升目の RGBA（瞬間＝影の範囲／時間＝日影になる時間の段彩＋境目の線）と数値（最大の日影時間など）。
import { decodeTile3D } from "./tiles3d-decode.js";
import { collectLeafTiles } from "./meshdecode.js";

const D2R = Math.PI / 180, R_EARTH = 6371000;

// 太陽の高度・方位（北から時計回り）。solarHour＝真太陽時（12＝南中）。decl＝赤緯（度）
export function sunAt(latDeg, decl, solarHour) {
	const phi = latDeg * D2R, d = decl * D2R, H = (solarHour - 12) * 15 * D2R;
	const sinA = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(H);
	const alt = Math.asin(Math.max(-1, Math.min(1, sinA)));
	const azS = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(d) * Math.cos(phi));   // 南から西回り
	return { alt, az: azS + Math.PI };   // 北から時計回り
}
// 日付 → 赤緯（度）と均時差（時）。時計の時刻を真太陽時へ直すのに使う
export function declOf(date) {
	const N = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 864e5);
	const decl = 23.44 * Math.sin(2 * Math.PI * (284 + N) / 365);
	const B = 2 * Math.PI * (N - 81) / 364, eot = (9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B)) / 60;
	return { decl, eot };
}

// 任意の tileset の葉（最も細かい段）を、変換行列を親から積みながら集める（範囲の外の枝は落とす）
const m4mul = (a, b) => { const o = new Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c*4+r] = a[r]*b[c*4] + a[4+r]*b[c*4+1] + a[8+r]*b[c*4+2] + a[12+r]*b[c*4+3]; return o; };
const I4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function ecefLL(x, y, z) { const p = Math.hypot(x, y); return [Math.atan2(y, x) / D2R, Math.atan2(z, p * (1 - 0.00669437999014)) / D2R]; }
function volLL(bv, M) {   // 境界体積 → 経緯度の外接（度・粗くてよい）
	if (bv?.region) { const r = bv.region; return [r[0] / D2R, r[1] / D2R, r[2] / D2R, r[3] / D2R]; }
	const c = bv?.box ? bv.box.slice(0, 3) : bv?.sphere ? bv.sphere.slice(0, 3) : null; if (!c) return null;
	const rad = bv.box ? Math.hypot(bv.box[3], bv.box[4], bv.box[5]) + Math.hypot(bv.box[6], bv.box[7], bv.box[8]) + Math.hypot(bv.box[9], bv.box[10], bv.box[11]) : bv.sphere[3];
	const e = [M[0]*c[0] + M[4]*c[1] + M[8]*c[2] + M[12], M[1]*c[0] + M[5]*c[1] + M[9]*c[2] + M[13], M[2]*c[0] + M[6]*c[1] + M[10]*c[2] + M[14]];
	const [lo, la] = ecefLL(...e), d = rad / 111320;
	return [lo - d / Math.max(0.1, Math.cos(la * D2R)), la - d, lo + d / Math.max(0.1, Math.cos(la * D2R)), la + d];
}
async function leavesOf(url, bbox, M = I4, depth = 0) {
	const r = await fetch(url, { credentials: "omit" }); if (!r.ok) throw new Error(`tileset HTTP ${r.status}`);
	const j = await r.json(), out = [];
	const walk = async (t, P) => {
		const MM = t.transform ? m4mul(P, t.transform) : P, ll = volLL(t.boundingVolume, MM);
		if (ll && (ll[2] < bbox[0] || ll[0] > bbox[2] || ll[3] < bbox[1] || ll[1] > bbox[3])) return;
		const uri = t.content?.uri ?? t.content?.url;
		if (t.children?.length) { for (const c of t.children) await walk(c, MM); return; }
		if (!uri) return;
		const abs = new URL(uri, url).href;
		if (/\.json(\?|$)/i.test(abs) && depth < 4) out.push(...await leavesOf(abs, bbox, MM, depth + 1));
		else out.push({ uri: abs, M: MM });
	};
	await walk(j.root, M);
	return out;
}

// 建物の三角形（局所の平面 m＝原点からの東・北・高さ）を集める
async function gatherTriangles({ tilesets = [], sets = [], bbox, maxTris = 3e6 }) {
	const [w, s, e, n] = bbox, lon0 = (w + e) / 2 * D2R, lat0 = (s + n) / 2 * D2R, kx = Math.cos(lat0) * R_EARTH, ky = R_EARTH;
	const urls = [];   // { uri, M }
	for (const t of tilesets) urls.push(...await leavesOf(new URL(t, self.location?.href).href, bbox));
	for (const st of sets) if (!st.bbox || !(st.bbox[2] < w || st.bbox[0] > e || st.bbox[3] < s || st.bbox[1] > n)) urls.push(...(await collectLeafTiles(st.base + "tileset.json", 0, null, null, bbox)).map(l => ({ uri: l.uri, M: I4 })));   // PLATEAU＝葉が RTC で自分の置き場を持つ
	const tris = [];   // Float32Array の塊（x0,y0,h0, x1,y1,h1, x2,y2,h2）
	let count = 0;
	const one = async ({ uri: url, M }) => {
		const r = await fetch(url, { credentials: "omit" }); if (!r.ok) return;
		const out = await decodeTile3D(await r.arrayBuffer(), { transform: M, baseUri: url, textures: false, ground: "terrain" });
		for (const b of out?.batches || []) {
			const m = b.mesh, o = m.origin, P = m.pos, I = m.idx, nT = I.length / 3;
			if (count + nT > maxTris) return;
			const buf = new Float32Array(nT * 9);
			const vx = new Float64Array(P.length / 3 * 3);
			for (let i = 0; i < P.length; i += 3) {   // 単位球の世界座標（高さは各棟の足元から）→ 局所の東・北・高さ
				const x = o[0] + P[i], y = o[1] + P[i + 1], z = o[2] + P[i + 2], rr = Math.hypot(x, y, z);
				vx[i] = (Math.atan2(z, x) - lon0) * kx; vx[i + 1] = (Math.asin(y / rr) - lat0) * ky; vx[i + 2] = (rr - 1) * R_EARTH;
			}
			for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) { const v = I[t * 3 + k] * 3; buf[t * 9 + k * 3] = vx[v]; buf[t * 9 + k * 3 + 1] = vx[v + 1]; buf[t * 9 + k * 3 + 2] = vx[v + 2]; }
			tris.push(buf); count += nT;
		}
	};
	let i = 0;
	await Promise.all(Array.from({ length: 6 }, async () => { while (i < urls.length) { const u = urls[i++]; try { await one(u); } catch (err) { console.warn("[sunshadow] tile", u.uri, err?.message); } } }));
	return { tris, count, tiles: urls.length, lon0, lat0, kx, ky };
}

// 本体。opts＝{ bbox:[w,s,e,n], tilesets?, sets?, mode:"instant"|"duration", date:ISO, decl?, hours:[8,16], step:0.5（時）, planeH:4（m）, cell?:m, maxCells? }
export async function computeSunShadow(opts) {
	const { bbox, mode = "duration", planeH = 4, hours = [8, 16], step = 0.5 } = opts;
	const g = await gatherTriangles(opts);
	const [w, s, e, n] = bbox, spanX = (e - w) * D2R * g.kx, spanY = (n - s) * D2R * g.ky;
	const maxCells = opts.maxCells ?? 1024 * 1024;
	const cell = Math.max(opts.cell ?? 0.5, Math.sqrt(spanX * spanY / maxCells));
	const W = Math.max(1, Math.ceil(spanX / cell)), H = Math.max(1, Math.ceil(spanY / cell));
	const x0 = -spanX / 2, y1 = spanY / 2;   // 升目の左上（局所 m）
	const cnt = new Uint16Array(W * H), stamp = new Uint16Array(W * H);
	const date = opts.date ? new Date(opts.date) : new Date();
	const { decl: declD, eot } = declOf(date);
	const decl = opts.decl ?? (mode === "duration" ? -23.44 : declD);   // 日影図の既定＝冬至
	const latDeg = g.lat0 / D2R;
	// 時刻の列（真太陽時）。瞬間＝与えた時計の時刻を真太陽時へ（経度と均時差）
	const times = [];
	if (mode === "instant") { const utcH = date.getUTCHours() + date.getUTCMinutes() / 60; times.push(((utcH + g.lon0 / D2R / 15 + eot) % 24 + 24) % 24); }
	else for (let t = hours[0]; t <= hours[1] + 1e-9; t += step) times.push(t);
	let used = 0;
	for (let si = 0; si < times.length; si++) {
		const sun = sunAt(latDeg, decl, times[si]);
		if (sun.alt <= 0.5 * D2R) continue;   // 日の出前・日没後＝数えない
		used++;
		const L = 1 / Math.tan(sun.alt), dx = -Math.sin(sun.az) * L, dy = -Math.cos(sun.az) * L, sid = si + 1;
		for (const buf of g.tris) for (let t = 0; t < buf.length; t += 9) {
			let hMax = Math.max(buf[t + 2], buf[t + 5], buf[t + 8]);
			if (hMax <= planeH) continue;   // 測定面より下の三角形は影を作らない
			const px = [], py = [];
			for (let k = 0; k < 3; k++) { const h = Math.max(0, buf[t + k * 3 + 2] - planeH); px.push((buf[t + k * 3] + h * dx - x0) / cell); py.push((y1 - (buf[t + k * 3 + 1] + h * dy)) / cell); }
			fillTri(px, py, W, H, stamp, cnt, sid);
		}
	}
	// 色付け
	const rgba = new Uint8ClampedArray(W * H * 4);
	let maxH = 0;
	if (mode === "instant") {
		for (let i = 0; i < W * H; i++) if (cnt[i]) { rgba[i * 4] = 20; rgba[i * 4 + 1] = 24; rgba[i * 4 + 2] = 60; rgba[i * 4 + 3] = 150; }
	} else {
		// 日影時間の段彩（日影規制で使う 2・3・4・5 時間の境＝線も引く）
		const band = h => h >= 5 ? 5 : h >= 4 ? 4 : h >= 3 ? 3 : h >= 2 ? 2 : h >= 1 ? 1 : 0;
		const PAL = [null, [120, 180, 255, 90], [80, 140, 240, 120], [60, 90, 220, 145], [120, 60, 200, 165], [200, 40, 120, 185]];
		const hrs = new Float32Array(W * H);
		for (let i = 0; i < W * H; i++) { hrs[i] = cnt[i] * step; if (hrs[i] > maxH) maxH = hrs[i]; const c = PAL[band(hrs[i])]; if (c) { rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = c[3]; } }
		for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {   // 段の境＝等時間線
			const i = y * W + x, b = band(hrs[i]);
			if (b >= 2 && (band(hrs[i + 1]) < b || band(hrs[i + W]) < b || band(hrs[i - 1] ?? 0) < b || band(hrs[i - W] ?? 0) < b)) { rgba[i * 4] = 30; rgba[i * 4 + 1] = 20; rgba[i * 4 + 2] = 60; rgba[i * 4 + 3] = 235; }
		}
	}
	// 指定地点の値（probe＝[[lon,lat]…]）＝日影時間（時）／瞬間は 0|1
	const probes = (opts.probe || []).map(([lo, la]) => {
		const x = Math.floor(((lo * D2R - g.lon0) * g.kx - x0) / cell), y = Math.floor((y1 - (la * D2R - g.lat0) * g.ky) / cell);
		const v = x >= 0 && y >= 0 && x < W && y < H ? cnt[y * W + x] : 0;
		return mode === "instant" ? (v ? 1 : 0) : +(v * step).toFixed(2);
	});
	return { rgba, w: W, h: H, bbox, cell, probes, stats: { triangles: g.count, tiles: g.tiles, steps: used, maxHours: +maxH.toFixed(2), decl: +decl.toFixed(2), planeH, mode } };
}

// 三角形を升目へ（外接矩形を舐めて辺関数で内外判定）。同じ時刻（sid）で塗った升目は数え直さない
function fillTri(px, py, W, H, stamp, cnt, sid) {
	const minX = Math.max(0, Math.floor(Math.min(px[0], px[1], px[2]))), maxX = Math.min(W - 1, Math.ceil(Math.max(px[0], px[1], px[2])));
	const minY = Math.max(0, Math.floor(Math.min(py[0], py[1], py[2]))), maxY = Math.min(H - 1, Math.ceil(Math.max(py[0], py[1], py[2])));
	if (minX > maxX || minY > maxY) return;
	const area = (px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0]);
	if (Math.abs(area) < 1e-9) return;   // 真横から見た壁＝面積ゼロ（隣の壁と屋根が埋める）
	const sg = area > 0 ? 1 : -1;
	for (let y = minY; y <= maxY; y++) {
		const cy = y + 0.5;
		for (let x = minX; x <= maxX; x++) {
			const cx = x + 0.5;
			const e0 = ((px[1] - px[0]) * (cy - py[0]) - (py[1] - py[0]) * (cx - px[0])) * sg;
			const e1 = ((px[2] - px[1]) * (cy - py[1]) - (py[2] - py[1]) * (cx - px[1])) * sg;
			const e2 = ((px[0] - px[2]) * (cy - py[2]) - (py[0] - py[2]) * (cx - px[2])) * sg;
			if (e0 >= 0 && e1 >= 0 && e2 >= 0) { const i = y * W + x; if (stamp[i] !== sid) { stamp[i] = sid; cnt[i]++; } }
		}
	}
}
