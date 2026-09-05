// ── gint programs（v2：ortho-map から移植）─────────────────────────────────
// v1(ortho-map) の gintPrograms を japan の substrate へ生まれ直させたもの。
// 【d3⇒mat4 の swap はここ一点】fetchProject の投影本体だけを
//   gint(ix,iy) → 中心からの delta → d3-ortho(rotate/scale/trig/jac) → screen px
// から
//   gint(ix,iy) → 中心からの delta → lonlat(u_origin+delta) → lonlatTo3D(単位球) → u_mvp → screen px
// へ差し替えた。Morton decode / dlonE7(antimeridian, 360e7周期) は不変。
// fetchProject が返すのは screen px＋zr(手前半球>0) ＝ v1 と同じ契約なので、
// 下流の全シェーダ（線幅・stencil・dash・AA・pick）は px 空間のまま丸ごと不変。

// ── 共有 VS ヘッダ：Morton decode ＋ 球面投影（mat4）─────────────────────────
// 返り値 vec3(screen_x, screen_y, zr)。zr < 0 は裏半球（v1 の horizon-clip 判定と同符号）。
const GLSL_VS_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_arc_tex;
uniform usampler2D u_meta_tex;
uniform int        u_arc_w;
uniform int        u_meta_w;
uniform mat4       u_mvp;        // japan の MVP（cameraState 由来）
uniform vec3       u_eye;        // カメラ位置（単位球ワールド）＝手前/裏半球判定
uniform vec2       u_origin;     // シーン原点 lon/lat (deg)＝Morton 中心（現状 deltaTo3D 化で未使用・documentation）
uniform vec4       u_origin_trig; // 原点の三角比 (cosLon,sinLon,cosLat,sinLat)＝CPUでdouble算出＝RTE角度加算の錨
uniform vec2       u_viewport;   // canvas 幅高 (device px)
uniform uint       u_ix_center;  // u_origin の Morton 整数（経度）
uniform uint       u_iy_center;  // u_origin の Morton 整数（緯度）
uniform float      u_lod_rank;   // GPU Dynamic LOD 閾値（VW rank 0-63）。辺の max(rankA,rankB) 未満は VS で discard
uniform vec4       u_clipT;      // mvp*[原点3D,1]＝CPU(double)算出＝MVP相殺回避の錨（clip空間の原点）
uniform float      u_origin_zr;  // dot(原点3D,eye)-1＝CPU(double)算出＝zr相殺回避の錨
// ── 深度統合（1canvas 段階B）：renderer の地形深度（terrainDepth＝山岳ビュー z<13）へ参加する時だけ実値。
// 全て 0 ＝完全に従来動作（worker モード/非統合は一切影響なし）。使用は VS_RENDER のみ（他は宣言だけ＝prune）。
uniform float      u_logCoef;      // >0＝対数深度を焼く（renderer applyLogDepth と同式・同係数）。0＝z=0（深度オフ）
uniform float      u_fogFar;       // 標高変位の距離フェード終端（renderer LINE_MAIN の df と同式＝遠景平ら化に追随）
uniform vec3       u_origin_pt;    // 原点3D（CPU double 算出）＝絶対方向 dir = u_origin_pt + rel
uniform sampler2D  u_elevTex;      // 標高アトラス（renderer と共有・texture unit 7 固定）
uniform vec4       u_elevBounds;   // originLng, originLat, spanLng, spanLat
uniform float      u_elevScale;    // (誇張/地球半径m)：0＝ドレープなし
uniform float      u_hasElev;      // 0/1
uniform float      u_elevEdgeFade; // 標高窓の縁フェード幅(deg)。renderer elev() と同式
const float D2R = 0.017453292519943295;

// 標高（renderer glsl.js elev() と同式＝基図の線/塗りと同じドレープ＝重ねてズレない）。
float elevAt(vec2 ll) {
	if (u_hasElev < 0.5) return 0.0;
	vec2 uv = (ll - u_elevBounds.xy) / u_elevBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
	float fade = 1.0;
	if (u_elevEdgeFade > 0.0) {
		vec2 w = vec2(u_elevEdgeFade) / u_elevBounds.zw;
		fade = min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
	}
	return texture(u_elevTex, uv).r * fade;   // アトラスは南上げ格納＝v直接
}
// 案A（renderer glsl.js QELEV と同式）: ドレープ標高を「地形メッシュと同じ折れ線面」に量子化＝
// 同じ格子頂点で elevAt を取り同じ三角形分割（対角 a-c-b / b-c-d）で補間＝描画されている面に厳密に乗る。
uniform vec4  u_meshQ;   // 地形メッシュ窓（xy=原点・zw=span deg）
uniform float u_meshG;   // 格子の頂点数 G（0=量子化オフ）
float elevQAt(vec2 ll) {
	if (u_meshG < 1.5) return elevAt(ll);
	vec2 g = (ll - u_meshQ.xy) / u_meshQ.zw;
	if (g.x < 0.0 || g.x > 1.0 || g.y < 0.0 || g.y > 1.0) return elevAt(ll);
	float N = u_meshG - 1.0;
	vec2 gc = min(g * N, vec2(N - 1e-4));
	vec2 gi = floor(gc);
	vec2 gf = gc - gi;
	vec2 st = u_meshQ.zw / N;
	vec2 b0 = u_meshQ.xy + gi * st;
	float h00 = elevAt(b0);
	float h10 = elevAt(b0 + vec2(st.x, 0.0));
	float h01 = elevAt(b0 + vec2(0.0, st.y));
	float h11 = elevAt(b0 + st);
	return (gf.x + gf.y < 1.0)
		? h00 + gf.x * (h10 - h00) + gf.y * (h01 - h00)
		: h11 + (1.0 - gf.x) * (h01 - h11) + (1.0 - gf.y) * (h10 - h11);
}

vec3 lonlatTo3D(vec2 ll) {
	float a = ll.x * D2R, b = ll.y * D2R, cb = cos(b);
	return vec3(cb * cos(a), sin(b), cb * sin(a));
}

