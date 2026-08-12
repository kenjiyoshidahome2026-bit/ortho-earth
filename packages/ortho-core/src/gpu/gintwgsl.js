// gint WGSL＝gl/gint/programs.js の忠実移植（Phase 3）。
// 数学は GLSL 版と1:1：Morton decode（compact16）・dlonE7（360e7 周期を uint のまま畳む＝exact）・
// 原点相対 RTE（sinP テイラー・cos-1=-2sin²(θ/2)）・GPU Dynamic LOD（rank discard＋前方スナップ）・
// capsule SDF 線・stencil winding 塗り・per-fid スタイル・隠線淡破線・標高ドレープ。
// GL との差分：
//  ・usampler2D texelFetch → texture_2d<u32> + textureLoad（sampler 不要）
//  ・uniform 群 → GF（フレーム一括 256B）＋GP（描画役割毎 48B）＋Styles（style/dash 表）
//  ・クリップ z：GL[-w,w]→WebGPU[0,w]。生クリップを出す stencil 系は z'=(z+w)/2 で同一クリップ体積へ写像。
//    線の対数深度は z01=0.5·log2(1+w)·coef（renderer と同じ写像＝深度互換）。
//  ・inout 引数（lodSnap）→ 戻り値 struct。GLSL mod（floor型）→ fmod 自前（WGSL % は trunc 型）。

// フレーム一括 uniform（ちょうど 256B＝1スロット）。詰め順は gint.js packGF と厳密対応。
//   centers=(ix,iy) Morton中心 / texw=(arc_w, meta_w) / flags=(has_pivot, use_vbb, pivot_w, fidstyle_w)
//   depthP=(logCoef, fogFar, elevScale, hasElev)＝深度統合（terrainDepth 時のみ非0）
const GF = /* wgsl */`
struct GF {
	mvp: mat4x4f,
	clipT: vec4f,      // mvp*[原点3D,1]（CPU double）＝MVP相殺回避の錨
	trig: vec4f,       // 原点の三角比 (cosLon,sinLon,cosLat,sinLat)
	eye: vec3f,
	originPt: vec3f,   // 原点3D（drape の絶対方向 dir=originPt+rel 用）
	origin: vec2f,     // シーン原点 lon/lat (deg)＝Morton 中心
	viewport: vec2f,   // device px
	centers: vec2u,    // (u_ix_center, u_iy_center)
	texw: vec2i,       // (u_arc_w, u_meta_w)
	originZr: f32,     // dot(原点3D,eye)-1（CPU double）＝zr相殺回避の錨
	lodRank: f32,      // GPU Dynamic LOD 閾値（VW rank 0-63）
	ellT2: vec2f,      // 楕円体 dβ 錨 (cos2φ0, sin2φ0)（旧 _pad0。球＝(0,0)＝補正が厳密0）
	vbb: vec4u,        // 視野 bbox（e7整数・線幅マージン込み）
	flags: vec4u,      // has_pivot, use_vbb, pivot_w, fidstyle_w(0=無効)
	depthP: vec4f,     // logCoef, fogFar, elevScale, hasElev
	elevBounds: vec4f,
	elevP: vec4f,      // edgeFade, cos4φ0, sin4φ0, ell(1=楕円体)＝予備3枠に dβ 錨の残りとゲート（球＝0,0,0）
};
@group(0) @binding(0) var<uniform> F: GF;
struct Styles { style: array<vec4f, 256>, dash: array<vec4f, 256> };   // dash は xy のみ使用（uniform 配列は 16B stride）
@group(0) @binding(1) var<uniform> S: Styles;
struct GP {
	a: vec4f,      // lineWidth(device px), widthAdd, ptRadius(device px), hidden(0/1)
	b: vec4i,      // activeId, pass(0=clean/1=highlight), 0, 0
	color: vec4f,  // fill/mask 色（cover 用）
};
@group(1) @binding(0) var<uniform> P: GP;
`;

