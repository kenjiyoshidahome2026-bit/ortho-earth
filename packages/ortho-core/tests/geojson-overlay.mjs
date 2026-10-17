// geojson.ts（外部ベクタ → 塗り扇／境界線のバッファ・JS の点内判定）の検定。純関数＝外部データ不要。
//   ・塗り扇（anchor, v_i, v_{i+1}）の符号付き面積の和＝各リングの符号付き面積の和（stencil の巻き数が穴を引く）
//   ・長い辺だけ大円で 2° 刻みに密化（短い辺は素通り）・中間点は大円の上
//   ・日付変更線を跨ぐリングを連続化（デルタが ±180° を飛ばない）
//   ・ranges（feature ごとの頂点レンジと外接円）・lines:false
//   ・pointInFeature（穴・MultiPolygon・面でない型）
import { buildGeoJSONOverlay, pointInFeature } from "../src/geojson.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const D2R = Math.PI / 180;
const shoelace = r => { let s = 0; for (let i = 0; i + 1 < r.length; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return s / 2; };
const fanArea = fan => { let s = 0; for (let i = 0; i < fan.length; i += 6) s += ((fan[i + 2] - fan[i]) * (fan[i + 5] - fan[i + 1]) - (fan[i + 4] - fan[i]) * (fan[i + 3] - fan[i + 1])) / 2; return s; };
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const poly = coordinates => ({ geometry: { type: "Polygon", coordinates } });

// ── 塗り扇の面積（小さな多角形＝密化なし） ──
{
	const outer = sq(139, 35, 139.5, 35.5), hole = sq(139.1, 35.1, 139.2, 35.2).reverse();
	const o = buildGeoJSONOverlay([poly([outer, hole])], [139.25, 35.25]);
	ok("扇の三角形数＝辺の数（密化なし）", o.fanPos.length / 6 === 8, `tri=${o.fanPos.length / 6}`);
	ok("扇の符号付き面積＝外周－穴", near(fanArea(o.fanPos), shoelace(outer) + shoelace(hole), 1e-6), `${fanArea(o.fanPos).toFixed(6)}`);
	ok("頂点は origin からの差分", o.fanPos.every(v => Math.abs(v) <= 0.26) && o.origin[0] === 139.25 && o.origin[1] === 35.25);
	ok("境界線＝辺の数・色と太さは既定", o.P1.length / 2 === 8 && o.lineHalf.every(h => near(h, 1.2)) && near(o.lineCol[3], 0.95));
	ok("ranges 無し＝feats は null", o.feats === null);
	const n = buildGeoJSONOverlay([poly([outer])], [139.25, 35.25], { lines: false, lineColor: [1, 0, 0, 1], lineWidth: 3 });
	ok("lines:false＝境界線バッファが空", n.P1.length === 0 && n.lineHalf.length === 0 && n.fanPos.length > 0);
	const c = buildGeoJSONOverlay([{ geometry: { type: "LineString", coordinates: [[0, 0], [1, 0]] } }], [0, 0], { lineColor: [1, 0, 0, 1], lineWidth: 3 });
	ok("LineString＝境界線だけ・指定の色と太さ", c.fanPos.length === 0 && c.P1.length === 2 && near(c.lineHalf[0], 3) && c.lineCol[0] === 1);
}

// ── 大円の密化 ──
{
	const o = buildGeoJSONOverlay([{ geometry: { type: "LineString", coordinates: [[0, 60], [90, 60]] } }], [0, 0]);
	const segs = o.P1.length / 2;
	// 中心角：(0,60)-(90,60) の大円距離
	const v = (lon, lat) => [Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.cos(lat * D2R) * Math.sin(lon * D2R), Math.sin(lat * D2R)];
	const a = v(0, 60), b = v(90, 60), w = Math.acos(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / D2R;
	ok("長い辺は 2° 刻みに割る", segs === Math.ceil(w / 2), `segs=${segs} w=${w.toFixed(2)}°`);
	// 中間点は大円の上＝a×b の法線と直交
	const nx = a[1] * b[2] - a[2] * b[1], ny = a[2] * b[0] - a[0] * b[2], nz = a[0] * b[1] - a[1] * b[0];
	let onGC = true, maxLat = 0;
	for (let i = 0; i < segs; i++) { const p = v(o.P2[2 * i], o.P2[2 * i + 1]); if (Math.abs(p[0] * nx + p[1] * ny + p[2] * nz) > 1e-6) onGC = false; maxLat = Math.max(maxLat, o.P2[2 * i + 1]); }
	ok("中間点は大円の上（極側へ膨らむ）", onGC && maxLat > 65, `maxLat=${maxLat.toFixed(2)}`);
	ok("端点はそのまま", near(o.P1[0], 0) && near(o.P1[1], 60) && near(o.P2[2 * segs - 2], 90) && near(o.P2[2 * segs - 1], 60));
	const s = buildGeoJSONOverlay([{ geometry: { type: "LineString", coordinates: [[139, 35], [139.01, 35.01]] } }], [139, 35]);
	ok("短い辺は素通り（1 本）", s.P1.length === 2);
}

// ── 日付変更線 ──
{
	const ring = [[179, 10], [-179, 10], [-179, 11], [179, 11], [179, 10]];
	const o = buildGeoJSONOverlay([poly([ring])], [180, 10.5]);
	const xs = Array.from(o.fanPos).filter((_, i) => i % 2 === 0);
	ok("跨ぐリングは連続（デルタが ±1.01° に収まる）", xs.every(x => Math.abs(x) <= 1.01), `max |dx|=${Math.max(...xs.map(Math.abs)).toFixed(3)}`);
	ok("跨ぐリングの面積＝2°×1° 相当", near(Math.abs(fanArea(o.fanPos)), 2, 1e-3), `${fanArea(o.fanPos).toFixed(4)}`);
}

// ── ranges ──
{
	const feats = [poly([sq(0, 0, 1, 1)]), null, { geometry: null }, { geometry: { type: "Point", coordinates: [0, 0] } }, { geometry: { type: "MultiPolygon", coordinates: [[sq(10, 0, 11, 1)], [sq(20, 0, 21, 1)]] } }];
	const o = buildGeoJSONOverlay(feats, [0, 0], { ranges: true });
	ok("ranges：頂点を持つ feature だけ（null・点は飛ばす）", o.feats.length === 2);
	const [r0, r1] = o.feats;
	ok("ranges：レンジは連続で fan 全体を覆う", r0.start === 0 && r1.start === r0.count && (r0.count + r1.count) * 2 === o.fanPos.length);
	ok("ranges：外接円の中心は単位ベクトル（Y-up）", near(Math.hypot(...r0.C), 1, 1e-12) && near(r0.C[1], Math.sin(0.5 * D2R), 1e-12));
	ok("ranges：cos²+sin²＝1・半径は bbox 対角の半分", near(r1.cosR ** 2 + r1.sinR ** 2, 1, 1e-12) && near(Math.acos(r1.cosR) / D2R, Math.hypot(5.5, 0.5), 1e-6));
}

// ── pointInFeature ──
{
	const g = { type: "Polygon", coordinates: [sq(0, 0, 10, 10), sq(4, 4, 6, 6)] };
	ok("点内：外周の内側", pointInFeature(2, 2, g));
	ok("点内：穴の中は外", !pointInFeature(5, 5, g));
	ok("点内：外周の外", !pointInFeature(11, 5, g) && !pointInFeature(5, -1, g));
	const m = { type: "MultiPolygon", coordinates: [[sq(0, 0, 1, 1)], [sq(5, 5, 6, 6)]] };
	ok("点内：MultiPolygon のどれか", pointInFeature(5.5, 5.5, m) && pointInFeature(0.5, 0.5, m) && !pointInFeature(3, 3, m));
	ok("点内：面でない型・null・空は false", !pointInFeature(0, 0, { type: "LineString", coordinates: [[0, 0], [1, 1]] }) && !pointInFeature(0, 0, null) && !pointInFeature(0, 0, { type: "Polygon", coordinates: [] }));
	const tri = { type: "Polygon", coordinates: [[[0, 0], [10, 0], [0, 10], [0, 0]]] };
	ok("点内：凹でない三角形の斜辺の両側", pointInFeature(4, 4, tri) && !pointInFeature(6, 6, tri));
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ geojson-overlay 全 PASS");
process.exit(fail ? 1 : 0);