// GPU の sin() は微小角で信用できない：GLSL 仕様は sin/cos の精度を未規定で、SwiftShader は
// |x|≲1e-7rad を 0 にフラッシュ（transform feedback 実測）、実 GPU も実装依存の近似誤差を持つ。
// 高ズームは Δ角が 1e-9〜1e-6rad かつ倍率 ~1e8px/rad＝誤差がそのまま px の這いになる（v1 の
// 「z>16 は三角関数を捨てる（Jacobian）」と同じ問題の v2 形。左下悪化・チルト軽減の空間署名まで一致）。
// 微小角は Taylor（x−x³/6+x⁵/120＝f32 で厳密同等）、大角（|x|>0.1rad＝低ズームの遠方＝px が km 級）のみ native sin。
float sinP(float x) {
	float x2 = x * x;
	return (abs(x) < 0.1) ? x * (1.0 - x2 * (1.0 / 6.0) * (1.0 - x2 * (1.0 / 20.0))) : sin(x);
}
float cosP(float x) { float s = sinP(0.5 * x); return 1.0 - 2.0 * s * s; }
// 楕円体（?ell=1・段階B）＝renderer glsl.js と同式：dlat（測地緯度差分）→dβ（更成緯度差分）の閉形式差分。
// 球＝u_ell_trig=vec4(0)（GL既定値も0）で補正が厳密0。u_origin_trig は β の三角を運ぶ（drawdata が配る）。
const float ELL_NU  = 0.0016792203863837047;
const float ELL_NU2 = 0.0000014098905530233192;
const float ELL_INV_R = 1.0033640898209764;
uniform vec4  u_ell_trig;   // (cos2φ0, sin2φ0, cos4φ0, sin4φ0)（CPU double・原点の測地緯度）。球=vec4(0)
uniform float u_ell;        // 1=楕円体（ドレープの変位方向・dβ早期returnのゲート）。球=0
float dBeta(float dp) {
	if (u_ell < 0.5) return dp;   // 球＝恒等を早期return＝補正の三角関数を毎頂点払わない
	float sd = sinP(dp), cd = cosP(dp), s2d = sinP(2.0 * dp), c2d = cosP(2.0 * dp);
	return dp - 2.0 * ELL_NU  * (u_ell_trig.x * cd  - u_ell_trig.y * sd)  * sd
	          + 2.0 * ELL_NU2 * (u_ell_trig.z * c2d - u_ell_trig.w * s2d) * s2d;
}

// 原点相対 RTE：絶対経緯度を float32 で組み立てない（u_origin.x≈140 の加算は ulp≈1.8m の格子スナップ＝
// 原点がカメラ追従で毎フレーム動く→頂点が格子間を飛ぶ＝パンで這う揺らぎ）。原点の三角比（u_origin_trig＝
// CPUでdouble算出）へ、小さいΔ角(dlon/dlat)を角度加算で合成＝厳密・全球で有効（線形化＝接平面近似ではない）。
// 頂点3D − 原点3D を「桁落ちなし」で直接作る（絶対 dir を組んで引くと ≈1 同士の相殺で高ズームに揺らぎ）。
// cos(θ)-1 は -2sin²(θ/2) の恒等式で作り、全項に小因子を残す＝dlon/dlat→0 で rel=0 が厳密。
// 原点三角比 u_origin_trig=(cosLon0,sinLon0,cosLat0,sinLat0)。原点3D=(cLat cLon, sLat, cLat sLon)。
// dlat は dBeta で β差分へ（球では恒等）＝以降は純粋な球面幾何（β単位球）。
vec3 deltaToRel(float dlon_deg, float dlat_deg) {
	float da = dlon_deg * D2R, db = dBeta(dlat_deg * D2R);
	float sda = sinP(da), sdb = sinP(db);
	float sha = sinP(da * 0.5), shb = sinP(db * 0.5);
	float cdaM1 = -2.0 * sha * sha, cdbM1 = -2.0 * shb * shb;   // cos(da)-1, cos(db)-1（相殺なし）
	float cda = 1.0 + cdaM1, cdb = 1.0 + cdbM1;
	float ccM1 = cdaM1 + cdbM1 + cdaM1 * cdbM1;                 // cos(da)cos(db)-1（相殺なし）
	float cLon = u_origin_trig.x, sLon = u_origin_trig.y, cLat = u_origin_trig.z, sLat = u_origin_trig.w;
	float rx = cLat * cLon * ccM1 - cLat * sLon * cdb * sda - sLat * cLon * sdb * cda + sLat * sLon * sdb * sda;
	float ry = sLat * cdbM1 + cLat * sdb;
	float rz = cLat * sLon * ccM1 + cLat * cLon * cdb * sda - sLat * sLon * sdb * cda - sLat * cLon * sdb * sda;
	return vec3(rx, ry, rz);
}

uint compact16(uint m) {
	m &= 0x55555555u;
	m = (m | (m >> 1u)) & 0x33333333u;
	m = (m | (m >> 2u)) & 0x0F0F0F0Fu;
	m = (m | (m >> 4u)) & 0x00FF00FFu;
	m = (m | (m >> 8u)) & 0x0000FFFFu;
	return m;
}

// 経度 Δ（1e-7°単位, 符号付き最短）。経度は 360e7 周期で、素朴な int(a-b) は 2^32 で
// 折れて ±180° 越えを誤ラップする。max/min で |Δ| を厳密に取り、360e7 で正しく畳む。
// 【畳み込みは uint のまま】旧実装 f = 3.6e9 - float(d) は float 化後の大数引き算＝f32 ulp(3.6e9)=256
// （2.56e-5°≈2.8m）に格子化し、antimeridian 跨ぎの頂点がパンで最大数十px 飛ぶ（f32忠実シミュ実測）。
float dlonE7(uint a, uint b) {
	uint d = max(a, b) - min(a, b);   // |Δ| ∈ [0, 360e7], exact
	float s = (a >= b) ? 1.0 : -1.0;
	if (d > 1800000000u) { d = 3600000000u - d; s = -s; }  // take the short way around (exact in uint)
	return float(d) * s;
}

// gint 整数 → 原点相対 delta (deg)（decode 共通部）。
vec2 decodeDLL(uint idx) {
	ivec2 tc = ivec2(int(idx) % u_arc_w, int(idx) / u_arc_w);
	uvec4 px = texelFetch(u_arc_tex, tc, 0);
	uint lo = px.r, hi = px.g;
	uint lo_c = ((hi >> 31u) != 0u) ? lo : (lo & 0xFFFFFFC0u);
	uint hi_c = hi & 0x7FFFFFFFu;
	uint ix = (compact16(hi_c) << 16u) | compact16(lo_c);
	uint iy = (compact16(hi_c >> 1u) << 16u) | compact16(lo_c >> 1u);
	// 中心(=シーン原点)からの delta を整数空間で計算（精度確保・antimeridian 対応）。
	return vec2(dlonE7(ix, u_ix_center) * 1e-7, float(int(iy - u_iy_center)) * 1e-7);
}
// gint 整数 → 原点相対 rel（fetchProject / fetchClip が共用）。
vec3 decodeRel(uint idx) {
	vec2 dLL = decodeDLL(idx);
	return deltaToRel(dLL.x, dLL.y);              // 頂点3D − 原点3D（小・正確）
}

