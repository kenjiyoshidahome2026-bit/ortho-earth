// gint/drawdata.ts（cam → mvp/eye/origin/RTE の錨/LOD ランク/視野 bbox/近傍窓）の検定。純関数＝外部データ不要。
//   ・origin は 1e-7° に量子化（錨とデルタの共通原点＝高ズームの這う揺らぎ対策）・経度は [-180,180) に畳む
//   ・clipT＝mvp·T・originZr＝T·eye−1（float64 の錨）
//   ・線幅と点半径は ×dpr・既定値
//   ・lodRank はズームとともに細かく（小さく）なる・真上の z が r≈63−3z
//   ・lastViewBbox：真上は 8 隅から・地平線が見えるチルトは地平キャップ・全球は null
//   ・near：真上は正・下辺が地球を外れれば [0,0]
//   ・zoomInRange（データ × スタイルの積）
import { computeDrawData, zoomInRange } from "../src/gint/drawdata.ts";
import { lonlatTo3D } from "../src/camera.ts";
import * as mat from "../src/mat.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;
const D2R = Math.PI / 180;
const view = (o = {}) => ({ width: 1280, height: 800, dpr: 2, ...o });
const run = (cam, data = {}, s = view()) => ({ s, d: computeDrawData(s, { cam: { dpr: 1, pitch: 0, bearing: 0, ...cam }, ...data }) });
const mx = lon => Math.round((lon + 180) * 1e7) >>> 0, my = lat => Math.round((lat + 90) * 1e7) >>> 0;

// ── origin・錨 ──
{
	const { s, d } = run({ center: [139.123456789, 35.987654321], zoom: 18 });
	ok("origin は 1e-7° に量子化", near(d.origin[0], 139.1234568, 1e-9) && near(d.origin[1], 35.9876543, 1e-9), d.origin.join(","));
	const T = lonlatTo3D(d.origin[0], d.origin[1]);
	const c = mat.transform(d.mvp, [T[0], T[1], T[2], 1]);
	ok("clipT＝mvp·T（f32 の mvp で 1e-5 以内）", d.clipT.every((v, i) => near(v, c[i], 1e-5 * Math.max(1, Math.abs(v)))));
	ok("originZr＝T·eye−1・originPt＝T", near(d.originZr, mat.dot(T, d.eye) - 1, 1e-12) && d.originPt.every((v, i) => near(v, T[i], 1e-15)));
	ok("mvp は Float32Array", d.mvp instanceof Float32Array && d.mvp.length === 16);
	ok("s.cam を書く（identify の unproject 用）", s.cam && Array.isArray(s.cam.eye));
	ok("zoom はそのまま", d.zoom === 18);
}
{
	const { d } = run({ center: [190, 10], zoom: 6 });
	ok("経度 190 → origin -170", near(d.origin[0], -170, 1e-9));
	const { d: e } = run({ center: [-540, 10], zoom: 6 });
	ok("経度 -540 → origin -180", near(e.origin[0], -180, 1e-9));
}

// ── ノブ（×dpr・既定値・運搬） ──
{
	const { d } = run({ center: [0, 0], zoom: 5 });
	ok("既定：lineWidth 1×dpr・ptRadius 1.5×dpr・hiliteWidth 0", d.lineWidth === 2 && d.ptRadius === 3 && d.hiliteWidth === 0);
	const st = { a: 1 }, { d: e } = run({ center: [0, 0], zoom: 5 }, { lineWidth: 3, ptRadius: 2, hiliteWidth: 4, styleTable: st, outlineZoom: 7, moveBudget: 9, _forceLow: true, fillColor: [1, 0, 0, 1] });
	ok("指定：×dpr", e.lineWidth === 6 && e.ptRadius === 4 && e.hiliteWidth === 8);
	ok("選別リスト：styleTable・outlineZoom・moveBudget・_forceLow・fillColor を運ぶ", e.styleTable === st && e.outlineZoom === 7 && e.moveBudget === 9 && e._forceLow === true && e.fillColor[0] === 1);
}