// 線・stencil 系の共有ヘッダ（GLSL_VS_HEADER の移植）。group(2)=arc+meta、group(3)=pivot/fidStyle/標高。
const HEADER = /* wgsl */`
${GF}
@group(2) @binding(0) var arcTex: texture_2d<u32>;
@group(2) @binding(1) var metaTex: texture_2d<u32>;
@group(3) @binding(0) var pivotTex: texture_2d<u32>;
@group(3) @binding(1) var fidTex: texture_2d<u32>;
@group(3) @binding(2) var elevTex: texture_2d<f32>;
@group(3) @binding(3) var elevSamp: sampler;
const D2R: f32 = 0.017453292519943295;
// 標高（renderer と同式＝基図の線/塗りと同じドレープ＝重ねてズレない）
fn elevAt(ll: vec2f) -> f32 {
	if (F.depthP.w < 0.5) { return 0.0; }
	let uv = (ll - F.elevBounds.xy) / F.elevBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 0.0; }
	var fade = 1.0;
	if (F.elevP.x > 0.0) {
		let w = vec2f(F.elevP.x) / F.elevBounds.zw;
		fade = min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
	}
	return textureSampleLevel(elevTex, elevSamp, uv, 0.0).r * fade;
}
// GPU sin の微小角誤差回避（テイラー切替＝GLSL 版と同一）
fn sinP(x: f32) -> f32 {
	let x2 = x * x;
	return select(sin(x), x * (1.0 - x2 * (1.0 / 6.0) * (1.0 - x2 * (1.0 / 20.0))), abs(x) < 0.1);
}
fn cosP(x: f32) -> f32 { let s = sinP(0.5 * x); return 1.0 - 2.0 * s * s; }
// 楕円体 dβ（GLSL gint 版と同式・球＝ellT2/elevP.yz=0 で補正が厳密0。F.trig は β の三角）
fn dBeta(dp: f32) -> f32 {
	if (F.elevP.w < 0.5) { return dp; }   // 球＝恒等を早期return＝補正の三角関数を毎頂点払わない
	let sd = sinP(dp); let cd = cosP(dp); let s2d = sinP(2.0 * dp); let c2d = cosP(2.0 * dp);
	return dp - 2.0 * 0.0016792203863837047    * (F.ellT2.x * cd  - F.ellT2.y * sd)  * sd
	          + 2.0 * 0.0000014098905530233192 * (F.elevP.y * c2d - F.elevP.z * s2d) * s2d;
}
// 原点相対 RTE：頂点3D − 原点3D を桁落ちなしで直接作る（cos(θ)-1=-2sin²(θ/2)）
// dlat は dBeta で β差分へ（球では恒等）＝以降は純粋な球面幾何（β単位球）
fn deltaToRel(dlonDeg: f32, dlatDeg: f32) -> vec3f {
	let da = dlonDeg * D2R; let db = dBeta(dlatDeg * D2R);
	let sda = sinP(da); let sdb = sinP(db);
	let sha = sinP(da * 0.5); let shb = sinP(db * 0.5);
	let cdaM1 = -2.0 * sha * sha; let cdbM1 = -2.0 * shb * shb;
	let cda = 1.0 + cdaM1; let cdb = 1.0 + cdbM1;
	let ccM1 = cdaM1 + cdbM1 + cdaM1 * cdbM1;
	let cLon = F.trig.x; let sLon = F.trig.y; let cLat = F.trig.z; let sLat = F.trig.w;
	let rx = cLat * cLon * ccM1 - cLat * sLon * cdb * sda - sLat * cLon * sdb * cda + sLat * sLon * sdb * sda;
	let ry = sLat * cdbM1 + cLat * sdb;
	let rz = cLat * sLon * ccM1 + cLat * cLon * cdb * sda - sLat * sLon * sdb * cda - sLat * cLon * sdb * sda;
	return vec3f(rx, ry, rz);
}
fn compact16(m0: u32) -> u32 {
	var m = m0 & 0x55555555u;
	m = (m | (m >> 1u)) & 0x33333333u;
	m = (m | (m >> 2u)) & 0x0F0F0F0Fu;
	m = (m | (m >> 4u)) & 0x00FF00FFu;
	m = (m | (m >> 8u)) & 0x0000FFFFu;
	return m;
}
// 経度Δ（1e-7°単位・符号付き最短）。360e7 周期を uint のまま畳む＝exact（float 化の格子化を避ける）
fn dlonE7(a: u32, b: u32) -> f32 {
	var d = max(a, b) - min(a, b);
	var sg = select(-1.0, 1.0, a >= b);
	if (d > 1800000000u) { d = 3600000000u - d; sg = -sg; }
	return f32(d) * sg;
}
// gint 整数 → 原点相対 delta (deg)
fn decodeDLL(idx: u32) -> vec2f {
	let tc = vec2i(i32(idx) % F.texw.x, i32(idx) / F.texw.x);
	let px = textureLoad(arcTex, tc, 0);
	let lo = px.r; let hi = px.g;
	let lo_c = select(lo & 0xFFFFFFC0u, lo, (hi >> 31u) != 0u);
	let hi_c = hi & 0x7FFFFFFFu;
	let ix = (compact16(hi_c) << 16u) | compact16(lo_c);
	let iy = (compact16(hi_c >> 1u) << 16u) | compact16(lo_c >> 1u);
	return vec2f(dlonE7(ix, F.centers.x) * 1e-7, f32(i32(iy - F.centers.y)) * 1e-7);
}
fn decodeRel(idx: u32) -> vec3f {
	let dLL = decodeDLL(idx);
	return deltaToRel(dLL.x, dLL.y);
}
struct Proj { xy: vec2f, zr: f32, w: f32 };
// gint 整数 → screen px（zr>0 手前半球）
fn fetchProject(idx: u32) -> Proj {
	let rel = decodeRel(idx);
	let zr = F.originZr + dot(rel, F.eye);
	let clip = F.clipT + F.mvp * vec4f(rel, 0.0);
	if (clip.w <= 0.0) { return Proj(F.viewport * 0.5, -1.0, clip.w); }
	let ndc = clip.xy / clip.w;
	return Proj(vec2f((ndc.x * 0.5 + 0.5) * F.viewport.x, (1.0 - (ndc.y * 0.5 + 0.5)) * F.viewport.y), zr, clip.w);
}
// 深度統合用：標高ドレープ込み投影（elevScale=0 なら fetchProject と同一）
fn projectDrape(idx: u32) -> Proj {
	let dLL = decodeDLL(idx);
	let rel = deltaToRel(dLL.x, dLL.y);
	let zr = F.originZr + dot(rel, F.eye);
	var relW = rel;
	if (F.depthP.z > 0.0 && F.depthP.w > 0.5) {
		var dir = F.originPt + rel;
		let df = 1.0 - smoothstep(F.depthP.y * 0.8, F.depthP.y * 2.0, distance(F.eye, dir));
		let ll = F.origin + dLL;
		let h = elevAt(ll) * F.depthP.z * df;
		if (F.elevP.w > 0.5) {   // 楕円体＝測地法線で変位（renderer liftDir と同式＝基図の線と同じ高さ）
			let p = ll.y * D2R; let l = ll.x * D2R; let cp = cos(p);
			dir = vec3f(cp * cos(l), sin(p) * 1.0033640898209764, cp * sin(l));
		}
		relW = rel + h * dir;
	}
	let clip = F.clipT + F.mvp * vec4f(relW, 0.0);
	if (clip.w <= 0.0) { return Proj(F.viewport * 0.5, -1.0, clip.w); }
	let ndc = clip.xy / clip.w;
	return Proj(vec2f((ndc.x * 0.5 + 0.5) * F.viewport.x, (1.0 - (ndc.y * 0.5 + 0.5)) * F.viewport.y), zr, clip.w);
}
// stencil 用：クリップ座標のまま（部分表示でも巻き数が壊れない）。z は GL[-w,w]→WebGPU[0,w] へ等価写像
fn fetchClip(idx: u32) -> vec4f {
	let c = F.clipT + F.mvp * vec4f(decodeRel(idx), 0.0);
	return vec4f(c.xy, (c.z + c.w) * 0.5, c.w);
}
// 塗り扇(stencil/idfill)を地形にドレープ＝projectDrape と同じ標高変位のクリップ座標版。elevScale=0(真俯瞰)なら fetchClip と同一
//（既存挙動を壊さない）。町丁目 overlay の面ドレープ(wgsl.js OVERLAY_WGSL vsStencil・2026-08-13)を gint 塗り扇へ写す＝
// 汚い土砂ポリゴン(自己交差/重なり)も winding で斜面に貼る。扇の pivot は非ドレープでよい（winding は screen で pivot 不変）。
fn fetchClipDrape(idx: u32) -> vec4f {
	let dLL = decodeDLL(idx);
	let rel = deltaToRel(dLL.x, dLL.y);
	var relW = rel;
	if (F.depthP.z > 0.0 && F.depthP.w > 0.5) {
		var dir = F.originPt + rel;
		let df = 1.0 - smoothstep(F.depthP.y * 0.8, F.depthP.y * 2.0, distance(F.eye, dir));
		let ll = F.origin + dLL;
		let h = elevAt(ll) * F.depthP.z * df;
		if (F.elevP.w > 0.5) { let p = ll.y * D2R; let l = ll.x * D2R; let cp = cos(p); dir = vec3f(cp * cos(l), sin(p) * 1.0033640898209764, cp * sin(l)); }
		relW = rel + h * dir;
	}
	let c = F.clipT + F.mvp * vec4f(relW, 0.0);
	return vec4f(c.xy, (c.z + c.w) * 0.5, c.w);
}
fn toNDC(p: vec2f) -> vec4f {
	return vec4f(2.0 * p.x / F.viewport.x - 1.0, 1.0 - 2.0 * p.y / F.viewport.y, 0.0, 1.0);
}
fn fetchEdgeMeta(edgeId: i32) -> vec4u {
	return textureLoad(metaTex, vec2i(edgeId % F.texw.y, edgeId / F.texw.y), 0);
}
// 頂点の VW rank（terminal=63 常時保持、他は低6bit）
fn fetchRank(idx: u32) -> u32 {
	let px = textureLoad(arcTex, vec2i(i32(idx) % F.texw.x, i32(idx) / F.texw.x), 0);
	return select(px.r & 0x3Fu, 63u, (px.g >> 31u) != 0u);
}
fn fetchFidBbox(fid: u32) -> vec4u {
	return textureLoad(pivotTex, vec2i(i32(fid) % i32(F.flags.z), i32(fid) / i32(F.flags.z)), 0);
}
// feature 単位 GPU bbox カリング
fn bboxVisible(fid: u32) -> bool {
	if (F.flags.y == 0u) { return true; }
	let bb = fetchFidBbox(fid);
	return !(bb.z < F.vbb.x || bb.x > F.vbb.z || bb.w < F.vbb.y || bb.y > F.vbb.w);
}
// stencil 塗りの扇要（feature bbox 中心）＝TBDR パラメータバッファ対策。無し＝クリップ原点（z01写像済み）
fn pivotClip(fid: u32) -> vec4f {
	if (F.flags.x == 0u) { return vec4f(0.0, 0.0, 0.5, 1.0); }   // クリップ原点（z は WebGPU [0,w] の中央）
	let bb = fetchFidBbox(fid);
	let cx = bb.x + (bb.z - bb.x) / 2u; let cy = bb.y + (bb.w - bb.y) / 2u;
	let dlon = dlonE7(cx, F.centers.x) * 1e-7;
	let dlat = f32(i32(cy - F.centers.y)) * 1e-7;
	let c = F.clipT + F.mvp * vec4f(deltaToRel(dlon, dlat), 0.0);
	return vec4f(c.xy, (c.z + c.w) * 0.5, c.w);
}
// GPU Dynamic LOD（gap無し）：A が閾値未満は捨て、B は「次に閾値を満たす頂点」まで前方スナップ
struct Snap { keep: bool, a: u32, b: u32 };
fn lodSnap(a: u32, b0: u32, edgeId: i32) -> Snap {
	if (f32(fetchRank(a)) < F.lodRank) { return Snap(false, a, b0); }
	var b = b0;
	for (var k = 1; k < 4096; k++) {
		if (f32(fetchRank(b)) >= F.lodRank) { break; }
		let m = fetchEdgeMeta(edgeId + k);
		if (m.r != b) { break; }
		b = m.g;
	}
	return Snap(true, a, b);
}
fn fmod(x: f32, y: f32) -> f32 { return x - y * floor(x / y); }   // GLSL mod（floor型）
const DEGEN: vec4f = vec4f(2.0, 0.0, 0.5, 1.0);   // 画面外へ捨てる縮退頂点
`;