// 【swap 本体】gint 整数 → 単位球 → mat4 → screen px。
vec3 fetchProject(uint idx) {
	vec3 rel = decodeRel(idx);
	float zr = u_origin_zr + dot(rel, u_eye);     // = dot(dir,eye)-1（相殺回避）。>0 手前半球
	vec4 clip = u_clipT + u_mvp * vec4(rel, 0.0); // = mvp*[dir,1]（相殺回避）
	if (clip.w <= 0.0) return vec3(u_viewport * 0.5, -1.0);   // カメラ背後 → 裏扱い
	vec2 ndc = clip.xy / clip.w;
	return vec3((ndc.x * 0.5 + 0.5) * u_viewport.x,
				(1.0 - (ndc.y * 0.5 + 0.5)) * u_viewport.y,
				zr);
}

// 深度統合（段階B）用の投影：標高ドレープ（u_elevScale>0 時）を掛けた screen px＋clip.w を返す。
// ドレープは renderer LINE_MAIN と同式（距離フェード df ＝遠景平ら化に追随・relW=rel+h*dir の相殺なしRTE）
// ＝基図の線と同じ高さに乗る。u_elevScale=0 なら relW=rel が厳密に成立＝fetchProject と同一結果（従来動作）。
vec3 projectDrape(uint idx, out float clipW) {
	vec2 dLL = decodeDLL(idx);
	vec3 rel = deltaToRel(dLL.x, dLL.y);
	float zr = u_origin_zr + dot(rel, u_eye);     // 半球判定は非ドレープ（粗くて可）
	vec3 relW = rel;
	if (u_elevScale > 0.0 && u_hasElev > 0.5) {
		vec3 dir = u_origin_pt + rel;             // 絶対単位球点（elev/df 用＝粗くて可）
		float df = 1.0 - smoothstep(u_fogFar * 0.8, u_fogFar * 2.0, distance(u_eye, dir));
		vec2 ll = u_origin + dLL;
		float h = elevQAt(ll) * u_elevScale * df;   // 案A
		if (u_ell > 0.5) {                        // 楕円体＝測地法線で変位（renderer liftDir と同式＝基図の線と同じ高さ）
			float p = ll.y * D2R, l = ll.x * D2R, cp = cos(p);
			dir = vec3(cp * cos(l), sin(p) * ELL_INV_R, cp * sin(l));
		}
		relW = rel + h * dir;                     // (dir*(1+h)) − 原点3D を相殺なしで
	}
	vec4 clip = u_clipT + u_mvp * vec4(relW, 0.0);
	clipW = clip.w;
	if (clip.w <= 0.0) return vec3(u_viewport * 0.5, -1.0);   // カメラ背後 → 裏扱い
	vec2 ndc = clip.xy / clip.w;
	return vec3((ndc.x * 0.5 + 0.5) * u_viewport.x,
				(1.0 - (ndc.y * 0.5 + 0.5)) * u_viewport.y,
				zr);
}

// per-feature bbox テクスチャ（fid→bbox e7整数・RGBA32UI・unit2）。
// pivotClip＝stencil 塗りの扇要（bbox中心）：巻き数は閉リングなら要の位置に依存しない＝正確さ不変。
//   旧・クリップ原点（画面中心）要は全三角形が「画面中心→辺」＝TBDR(Apple GPU) のパラメータバッファが
//   辺数×画面級で爆発した（fill 表示瞬間にGB級）。u_has_pivot=0（線のみ/疎fid）は従来のクリップ原点。
// bboxVisible＝feature 単位の GPU bbox カリング：チャンク粒度（広域ポリゴン＝国立公園級で無力）より
//   細かく、VS 冒頭で視野bbox との交差判定＝視野外 feature を頂点ごと捨てる（walk/raster 前の早期棄却）。
uniform usampler2D u_pivot_tex;
uniform int        u_pivot_w;
uniform int        u_has_pivot;
uniform uvec4      u_view_bbox;   // 視野 bbox（e7整数・保守的＝地平キャップ fallback 込み）
uniform int        u_use_vbb;     // 1＝bboxカリング有効（bboxテクスチャと視野bboxが両方ある時だけ）
uvec4 fetchFidBbox(uint fid) {
	return texelFetch(u_pivot_tex, ivec2(int(fid) % u_pivot_w, int(fid) / u_pivot_w), 0);
}
bool bboxVisible(uint fid) {
	if (u_use_vbb == 0) return true;
	uvec4 bb = fetchFidBbox(fid);
	return !(bb.z < u_view_bbox.x || bb.x > u_view_bbox.z || bb.w < u_view_bbox.y || bb.y > u_view_bbox.w);
}
vec4 pivotClip(uint fid) {
	if (u_has_pivot == 0) return vec4(0.0, 0.0, 0.0, 1.0);
	uvec4 bb = fetchFidBbox(fid);
	uint cx = bb.x + (bb.z - bb.x) / 2u, cy = bb.y + (bb.w - bb.y) / 2u;   // 中点（和は u32 を溢れる＝差分で）
	float dlon = dlonE7(cx, u_ix_center) * 1e-7;
	float dlat = float(int(cy - u_iy_center)) * 1e-7;
	return u_clipT + u_mvp * vec4(deltaToRel(dlon, dlat), 0.0);
}

// stencil 用：クリップ座標のまま返す＝カメラ後方(w<=0)の頂点も動かさずハードウェアクリップに任せる。
// スクリーン化(fetchProject)は後方頂点を画面中央へ潰す＝ファン三角形が歪み winding が壊れ、
// チルトで図形の一部が視野外に出ると塗りが「中央へ向かう楔」でフラッドする（実写バグ）。
// クリップ空間の三角形はクリッピング後も可視画素の巻き数が厳密に保たれる＝部分表示でも正しい塗り。
vec4 fetchClip(uint idx) {
	return u_clipT + u_mvp * vec4(decodeRel(idx), 0.0);
}