// ── lodRank ──
{
	const ranks = [4, 8, 12, 16].map(z => run({ center: [139.7, 35.6], zoom: z }).d.lodRank);
	ok("lodRank はズームとともに小さく（細かく）", ranks.every((r, i) => i === 0 || r < ranks[i - 1]), ranks.join(","));
	ok("lodRank は 0..63", ranks.every(r => r >= 0 && r <= 63));
	const r10 = run({ center: [0, 0], zoom: 10 }, {}, view({ dpr: 1 })).d.lodRank;
	ok("赤道・真上の z10 ≈ 63−3z（±2）", Math.abs(r10 - 33) <= 2, `rank=${r10}`);
	const { d } = run({ center: [139.7, 35.6], zoom: 12 });
	ok("farAxes は単位ベクトル 2 本・farScale＝[cosφ,1]", d.farAxes && near(Math.hypot(d.farAxes[0], d.farAxes[1]), 1, 1e-9) && near(Math.hypot(d.farAxes[2], d.farAxes[3]), 1, 1e-9) && near(d.farScale[0], Math.cos(35.6 * D2R), 1e-3));
	ok("真上・北が上：東は +x・北は +y", d.farAxes[0] > 0.99 && d.farAxes[3] > 0.99);
}

// ── lastViewBbox ──
{
	const { s } = run({ center: [139.7, 35.6], zoom: 12 });
	const b = s.lastViewBbox;
	ok("真上：8 隅の bbox が視野中心を含む", b && b[0] < mx(139.7) && mx(139.7) < b[2] && b[1] < my(35.6) && my(35.6) < b[3]);
	ok("真上：z12 の bbox は 1° 未満", b && (b[2] - b[0]) / 1e7 < 1 && (b[3] - b[1]) / 1e7 < 1);
	const { s: t } = run({ center: [139.7, 35.6], zoom: 8, pitch: 75 * D2R });
	const h = t.lastViewBbox;
	ok("地平線が見えるチルト：地平キャップの bbox（null にしない）", h && h[0] < mx(139.7) && mx(139.7) < h[2] && h[1] < my(35.6) && my(35.6) < h[3], h ? h.map(v => (v / 1e7).toFixed(1)).join(",") : "null");
	const { s: g } = run({ center: [0, 0], zoom: 0 });
	ok("全球（z0）：bbox は null", g.lastViewBbox === null);
	const { s: a } = run({ center: [179.9, 0], zoom: 4, pitch: 80 * D2R });
	ok("日付変更線を跨ぐ地平キャップ：null", a.lastViewBbox === null);
}

// ── near（近傍窓） ──
{
	const { d } = run({ center: [139.7, 35.6], zoom: 14 });
	ok("真上：near は正で小さい", d.near[0] > 0 && d.near[1] > 0 && d.near[0] < 1 && d.near[1] < 1, d.near.map(v => v.toFixed(4)).join(","));
	const { d: g } = run({ center: [0, 0], zoom: 0 });
	ok("全球：near＝[0,0]", g.near[0] === 0 && g.near[1] === 0);
}

// ── zoomInRange ──
{
	const cam = z => ({ cam: { zoom: z } });
	ok("zoomInRange：既定 0..22", zoomInRange({}, cam(0)) && zoomInRange({}, cam(22)) && !zoomInRange({}, cam(22.1)));
	ok("zoomInRange：層とデータの積（大きい min・小さい max）", zoomInRange({ minZoom: 5, maxZoom: 15 }, { ...cam(8), minZoom: 7, maxZoom: 10 }) && !zoomInRange({ minZoom: 5 }, { ...cam(6), minZoom: 7 }) && !zoomInRange({ maxZoom: 15 }, { ...cam(11), maxZoom: 10 }));
	ok("zoomInRange：null は既定扱い", zoomInRange({ minZoom: null, maxZoom: null }, { ...cam(3), minZoom: null, maxZoom: null }));
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ gint-drawdata 全 PASS");
process.exit(fail ? 1 : 0);