// 線＋pick 線（VS_RENDER / FS_RENDER / VS_PICK_LINE / FS_PICK の移植）。
// 6 verts/edge: (A-)(A+)(B+)(A-)(B+)(B-)。pass=0: 非アクティブ / 1: アクティブのみ。
export const GINT_LINE_WGSL = /* wgsl */`
${HEADER}
struct LineOut {
	@builtin(position) pos: vec4f,
	@location(0) color: vec4f,
	@location(1) zr: f32,
	@location(2) dist: f32,
	@location(3) @interpolate(flat) halfw: f32,
	@location(4) @interpolate(flat) dash: vec2f,
	@location(5) @interpolate(flat) distBase: f32,
	@location(6) frag: vec2f,
	@location(7) @interpolate(flat) ea: vec2f,
	@location(8) @interpolate(flat) eb: vec2f,
};
@vertex fn vsRender(@builtin(vertex_index) vi: u32) -> LineOut {
	var o: LineOut;
	o.pos = DEGEN;
	let edgeId = i32(vi) / 6;
	let sub = i32(vi) % 6;
	let em = fetchEdgeMeta(edgeId);
	let featId = i32(em.a);
	// feature bbox カリング（ポリゴン辺のみ＝styleId 0）
	if ((em.b & 255u) == 0u && !bboxVisible(em.a)) { return o; }
	let sn = lodSnap(em.r, em.g, edgeId);
	if (!sn.keep) { return o; }
	if (P.b.y == 0 && featId == P.b.x) { return o; }   // clean パス＝アクティブ除外
	if (P.b.y == 1 && featId != P.b.x) { return o; }   // highlight パス＝アクティブのみ
	// per-fid スタイル（paint 時のみ）：visibility=filter・width=0=非表示・線色上書き
	var lw = P.a.x;
	var fidColor = vec4f(0.0);
	if (F.flags.w != 0u) {
		let rec = textureLoad(fidTex, vec2i(i32(em.a) % i32(F.flags.w), i32(em.a) / i32(F.flags.w)), 0);
		if ((rec.b & 1u) == 0u) { return o; }
		let w8 = (rec.b >> 24u) & 255u;
		if (w8 == 0u) { return o; }
		lw = f32(w8) * 0.125 + P.a.y;
		let lc = rec.g;
		if ((lc & 255u) != 0u) {
			fidColor = vec4f(f32(lc >> 24u), f32((lc >> 16u) & 255u), f32((lc >> 8u) & 255u), f32(lc & 255u)) / 255.0;
		}
	}
	let useA = (sub == 0 || sub == 1 || sub == 3);
	let side = select(-1.0, 1.0, sub == 1 || sub == 2 || sub == 4);
	let si = select(sn.b, sn.a, useA);
	let oi = select(sn.a, sn.b, useA);
	let ps = projectDrape(si);
	o.zr = ps.zr;
	let po = projectDrape(oi);
	var oXY = po.xy;
	if (po.zr < 0.0 && ps.zr > 0.0) { oXY = ps.xy + (ps.zr / (ps.zr - po.zr)) * (po.xy - ps.xy); }
	// 対数深度（renderer と同式・同係数の z01）。logCoef=0（深度オフ）は z=0
	let zc = select(0.0, log2(max(1.0 + ps.w, 1e-6)) * F.depthP.x * 0.5, F.depthP.x > 0.0);
	let dir = oXY - ps.xy;
	let len = length(dir);
	if (len < 1e-4) { let nd0 = toNDC(ps.xy); o.pos = vec4f(nd0.xy, zc, 1.0); return o; }
	let tang = dir / len;
	let perp = vec2f(-tang.y, tang.x);
	let halfPx = lw * 0.5 + 1.0;   // AA余白込み（device px 一本＝GL の u_dpr=1 と同じ）
	let qpos = ps.xy + side * halfPx * perp - tang * halfPx;
	let nd = toNDC(qpos);
	o.pos = vec4f(nd.xy, zc, 1.0);
	o.frag = qpos; o.ea = ps.xy; o.eb = oXY;
	let styleIdx = i32(em.b & 0xFFu);
	o.color = select(select(S.style[styleIdx], fidColor, fidColor.a > 0.0), vec4f(1.0, 0.9, 0.0, 1.0), P.b.y == 1);
	o.dash = S.dash[styleIdx].xy;
	o.distBase = f32(em.b >> 8u) * 0.017453292;
	o.dist = select(len, 0.0, useA);
	o.halfw = lw * 0.5;
	return o;
}
@fragment fn fsRender(in: LineOut) -> @location(0) vec4f {
	// fwidth は WGSL の uniformity 規則で分岐内から呼べない＝無条件で先に取る（discard は demote＝微分は健在）
	let aaD = max(fwidth(in.dist), 0.001);
	let pa = in.frag - in.ea; let ba = in.eb - in.ea;
	let t2 = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
	let dcap = length(pa - ba * t2);
	let aaW = max(fwidth(dcap), 1e-3);
	if (in.zr < -0.05) { discard; }
	if (in.color.a == 0.0) { discard; }
	var alpha = in.color.a * smoothstep(-0.01, 0.02, in.zr);
	if (P.a.w > 0.5) {   // 隠線（尾根の向こう）＝淡い固定破線（CAD流）
		let t = fmod(in.distBase + in.dist, 10.0);
		alpha *= (1.0 - smoothstep(6.0 - aaD, 6.0 + aaD, t)) * 0.35;
	}
	if (in.dash.y > 0.0) {
		let d = in.distBase + in.dist;
		let period = in.dash.x + in.dash.y;
		let t = fmod(d, period);
		alpha *= 1.0 - smoothstep(in.dash.x - aaD, in.dash.x + aaD, t);
	}
	// カプセルSDF：両端が半円＝鋭角の繋ぎ目でもトゲが出ない
	alpha *= clamp((in.halfw - dcap) / aaW + 0.5, 0.0, 1.0);
	if (alpha < 0.004) { discard; }
	return vec4f(in.color.rgb, alpha);   // straight alpha（blend が SRC_ALPHA/1-SRC_ALPHA）
}
struct PickOut {
	@builtin(position) pos: vec4f,
	@location(0) color: vec4f,
	@location(1) zr: f32,
};
@vertex fn vsPickLine(@builtin(vertex_index) vi: u32) -> PickOut {
	var o: PickOut;
	o.pos = DEGEN;
	let edgeId = i32(vi) / 6;
	let sub = i32(vi) % 6;
	let em = fetchEdgeMeta(edgeId);
	if ((em.b & 255u) == 0u) { return o; }   // ポリゴン辺＝JSレイキャスト側＝pick から除外
	if (F.flags.w != 0u &&
		(textureLoad(fidTex, vec2i(i32(em.a) % i32(F.flags.w), i32(em.a) / i32(F.flags.w)), 0).b & 1u) == 0u) { return o; }
	let sn = lodSnap(em.r, em.g, edgeId);
	if (!sn.keep) { return o; }
	let useA = (sub == 0 || sub == 1 || sub == 3);
	let side = select(-1.0, 1.0, sub == 1 || sub == 2 || sub == 4);
	let si = select(sn.b, sn.a, useA);
	let oi = select(sn.a, sn.b, useA);
	let ps = fetchProject(si);
	o.zr = ps.zr;
	let po = fetchProject(oi);
	var oXY = po.xy;
	if (po.zr < 0.0 && ps.zr > 0.0) { oXY = ps.xy + (ps.zr / (ps.zr - po.zr)) * (po.xy - ps.xy); }
	let dir = oXY - ps.xy;
	let len = length(dir);
	if (len < 1e-4) { o.pos = toNDC(ps.xy); return o; }
	let tang = dir / len;
	let perp = vec2f(-tang.y, tang.x);
	o.pos = toNDC(ps.xy + side * (P.a.x * 0.5) * perp - tang * (P.a.x * 0.5));
	let fid1 = em.a + 1u;
	o.color = vec4f(f32(fid1 & 255u) / 255.0, f32((fid1 >> 8u) & 255u) / 255.0, f32((fid1 >> 16u) & 255u) / 255.0, 1.0);
	return o;
}
@fragment fn fsPick(in: PickOut) -> @location(0) vec4f {
	if (in.zr < 0.0) { discard; }
	return in.color;
}
`;