// 塗り扇(stencil/idfill)を地形にドレープ＝projectDrape と同じ標高変位のクリップ座標版（WebGPU fetchClipDrape と対・
// 2026-08-14 GL 移植）。u_elevScale=0(真俯瞰)なら fetchClip と同一＝既存挙動を壊さない。汚い土砂ポリゴン
//（自己交差/重なり）も winding で斜面に貼る。扇の pivot は非ドレープでよい（winding は screen で pivot 不変）。
vec4 fetchClipDrape(uint idx) {
	vec2 dLL = decodeDLL(idx);
	vec3 rel = deltaToRel(dLL.x, dLL.y);
	vec3 relW = rel;
	if (u_elevScale > 0.0 && u_hasElev > 0.5) {
		vec3 dir = u_origin_pt + rel;
		float df = 1.0 - smoothstep(u_fogFar * 0.8, u_fogFar * 2.0, distance(u_eye, dir));
		vec2 ll = u_origin + dLL;
		float h = elevQAt(ll) * u_elevScale * df;   // 案A
		if (u_ell > 0.5) { float p = ll.y * D2R, l = ll.x * D2R, cp = cos(p); dir = vec3(cp * cos(l), sin(p) * ELL_INV_R, cp * sin(l)); }
		relW = rel + h * dir;
	}
	return u_clipT + u_mvp * vec4(relW, 0.0);
}

vec4 toNDC(vec2 p) {
	return vec4(2.0 * p.x / u_viewport.x - 1.0,
				1.0 - 2.0 * p.y / u_viewport.y,
				0.0, 1.0);
}

uvec4 fetchEdgeMeta(int edge_id) {
	ivec2 mtc = ivec2(edge_id % u_meta_w, edge_id / u_meta_w);
	return texelFetch(u_meta_tex, mtc, 0);
}
// 頂点の VW rank（LOD 重要度 0-63）。terminal(L1 anchor)=63 常時保持、L2=低6bit（rust WEIGHT_MASK=0x3F）。
uint fetchRank(uint idx) {
	uvec4 px = texelFetch(u_arc_tex, ivec2(int(idx) % u_arc_w, int(idx) / u_arc_w), 0);
	return ((px.g >> 31u) != 0u) ? 63u : (px.r & 0x3Fu);
}

// GPU Dynamic LOD（gap無し・全描画パス共通）：始点 A が閾値未満の辺は捨てる（直前の kept 辺が跨いで描く）。
// 終点 B は「次に閾値を満たす頂点」まで前方スナップ＝間引き頂点を飛ばして kept 同士を直結。
// B のスナップはメタ隣接エントリを辿る：同一 arc 内は meta[e+1].A == meta[e].B（全密度でも
// long-jump tier でも成立）＝1 hop で次の kept 頂点へ（reversed arc も meta が向きを吸収済み）。
// 旧実装（arc 密頂点±1 の線形歩行）は rank とメタ密度の差ぶん texelFetch を浪費（ortho-map ZCTA実測: 1辺≈50fetch）。
// arc 終端は B が anchor(rank63)＝rank 判定で必ず停止。隣接が別 arc なら m.r != lodB で停止。
// 戻り値: true=辺を描く（lodB はスナップ済み）/ false=discard。
bool lodSnap(inout uint lodA, inout uint lodB, int edge_id) {
	if (float(fetchRank(lodA)) < u_lod_rank) return false;
	for (int k = 1; k < 4096; k++) {
		if (float(fetchRank(lodB)) >= u_lod_rank) break;
		uvec4 m = fetchEdgeMeta(edge_id + k);
		if (m.r != lodB) break;
		lodB = m.g;
	}
	return true;
}
`;

// 点用の投影ヘッダ（u_pt_tex から decode。fetchProject と同じ mat4 swap）。
const GLSL_PT_HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D u_pt_tex;
uniform usampler2D u_pt_meta_tex;
uniform int        u_pt_w;
uniform mat4       u_mvp;
uniform vec3       u_eye;
uniform vec2       u_origin;
uniform vec4       u_origin_trig; // 原点の三角比 (cosLon,sinLon,cosLat,sinLat)＝RTE角度加算の錨
uniform vec2       u_viewport;
uniform float      u_pt_radius;
uniform uint       u_ix_center;
uniform uint       u_iy_center;
uniform vec4       u_clipT;      // mvp*[原点3D,1]＝CPU(double)算出＝MVP相殺回避の錨
uniform float      u_origin_zr;  // dot(原点3D,eye)-1＝CPU(double)算出＝zr相殺回避の錨
const float D2R = 0.017453292519943295;

vec3 lonlatTo3D(vec2 ll) {
	float a = ll.x * D2R, b = ll.y * D2R, cb = cos(b);
	return vec3(cb * cos(a), sin(b), cb * sin(a));
}
// 微小角 sin（arc 側と同一＝GPU sin の実装誤差/ゼロフラッシュ回避）。
float sinP(float x) {
	float x2 = x * x;
	return (abs(x) < 0.1) ? x * (1.0 - x2 * (1.0 / 6.0) * (1.0 - x2 * (1.0 / 20.0))) : sin(x);
}
float cosP(float x) { float s = sinP(0.5 * x); return 1.0 - 2.0 * s * s; }
// 楕円体 dβ（arc 側と同一・球=u_ell=0 で早期return＝三角関数を払わない）
uniform vec4 u_ell_trig;
uniform float u_ell;
float dBeta(float dp) {
	if (u_ell < 0.5) return dp;
	float sd = sinP(dp), cd = cosP(dp), s2d = sinP(2.0 * dp), c2d = cosP(2.0 * dp);
	return dp - 2.0 * 0.0016792203863837047    * (u_ell_trig.x * cd  - u_ell_trig.y * sd)  * sd
	          + 2.0 * 0.0000014098905530233192 * (u_ell_trig.z * c2d - u_ell_trig.w * s2d) * s2d;
}
// 原点相対 RTE（arc 側 deltaToRel と同一）：頂点3D−原点3D を桁落ちなしで直接作る（cos-1=-2sin²(θ/2)）。
vec3 deltaToRel(float dlon_deg, float dlat_deg) {
	float da = dlon_deg * D2R, db = dBeta(dlat_deg * D2R);
	float sda = sinP(da), sdb = sinP(db);
	float sha = sinP(da * 0.5), shb = sinP(db * 0.5);
	float cdaM1 = -2.0 * sha * sha, cdbM1 = -2.0 * shb * shb;
	float cda = 1.0 + cdaM1, cdb = 1.0 + cdbM1;
	float ccM1 = cdaM1 + cdbM1 + cdaM1 * cdbM1;
	float cLon = u_origin_trig.x, sLon = u_origin_trig.y, cLat = u_origin_trig.z, sLat = u_origin_trig.w;
	float rx = cLat * cLon * ccM1 - cLat * sLon * cdb * sda - sLat * cLon * sdb * cda + sLat * sLon * sdb * sda;
	float ry = sLat * cdbM1 + cLat * sdb;
	float rz = cLat * sLon * ccM1 + cLat * cLon * cdb * sda - sLat * sLon * sdb * cda - sLat * cLon * sdb * sda;
	return vec3(rx, ry, rz);
}
uint compact16(uint m) {
	m &= 0x55555555u; m = (m | (m >> 1u)) & 0x33333333u; m = (m | (m >> 2u)) & 0x0F0F0F0Fu;
	m = (m | (m >> 4u)) & 0x00FF00FFu; m = (m | (m >> 8u)) & 0x0000FFFFu; return m;
}
float dlonE7(uint a, uint b) {
	uint d = max(a, b) - min(a, b); float s = (a >= b) ? 1.0 : -1.0;
	if (d > 1800000000u) { d = 3600000000u - d; s = -s; }   // uint で畳む＝exact（arc 側と同修正）
	return float(d) * s;
}
// pt_id → screen px（zr>0 手前）。
vec3 fetchPoint(int pt_id) {
	ivec2 tc = ivec2(pt_id % u_pt_w, pt_id / u_pt_w);
	uvec4 px = texelFetch(u_pt_tex, tc, 0);
	uint hi_c = px.g & 0x7FFFFFFFu;
	uint ix = (compact16(hi_c)       << 16u) | compact16(px.r);
	uint iy = (compact16(hi_c >> 1u) << 16u) | compact16(px.r >> 1u);
	float dlon = dlonE7(ix, u_ix_center) * 1e-7;
	float dlat = float(int(iy - u_iy_center)) * 1e-7;
	vec3 rel = deltaToRel(dlon, dlat);            // 頂点3D − 原点3D（小・正確）
	float zr = u_origin_zr + dot(rel, u_eye);     // = dot(dir,eye)-1（相殺回避）
	vec4 clip = u_clipT + u_mvp * vec4(rel, 0.0); // = mvp*[dir,1]（相殺回避）
	if (clip.w <= 0.0) return vec3(u_viewport * 0.5, -1.0);
	vec2 ndc = clip.xy / clip.w;
	return vec3((ndc.x * 0.5 + 0.5) * u_viewport.x, (1.0 - (ndc.y * 0.5 + 0.5)) * u_viewport.y, zr);
}
`;

// sub=0 → NDC原点(fan pivot); sub=1 → 頂点A; sub=2 → 頂点B。
// 頂点は fetchClip＝クリップ座標のまま出す（チルトでカメラ後方に回った頂点の中央潰れ→塗りフラッドの根治）。
// 14条地図(市街地)は手前半球のみ＝v1 の horizon-circle push は不要（低ズームの背面対応は低ズーム精緻化で）。
const VS_STENCIL = `${GLSL_VS_HEADER}
void main() {
	int edge_id = gl_VertexID / 3;
	int sub     = gl_VertexID % 3;
	uvec4 meta = fetchEdgeMeta(edge_id);
	if (!bboxVisible(meta.a)) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }   // 視野外 feature＝丸ごと棄却
	uint lodA = meta.r, lodB = meta.g;
	if (!lodSnap(lodA, lodB, edge_id)) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
	if (sub == 0) { gl_Position = pivotClip(meta.a); return; }   // 扇要＝feature局所（TBDRパラメータバッファ対策）
	gl_Position = fetchClipDrape(sub == 1 ? lodA : lodB);   // 塗り扇の辺端点を地形へドレープ（真俯瞰=無変化・WebGPU vsStencil と対）
}`;

// Mask stencil：アクティブ地物のリングだけ stencil を切り抜く。
const VS_STENCIL_MASK = `${GLSL_VS_HEADER}
flat out int v_feat_id;
void main() {
	int edge_id = gl_VertexID / 3;
	int sub     = gl_VertexID % 3;
	uvec4 meta = fetchEdgeMeta(edge_id);
	v_feat_id  = int(meta.a);
	if (sub == 0) { gl_Position = pivotClip(meta.a); return; }   // 扇要＝feature局所（VS_STENCIL と同じ）
	gl_Position = fetchClip(sub == 1 ? meta.r : meta.g);   // クリップ座標のまま（VS_STENCIL と同じ根治）
}`;

const FS_STENCIL_MASK = `#version 300 es
precision mediump float;
uniform int  u_active_id;
flat in  int v_feat_id;
out vec4 fragColor;
void main() {
	if (v_feat_id != u_active_id) discard;
	fragColor = vec4(0.0);
}`;