// stencil 塗り系（VS_STENCIL / VS_STENCIL_MASK / VS_FILL / FS_* の移植）＋stencil ゼロ書き。
export const GINT_STENCIL_WGSL = /* wgsl */`
${HEADER}
struct SOut { @builtin(position) pos: vec4f };
@vertex fn vsStencil(@builtin(vertex_index) vi: u32) -> SOut {
	var o: SOut;
	o.pos = DEGEN;
	let edgeId = i32(vi) / 3;
	let sub = i32(vi) % 3;
	let em = fetchEdgeMeta(edgeId);
	if (!bboxVisible(em.a)) { return o; }
	let sn = lodSnap(em.r, em.g, edgeId);   // 塗り stencil は lodRank=0（GF側）＝全密度
	if (!sn.keep) { return o; }
	if (sub == 0) { o.pos = pivotClip(em.a); return o; }
	o.pos = fetchClipDrape(select(sn.b, sn.a, sub == 1));   // 塗り扇の辺端点を地形へドレープ（真俯瞰=無変化）
	return o;
}
@fragment fn fsNull(in: SOut) -> @location(0) vec4f { return vec4f(0.0); }   // 色は writeMask=0 で殺す
struct MOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) featId: i32 };
@vertex fn vsStencilMask(@builtin(vertex_index) vi: u32) -> MOut {
	var o: MOut;
	o.pos = DEGEN;
	let edgeId = i32(vi) / 3;
	let sub = i32(vi) % 3;
	let em = fetchEdgeMeta(edgeId);
	o.featId = i32(em.a);
	if (sub == 0) { o.pos = pivotClip(em.a); return o; }
	o.pos = fetchClip(select(em.g, em.r, sub == 1));
	return o;
}
@fragment fn fsStencilMask(in: MOut) -> @location(0) vec4f {
	if (in.featId != P.b.x) { discard; }
	return vec4f(0.0);
}
struct FOut { @builtin(position) pos: vec4f };
@vertex fn vsFull(@builtin(vertex_index) vi: u32) -> FOut {   // フルスクリーン（cover / stencil ゼロ書き共用）
	var o: FOut;
	let x = select(-1.0, 3.0, vi == 1u);
	let y = select(-1.0, 3.0, vi == 2u);
	o.pos = vec4f(x, y, 0.5, 1.0);
	return o;
}
@fragment fn fsFill(in: FOut) -> @location(0) vec4f { return P.color; }   // straight alpha
// コロプレス ID 蓄積（idfill.js VS_ID/FS_ID）：stencil と同じ fan 幾何＋fid を flat varying へ。
// FS は front_facing で ±(fid+1) を rg16float へ加算＝R=Σ±(fid+1)・G=Σ±1(winding)。解決パスが R/G で fid 復元。
struct IdOut { @builtin(position) pos: vec4f, @location(0) @interpolate(flat) fid1: f32 };
@vertex fn vsId(@builtin(vertex_index) vi: u32) -> IdOut {
	var o: IdOut;
	o.pos = DEGEN; o.fid1 = 0.0;
	let edgeId = i32(vi) / 3;
	let sub = i32(vi) % 3;
	let em = fetchEdgeMeta(edgeId);
	o.fid1 = f32(em.a + 1u);
	if (!bboxVisible(em.a)) { return o; }
	// 不可視fid（filter で落とした feature）は winding 蓄積から除外する。含めると重複被覆時に
	// R/G が非整数化して解決パスが discard＝下の feature まで塗りが消える（振興局が市区町村に重なる
	// 北海道で実証 2026-08-12）。単被覆前提の idfill を「除外した feature は無い物」として正す。
	if (F.flags.w != 0u &&
		(textureLoad(fidTex, vec2i(i32(em.a) % i32(F.flags.w), i32(em.a) / i32(F.flags.w)), 0).b & 1u) == 0u) { return o; }
	let sn = lodSnap(em.r, em.g, edgeId);   // lodRank=0（GF側）＝全密度（自己交差斑点を出さない）
	if (!sn.keep) { return o; }
	if (sub == 0) { o.pos = pivotClip(em.a); return o; }
	o.pos = fetchClipDrape(select(sn.b, sn.a, sub == 1));   // 塗り扇の辺端点を地形へドレープ（真俯瞰=無変化）
	return o;
}
@fragment fn fsId(in: IdOut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
	let sgn = select(-1.0, 1.0, ff);
	return vec4f(sgn * in.fid1, sgn, 0.0, 0.0);   // rg16float＝rg のみ格納。blend 加算(ONE,ONE)
}
`;