// 6 verts/edge: (A-)(A+)(B+)(A-)(B+)(B-)。u_pass=0: 非アクティブ, u_pass=1: アクティブのみ(最後に描き z-fight 解消)。
// per-fid スタイル（paint 時のみ・u_has_fidstyle=1）：fid表(unit5)から visibility/line色/width を上書き。
// width はスタイル正味（u8×1/8px）＋u_width_add（パス都合の増分＝highlight+2 等。表に混ぜない＝spec §7.1）。
const VS_RENDER = `${GLSL_VS_HEADER}
uniform float u_line_width;
uniform float u_dpr;
uniform int   u_active_id;
uniform int   u_pass;
uniform vec4  u_style_table[256];
uniform vec4  u_hilite_color;   // ホバー(pass1)の線色。a>0で有効・0で素の線色を不透明に
uniform float u_hilite_width;   // ホバー(pass1)の指定全幅(device px)。0=未指定＝u_line_width のまま（per-fid/コロプレスに左右されず overlay 町丁目線と一致させる）
uniform vec2  u_dash_table[256];   // [dash_len, gap_len] in px; gap=0 → solid
uniform usampler2D u_fid_style;    // fid スタイル表（RGBA32UI・unit5。idfill と同一レイアウト）
uniform int        u_fidstyle_w;
uniform int        u_has_fidstyle;
uniform float      u_width_add;    // パス増分（clean=0 / highlight=+2）
out vec4  v_color;
out float v_zr;
out float v_dist;
out float v_perp;
flat out float v_halfw;
flat out vec2  v_dash;
flat out float v_dist_base;
out vec2       v_frag;   // 頂点の実スクリーン位置（device px）＝カプセルSDF用
flat out vec2  v_ea;     // 線分端A（device px）
flat out vec2  v_eb;     // 線分端B（clip済, device px）

void main() {
	int edge_id = gl_VertexID / 6;
	int sub     = gl_VertexID % 6;
	uvec4 meta  = fetchEdgeMeta(edge_id);
	int feat_id = int(meta.a);

	// feature bbox カリング（ポリゴン辺のみ＝styleId 0。折れ線 fid は bbox テクスチャに無い）
	if ((meta.b & 255u) == 0u && !bboxVisible(meta.a)) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
	uint lodA = meta.r, lodB = meta.g;
	if (!lodSnap(lodA, lodB, edge_id)) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }

	if (u_pass == 0 && feat_id == u_active_id) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
	if (u_pass == 1 && feat_id != u_active_id) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }

	// per-fid スタイル（paint 時のみ）。visibility=filter の実体（線にも効く）・width=0=線を描かない（§7.1）。
	float lw = u_line_width;
	vec4  fidColor = vec4(0.0);
	if (u_has_fidstyle == 1) {
		uvec4 rec = texelFetch(u_fid_style, ivec2(int(meta.a) % u_fidstyle_w, int(meta.a) / u_fidstyle_w), 0);
		if ((rec.b & 1u) == 0u) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
		uint w8 = (rec.b >> 24u) & 255u;
		if (w8 == 0u) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
		lw = float(w8) * 0.125 + u_width_add;
		uint lc = rec.g;
		if ((lc & 255u) != 0u)
			fidColor = vec4(float(lc >> 24u), float((lc >> 16u) & 255u), float((lc >> 8u) & 255u), float(lc & 255u)) / 255.0;
	}
	if (u_pass == 1 && u_hilite_width > 0.0) lw = u_hilite_width;   // ホバー＝指定全幅を最優先（per-fid幅にもコロプレスにも左右されず overlay 町丁目線と一致）

	// クアッドは「辺の正準方向（lodA→lodB）」で tang/perp を共有する。
	// 旧実装は各頂点が「自端→相手端」で dir を取っていた＝A側とB側で perp が反転し、
	// クアッドがボウタイ（ねじれリボン）化：細線ではAAに紛れ、太線（per-fid @width）で
	// 「片側欠け＋交差部だけ二重描画の濃い芯」として露呈（geoedit 8/20・本人「ねじれ」報告の根治）。
	bool  useA = (sub == 0 || sub == 1 || sub == 3);
	float side = (sub == 1 || sub == 2 || sub == 4) ? 1.0 : -1.0;

	float wA, wB;                        // 端点の clip.w（対数深度用。深度オフ時は未使用）
	vec3 pa3 = projectDrape(lodA, wA);   // ドレープ込み投影（u_elevScale=0 なら fetchProject と同一）
	vec3 pb3 = projectDrape(lodB, wB);
	v_zr = useA ? pa3.z : pb3.z;
	// 相手端が視点の裏へ回る場合の端点クリップ（旧＝自端基準の片側のみ→両対称へ）
	vec2 axy = pa3.xy, bxy = pb3.xy;
	if (pb3.z < 0.0 && pa3.z > 0.0) bxy = pa3.xy + (pa3.z / (pa3.z - pb3.z)) * (pb3.xy - pa3.xy);
	if (pa3.z < 0.0 && pb3.z > 0.0) axy = pb3.xy + (pb3.z / (pb3.z - pa3.z)) * (pa3.xy - pb3.xy);

	// 対数深度（renderer applyLogDepth/LINE_MAIN の zc と同式・同係数）＝地形/基図線と同じ深度空間。
	// u_logCoef=0（深度オフ）は z=0＝従来動作（深度テストも off なので値は無関係だが分岐で保証）。
	float wS = useA ? wA : wB;
	float zc = (u_logCoef > 0.0) ? (log2(max(1.0 + wS, 1e-6)) * u_logCoef - 1.0) : 0.0;

	vec2 dir = bxy - axy;
	float len = length(dir);
	if (len < 1e-4) { vec4 nd0 = toNDC(axy); gl_Position = vec4(nd0.xy, zc, 1.0); return; }
	vec2 tang = dir / len;
	vec2 perp = vec2(-tang.y, tang.x);
	float halfCss = lw * 0.5 + 1.0 / u_dpr;
	vec2 qpos = (useA ? axy : bxy) + side * halfCss * perp + (useA ? -halfCss : halfCss) * tang;   // AA余白込み・端は FS のカプセルSDFが丸める
	vec4 nd = toNDC(qpos);
	gl_Position = vec4(nd.xy, zc, 1.0);
	v_frag = qpos; v_ea = axy; v_eb = bxy;

	int style_idx = int(meta.b & 0xFFu);
	vec4 baseC = (fidColor.a > 0.0 ? fidColor : u_style_table[style_idx]);   // fid線色（paint）＞style_table（既定）
	v_color = (u_pass == 1) ? (u_hilite_color.a > 0.0 ? u_hilite_color : vec4(1.0, 0.9, 0.0, 1.0)) : baseC;   // ホバー(pass1)＝hiliteColor指定色（census=青）／未指定は黄（凍結デモの既定ハイライトを維持）
	v_dash      = u_dash_table[style_idx];
	v_dist_base = float(meta.b >> 8u) * 0.017453292;   // 累積px距離の基底（scale 非依存の相対）
	v_dist = useA ? 0.0 : len;
	v_perp  = side * halfCss * u_dpr;
	v_halfw = lw * 0.5 * u_dpr;
}`;

const FS_RENDER = `#version 300 es
precision mediump float;
uniform float u_hidden;   // 1＝隠線パス（深度不合格側＝depthFunc GREATER で再描画）：淡く＋固定破線（CAD流）。既定0＝通常
uniform highp vec3 u_eye; // 視点位置＝地平線フェード窓のスケール。VS(highp)と同一プログラム＝precision一致必須（mediumpだとリンク失敗＝gint全消え）
in  vec4  v_color;
in  float v_zr;
in  float v_dist;
in  float v_perp;
flat in float v_halfw;
flat in vec2  v_dash;
flat in float v_dist_base;
in  vec2  v_frag;
flat in vec2  v_ea;
flat in vec2  v_eb;
out vec4  fragColor;
void main() {
	if (v_zr < -0.05)     discard;
	if (v_color.a == 0.0) discard;
	// 地平線フェード窓＝カメラ高さ(length(u_eye)-1)に比例（上限0.02＝低ズームは従来どおりの柔らかさ）。
	// 旧・固定窓(-0.01..0.02)は、高ズームでは zr の最大値(=カメラ距離-1≈1e-3級)ごと窓の内側＝
	// 画面全体の gint 線が常時半透明(α≈0.35)だった（geoedit の太線で発覚 8/20。海岸線は z<7 専用で無傷だった理由）
	float win = clamp((length(u_eye) - 1.0) * 0.5, 2e-4, 0.02);
	float alpha = v_color.a * smoothstep(-win * 0.5, win, v_zr);
	if (u_hidden > 0.5) {
		// 隠線（尾根の向こう）＝淡い固定破線：消し去らず「向こう側に在る」ことだけ静かに残す（CAD の隠線表現）。
		float t = mod(v_dist_base + v_dist, 10.0);
		float aa0 = max(fwidth(v_dist), 0.001);
		alpha *= (1.0 - smoothstep(6.0 - aa0, 6.0 + aa0, t)) * 0.35;
	}
	if (v_dash.y > 0.0) {
		float d      = v_dist_base + v_dist;
		float period = v_dash.x + v_dash.y;
		float t      = mod(d, period);
		float aa     = max(fwidth(v_dist), 0.001);
		alpha *= 1.0 - smoothstep(v_dash.x - aa, v_dash.x + aa, t);
	}
	// カプセルSDF：線分[v_ea,v_eb]への距離で塗る＝両端が半円(丸キャップ)。
	// 鋭角の繋ぎ目でも隣接線分の丸端が重なり、四角キャップのトゲ(イガイガ)が出ない。
	vec2 pa = v_frag - v_ea, ba = v_eb - v_ea;
	float t2 = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
	float dcap = length(pa - ba * t2);
	float aaW = max(fwidth(dcap), 1e-3);
	alpha *= clamp((v_halfw - dcap) / aaW + 0.5, 0.0, 1.0);
	if (alpha < 0.004) discard;
	fragColor = vec4(v_color.rgb, alpha);
}`;

// GPU picking：fid+1 を RGB 24bit に。(0,0,0)=地物なし。
const VS_PICK_LINE = `${GLSL_VS_HEADER}
uniform float u_line_width;
uniform usampler2D u_fid_style;    // fid スタイル表（visibility＝filter を pick にも効かせる）
uniform int        u_fidstyle_w;
uniform int        u_has_fidstyle;
out vec4  v_color;
out float v_zr;

void main() {
	int edge_id = gl_VertexID / 6;
	int sub     = gl_VertexID % 6;
	uvec4 meta  = fetchEdgeMeta(edge_id);

	// style 0 = polygon edge（JS レイキャストで識別）→ここでは捨てる。1 = polyline。
	if ((meta.b & 255u) == 0u) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
	// filter で非表示の feature は pick からも外す（見えない線に当たらない）
	if (u_has_fidstyle == 1 &&
		(texelFetch(u_fid_style, ivec2(int(meta.a) % u_fidstyle_w, int(meta.a) / u_fidstyle_w), 0).b & 1u) == 0u)
		{ gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }

	// pick も描画と同じ kept 集合＝当たり判定が「見えている線」と一致（12px マージンが吸収する範囲の差だが、
	// settle 毎の VS 起動と walk を描画パスと同じだけ削る＝軽さの均質化）。
	uint lodA = meta.r, lodB = meta.g;
	if (!lodSnap(lodA, lodB, edge_id)) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }

	bool  useA = (sub == 0 || sub == 1 || sub == 3);
	float side = (sub == 1 || sub == 2 || sub == 4) ? 1.0 : -1.0;

	// 描画VSと同じ「辺の正準方向」でクアッドを張る（旧＝自端基準で perp が反転＝ボウタイ。同時修正 8/20）
	vec3 pa3 = fetchProject(lodA);
	vec3 pb3 = fetchProject(lodB);
	v_zr = useA ? pa3.z : pb3.z;
	vec2 axy = pa3.xy, bxy = pb3.xy;
	if (pb3.z < 0.0 && pa3.z > 0.0) bxy = pa3.xy + (pa3.z / (pa3.z - pb3.z)) * (pb3.xy - pa3.xy);
	if (pa3.z < 0.0 && pb3.z > 0.0) axy = pb3.xy + (pb3.z / (pb3.z - pa3.z)) * (pa3.xy - pb3.xy);

	vec2 dir = bxy - axy;
	float len = length(dir);
	if (len < 1e-4) { gl_Position = toNDC(axy); return; }
	vec2 tang = dir / len;
	vec2 perp = vec2(-tang.y, tang.x);
	gl_Position = toNDC((useA ? axy : bxy) + side * (u_line_width * 0.5) * perp
	                          + (useA ? -1.0 : 1.0) * tang * (u_line_width * 0.5));

	uint fid1 = meta.a + 1u;
	v_color = vec4(float(fid1 & 255u)/255.0, float((fid1>>8u)&255u)/255.0, float((fid1>>16u)&255u)/255.0, 1.0);
}`;

const FS_PICK = `#version 300 es
precision mediump float;
in  vec4  v_color;
in  float v_zr;
out vec4  fragColor;
void main() {
	if (v_zr < 0.0) discard;
	fragColor = v_color;
}`;

// 点 picking：fid 色の円 quad。
const VS_PICK_POINT = `${GLSL_PT_HEADER}
out float v_zr;
out vec2  v_uv;
out vec4  v_color;
void main() {
	int pt_id = gl_VertexID / 6;
	int sub   = gl_VertexID % 6;
	float ox = (sub == 2 || sub == 4 || sub == 5) ? 1.0 : -1.0;
	float oy = (sub == 1 || sub == 2 || sub == 4) ? 1.0 : -1.0;
	vec3 p = fetchPoint(pt_id);
	v_zr = p.z;
	v_uv = vec2(ox, oy);
	gl_Position = vec4(2.0*(p.x + ox*u_pt_radius)/u_viewport.x - 1.0,
					   1.0 - 2.0*(p.y + oy*u_pt_radius)/u_viewport.y, 0.0, 1.0);
	ivec2 tc = ivec2(pt_id % u_pt_w, pt_id / u_pt_w);
	uint fid1 = texelFetch(u_pt_meta_tex, tc, 0).r + 1u;
	v_color = vec4(float(fid1 & 255u)/255.0, float((fid1>>8u)&255u)/255.0, float((fid1>>16u)&255u)/255.0, 1.0);
}`;

const FS_PICK_POINT = `#version 300 es
precision mediump float;
in  float v_zr;
in  vec2  v_uv;
in  vec4  v_color;
out vec4  fragColor;
void main() {
	if (v_zr < 0.0)            discard;
	if (dot(v_uv, v_uv) > 1.0) discard;
	fragColor = v_color;
}`;

// 6 verts/point: 投影点を中心にした quad。
const VS_POINT = `${GLSL_PT_HEADER}
uniform int u_active_id;
out float v_zr;
out vec2  v_uv;
out vec4  v_color;
void main() {
	int pt_id = gl_VertexID / 6;
	int sub   = gl_VertexID % 6;
	float ox = (sub == 2 || sub == 4 || sub == 5) ? 1.0 : -1.0;
	float oy = (sub == 1 || sub == 2 || sub == 4) ? 1.0 : -1.0;
	vec3 p = fetchPoint(pt_id);
	v_zr = p.z;
	v_uv = vec2(ox, oy);
	ivec2 tc = ivec2(pt_id % u_pt_w, pt_id / u_pt_w);
	int feat_id = int(texelFetch(u_pt_meta_tex, tc, 0).r);
	bool isActive = (feat_id == u_active_id);
	float r = isActive ? u_pt_radius * 1.6 : u_pt_radius;
	gl_Position = vec4(2.0*(p.x + ox*r)/u_viewport.x - 1.0,
					   1.0 - 2.0*(p.y + oy*r)/u_viewport.y, 0.0, 1.0);
	v_color = isActive ? vec4(1.0, 0.9, 0.0, 1.0) : vec4(1.0, 0.420, 0.208, 1.0);
}`;