// コロプレス解決（idfill.js FS_RESOLVE）：ID バッファ画素→fid→スタイル表→色。専用バインド（idTex+fidTex+小uniform）。
// R/G で fid 復元（多重登記は約分で消える）。overlap=1 は監査プローブ（異常画素だけ色分け）。
export const GINT_IDRESOLVE_WGSL = /* wgsl */`
@group(0) @binding(0) var idTex: texture_2d<f32>;
@group(0) @binding(1) var fidTex: texture_2d<u32>;
@group(0) @binding(2) var<uniform> R: vec4u;   // (fid_w, fid_count, overlap, 0)
struct FOut { @builtin(position) pos: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> FOut {
	var o: FOut;
	o.pos = vec4f(select(-1.0, 3.0, vi == 1u), select(-1.0, 3.0, vi == 2u), 0.5, 1.0);
	return o;
}
@fragment fn fs(in: FOut) -> @location(0) vec4f {
	let t = textureLoad(idTex, vec2i(floor(in.pos.xy)), 0).rg;
	if (R.z == 1u) {   // 監査プローブ（品質監査）：winding 和の異常だけ色分け
		let ar = abs(t.r); let ag = abs(t.g);
		if (ag < 0.5) { if (ar > 0.5) { return vec4f(0.0, 0.9, 1.0, 0.85); } discard; }   // シアン＝向き矛盾
		let qo = t.r / t.g;
		if (abs(qo - round(qo)) > 0.25) { return vec4f(1.0, 0.0, 0.8, 0.85); }   // マゼンタ＝別筆の重なり
		if (ag > 1.5) { return vec4f(1.0, 0.55, 0.0, 0.85); }                    // 橙＝同一筆の多重登記
		discard;
	}
	if (abs(t.g) < 0.5) { discard; }        // 被覆なし（穴・外）。G の符号は外環 CW も吸収
	let q = t.r / t.g;                      // 多重登記は約分で消える（R=k(fid+1),G=k → q=fid+1）
	if (abs(q - round(q)) > 0.25) { discard; }   // 別 feature の真の重複＝fid 不定＝塗らない
	let fid = i32(round(q)) - 1;
	if (fid < 0 || fid >= i32(R.y)) { discard; }
	let rec = textureLoad(fidTex, vec2i(fid % i32(R.x), fid / i32(R.x)), 0);
	if ((rec.b & 1u) == 0u) { discard; }    // flags bit0 = visible（filter）
	let c = rec.r;                          // R = fill 色 RGBA8
	let col = vec4f(f32(c >> 24u), f32((c >> 16u) & 255u), f32((c >> 8u) & 255u), f32(c & 255u)) / 255.0;
	if (col.a <= 0.0) { discard; }
	return vec4f(col.rgb, col.a);           // straight alpha（blend が SRC_ALPHA/1-SRC_ALPHA）
}
`;