const FS_POINT = `#version 300 es
precision mediump float;
in  float v_zr;
in  vec2  v_uv;
in  vec4  v_color;
out vec4  fragColor;
void main() {
	if (v_zr < 0.0)            discard;
	if (dot(v_uv, v_uv) > 1.0) discard;
	fragColor = v_color;
}`;

const FS_STENCIL = `#version 300 es
precision mediump float;
out vec4 fragColor;
void main() { fragColor = vec4(0.0); }`;

const VS_FILL = `#version 300 es
void main() {
	vec2[4] p = vec2[4](vec2(-1,-1), vec2(1,-1), vec2(-1,1), vec2(1,1));
	gl_Position = vec4(p[gl_VertexID], 0.0, 1.0);
}`;

const FS_FILL = `#version 300 es
precision mediump float;
uniform vec4 u_fill_color;
out vec4 fragColor;
void main() { fragColor = u_fill_color; }`;

// 共有 uniform（v1 の rotate/scale/rsincos/jac を廃し、mat4/eye/origin へ）。
const SHARED_UNIFORM_NAMES = [
	'u_arc_tex','u_meta_tex','u_arc_w','u_meta_w',
	'u_mvp','u_eye','u_origin','u_origin_trig','u_clipT','u_origin_zr','u_viewport',
	'u_ix_center','u_iy_center','u_lod_rank',
	'u_ell_trig','u_ell',   // 楕円体 dβ 錨＋変位方向ゲート（球=全0=GL既定値＝従来動作）
];
// 深度統合（段階B）uniform 名（bindDepthUniforms が set。未設定なら全0=従来動作）。
// 線(uRender)に加え、塗り扇(uStencil)・idfill蓄積(uId)もドレープ（fetchClipDrape）で参照する（2026-08-14）。
export const DEPTH_UNIFORM_NAMES = [
	'u_logCoef', 'u_fogFar', 'u_origin_pt', 'u_elevTex', 'u_elevBounds', 'u_elevScale', 'u_hasElev', 'u_elevEdgeFade', 'u_meshQ', 'u_meshG', 'u_hidden',
];
const PT_UNIFORM_NAMES = [
	'u_pt_tex','u_pt_meta_tex','u_pt_w',
	'u_mvp','u_eye','u_origin','u_origin_trig','u_clipT','u_origin_zr','u_viewport','u_pt_radius',
	'u_ix_center','u_iy_center','u_ell_trig','u_ell',
];

export function createGintPrograms(gl) {
	const renderProgram      = linkProgram(gl, VS_RENDER,        FS_RENDER);
	const stencilProgram     = linkProgram(gl, VS_STENCIL,       FS_STENCIL);
	const fillProgram        = linkProgram(gl, VS_FILL,          FS_FILL);
	const maskStencilProgram = linkProgram(gl, VS_STENCIL_MASK,  FS_STENCIL_MASK);
	const pointProgram       = linkProgram(gl, VS_POINT,         FS_POINT);
	const pickLineProgram    = linkProgram(gl, VS_PICK_LINE,     FS_PICK);
	const pickPointProgram   = linkProgram(gl, VS_PICK_POINT,    FS_PICK_POINT);

	const uRender      = getUniforms(gl, renderProgram,      [...SHARED_UNIFORM_NAMES, 'u_line_width', 'u_dpr', 'u_active_id', 'u_pass', 'u_style_table', 'u_dash_table', 'u_hilite_color', 'u_hilite_width',
		...DEPTH_UNIFORM_NAMES,   // 深度統合（段階B）用＝未設定なら全0=従来動作
		'u_pivot_tex', 'u_pivot_w', 'u_has_pivot', 'u_view_bbox', 'u_use_vbb',   // feature bbox カリング
		'u_fid_style', 'u_fidstyle_w', 'u_has_fidstyle', 'u_width_add']);        // per-fid スタイル（paint）
	const uStencil     = getUniforms(gl, stencilProgram,     [...SHARED_UNIFORM_NAMES, ...DEPTH_UNIFORM_NAMES, 'u_pivot_tex', 'u_pivot_w', 'u_has_pivot', 'u_view_bbox', 'u_use_vbb']);   // 深度＝fetchClipDrape（面ドレープ）
	const uFill        = getUniforms(gl, fillProgram,        ['u_fill_color']);
	const uMaskStencil = getUniforms(gl, maskStencilProgram, [...SHARED_UNIFORM_NAMES, 'u_active_id']);
	const uPoint       = getUniforms(gl, pointProgram,       [...PT_UNIFORM_NAMES, 'u_active_id']);
	const uPickLine    = getUniforms(gl, pickLineProgram,    [...SHARED_UNIFORM_NAMES, 'u_line_width', 'u_fid_style', 'u_fidstyle_w', 'u_has_fidstyle']);
	const uPickPoint   = getUniforms(gl, pickPointProgram,   PT_UNIFORM_NAMES);

	const emptyVAO = gl.createVertexArray();
	gl.enable(gl.BLEND);
	gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

	return { renderProgram, stencilProgram, fillProgram, maskStencilProgram,
			 pointProgram, pickLineProgram, pickPointProgram,
			 uRender, uStencil, uFill, uMaskStencil, uPoint, uPickLine, uPickPoint, emptyVAO };
}

function compileShader(gl, type, src) {
	const s = gl.createShader(type);
	gl.shaderSource(s, src);
	gl.compileShader(s);
	if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
	return s;
}

function linkProgram(gl, vs, fs) {
	const p = gl.createProgram();
	gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vs));
	gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fs));
	gl.linkProgram(p);
	if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
	return p;
}

function getUniforms(gl, prog, names) {
	const u = {};
	for (const n of names) u[n] = gl.getUniformLocation(prog, n);
	return u;
}

// idfill.js（コロプレス ID バッファ塗り）がシェーダ部品を共用する（VS ヘッダ＝投影/RTE/LOD/pivot 一式）。
export { GLSL_VS_HEADER, VS_FILL, SHARED_UNIFORM_NAMES, linkProgram, getUniforms };