// 点＋pick 点（VS_POINT / FS_POINT / VS_PICK_POINT / FS_PICK_POINT の移植）。
// group(2) を (ptTex, ptMetaTex) として使う（線系と同じレイアウト＝bind group 差し替えだけ）。
export const GINT_POINT_WGSL = /* wgsl */`
${GF}
@group(2) @binding(0) var ptTex: texture_2d<u32>;
@group(2) @binding(1) var ptMetaTex: texture_2d<u32>;
const D2R: f32 = 0.017453292519943295;
fn sinP(x: f32) -> f32 {
	let x2 = x * x;
	return select(sin(x), x * (1.0 - x2 * (1.0 / 6.0) * (1.0 - x2 * (1.0 / 20.0))), abs(x) < 0.1);
}
fn cosP(x: f32) -> f32 { let s = sinP(0.5 * x); return 1.0 - 2.0 * s * s; }
fn dBeta(dp: f32) -> f32 {   // 楕円体 dβ（arc 側と同一・球＝錨全0で厳密0）
	let sd = sinP(dp); let cd = cosP(dp); let s2d = sinP(2.0 * dp); let c2d = cosP(2.0 * dp);
	return dp - 2.0 * 0.0016792203863837047    * (F.ellT2.x * cd  - F.ellT2.y * sd)  * sd
	          + 2.0 * 0.0000014098905530233192 * (F.elevP.y * c2d - F.elevP.z * s2d) * s2d;
}
fn deltaToRel(dlonDeg: f32, dlatDeg: f32) -> vec3f {
	let da = dlonDeg * D2R; let db = dBeta(dlatDeg * D2R);
	let sda = sinP(da); let sdb = sinP(db);
	let sha = sinP(da * 0.5); let shb = sinP(db * 0.5);
	let cdaM1 = -2.0 * sha * sha; let cdbM1 = -2.0 * shb * shb;
	let cda = 1.0 + cdaM1; let cdb = 1.0 + cdbM1;
	let ccM1 = cdaM1 + cdbM1 + cdaM1 * cdbM1;
	let cLon = F.trig.x; let sLon = F.trig.y; let cLat = F.trig.z; let sLat = F.trig.w;
	let rx = cLat * cLon * ccM1 - cLat * sLon * cdb * sda - sLat * cLon * sdb * cda + sLat * sLon * sdb * sda;
	let ry = sLat * cdbM1 + cLat * sdb;
	let rz = cLat * sLon * ccM1 + cLat * cLon * cdb * sda - sLat * sLon * sdb * cda - sLat * cLon * sdb * sda;
	return vec3f(rx, ry, rz);
}
fn compact16(m0: u32) -> u32 {
	var m = m0 & 0x55555555u;
	m = (m | (m >> 1u)) & 0x33333333u;
	m = (m | (m >> 2u)) & 0x0F0F0F0Fu;
	m = (m | (m >> 4u)) & 0x00FF00FFu;
	m = (m | (m >> 8u)) & 0x0000FFFFu;
	return m;
}
fn dlonE7(a: u32, b: u32) -> f32 {
	var d = max(a, b) - min(a, b);
	var sg = select(-1.0, 1.0, a >= b);
	if (d > 1800000000u) { d = 3600000000u - d; sg = -sg; }
	return f32(d) * sg;
}
struct Pt { xy: vec2f, zr: f32 };
fn fetchPoint(ptId: i32) -> Pt {
	let tc = vec2i(ptId % F.texw.x, ptId / F.texw.x);
	let px = textureLoad(ptTex, tc, 0);
	let hi_c = px.g & 0x7FFFFFFFu;
	let ix = (compact16(hi_c) << 16u) | compact16(px.r);
	let iy = (compact16(hi_c >> 1u) << 16u) | compact16(px.r >> 1u);
	let dlon = dlonE7(ix, F.centers.x) * 1e-7;
	let dlat = f32(i32(iy - F.centers.y)) * 1e-7;
	let rel = deltaToRel(dlon, dlat);
	let zr = F.originZr + dot(rel, F.eye);
	let clip = F.clipT + F.mvp * vec4f(rel, 0.0);
	if (clip.w <= 0.0) { return Pt(F.viewport * 0.5, -1.0); }
	let ndc = clip.xy / clip.w;
	return Pt(vec2f((ndc.x * 0.5 + 0.5) * F.viewport.x, (1.0 - (ndc.y * 0.5 + 0.5)) * F.viewport.y), zr);
}
struct POut {
	@builtin(position) pos: vec4f,
	@location(0) zr: f32,
	@location(1) uv: vec2f,
	@location(2) color: vec4f,
};
@vertex fn vsPoint(@builtin(vertex_index) vi: u32) -> POut {
	var o: POut;
	let ptId = i32(vi) / 6;
	let sub = i32(vi) % 6;
	let ox = select(-1.0, 1.0, sub == 2 || sub == 4 || sub == 5);
	let oy = select(-1.0, 1.0, sub == 1 || sub == 2 || sub == 4);
	let p = fetchPoint(ptId);
	o.zr = p.zr;
	o.uv = vec2f(ox, oy);
	let tc = vec2i(ptId % F.texw.x, ptId / F.texw.x);
	let featId = i32(textureLoad(ptMetaTex, tc, 0).r);
	let isActive = featId == P.b.x;
	let r = select(P.a.z, P.a.z * 1.6, isActive);
	o.pos = vec4f(2.0 * (p.xy.x + ox * r) / F.viewport.x - 1.0, 1.0 - 2.0 * (p.xy.y + oy * r) / F.viewport.y, 0.0, 1.0);
	o.color = select(vec4f(1.0, 0.420, 0.208, 1.0), vec4f(1.0, 0.9, 0.0, 1.0), isActive);
	return o;
}
@fragment fn fsPoint(in: POut) -> @location(0) vec4f {
	if (in.zr < 0.0) { discard; }
	if (dot(in.uv, in.uv) > 1.0) { discard; }
	return in.color;
}
@vertex fn vsPickPoint(@builtin(vertex_index) vi: u32) -> POut {
	var o: POut;
	let ptId = i32(vi) / 6;
	let sub = i32(vi) % 6;
	let ox = select(-1.0, 1.0, sub == 2 || sub == 4 || sub == 5);
	let oy = select(-1.0, 1.0, sub == 1 || sub == 2 || sub == 4);
	let p = fetchPoint(ptId);
	o.zr = p.zr;
	o.uv = vec2f(ox, oy);
	o.pos = vec4f(2.0 * (p.xy.x + ox * P.a.z) / F.viewport.x - 1.0, 1.0 - 2.0 * (p.xy.y + oy * P.a.z) / F.viewport.y, 0.0, 1.0);
	let tc = vec2i(ptId % F.texw.x, ptId / F.texw.x);
	let fid1 = textureLoad(ptMetaTex, tc, 0).r + 1u;
	o.color = vec4f(f32(fid1 & 255u) / 255.0, f32((fid1 >> 8u) & 255u) / 255.0, f32((fid1 >> 16u) & 255u) / 255.0, 1.0);
	return o;
}
@fragment fn fsPickPoint(in: POut) -> @location(0) vec4f {
	if (in.zr < 0.0) { discard; }
	if (dot(in.uv, in.uv) > 1.0) { discard; }
	return in.color;
}
`;
