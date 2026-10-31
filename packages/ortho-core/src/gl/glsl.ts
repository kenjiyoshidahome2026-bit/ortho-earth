import { CS_ATMO_GLSL } from "../csatmo.ts";
import { csGlslPrelude, csGlslUser, type CsSpec } from "../csshader.ts";
// 透視カメラ（チルト対応）。経緯度→単位球3D→u_mvp でクリップ座標へ。
// 頂点はシーン原点(u_origin)からの経緯度差分。fill は clip 直行、line/capsule はスクリーン空間で幅付け。

// 標高サンプラ（GEBCO/ALOS, R32F meters）。PROJECT（VS用）と FILL_FS（標高ゲート＝図郭外の陸/海裁定）で
// 同一テキストを共有＝両ステージの uniform 宣言が厳密一致（リンク保証）し、式の乖離も構造的に防ぐ。
const ELEV = /* glsl */`
uniform sampler2D u_elevTex;
uniform vec4 u_elevBounds;   // originLng, originLat, spanLng, spanLat（アトラス被覆）
uniform float u_elevScale;   // (誇張 / 地球半径m) : m → 単位球
uniform float u_hasElev;     // 0/1
uniform float u_elevEdgeFade;   // 窓の縁のフェード幅(deg)。0=無効（R90全球窓）。R10/R01窓の外（標高0）との崖を馴染ませる
// 遠景層（far）＝近窓の外を受け持つ粗い R10 第2アトラス（terrain.js が深ズーム×チルトで常設）。
// 近窓の縁は「0 へ落とす」でなく「遠層の値へ溶かす」＝ズームインで近窓(cap4=4°)が縮んでも
// 遠方の山（富士等）が消えない一般則。遠層なし（u_hasFar=0）は elevFar=0 で従来式
// mix(0, near, fade) = near×fade に厳密一致＝挙動不変。
uniform sampler2D u_farElevTex;
uniform vec4 u_farBounds;
uniform float u_hasFar;
uniform float u_farEdgeFade;
float elevFadeAt(vec2 uv) {
	if (u_elevEdgeFade <= 0.0) return 1.0;
	vec2 w = vec2(u_elevEdgeFade) / u_elevBounds.zw;
	return min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
}
float elevFar(vec2 ll) {
	if (u_hasFar < 0.5) return 0.0;
	ll.x -= 360.0 * floor((ll.x + 180.0) / 360.0);   // 経度を -180..180 へ（原点相対の経度は ±180 を越えうる）
	vec2 uv = (ll - u_farBounds.xy) / u_farBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
	float f = 1.0;
	if (u_farEdgeFade > 0.0) {   // 遠窓自身の縁は従来どおり 0 へフェード（その先は覆いが無い）
		vec2 w = vec2(u_farEdgeFade) / u_farBounds.zw;
		f = min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
	}
	return texture(u_farElevTex, uv).r * f;
}
// 近景層（near）＝目の足元の細密窓（1 セル・2026-10-28）：近窓（R01＝108m/texel）の内側に外来 DEM／R01 生タイルから焼いた
// 1/64°〜1/2° の窓を重ねる。縁は近窓の値へ溶かす（far の一般則の内側版）＝近景層なし（u_hasNear=0）は base をそのまま返す＝挙動不変
// 近景テクスチャは 2 セル幅：左半分＝近景層（near）・右半分＝足元層（fine・2026-10-31）＝画面下端の視線が目から 1.5 km 以内で当たる地面の 1/512°〜1/32° の窓
// （≈1〜7 m/texel）。足元層は近景層の値へ縁で溶かす（near が近窓へ溶けるのと同じ一般則）＝無し（u_hasFine=0）は近景層のまま
uniform sampler2D u_nearElevTex;
uniform vec4 u_nearBounds;
uniform float u_hasNear;
uniform float u_nearEdgeFade;
uniform vec4 u_fineBounds;
uniform float u_hasFine;
uniform float u_fineEdgeFade;
float elevFine(vec2 ll, float base) {
	if (u_hasFine < 0.5) return base;
	vec2 uv = (ll - u_fineBounds.xy) / u_fineBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return base;
	vec2 w = vec2(u_fineEdgeFade) / u_fineBounds.zw;
	float f = min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
	return mix(base, texture(u_nearElevTex, vec2(0.5 + uv.x * 0.5, uv.y)).r, f);
}
float elevNear(vec2 ll, float base) {
	if (u_hasNear < 0.5) return base;
	vec2 uv = (ll - u_nearBounds.xy) / u_nearBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return base;
	vec2 w = vec2(u_nearEdgeFade) / u_nearBounds.zw;
	float f = min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
	return elevFine(ll, mix(base, texture(u_nearElevTex, vec2(uv.x * 0.5, uv.y)).r, f));
}
float elev(vec2 ll) {
	if (u_hasElev < 0.5) return 0.0;
	vec2 uv = (ll - u_elevBounds.xy) / u_elevBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return elevFar(ll);
	return elevNear(ll, mix(elevFar(ll), texture(u_elevTex, uv).r, elevFadeAt(uv)));   // アトラスは南上げ格納＝v直接
}
`;

const PROJECT = /* glsl */`
uniform mat4  u_mvp;
uniform vec3  u_eye;        // カメラ位置（単位球ワールド）
uniform vec2  u_origin;     // シーン原点 lon/lat (deg)
uniform vec2  u_viewport;   // canvas 幅高 (device px)
uniform float u_fogNear;    // フォグ開始距離（カメラからの距離）
uniform float u_fogFar;     // フォグ全開距離
uniform vec3  u_fogColor;   // 霞む先の色（=land基色）
const float D2R = 0.017453292519943295;
float fogOf(vec3 w) { return clamp((distance(u_eye, w) - u_fogNear) / max(u_fogFar - u_fogNear, 1e-6), 0.0, 1.0); }
uniform float u_logCoef;   // 対数深度係数 = 2/log2(far+1)。球(半径1)+局所(建物)の深度精度枯れ(z-fight/マダラ)対策
// 対数深度を頂点側で焼く（Outerra法のVS版）。FSで gl_FragDepth を書くと GPU の early-Z/階層Z棄却が無効になり
// 隠面フラグメントまで全額シェーディングされるため、クリップ座標 z に log2(1+w) を書き込み FS は深度に触れない。
// 三角形内は線形補間＝厳密な対数曲線と微差が出るが、terrain/建物/建物メッシュ とも三角形が小さく実害なし。
// window深度は 0.5*(z/w+1) = log2(1+w)*u_logCoef*0.5 ＝旧FS版と同一式（全パスで一貫＝深度の互換維持）。
// log2(1+w) を桁落ちなしに（w<0.1＝log1p の 7 次級数×1/ln2・FS の log1pS と同じ）：1.0+w を float32 で作ると w が 6e-8（≈0.4 m）刻みに量子化され、
// 目が数 m まで寄った 1 m 級の模型（Cesium Man）は表と裏が同じ深度＝裏の三角形が透けてテクスチャが散った（2026-10-28）
float log2p1(float w) { if (w < 0.1) return (w * (1.0 - w * (0.5 - w * (0.33333334 - w * (0.25 - w * (0.2 - w * (0.16666667 - w * 0.14285715))))))) * 1.4426950; return log2(1.0 + w); }
void applyLogDepth() {
	gl_Position.z = (log2p1(max(gl_Position.w, 1e-30)) * u_logCoef - 1.0) * gl_Position.w;
}

vec3 lonlatTo3D(vec2 ll) {
	float a = ll.x * D2R, b = ll.y * D2R, cb = cos(b);
	return vec3(cb * cos(a), sin(b), cb * sin(a));
}
// ── 原点相対 RTE（MVP相殺回避）─────────────────────────────────────────────
// 絶対点×MVP は高ズームで ≈1 同士の相殺→数px格子化（コード既知の z18+ 問題）。対策＝原点3D の clip 位置を
// CPU(double)で先に固定（u_clipT）し、シェーダは「頂点3D−原点3D」の小ベクトルだけを u_mvp で回して足す。
uniform vec4 u_clipT;      // mvp*[u_originPt,1]（CPU double）＝clip空間の原点（相殺回避の錨）
uniform vec3 u_originPt;   // lonlatTo3D(u_origin)（CPU double）＝標高項 h*dir と絶対復元の錨
uniform vec4 u_originTrig; // (cosLon,sinLon,cosLat,sinLat) of u_origin（CPU double）
// GPU の sin() は微小角で信用できない（GLSL 仕様で精度未規定・SwiftShader は |x|≲1e-7rad をゼロフラッシュ、
// 実GPUも実装依存誤差）。高ズームは Δ角×倍率~1e8px/rad で誤差がそのまま px の這い＝タイル/建物の揺らぎになる。
// 微小角は Taylor（x−x³/6+x⁵/120＝f32 で厳密同等）、大角（|x|>0.1rad）のみ native sin（gint 側 sinP と同一）。
float sinP(float x) {
	float x2 = x * x;
	return (abs(x) < 0.1) ? x * (1.0 - x2 * (1.0 / 6.0) * (1.0 - x2 * (1.0 / 20.0))) : sin(x);
}
float cosP(float x) { float s = sinP(0.5 * x); return 1.0 - 2.0 * s * s; }   // 全域可・微小角も桁落ちなし
// ── 楕円体（?ell=1・段階B 2026-08-11）──────────────────────────────────────
// 世界＝β（更成緯度）単位球 × S=diag(1,b/a,1)。S は CPU が mvp へ畳み込み済み＝シェーダの球面式は不変。
// 頂点が運ぶ dlat（測地緯度の差分）だけ dβ へ変換して deltaToRel に流す。β=φ−ν·sin2φ+(ν²/2)·sin4φ
//（全球で誤差≤2cm）の差分を積形式 sinA−sinB=2cos((A+B)/2)sin((A−B)/2) で＝桁落ちなし・テイラー半径の
// 制約なし（z0 の全球ビューも厳密収束）。球＝u_ellTrig=vec4(0) で補正が厳密に 0（GL の uniform 既定値も 0
// ＝renderer が未設定でも球のまま）。原点の測地緯度三角は CPU double（u_originTrig は β の三角を運ぶ）。
const float ELL_NU  = 0.0016792203863837047;    // ν = f/(2−f)（WGS84）
const float ELL_NU2 = 0.0000014098905530233192; // ν²/2
const float ELL_INV_R = 1.0033640898209764;     // a/b = 1/(1−f)（測地法線の β空間像の y 伸長）
uniform vec4  u_ellTrig;   // (cos2φ0, sin2φ0, cos4φ0, sin4φ0)（CPU double・シーン原点の測地緯度）。球=vec4(0)
uniform float u_ell;       // 1=楕円体（標高方向・β→φ復元のゲート）。球=0
float dBeta(float dp) {    // 測地緯度の差分 dφ(rad) → 更成緯度の差分 dβ(rad)
	if (u_ell < 0.5) return dp;   // 球＝恒等を早期return（uniform分岐＝コヒーレント）。補正の三角関数を毎頂点払わない
	float sd = sinP(dp), cd = cosP(dp), s2d = sinP(2.0 * dp), c2d = cosP(2.0 * dp);
	return dp - 2.0 * ELL_NU  * (u_ellTrig.x * cd  - u_ellTrig.y * sd)  * sd
	          + 2.0 * ELL_NU2 * (u_ellTrig.z * c2d - u_ellTrig.w * s2d) * s2d;
}
// 標高の変位方向：球＝β動径（従来の dir）・楕円体＝測地法線の β空間像 m=(cosφcosλ, sinφ·(a/b), cosφsinλ)
//（S を通すと単位測地法線＝地形/建物が正しく「上」へ立つ。方向のみ＝全角 f32 三角で十分・ll は絶対経緯度）。
vec3 liftDir(vec2 ll, vec3 dir) {
	if (u_ell < 0.5) return dir;
	float p = ll.y * D2R, l = ll.x * D2R, cp = cos(p);
	return vec3(cp * cos(l), sin(p) * ELL_INV_R, cp * sin(l));
}
// β→φ 復元（deg）：レイキャスト系（球上の点→asin=β）から elev() など測地緯度の台帳を引く時に通す。球=恒等。
float geoLat(float betaDeg) {
	float b = betaDeg * D2R;
	return betaDeg + u_ell * degrees(ELL_NU * sin(2.0 * b) + ELL_NU2 * sin(4.0 * b));
}
// 頂点3D−u_originPt を桁落ちなしで直接作る（cos(θ)-1=-2sin²(θ/2) で全項に小因子）。dDeg=原点相対(dlon,dlat)deg。
// dlat は測地緯度の差分＝dBeta で β の差分へ（球では恒等）＝以降は純粋な球面幾何。
vec3 deltaToRel(vec2 dDeg) {
	float da = dDeg.x * D2R, db = dBeta(dDeg.y * D2R);
	float sda = sinP(da), sdb = sinP(db);
	float sha = sinP(da * 0.5), shb = sinP(db * 0.5);
	float cdaM1 = -2.0 * sha * sha, cdbM1 = -2.0 * shb * shb;
	float cda = 1.0 + cdaM1, cdb = 1.0 + cdbM1;
	float ccM1 = cdaM1 + cdbM1 + cdaM1 * cdbM1;
	float cLon = u_originTrig.x, sLon = u_originTrig.y, cLat = u_originTrig.z, sLat = u_originTrig.w;
	float rx = cLat * cLon * ccM1 - cLat * sLon * cdb * sda - sLat * cLon * sdb * cda + sLat * sLon * sdb * sda;
	float ry = sLat * cdbM1 + cLat * sdb;
	float rz = cLat * sLon * ccM1 + cLat * cLon * cdb * sda - sLat * sLon * sdb * cda - sLat * cLon * sdb * sda;
	return vec3(rx, ry, rz);
}
// 標高テクスチャ（範囲内なら高さ(m)、外は0）＝ELEV チャンク（FILL_FS と共有）
${ELEV}
// clip.xy/clip.w → device px（左上原点, y下向き）
vec2 toScreen(vec4 c) {
	vec2 ndc = c.xy / c.w;
	return vec2((ndc.x * 0.5 + 0.5) * u_viewport.x, (1.0 - (ndc.y * 0.5 + 0.5)) * u_viewport.y);
}
`;

// 建物：フットプリントを高さ方向に押し出した3Dメッシュ。深度テストで前後関係を解決。
// 案A（2026-09-06 本人指名）: 線・塗りのドレープ標高を「地形メッシュと同じ折れ線面」に量子化する。
// 地形面はメッシュ格子（G×G 頂点・セル G-1・三角形の対角は b-c）の頂点でだけ elev() を取り間は直線補間＝
// 折れ線近似。線・塗りが「その場の真の標高」を取ると凸斜面で面より高く浮く（COG で画像内の道路との視差が
// 見えて顕在化）。elevQ は同じ格子頂点で elev() を取り同じ三角形分割で補間＝描画されている面に厳密に乗る。
// 窓外（遠景メッシュ域）・地形なし（u_meshG=0）は素の elev() へフォールバック（遠景は霞の中＝ズレ不可視）。
const QELEV = /* glsl */`
uniform vec4 u_meshQ;    // 地形メッシュ窓（xy=原点 lon/lat・zw=span deg）
uniform float u_meshG;   // 格子の頂点数 G（0=量子化オフ＝真俯瞰など地形なし）
float elevQ(vec2 ll) {
	if (u_meshG < 1.5) return elev(ll);
	// 近景層（順 1a）の窓の内側は近景メッシュパス（同じ単位格子を窓へ縮めた物）が地面＝その格子で量子化（主パスはそこを discard 済み・2026-10-28）
	vec4 win = u_meshQ;
	if (u_hasNear > 0.5) { vec2 gn = (ll - u_nearBounds.xy) / u_nearBounds.zw; if (gn.x >= 0.0 && gn.x <= 1.0 && gn.y >= 0.0 && gn.y <= 1.0) win = u_nearBounds; }
	if (u_hasFine > 0.5) { vec2 gf = (ll - u_fineBounds.xy) / u_fineBounds.zw; if (gf.x >= 0.0 && gf.x <= 1.0 && gf.y >= 0.0 && gf.y <= 1.0) win = u_fineBounds; }   // 足元層の窓の内側は足元メッシュパスの格子
	vec2 g = (ll - win.xy) / win.zw;
	if (g.x < 0.0 || g.x > 1.0 || g.y < 0.0 || g.y > 1.0) return elev(ll);
	float N = u_meshG - 1.0;                        // セル数
	vec2 gc = min(g * N, vec2(N - 1e-4));
	vec2 gi = floor(gc);
	vec2 gf = gc - gi;
	vec2 st = win.zw / N;
	vec2 b0 = win.xy + gi * st;
	float h00 = elev(b0);
	float h10 = elev(b0 + vec2(st.x, 0.0));
	float h01 = elev(b0 + vec2(0.0, st.y));
	float h11 = elev(b0 + st);
	return (gf.x + gf.y < 1.0)                       // メッシュと同じ対角（a-c-b / b-c-d）で厳密一致
		? h00 + gf.x * (h10 - h00) + gf.y * (h01 - h00)
		: h11 + (1.0 - gf.x) * (h01 - h11) + (1.0 - gf.y) * (h10 - h11);
}`;

export const BUILDING_VS = `#version 300 es
precision highp float;
in vec3 a_pos;      // dlon, dlat, hWorld（原点からの経緯度差分＋高さ・単位球スケール）
in float a_shade;   // 陰影（屋根1/壁0.76）
in vec2 a_anchor;   // 建物の基準点（原点からの経緯度差分）。一棟の全頂点で単一標高＝垂直プリズム
${PROJECT}
${QELEV}
out float v_shade;
out float v_front;
out float v_fog;
out vec2  v_ll;      // シーン原点相対の lon/lat 差分(deg)＝メッシュマスク uv 用。⚠絶対経緯度を varying で運ばない：
                     // f32 の ulp は経度139°で~1.4m＝25mマスクセルの境界で画素ジッタ→深ズーム(z20)で櫛状の
                     // まだら discard（点描ゴースト・2026-08-02 中野実測）。大きい定数部は uniform 側で f64 前計算。
void main() {
	vec2 dLL = a_pos.xy;                       // 原点相対 (deg)。multidraw は mdize が u_tileOff を足す
	vec2 dAnchor = a_anchor;                   // 基準点の原点相対 (deg)
	vec2 ll = u_origin + dLL;
	v_ll = dLL;
	vec3 rel = deltaToRel(dLL);               // 頂点3D − 原点3D（小・正確）
	vec3 dir = u_originPt + rel;              // 絶対単位球点（front/fog 用＝粗くて可）
	float base = elevQ(u_origin + dAnchor) * u_elevScale;     // 基準点の標高で足元を揃える（屋根水平・壁垂直）。案A＝描画メッシュ面
	float h = base + a_pos.z;                  // 地形標高 + 建物高さ
	vec3 relW = rel + h * liftDir(ll, dir);    // (dir*(1+h)) − 原点3D を相殺なしで（地形の上に建物を積む。楕円体＝測地法線）
	v_shade = a_shade;
	v_front = dot(u_eye, u_eye) < 1.0 ? 1.0 : dot(dir, u_eye) - 1.0;
	v_fog = fogOf(u_originPt + relW);
	gl_Position = u_clipT + u_mvp * vec4(relW, 0.0);
	gl_PointSize = 7.0;   // GL_POINTS 描画時のみ有効（線/面描画では無視）＝draped の点データ用
	applyLogDepth();
}`;

// 隣接区境をまたぐと メッシュ地区が同時に複数(最大4)アクティブになるため、bbox/mask をスロット化。
// GLSL ES 3.00 は sampler 配列の動的添字を許さないので4本を個別 uniform にしアンロールで判定。
export const BUILDING_FS = `#version 300 es
precision highp float;
uniform vec3 u_bldColor;
uniform vec3 u_fogColor;
uniform int u_meshCount;         // 0..4：アクティブなメッシュ地区数
uniform vec4 u_meshBbox0;        // [minLon,minLat,maxLon,maxLat] deg。マスクの UV 正規化に使う
uniform vec4 u_meshBbox1;
uniform vec4 u_meshBbox2;
uniform vec4 u_meshBbox3;
uniform sampler2D u_meshMask0;   // メッシュの実フットプリントの被覆マスク（立ってるセル＝LOD2 が担う）
uniform sampler2D u_meshMask1;
uniform sampler2D u_meshMask2;
uniform sampler2D u_meshMask3;
in float v_shade;
in float v_front;
in float v_fog;
in vec2  v_ll;
out vec4 fragColor;
bool maskedBy(vec4 offInv, sampler2D mask, vec2 rel) {
	// uv = (origin−bboxMin)/span + rel/span。offInv.xy=(origin−bboxMin)/span（CPUでf64計算）・zw=1/span。
	// rel はシーン原点相対の小値＝f32 で精密。旧・絶対経緯度 (ll−bboxMin)/span は f32 ジッタでセル境界がまだらになった。
	vec2 uv = offInv.xy + rel * offInv.zw;
	return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0 && texture(mask, uv).r > 0.5;
}
void main() {
	if (v_front < 0.0) discard;
	// 実フットプリントが立つセルだけ基図建物を伏せる（矩形でなく被覆マスク＝空白地帯なし）
	if ((u_meshCount > 0 && maskedBy(u_meshBbox0, u_meshMask0, v_ll)) ||
	    (u_meshCount > 1 && maskedBy(u_meshBbox1, u_meshMask1, v_ll)) ||
	    (u_meshCount > 2 && maskedBy(u_meshBbox2, u_meshMask2, v_ll)) ||
	    (u_meshCount > 3 && maskedBy(u_meshBbox3, u_meshMask3, v_ll))) discard;
	// 深度は VS の applyLogDepth() が焼き済み（gl_FragDepth を書くと early-Z が無効になるためFSでは触れない）
	vec3 c = mix(u_bldColor * v_shade, u_fogColor, v_fog);
	fragColor = vec4(c, 1.0);
}`;

// a glTF line's ribbon (globe meshdecode linePrimAsRibbons, 2026-10-31): the normal is the line's direction and the 4th byte −(2·w + side), w = width
// in quarter CSS px. The vertex moves across the line's direction on screen by half the width (Cesium draws lines this many pixels wide whatever
// the distance). gpu/wgsl.ts MESH_WGSL has the same
const LINE_RIBBON = `if (a_ol < -0.004) {
		float lb = floor(-a_ol * 127.0 + 0.5), hp = floor(lb * 0.5) * 0.125 * max(u_lineDpr, 1.0);
		vec4 dc = u_mvp * vec4(v_n, 0.0);
		vec2 sd = (dc.xy * gl_Position.w - gl_Position.xy * dc.w) * u_viewport;
		if (dot(sd, sd) < 1e-30) sd = vec2(1.0, 0.0);
		gl_Position.xy += normalize(vec2(-sd.y, sd.x)) * (mod(lb, 2.0) * 2.0 - 1.0) * hp * 2.0 / u_viewport * gl_Position.w;
		gl_Position *= 0.999;   // 0.1% nearer the eye (same place on screen): a line lying on a surface (3D Tiles edges, SURFACES_AND_EDGES) wins the depth test
		v_ol = vec3(0.0);
		v_n = v_toEye;   // a ribbon faces the eye (the FS's back-face test and light read v_n; lines are unlit in Cesium)
	}`;
// 建物メッシュ（LOD2 等）（任意三角形）。頂点は ortho 単位球座標へ変換済み。
// 面法線は FS で dFdx/dFdy から算出＝CPU法線/un-index 不要のフラット陰影。裏半球カリング＋深度で前後解決。
export const MESH_VS = `#version 300 es
precision highp float;
in vec3 a_pos;      // 重心(u_meshOrigin)相対の delta（RTE-lite：小さい値＝float32 仮数がフルに効く＝建物ディテールを高精度に）
in vec3 a_normal;   // glTF 実法線を ortho へ変換済
uniform vec3 u_meshOrigin;   // メッシュ重心＝単位球の錨。絶対位置 = u_meshOrigin + a_pos
uniform vec4 u_clipMesh;     // mvp*[u_meshOrigin,1]（CPU double）＝MVP相殺回避の錨（旧: シェーダ内 float32 で算出＝錨が相殺）
uniform vec4 u_liftBounds;   // DTM(裸地=DEM10B)保証域 [lng0,lat0,spanLng,spanLat]。外＝接地リフトしない（DSM=ビル天端でリフトすると屋根が斜面に裂ける）
uniform float u_xfOn;        // バッチの剛体変換（glTF の rigid アニメ・W4）：1＝a_pos を u_xfL·a_pos + u_xfT（原点相対）に写し法線も回す。0＝素通し（ビット同一）
uniform mat3 u_xfL;
uniform vec3 u_xfT;
uniform vec3 u_eyeRel;       // u_eye − u_meshOrigin（CPU double）＝視線ベクトルを原点相対で組む（下の v_toEye）
in float a_ol;      // CESIUM_primitive_outline: the normal's 4th byte = 3 bits, which outline coordinates are 1 at this vertex (unset = 0 = none); negative = a glTF line's ribbon (below)
out vec3 v_ol;
uniform float u_lineDpr;   // device px per CSS px (the ribbons' widths are CSS px)
${PROJECT}
// Cesium の霧（csatmo.ts csFogV・頂点で色と量）：u_csFogD＝濃さ（0＝なし）・u_csFogL＝xyz 光へ向く単位ベクトル・w 照明あり 1／なし −1
uniform float u_csFogD;
uniform vec4 u_csFogL;
${CS_ATMO_GLSL}
out vec4 v_csFog;
out vec3  v_n;      // 実法線
out vec3  v_toEye;  // 視線ベクトル（巻き順に依存せず法線を表向きへ）
out float v_front;  // >0 で手前半球
out float v_fog;
void main() {
	vec3 ap = u_xfOn > 0.5 ? u_xfL * a_pos + u_xfT : a_pos;      // バッチの剛体変換（W4）＝原点相対のまま
	vec3 wp = u_meshOrigin + ap;                                 // 絶対位置（陰影・フォグ・半球判定用＝粗くて可）
	vec3 dir = normalize(wp);
	v_n = a_normal;
	if (u_xfOn > 0.5) v_n = u_xfL * a_normal;
	float olK = floor(a_ol * 127.0 + 0.5);
	v_ol = vec3(mod(olK, 2.0), mod(floor(olK / 2.0), 2.0), floor(olK / 4.0));
	v_toEye = u_eyeRel - ap;                                     // ＝u_eye − wp を原点相対で：u_eye − wp（≈1 同士の差）は float32 で 0.4 m 級の誤差＝目が数 m まで寄った 1 m 級の模型（Cesium Man）で FS の面法線（dFdx）と裏面判定が乱れ裏側の三角形が透けた（2026-10-28）
	v_front = dot(u_eye, u_eye) < 1.0 ? 1.0 : dot(dir, u_eye) - 1.0;
	v_fog = fogOf(wp);
	v_csFog = csFogV(u_eye * CS_R, wp * CS_R, u_csFogD, u_csFogL.xyz, u_csFogL.w);
	// 接地リフト（DTM 化で解禁・746b48a の続き）：メッシュは単位球接地(r=1)で焼き込み済み＝頂点位置の
	// 地表標高（DTM）を elev() でサンプルし法線方向へ持ち上げる。旧・リフト禁止の根拠は ALOS DSM の
	// 不連続（ビル天端の縁で数十〜100m級→同一建物内の頂点が別量動き屋根が裂ける・実機確認）だったが、
	// 現 z≥12 の標高源 R01=DEM10B（裸地・滑らか）では不発。地形の深度書き全ズーム化に伴い、リフト無しでは
	// 持ち上がった地面が建物を深度で飲む（札幌 z16.9 で実測）。建物内の微小な地勾配は頂点へそのまま乗る
	//（斜面の建物は基礎が地形に沿う近似）。⚠橋梁(two=両面)は径間中央が谷の DTM に沿って数m沈み得る＝既知の割り切り。
	// RTE：原点の clip 位置は CPU(double) 錨 u_clipMesh（旧 u_mvp*vec4(u_meshOrigin,1) はシェーダ float32＝
	// ≈1 同士の相殺で錨自体が高ズームに揺らいだ）。delta は小さく float32 精度フルのまま u_mvp で回す。
	// リフト項 h*dir も delta 側に足す＝RTE を壊さない（gint projectDrape と同形）。
	float lat = geoLat(degrees(asin(clamp(dir.y, -1.0, 1.0))));   // β球点→β→測地緯度（elev/リフト域は測地の台帳。球=恒等）
	float lon = degrees(atan(dir.z, dir.x));
	// DTM保証域(u_liftBounds)の中でだけリフト：混成窓の遠方セル等＝ALOS DSM（ビル天端込み）でリフトすると
	// 屋上が斜面に裂ける（東新橋/汐留 高チルトで実測＝旧「形状崩壊」の再現）。境界は 0.05° の smoothstep で
	// 畳む＝境界を跨ぐ建物（≦0.002°）を引き裂かない。域外・bounds無し(全0)は h=0＝従来の r=1 接地。
	float inX = smoothstep(0.0, 0.05, min(lon - u_liftBounds.x, u_liftBounds.x + u_liftBounds.z - lon));
	float inY = smoothstep(0.0, 0.05, min(lat - u_liftBounds.y, u_liftBounds.y + u_liftBounds.w - lat));
	float h = elev(vec2(lon, lat)) * u_elevScale * inX * inY;
	gl_Position = u_clipMesh + u_mvp * vec4(ap + h * liftDir(vec2(lon, lat), dir), 0.0);   // 楕円体＝測地法線で接地リフト
	${LINE_RIBBON}
	applyLogDepth();
}`;

export const MESH_FS = `#version 300 es
precision highp float;
uniform vec3 u_bldColor;
uniform vec3 u_fogColor;
in vec4 v_csFog;   // Cesium の霧（頂点で計算）
uniform float u_cullBack;   // 1=裏面discard（建物＝閉じた体積）、0=両面（橋梁＝ケーブル/柵の開いた薄面。dedupで片面化済みのため）
uniform vec3  u_eye;        // カメラ位置（接地の局所系＝画素の動径を出す・light 用）
uniform float u_lightOn;    // style の light（MapLibre・B3 2026-10-12）：1＝u_lightDir（東・北・上の単位ベクトル）・u_lightI（強さ）・u_lightColor で陰影。0＝従来の固定光（ビット同一）
uniform vec3  u_lightDir;
uniform float u_lightI;
uniform vec3  u_lightColor;
uniform int   u_lightN;       // 局所の光源（第 3 波 W2・2026-10-12）＝point/spot/ambient/hemisphere・上限 8。並びは light.js localLightsPayload（A＝位置+kind・B＝色+強さ・C＝向き／地面色+range・D＝cos 内外+decay）
uniform vec4  u_lA[8];
uniform vec4  u_lB[8];
uniform vec4  u_lC[8];
uniform vec4  u_lD[8];
uniform float u_csOn;        // Cesium の模型の照明（@ortho-earth/cesium の setMeshLighting・2026-10-26）：1＝下の固定光・style の light の代わりに csLit（CesiumJS の式）で描く
uniform vec3  u_csDir;       // 光へ向く単位ベクトル（世界系）
uniform vec3  u_csColor;     // 光の色×強さ（HDR・SunLight は 2）
uniform vec3  u_csSH[9];     // 環境光の SH9（Cesium の並び＝L00,L1-1,L10,L11,L2-2,L2-1,L20,L21,L22・立方体図の系＝x 東・y 上・z 南）
uniform vec3  u_csIbl;       // (拡散の係数, 鏡面の係数, 一様な環境で L00 が 1 になる倍率＝鏡面の環境光を放射輝度に戻す)
uniform samplerCube u_csEnvMap;   // the model's specular environment (ImageBasedLighting.specularEnvironmentMaps: a prefiltered KTX2 cube, mip = roughness)
uniform vec2  u_csEnv;       // (1 = u_csEnvMap is set, its largest mip level)
uniform vec2  u_csMR;        // バッチの材質（metallic, roughness）＝glTF の係数（GL は材質テクスチャを持たない）
uniform vec2  u_csCC;        // KHR_materials_clearcoat (factor, roughness); factor 0 = none
uniform vec4  u_olC;         // CESIUM_primitive_outline: the outline colour and its alpha (0 = none)
in vec3  v_ol;
vec3 olW;   // fwidth(v_ol), taken at the top of main
// Cesium's PrimitiveOutlineStageFS: diffuse = mix(diffuse, colour, alpha * outlineness), outlineness = the brightest of the 3 coordinates looked up in a
// mip-mapped strip whose last texel is 192/255 (an outline 0.75 px wide, halved per level once the strip is under 16 texels). w = fwidth(v_ol)
vec3 olMix(vec3 b, vec3 w) {
	if (u_olC.a <= 0.0) return b;
	vec3 t = max(w, vec3(1.0 / 4096.0));
	vec3 o = 0.753 * clamp((v_ol - 1.0) / t + 1.5, 0.0, 1.0) * min(vec3(1.0), 1.0 / (16.0 * t));
	return mix(b, u_olC.rgb, u_olC.a * max(o.x, max(o.y, o.z)));
}
in vec3  v_n;
in vec3  v_toEye;
in float v_front;
in float v_fog;
out vec4 fragColor;
// 局所の光の寄与＝陰影の係数 d に足す（色×(d＋Σ光)）。pos＝画素の世界座標（単位球）・up＝その動径。ambient は向きに依らず・hemisphere は上向き具合で空色と地面色・point/spot は (1−dist/range)^decay と cos の smoothstep
vec3 localLights(vec3 n, vec3 pos, vec3 up) {
	vec3 acc = vec3(0.0);
	for (int i = 0; i < 8; i++) {
		if (i >= u_lightN) break;
		vec4 A = u_lA[i], B = u_lB[i], C = u_lC[i], D = u_lD[i];
		int kind = int(A.w + 0.5);
		if (kind == 3) acc += B.rgb * B.w;
		else if (kind == 4) acc += mix(C.rgb, B.rgb, dot(n, up) * 0.5 + 0.5) * B.w;
		else {
			vec3 dv = A.xyz - pos; float dist = length(dv); vec3 L = dv / max(dist, 1e-9);
			float at = C.w > 0.0 ? pow(clamp(1.0 - dist / C.w, 0.0, 1.0), D.z) : 1.0;
			if (kind == 2) at *= smoothstep(D.x, D.y, dot(-L, C.xyz));
			acc += B.rgb * B.w * at * max(dot(n, L), 0.0);
		}
	}
	return acc;
}
// Cesium の模型の照明（@ortho-earth/cesium・2026-10-26）＝CesiumJS の LightingStageFS をそのまま：czm_pbrLighting（Lambert／π＋GGX＝直接光×色×強さ・NdotL は 0.001 で止める）
// ＋環境光（ImageBasedLightingStageFS＝SH9 の拡散＋反射の向きの SH9 の鏡面・brdf LUT は Karis の近似）→ czm_pbrNeutralTonemapping → czm_linearToSrgb（pow 1/2.2）。
// 法線・視線は世界系、環境光の SH は Cesium の立方体図の系（x 東・y 上・z 南）＝接地の局所系（東・北・上）から写す。gpu/wgsl.ts csLit と同式。
vec3 csSH(vec3 n) {
	vec3 L = u_csSH[0] + u_csSH[1] * n.y + u_csSH[2] * n.z + u_csSH[3] * n.x + u_csSH[4] * (n.y * n.x) + u_csSH[5] * (n.y * n.z)
		+ u_csSH[6] * (3.0 * n.z * n.z - 1.0) + u_csSH[7] * (n.z * n.x) + u_csSH[8] * (n.x * n.x - n.y * n.y);
	return max(L, vec3(0.0));
}
vec3 csTonemap(vec3 color) {   // czm_pbrNeutralTonemapping（Khronos PBR Neutral・startCompression 0.76・desaturation 0.15）
	float x = min(color.r, min(color.g, color.b));
	float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
	color -= offset;
	float peak = max(color.r, max(color.g, color.b));
	if (peak < 0.76) return color;
	float dd = 0.24, newPeak = 1.0 - dd * dd / (peak + dd - 0.76);
	color *= newPeak / peak;
	float g = 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0);
	return mix(color, vec3(newPeak), g);
}
vec3 csSrgbToLinear(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }   // czm_srgbToLinear
vec3 csLit(vec3 base, vec3 n) {   // base＝リニアの基本色・n＝表向きの単位法線。戻り＝表示空間（sRGB）
	vec3 v = normalize(v_toEye), l = normalize(u_csDir), h = normalize(v + l);
	vec3 up = normalize(u_eye - v_toEye); vec3 e0 = cross(vec3(0.0, 1.0, 0.0), up);
	vec3 east = dot(e0, e0) < 1e-12 ? vec3(1.0, 0.0, 0.0) : normalize(e0); vec3 north = cross(up, east);
	float metallic = u_csMR.x, roughness = u_csMR.y;
	vec3 diffuse = base * (1.0 - metallic), f0 = mix(vec3(0.04), base, metallic);
	diffuse = olMix(diffuse, olW);   // CESIUM_primitive_outline
	float VdotH = clamp(dot(v, h), 0.0, 1.0), NdotL = clamp(dot(n, l), 0.001, 1.0), NdotV = clamp(dot(n, v), 0.0, 1.0), NdotH = clamp(dot(n, h), 0.0, 1.0);
	vec3 f90 = vec3(clamp(max(f0.r, max(f0.g, f0.b)) * 25.0, 0.0, 1.0));
	float vs = 1.0 - VdotH; vec3 F = f0 + (f90 - f0) * vs * vs * vs * vs * vs;
	float a = roughness * roughness, a2 = a * a;
	float GGX = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2) + NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
	float G = GGX > 0.0 ? 0.5 / GGX : 0.0;
	float f = (NdotH * a2 - NdotH) * NdotH + 1.0;
	float D = a2 / (3.14159265 * f * f);
	vec3 color = ((1.0 - F) * diffuse / 3.14159265 + F * G * D) * NdotL * u_csColor;
	// 環境光：拡散＝SH9（Cesium の係数＝散乱の強さ込み）・鏡面＝反射の向きの SH9 を放射輝度に戻した物（立方体図の mip の代わり）
	// the cube-map frame (x east, y up, z south); the world axes are mirrored (y the pole, z at 90E), so cross(pole, up) above points west
	vec3 nC = vec3(-dot(n, east), dot(n, up), -dot(n, north)), r = reflect(-v, n), rC = vec3(-dot(r, east), dot(r, up), -dot(r, north));
	vec4 rr = roughness * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
	float a004 = min(rr.x * rr.x, exp2(-9.28 * NdotV)) * rr.x + rr.y;
	vec2 AB = vec2(-1.04, 1.04) * a004 + rr.zw;
	vec3 f90i = max(vec3(1.0 - roughness), f0); float vn = 1.0 - NdotV; vec3 Fn = f0 + (f90i - f0) * vn * vn * vn * vn * vn;
	vec3 FssEss = Fn * AB.x + AB.y;
	vec3 avgF = f0 + (1.0 - f0) / 21.0; float Ems = 1.0 - AB.x - AB.y;
	vec3 FmsEms = FssEss * avgF * Ems / (1.0 - avgF * Ems);
	color += csSH(nC) * (FmsEms + (1.0 - FssEss - FmsEms) * diffuse) * u_csIbl.x + (u_csEnv.x > 0.5 ? textureLod(u_csEnvMap, rC, roughness * u_csEnv.y).rgb : csSH(rC) * u_csIbl.z) * FssEss * u_csIbl.y;
	if (u_csCC.x > 0.0) {   // KHR_materials_clearcoat (Cesium's clearcoat layer): GGX with f0 0.04 on the geometric normal, its Fresnel taking from the base under it
		float cr = clamp(u_csCC.y, 0.0, 1.0), ca = cr * cr, ca2 = ca * ca, cvs = 1.0 - VdotH, cF = 0.04 + 0.96 * cvs * cvs * cvs * cvs * cvs;
		float cGGX = NdotL * sqrt(NdotV * NdotV * (1.0 - ca2) + ca2) + NdotV * sqrt(NdotL * NdotL * (1.0 - ca2) + ca2), cG = cGGX > 0.0 ? 0.5 / cGGX : 0.0;
		float cf = (NdotH * ca2 - NdotH) * NdotH + 1.0, cD = ca2 / (3.14159265 * cf * cf);
		vec4 crr = cr * vec4(-1.0, -0.0275, -0.572, 0.022) + vec4(1.0, 0.0425, 1.04, -0.04);
		float ca004 = min(crr.x * crr.x, exp2(-9.28 * NdotV)) * crr.x + crr.y; vec2 cAB = vec2(-1.04, 1.04) * ca004 + crr.zw;
		float cvn = 1.0 - NdotV, cFv = 0.04 + 0.96 * cvn * cvn * cvn * cvn * cvn;
		vec3 cEnv = u_csEnv.x > 0.5 ? textureLod(u_csEnvMap, rC, cr * u_csEnv.y).rgb : csSH(rC) * u_csIbl.z;
		color = color * (1.0 - u_csCC.x * cFv) + u_csCC.x * (cF * cG * cD * NdotL * u_csColor + cEnv * (0.04 * cAB.x + cAB.y) * u_csIbl.y);
	}
	return pow(max(csTonemap(color), 0.0), vec3(1.0 / 2.2));
}
uniform vec2 u_split;   // Cesium splitDirection: x = 0 off, else sign = side kept (-1 left, +1 right) and |x| - 1 = the split as a fraction of the width; y = the width (device px)
void main() {
	// 面の幾何法線＝スクリーン微分（discard より前＝隣接ヘルパー画素が生きているうちに取る）。
	// v_toEye = eye − pos で eye は定数＝微分は −dPos、cross で符号が相殺し位置微分の面法線と等価＝varying追加不要。
	vec3 gn = cross(dFdx(v_toEye), dFdy(v_toEye));
	olW = fwidth(v_ol);   // the outline's pixel footprint (before any discard)
	if (v_front < 0.0) discard;                                   // 裏半球
	if (u_split.x != 0.0 && sign(u_split.x) * (gl_FragCoord.x - (abs(u_split.x) - 1.0) * u_split.y) < 0.0) discard;   // the other side of the split
	vec3 n = normalize(v_n);                                      // glTF 実法線（陰影用＝従来のまま）
	// 裏面カリングは幾何法線で判定＝面内で一定値＝画素毎の揺れが構造的に消える。旧・補間int8法線の
	// dot閾値(-0.02)は「すれすれ帯≈1px」前提が深ズーム(z20)で数十pxに化け、閾値をまたぐ画素だけ
	// discard される「点描ゴースト」になった（2026-08-02 実測・中野z20）。向き（表裏）は属性法線で
	// 採決＝巻き順非依存・面単位で一定。退化面（微分ゼロ）だけ旧判定へフォールバック。
	float g2 = dot(gn, gn);
	float fe = g2 > 1e-18 ? dot(normalize(gn * sign(dot(gn, n))), normalize(v_toEye)) : dot(n, normalize(v_toEye));
	if (u_cullBack > 1.5) fe = gl_FrontFacing ? max(abs(fe), 1e-3) : -1.0;   // 2＝Cesium の表裏（glTF・doubleSided でない材質）：巻き順で裏を捨て、法線は書かれたまま（反転しない）。glTF の表（反時計回り）＝gl_FrontFacing（世界軸の鏡像は投影の行列が戻す・砂場で確認）
	if (u_cullBack > 0.5 && fe < -0.02) discard;
	if (fe < 0.0) n = -n;                                         // 両面時は法線を視線側へ＝裏から見ても陰影が成立
	vec3 L = normalize(vec3(-0.35, 0.85, 0.30));                  // 斜め上の光＝屋根が立つ
	vec3 d = vec3(clamp(dot(n, L) * 0.28 + 0.76, 0.72, 1.0));    // 基図建物の屋根1.0/壁0.76に合わせる（up向き屋根→~1.0、垂直壁→~0.76）
	if (u_lightOn > 0.5) {   // style の light＝接地の局所系（上＝画素の動径・東・北）で向きを写し、MapLibre の式 mix(1−強さ, 1, max(dot, 0))×色
		vec3 up = normalize(u_eye - v_toEye); vec3 e0 = cross(vec3(0.0, 1.0, 0.0), up);
		vec3 east = dot(e0, e0) < 1e-12 ? vec3(1.0, 0.0, 0.0) : normalize(e0); vec3 north = cross(up, east);
		vec3 Ls = normalize(east * u_lightDir.x + north * u_lightDir.y + up * u_lightDir.z);
		d = u_lightColor * mix(1.0 - u_lightI, 1.0, clamp(dot(n, Ls), 0.0, 1.0));
	}
	if (u_lightN > 0) { vec3 pw = u_eye - v_toEye; d += localLights(n, pw, normalize(pw)); }   // 局所の光源（W2）
	vec3 base = u_bldColor * d;
	if (u_csOn > 1.5) base = u_bldColor; else if (u_csOn > 0.5) base = csLit(csSrgbToLinear(u_bldColor), n);   // Cesium の照明（@ortho-earth/cesium）・2＝unlit＝素の色
	vec3 c = mix(base, u_fogColor, v_fog);
	c = mix(c, v_csFog.rgb, v_csFog.a);   // Cesium の霧（影の後）
	fragColor = vec4(c, 1.0);
}`;

// テクスチャ/マテリアル付きの派生（glTF/GLB 直読み・2026-09-20）：メッシュ本体の文字列から機械的に派生＝本体は 1 文字も変えない。
// 頂点に a_uv(f32x2)・a_col(RGBA8 正規化＝baseColorFactor×COLOR_0 を worker が焼き込み)、FS は u_tex（unit 7）をサンプル。
// 陰影 d・フォグ・裏面判定は本体と同じ＝色だけ「建物色」が「頂点色×テクスチャ」に替わる。α は alphaMode ごと（OPAQUE=無視・MASK=cutoff で discard・BLEND=前乗算で合成）。
// テクスチャは discard より前に引く（ミップ選択の微分＝uniform control flow）。錨（anchor）が無ければ読み込み時に throw＝門で捕まる。
const derive = (src: string, pairs: readonly (readonly [string, string])[], label: string): string => pairs.reduce((s, [a, b]) => { if (s.split(a).length !== 2) throw new Error(`glsl derive(${label}): anchor missing/ambiguous: ${a.slice(0, 50)}`); return s.replace(a, b); }, src);
export const MESH_TEX_VS = derive(MESH_VS, [
	["in vec3 a_normal;   // glTF 実法線を ortho へ変換済\n", "in vec3 a_normal;   // glTF 実法線を ortho へ変換済\nin vec2 a_uv;\nin vec4 a_col;\nout vec2 v_uv;\nout vec4 v_col;\n"],
	["\tv_n = a_normal;\n", "\tv_n = a_normal;\n\tv_uv = a_uv; v_col = a_col;\n"],
], "MESH_TEX_VS");
export const MESH_TEX_FS = derive(MESH_FS, [
	["uniform float u_cullBack;", "uniform float u_cullBack;\nuniform sampler2D u_tex;\nuniform float u_alphaCut;\nuniform float u_blend;\nuniform vec4 u_tint;\nuniform float u_tintB;\nuniform sampler2D u_paint;\nuniform float u_paintB;\nuniform sampler2D u_drape;\nuniform vec4 u_drU;\nuniform vec4 u_drV;\nuniform float u_drOn;\nuniform vec3 u_eyeRel;\nin vec2 v_uv;\nin vec4 v_col;\nvec3 tintC(vec3 c) { if (u_tintB < -0.5) return c; c = mix(c, u_tint.rgb, u_tintB); return c * mix(u_tint.rgb, vec3(1.0), ceil(u_tintB)); }\n// the style colour of the feature under this texel (feature ID texture, nearest texel; alpha 0 = no colour), blended like tintC (Cesium colorBlendMode)\nvec4 paintT(vec4 c) { if (u_paintB < -0.5) return c; ivec2 sz = textureSize(u_paint, 0); vec4 p = texelFetch(u_paint, clamp(ivec2(floor(v_uv * vec2(sz))), ivec2(0), sz - 1), 0); if (p.a < 0.5) return c; return vec4(mix(c.rgb, p.rgb, u_paintB) * mix(p.rgb, vec3(1.0), ceil(u_paintB)), c.a); }\n// imagery draped on the mesh (set \"meshDrape\": Cesium3DTileset.imageryLayers): uv = the window's plane map of the point (origin-relative), over the base colour by its alpha. Lod 0 = no derivatives (after the clip discards too)\nvec4 drapeT(vec4 c, vec3 p) { if (u_drOn < 0.5) return c; vec2 uv = vec2(dot(u_drU.xyz, p) + u_drU.w, dot(u_drV.xyz, p) + u_drV.w); if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return c; vec4 d = textureLod(u_drape, uv, 0.0); return vec4(mix(c.rgb, d.rgb, d.a), c.a); }"],   // u_alphaCut＝これ未満の α は discard（MASK=alphaCutoff・OPAQUE=−1・BLEND=1/255）／u_blend=1＝半透明（α を前乗算で出力＝既定の blendFunc ONE/ONE_MINUS_SRC_ALPHA）
	["\tvec3 gn = cross(dFdx(v_toEye), dFdy(v_toEye));\n", "\tvec3 gn = cross(dFdx(v_toEye), dFdy(v_toEye));\n\tvec4 txr = paintT(texture(u_tex, v_uv)); vec4 tx = txr * v_col;\n\ttxr = drapeT(txr, u_eyeRel - v_toEye); tx = txr * v_col;\n"],
	["\tvec3 base = u_bldColor * d;\n\tif (u_csOn > 1.5) base = u_bldColor; else if (u_csOn > 0.5) base = csLit(csSrgbToLinear(u_bldColor), n);   // Cesium の照明（@ortho-earth/cesium）・2＝unlit＝素の色\n\tvec3 c = mix(base, u_fogColor, v_fog);\n\tc = mix(c, v_csFog.rgb, v_csFog.a);   // Cesium の霧（影の後）\n\tfragColor = vec4(c, 1.0);\n}", "\tif (tx.a < u_alphaCut) discard;\n\tfloat ta = u_tintB < -0.5 ? 1.0 : u_tint.a;\n\tfloat a = (u_blend > 1.5 ? 1.0 : u_blend > 0.5 ? tx.a : 1.0) * (u_blend > 0.5 ? ta : 1.0);\n\tvec3 base = tintC(tx.rgb) * d;\n\tif (u_csOn > 1.5) base = tintC(tx.rgb); else if (u_csOn > 0.5) base = csLit(tintC(csSrgbToLinear(txr.rgb) * v_col.rgb), n);   // Cesium の照明＝テクスチャは sRGB・頂点色（baseColorFactor×COLOR_0）はリニア\n\tvec3 c = mix(base, u_fogColor, v_fog);\n\tc = mix(c, v_csFog.rgb, v_csFog.a);   // Cesium の霧（影の後）\n\tfragColor = vec4(c * a, a);\n}"],
], "MESH_TEX_FS");
// 模型の輪郭線（Cesium の Model.silhouetteColor／silhouetteSize・2026-10-29）＝同じ頂点を画面上で法線の向きへ u_silPx（device px）押し出した殻を色で塗る。
// 模型の前に深度を書かずに描く＝模型が自分の上を塗り直し、外へはみ出した縁だけ残る（Cesium のステンシルの輪郭と同じ見え方）。gpu/wgsl.ts MESH_SIL_WGSL と対
export const MESH_SIL_VS = derive(MESH_TEX_VS, [
	["uniform vec3 u_eyeRel;", "uniform vec3 u_eyeRel;\nuniform float u_silPx;"],
	["\tapplyLogDepth();\n}", "\tapplyLogDepth();\n\tvec2 cn = (u_mvp * vec4(v_n, 0.0)).xy;\n\tif (dot(cn, cn) > 1e-30) gl_Position.xy += normalize(cn) * u_silPx * 2.0 / u_viewport * gl_Position.w;\n}"],
], "MESH_SIL_VS");
export const MESH_SIL_FS = `#version 300 es
precision highp float;
uniform vec4 u_silColor;
in float v_front;
out vec4 fragColor;
void main() {
	if (v_front < 0.0) discard;
	fragColor = vec4(u_silColor.rgb * u_silColor.a, u_silColor.a);
}`;

// 利用者のシェーダ（Cesium の CustomShader・2026-10-29）＝模型の派生（MESH_TEX）に利用者の GLSL を差し込む。csshader.ts が前置き（構造体・uniform・czm_）と
// uniform の改名を作り、ここは呼び出しの継ぎ目だけ：頂点＝vertexMain の positionMC の差分を J（MC → 世界の線形部）で世界へ戻して ap に足す・
// 画素＝材質（czm_modelMaterial）を Cesium の MaterialStageFS と同じに組み（diffuse＝base×(1−金属)・specular＝f0）、fragmentMain の後の材質で照らす
// （UNLIT＝diffuse を sRGB に・PBR＝csLit と同じ式を材質から＝csLitM）。a_mc＝(positionMC, 地物の番号)・u_csJ／u_csV＝バッチの J・目の回転（m 単位の目の座標）。
// gpu/wgsl.ts meshCustomWGSL と対
const csLitMOf = (fs: string): string => {   // MESH_FS の csLit を材質を取る形に（式は 1 字も写し替えない）
	const i = fs.indexOf("vec3 csLit(vec3 base, vec3 n) {"), j = fs.indexOf("\n}\n", i);
	return derive(fs.slice(i, j + 3), [
		["vec3 csLit(vec3 base, vec3 n) {", "vec3 csLitM(czm_modelMaterial m, vec3 n) {"],
		["\tfloat metallic = u_csMR.x, roughness = u_csMR.y;\n\tvec3 diffuse = base * (1.0 - metallic), f0 = mix(vec3(0.04), base, metallic);\n", "\tfloat roughness = m.roughness;\n\tvec3 diffuse = m.diffuse, f0 = m.specular;\n"],
		["\treturn pow(max(csTonemap(color)", "\tcolor += m.emissive;\n\treturn pow(max(csTonemap(color)"],
	], "csLitM");
};
export function meshCustomGLSL(spec: CsSpec): { vs: string; fs: string } {
	const vsUser = spec.vs ? csGlslUser(spec.vs, spec) : "", fsUser = spec.fs ? csGlslUser(spec.fs, spec) : "";
	const vs = derive(MESH_TEX_VS, [
		["in vec2 a_uv;\nin vec4 a_col;\nout vec2 v_uv;\nout vec4 v_col;\n", "in vec2 a_uv;\nin vec4 a_col;\nout vec2 v_uv;\nout vec4 v_col;\nin vec4 a_mc;\nout vec4 v_mc;\nin vec2 a_uvm;\nout vec2 v_uvm;\nuniform mat3 u_csJ;\nuniform mat3 u_csV;\n"],
		["void main() {\n\tvec3 ap = u_xfOn > 0.5 ? u_xfL * a_pos + u_xfT : a_pos;      // バッチの剛体変換（W4）＝原点相対のまま\n",
		 csGlslPrelude(spec, "vs") + vsUser + "\nvoid main() {\n\tvec3 ap = u_xfOn > 0.5 ? u_xfL * a_pos + u_xfT : a_pos;      // バッチの剛体変換（W4）＝原点相対のまま\n\tv_mc = a_mc; v_uvm = a_uvm;\n"
		 + (spec.vs ? "\t{\n\t\tVertexInput csVi; csVi.attributes = csAttrsOf(a_mc.xyz, u_meshOrigin + ap, u_csV * (ap - u_eyeRel) * 6378137.0, (u_xfOn > 0.5 ? u_xfL * a_normal : a_normal), a_uv, a_col, a_mc.w, u_csJ, u_csV);\n"
			+ "\t\tcsVi.featureIds.featureId_0 = int(a_mc.w + 0.5); csVi.featureIds.featureId_1 = 0; csVi.metadata = csMetaOf(a_uvm);\n"
			+ "\t\tczm_modelVertexOutput csVo; csVo.positionMC = a_mc.xyz; csVo.pointSize = 1.0;\n\t\tvertexMain(csVi, csVo);\n\t\tap += u_csJ * (csVo.positionMC - a_mc.xyz);\n\t\tv_mc.xyz = csVo.positionMC;\n\t}\n" : "")],
	], "MESH_CS_VS");
	const fs = derive(MESH_TEX_FS, [
		["uniform float u_cullBack;", "uniform float u_cullBack;\nin vec4 v_mc;\nin vec2 v_uvm;\nuniform mat3 u_csJ;\nuniform mat3 u_csV;\nuniform vec2 u_csMode;   // x＝UNLIT・y＝材質の α で半透明（TRANSLUCENT）"],
		["void main() {\n", csGlslPrelude(spec, "fs") + fsUser + "\n" + csLitMOf(MESH_FS) + "void main() {\n"],
		["\tif (u_csOn > 1.5) base = tintC(tx.rgb); else if (u_csOn > 0.5) base = csLit(",
		 "\tvec3 csB = tintC(csSrgbToLinear(txr.rgb) * v_col.rgb);\n\tbool csUnlit = u_csMode.x > 0.5 || (u_csOn > 1.5 && u_csMode.x > -0.5);\n\tfloat csMet = csUnlit ? 0.0 : u_csMR.x;\n"
		 + "\tczm_modelMaterial csM; csM.baseColor = vec4(csB, tx.a); csM.diffuse = csB * (1.0 - csMet); csM.alpha = tx.a; csM.specular = mix(vec3(0.04), csB, csMet); csM.roughness = u_csMR.y;\n"
		 + "\tcsM.normalEC = normalize(u_csV * n); csM.occlusion = 1.0; csM.emissive = vec3(0.0);\n"
		 + (spec.fs ? "\tFragmentInput csFi; csFi.attributes = csAttrsOf(v_mc.xyz, u_eye - v_toEye, u_csV * (-v_toEye) * 6378137.0, n, v_uv, v_col, v_mc.w, u_csJ, u_csV);\n"
			+ "\tcsFi.featureIds.featureId_0 = int(v_mc.w + 0.5); csFi.featureIds.featureId_1 = 0; csFi.metadata = csMetaOf(v_uvm);\n\tfragmentMain(csFi, csM);\n" : "")
		 + "\tvec3 csN = normalize(transpose(u_csV) * csM.normalEC);\n"
		 + "\tbase = csUnlit ? pow(max(csM.diffuse, 0.0), vec3(1.0 / 2.2)) : u_csOn > 0.5 ? csLitM(csM, csN) : pow(max(csM.diffuse, 0.0), vec3(1.0 / 2.2)) * d;   // UNLIT＝Cesium の lightingStage（diffuse を sRGB へ・トーンマップ無し）\n"
		 + "\tif (u_csMode.y > 0.5) a = clamp(csM.alpha, 0.0, 1.0);\n"
		 + "\tif (false) base = csLit("],
	], "MESH_CS_FS");
	return { vs, fs };
}

// 地形サーフェス：標高で変位した格子メッシュ。hillshade は FS で per-pixel に計算＝
// VS の標高フェッチを5回/頂点（変位1+中央差分勾配4）→1回に削減（格子236万頂点＝毎フレーム~950万フェッチの削減）。
// FS側は可視フラグメント数ぶんの3フェッチ＝総量でも減る上、頂点補間よりシャープな陰影になる。
export const TERRAIN_VS = `#version 300 es
precision highp float;
in vec2 a_uv;      // 単位格子 [0,1]²（メッシュは G だけに依存＝窓が動いても作り直さない）
uniform vec4 u_mesh;   // xy=窓の原点(lon,lat)  zw=窓の幅(deg)
${PROJECT}
// Cesium の霧（csatmo.ts csFogV・頂点で色と量）：u_csFogD＝濃さ（0＝なし）・u_csFogL＝xyz 光へ向く単位ベクトル・w 照明あり 1／なし −1
uniform float u_csFogD;
uniform vec4 u_csFogL;
${CS_ATMO_GLSL}
out vec4 v_csFog;
out vec2 v_ll;
out float v_front;
out float v_fog;
out float v_h;
uniform vec4 u_cogMesh;   // COG uv＝off+a_uv×scale（メッシュ窓→COG bbox の変換を JS f64 前計算）
out vec2 v_cuv;
uniform vec4 u_gndMesh0;  // 地面アトラス（前景/近/中/遠）＝同じ変換（JS f64 前計算）
uniform vec4 u_gndMesh1;
uniform vec4 u_gndMesh2;
uniform vec4 u_gndMesh3;
out vec2 v_guv0;
out vec2 v_guv1;
out vec2 v_guv2;
out vec2 v_guv3;
void main() {
	vec2 a_ll = u_mesh.xy + u_mesh.zw * a_uv;   // 絶対 lon/lat（旧・頂点属性を単位格子＋uniform へ）
	v_cuv = u_cogMesh.xy + a_uv * u_cogMesh.zw;
	v_guv0 = u_gndMesh0.xy + a_uv * u_gndMesh0.zw;
	v_guv1 = u_gndMesh1.xy + a_uv * u_gndMesh1.zw;
	v_guv2 = u_gndMesh2.xy + a_uv * u_gndMesh2.zw;
	v_guv3 = u_gndMesh3.xy + a_uv * u_gndMesh3.zw;
	vec2 dDeg = a_ll - u_origin;              // 原点相対 (deg)。renderer は terrain に scenes.main.origin を渡す
	vec3 rel = deltaToRel(dDeg);              // 頂点3D − 原点3D（小・正確）
	vec3 dir = u_originPt + rel;              // 絶対単位球点（df/front/fog は粗くて可）
	// 遠景は変位を距離フェードで平ら化＝grazing(すれすれ角)で粗いメッシュ格子が縦壁に見えるのを消す。
	// 開始はフォグがほぼ霞み切る距離から＝可視域の山（中央・北アルプス等）は立体のまま、
	// シルエットが霞に溶けた先だけ平ら化（fogNear基準だと100km先の山脈が丸ごと潰れて見えなくなる）。
	float df = 1.0 - smoothstep(u_fogFar * 0.8, u_fogFar * 2.0, distance(u_eye, dir));
	float h = elev(a_ll) * df;
	v_h = h;
	v_ll = a_ll;
	vec3 relW = rel + (h * u_elevScale) * liftDir(a_ll, dir);   // (dir*(1+h*scale)) − 原点3D を相殺なしで（楕円体＝測地法線）
	v_front = dot(u_eye, u_eye) < 1.0 ? 1.0 : dot(dir, u_eye) - 1.0;
	v_fog = fogOf(u_originPt + relW);
	v_csFog = csFogV(u_eye * CS_R, (u_originPt + relW) * CS_R, u_csFogD, u_csFogL.xyz, u_csFogL.w);
	gl_Position = u_clipT + u_mvp * vec4(relW, 0.0);
	applyLogDepth();
}`;

// 全球ハイプソ（NEラスタの美しさを標高から計算で作る）共通チャンク：GLOBE_FS（真俯瞰の球面＝海と全球の陸）と
// TERRAIN_FS（チルト時の地形面）で同一式＝ピッチを変えても陸の色が変わらない。u_whK=出現度（CPU側で
// knob(view.worldHypso)×ズームフェード。0=恒等＝従来の紙/単色陰影）。
// ・5段ランプ：低地の緑→黄緑→砂→茶灰→高峰の白
// ・arid＝乾燥帯補正：標高だけの古典ハイプソはサハラ(300m)が緑になる。NE の cross-blend（気候）を
//   「砂漠は回帰線帯（馬緯度）に並ぶ」という緯度近似で代用＝低地の緑を砂色へ寄せる
// ・snow＝氷床の白：南極（南緯60°以南は無条件）＋グリーンランド氷床（高緯度×氷床標高。低標高の
//   スカンジナビアは緑のまま）
// ・末尾のわずかな脱彩度＝NE1系の落ち着いた色域へ
// ユーザ COG（geopbf/cog が等経緯度整列 RGBA へ warp 済み）。uv は呼び出し側が「原点相対の小値 × f64 前計算係数」で
// VS にて組む（u_cogOffInv/u_cogMesh）＝絶対経緯度を f32 で引かない（サブメートル COG の位置ジッタ根治＝
// meshBbox の off+rel×inv 方式と同族）。アトラスは行0=北＝v 反転。α合成＝下色の上に被せる（nodata/圏外は素通し）。
// 見比べ（2 枚組・2026-10-27）＝同じ窓の 2 枚を縦に積んだアトラス（上半分＝A・下半分＝B）。u_cogPair＝(組か, 境の u, 半テクセル, 0)：
// u＜境＝A・u≥境＝B（境＝経度の線＝地面に引く縦の境）。半分の端は半テクセル内へ寄せる＝線形補間が隣の絵を混ぜない。
const COG = /* glsl */`
uniform sampler2D u_cogTex;
uniform float u_hasCog;
uniform vec4 u_cogPair;
vec3 cogTexMix(vec3 col, vec2 uv) {
	if (u_hasCog < 0.5) return col;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return col;
	float v = 1.0 - uv.y;
	if (u_cogPair.x > 0.5) v = clamp(v * 0.5, u_cogPair.z, 0.5 - u_cogPair.z) + (uv.x >= u_cogPair.y ? 0.5 : 0.0);
	vec4 c = texture(u_cogTex, vec2(uv.x, v));
	return mix(col, c.rgb, c.a);
}`;

// 地面アトラス（RTT ドレープ・2026-09-21）：ラスタ基図→ベクタ塗り（3D 時）→ラスタ重ね を renderer が経緯度整列の 3 段窓
// （近/中/遠・前乗算）へ合成し、地形・球・塗りの FS が COG と同じ場所で画素標本化する＝地形面そのものに写る（幾何の不一致ゼロ）。
// uv の v＝(lat−S)/span（GL の FBO は行0＝南＝反転なし）。3 枚とも無条件に標本化してから選ぶ（分岐内の texture() は LOD 未定義）。
const GND = /* glsl */`
uniform sampler2D u_gnd0;
uniform sampler2D u_gnd1;
uniform sampler2D u_gnd2;
uniform sampler2D u_gnd3;
uniform float u_gndN;   // 有効な窓の数（0..4・細かい順＝前景/近/中/遠）
uniform float u_gndSplit;   // 分割（Cesium の ImageryLayer.splitDirection）の画面 x（device px）｜負＝分割なし。窓は左右の半分に焼いてある
float gndEdge(vec2 uv) {   // 窓内 1・縁 4% で 0 へ・外 0
	vec2 d = min(uv, 1.0 - uv);
	return clamp(min(d.x, d.y) / 0.04, 0.0, 1.0);
}
vec2 gndUV(vec2 uv) {   // 窓 uv → テクスチャ uv（分割時は画面の x で左右の半分を選ぶ。半分の縁は数 texel 内へ寄せる＝隣の半分が滲まない）
	uv = clamp(uv, 0.0, 1.0);
	if (u_gndSplit >= 0.0) uv.x = clamp(uv.x * 0.5, 0.002, 0.498) + (gl_FragCoord.x >= u_gndSplit ? 0.5 : 0.0);
	return uv;
}
vec3 gndMix(vec3 col, vec2 uv0, vec2 uv1, vec2 uv2, vec2 uv3) {
	if (u_gndN < 0.5) return col;
	vec4 c0 = texture(u_gnd0, gndUV(uv0));
	vec4 c1 = texture(u_gnd1, gndUV(uv1));
	vec4 c2 = texture(u_gnd2, gndUV(uv2));
	vec4 c3 = texture(u_gnd3, gndUV(uv3));
	// 窓の縁 4% はひとつ外の窓へクロスフェード＝解像度の段差を溶かす（w=1 で内側・0 で外側。前乗算同士の線形補間）
	float w0 = gndEdge(uv0), w1 = u_gndN > 1.5 ? gndEdge(uv1) : 0.0, w2 = u_gndN > 2.5 ? gndEdge(uv2) : 0.0, w3 = u_gndN > 3.5 ? gndEdge(uv3) : 0.0;
	vec4 c = mix(mix(mix(mix(vec4(0.0), c3, w3), c2, w2), c1, w1), c0, w0);
	return col * (1.0 - c.a) + c.rgb;   // アトラスは前乗算＝over 合成
}
// 前乗算の床（rgb·a, a）の上にアトラスを over（B5＝background 層の無い MapLibre の地図は床が透明＝塗りだけが残る。a=1 なら gndMix と同じ値）
vec4 gndOver(vec4 col, vec2 uv0, vec2 uv1, vec2 uv2, vec2 uv3) {
	if (u_gndN < 0.5) return col;
	vec4 c0 = texture(u_gnd0, gndUV(uv0));
	vec4 c1 = texture(u_gnd1, gndUV(uv1));
	vec4 c2 = texture(u_gnd2, gndUV(uv2));
	vec4 c3 = texture(u_gnd3, gndUV(uv3));
	float w0 = gndEdge(uv0), w1 = u_gndN > 1.5 ? gndEdge(uv1) : 0.0, w2 = u_gndN > 2.5 ? gndEdge(uv2) : 0.0, w3 = u_gndN > 3.5 ? gndEdge(uv3) : 0.0;
	vec4 c = mix(mix(mix(mix(vec4(0.0), c3, w3), c2, w2), c1, w1), c0, w0);
	return col * (1.0 - c.a) + c;
}`;

// 地面の材質（setGroundMaterial・CesiumJS の globe.material・2026-10-28）：地形面と球の床の画像の上に、標高／傾斜／方位の
// ランプ（1 列の色の表）・等高線・「陸だけ」を重ねる（Cesium の ElevationRamp・SlopeRamp・AspectRamp・ElevationContour・
// ElevationBand（ランプに焼く）・WaterMask の逆）。gpu/wgsl.ts GM_WGSL と同式。
const GM = /* glsl */`
uniform vec4 u_gm;        // (種類 0 なし／1 標高／2 傾斜／3 方位／4 等高線だけ, 最低標高 m, 1/(最高−最低), 陸だけ 0/1)
uniform vec4 u_gmC;       // 等高線の色 rgba（a=0 なし）
uniform vec4 u_gmP;       // (等高線の間隔 m, 太さ px, 材質の不透明度, 0)
uniform sampler2D u_gmRamp;
// h＝標高 m・gEN＝勾配（東・北 m/m）・dh＝fwidth(h)。戻り＝材質の色（rgb・a）。傾斜＝法線と上の角 0..π/2 を 0..1 に・
// 方位＝法線の水平成分（下り向き）の東から反時計回りの角 0..2π を 0..1 に（Cesium の GlobeVS と同じ）
vec4 gmColor(float h, vec2 gEN, float dh) {
	float k = u_gm.x;
	vec4 m = vec4(0.0);
	if (k < 3.5) {
		float v = k < 1.5 ? clamp((h - u_gm.y) * u_gm.z, 0.0, 1.0)
			: k < 2.5 ? acos(inversesqrt(1.0 + dot(gEN, gEN))) / 1.5707963267948966
			: fract(atan(-gEN.y, -gEN.x) / 6.283185307179586 + 1.0);
		m = texture(u_gmRamp, vec2(v, 0.5));
	}
	if (u_gmC.a > 0.0 && mod(h, u_gmP.x) < dh * u_gmP.y) m = u_gmC;   // 等高線（Cesium の ElevationContour）＝標高の画素差 × 太さ の帯
	if (u_gm.w > 0.5 && h <= 0.0) m.a = 0.0;   // 陸だけ（WaterMask の逆）＝標高 0 以下（海面）は塗らない
	m.a *= u_gmP.z;
	return m;
}`;
const WORLD_HYPSO = /* glsl */`
uniform float u_whK;
uniform sampler2D u_climTex;   // 気候場 720x360（Köppen-Geiger/Beck et al. CC-BY を焼き縮め）R=乾燥度 G=極地/氷床
uniform float u_hasClim;       // 0=未着（緯度近似フォールバック） 1=気候場で本物の cross-blend
// テーマパレット（正準既定＝worldpal.js・view.worldHypso で部分上書き）。式・標高帯はテーマ不変＝色だけ差し替え
uniform vec3 u_whLowH, u_whLowA;   // 低地 湿潤/乾燥
uniform vec3 u_whMidH, u_whMidA;   // 〜400m 湿潤/乾燥
uniform vec3 u_whR1, u_whR2, u_whPeak, u_whSnow;   // 400-1300 / 1300-2800 / 2800-4800 / 氷床
float wetBox(vec2 ll, vec4 b) {   // b=(lon0,lon1,lat0,lat1)・縁3°ソフト（気候場未着時のフォールバック用）
	return smoothstep(b.x - 3.0, b.x + 3.0, ll.x) * (1.0 - smoothstep(b.y - 3.0, b.y + 3.0, ll.x))
	     * smoothstep(b.z - 3.0, b.z + 3.0, ll.y) * (1.0 - smoothstep(b.w - 3.0, b.w + 3.0, ll.y));
}
vec3 worldHypso(float e, vec2 ll) {
	float latD = ll.y;
	float al = abs(latD);
	float arid, pol;
	if (u_hasClim > 0.5) {
		// 本物の cross-blend：気候場テクスチャ（海は焼き時に最寄り陸の値で充填済＝海岸で値が落ちない）
		vec2 c2 = texture(u_climTex, vec2(fract(ll.x / 360.0 + 0.5), 0.5 - latD / 180.0)).rg;   // 経度は一周で折り返す
		arid = c2.r; pol = c2.g;
	} else {
		// フォールバック＝緯度近似（馬緯度の乾燥帯×湿潤東岸の打ち消し箱）。気候場が届くまでの1-2フレーム用
		arid = smoothstep(10.0, 17.0, al) * (1.0 - smoothstep(32.0, 45.0, al));
		float wet = wetBox(ll, vec4(95.0, 148.0, 17.0, 40.0));
		wet = max(wet, wetBox(ll, vec4(118.0, 150.0, 40.0, 55.0)));
		wet = max(wet, wetBox(ll, vec4(-100.0, -70.0, 24.0, 40.0)));
		wet = max(wet, wetBox(ll, vec4(-63.0, -35.0, -35.0, -15.0)));
		wet = max(wet, wetBox(ll, vec4(74.0, 95.0, 8.0, 30.0)));
		arid *= 1.0 - wet;
		pol = 1.0 - smoothstep(-64.0, -58.0, latD);   // 逆順smoothstepはGLSL仕様未定義＝正順で等価書換（WGSL移植と同式）
	}
	vec3 low = mix(u_whLowH, u_whLowA, arid);
	vec3 mid = mix(u_whMidH, u_whMidA, arid);
	vec3 c = mix(low, mid, smoothstep(0.0, 400.0, e));
	c = mix(c, u_whR1, smoothstep(400.0, 1300.0, e));
	c = mix(c, u_whR2, smoothstep(1300.0, 2800.0, e));
	c = mix(c, u_whPeak, smoothstep(2800.0, 4800.0, e));
	// 雪/氷：気候場の極地チャンネル（EF=1・ET≈0.55）＋高緯度×氷床標高（グリーンランド内陸の保険）
	float snow = pol + smoothstep(56.0, 62.0, latD) * smoothstep(1100.0, 1900.0, e);
	c = mix(c, u_whSnow, clamp(snow, 0.0, 1.0));
	return mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))), 0.10);
}
`;

export const TERRAIN_FS = `#version 300 es
precision highp float;
uniform vec3 u_fogColor;
uniform vec3 u_land;
uniform float u_landA;   // 床の不透明度（B5）＝globe パスの u_land.a と同じ（background 層の無い MapLibre の地図＝0）。1＝従来とビット同一
uniform vec3 u_hypso;    // 標高ティント色（高所を land からこの色へ寄せる＝控えめな標高彩色）
uniform vec2 u_hypsoP;   // x=1/最大標高(m)（この高さで寄せ切る） y=寄せ量(0=無効…1=全置換)
uniform vec4  u_cg;          // 地面の照明（setGroundLighting・Cesium の globe.enableLighting・2026-10-26）：xyz＝光へ向く単位ベクトル（世界）・w＝0 無し／1 地形の法線／2 楕円体の上向き
uniform vec4  u_cgP;         // (lambert の倍率, 足す値, 効き 0..1＝距離のフェード済み, 大気の夜側の明るさ 0.05..1・負＝暗くしない)
uniform vec3  u_cgC;         // 光の色（czm_lightColor）
// 経緯度（deg）の点の東・北・上（世界軸＝ECEF の (x, z, y)）での lambert：n＝勾配（東・北・m/m）から、mode 2 は上向き
float cgLambert(vec2 ll, vec2 gEN, float mode) {
	vec2 lr = ll * 0.017453292519943295;
	float cl = cos(lr.y), sl = sin(lr.y), co = cos(lr.x), so = sin(lr.x);
	vec3 L = vec3(dot(u_cg.xyz, vec3(-so, 0.0, co)), dot(u_cg.xyz, vec3(-sl * co, cl, -sl * so)), dot(u_cg.xyz, vec3(cl * co, sl, cl * so)));   // 東・北・上
	vec3 n = mode > 1.5 ? vec3(0.0, 0.0, 1.0) : normalize(vec3(-gEN, 1.0));
	float diff = clamp(max(dot(n, L), 0.0) * u_cgP.x + u_cgP.y, 0.0, 1.0);
	return mix(1.0, diff, u_cgP.z);
}
uniform float u_globeAlpha;   // 球体の不透明度（globe パスと同じ値＝地形面も一緒に透ける）
uniform float u_terrNeg;      // 1＝負の標高をそのまま描く DEM（Cesium World Terrain の楕円体高・海底）＝低地フェードを止める：透かした先の 0m の球に地面が化けると、海面が −30m のサンフランシスコで地面ごと 30m 浮く（2026-10-31）
uniform float u_farPass;   // 1=遠景メッシュパス：近窓の内側は近メッシュの担当＝discard（二重描画・z-fight回避）・2=近景メッシュパス（近景層の窓だけ・主パスはその内側を discard）
${ELEV}
${WORLD_HYPSO}
${GM}
${COG}
${GND}
in vec2 v_guv0;
in vec2 v_guv1;
in vec2 v_guv2;
in vec2 v_guv3;
in vec2 v_cuv;
in vec2 v_ll;
in float v_front;
in float v_fog;
in float v_h;
in vec4 v_csFog;   // Cesium の霧（頂点で計算・csFogV）
out vec4 fragColor;
void main() {
	float mpp = fwidth(v_ll.y) * 111320.0;   // 画素の地上寸法(m)の目安＝下の低地フェード帯の上端（WGSL terrMpp と同式・経度は f32 刻みが粗いので使わない）。微分は discard より前
	if (v_front < -0.0015) discard;   // 海抜0の接線より少し先まで許容＝地平線の先に頭を出す高山（〜9km球換算）を描く。遮蔽は深度とフォグが担う
	if (u_farPass > 0.5 && u_farPass < 1.5) {   // 遠景パスは近窓の内側を塗らない。縁の座標一致は連続な elev()（近縁が遠層値へ溶ける）が保証
		vec2 uvN = (v_ll - u_elevBounds.xy) / u_elevBounds.zw;
		if (uvN.x >= 0.0 && uvN.x <= 1.0 && uvN.y >= 0.0 && uvN.y <= 1.0) discard;
	}
	if (u_farPass < 0.5 && u_hasNear > 0.5) {   // 主パスは近景層の窓の内側を塗らない（近景メッシュパスの担当。縁の連続は elevNear の溶かしが保証）
		vec2 uvF = (v_ll - u_nearBounds.xy) / u_nearBounds.zw;
		if (uvF.x >= 0.0 && uvF.x <= 1.0 && uvF.y >= 0.0 && uvF.y <= 1.0) discard;
	}
	if (u_farPass > 1.5 && u_farPass < 2.5 && u_hasFine > 0.5) {   // 近景メッシュパスは足元層の窓の内側を塗らない（足元メッシュパス u_farPass=3 の担当）
		vec2 uvG = (v_ll - u_fineBounds.xy) / u_fineBounds.zw;
		if (uvG.x >= 0.0 && uvG.x <= 1.0 && uvG.y >= 0.0 && uvG.y <= 1.0) discard;
	}
	// 海〜低地は地形を透明化し、海岸線は精細なベクタに委ねる。低地から滑らかに陰影を立ち上げ、
	// 粗い標高メッシュが海岸で作る「崖」のガタつき・平野のノイズを消す。
	// 帯の上端＝画素 2 個分の標高（1〜100m）：透けた先は海抜0の球の床（同じ地面アトラス）＝チルトで h·tanθ ずれた
	// 二重像になる（京都 40m×60° で堀が 70m ずれる）。ずれが 2px 未満の高さでだけ透かす（wgsl.js TERRAIN_WGSL と同式）。
	float t = u_terrNeg > 0.5 ? 1.0 : smoothstep(1.0, clamp(2.0 * mpp, 2.0, 100.0), v_h);
	if (t <= 0.0) discard;
	// 北西光の hillshade（前方差分＝中央差分の半分のフェッチ）。
	// 歩幅＝アトラス1texel（下限は従来の0.004°≈450m＝近景は不変）。固定歩幅はズームアウトで
	// texel未満に落ち「鈍った勾配×小さい歩幅」で陰影がベタ灰色に消えていた（広域の塗りの甘さ）。
	// texel差分＝アトラスが持つ最小起伏を常に同じゲインで見せる＝どのスケールでも塗りが痩せない。
	// 遠層域は下限 0.004°≈450m がそのまま R10 texel（463m）＝遠景の歩幅として妥当（別計算しない）。
	vec2 tsz = vec2(textureSize(u_elevTex, 0));
	float d = max(0.004, u_elevBounds.w / tsz.y);
	float dTex = u_elevBounds.w / tsz.y;   // アトラス 1 texel（勾配・材質用）
	float shadeK = 1.0;
	float h0 = elev(v_ll);
	if (u_farPass > 1.5) {   // 近景メッシュパス：歩幅は近景層の 1 texel（下限 0.004° を外す）・陰影の利得は歩幅比で揃える（＝勾配換算・見た目の濃さ不変）
		// ただし R16F の刻み q（1024〜2048 m で 1 m）の 32 倍を下限に＝1 texel 差分が丸め 1 段を勾配に化けさせて粒々の陰影になった（2026-10-31・wgsl と同式）
		float q = exp2(floor(log2(max(abs(h0), 1.0))) - 10.0);
		float nbw = u_farPass > 2.5 ? u_fineBounds.w : u_nearBounds.w;   // 足元メッシュパス（3）は足元層の 1 texel
		dTex = max(nbw / float(textureSize(u_nearElevTex, 0).y), q * 32.0 / 111320.0);
		shadeK = 0.004 / max(dTex, 1e-6); d = dTex;
	}
	float hx = elev(v_ll + vec2(d, 0.0)) - h0;
	float hy = elev(v_ll + vec2(0.0, d)) - h0;
	float shade = clamp(0.82 + (-hx + hy) * 0.0007 * shadeK, 0.45, 1.15);
	float cgK = 1.0;   // 地面の照明（Cesium）＝北西の陰影の代わりに太陽の lambert を画像ごと掛ける
	float gmDh = fwidth(h0);   // 地面の材質の等高線＝標高の画素差（一様な制御の流れで）
	vec2 gmEN = vec2(0.0);   // 勾配（東・北 m/m）＝地面の照明と材質（傾斜・方位）が使う。アトラスの 1 texel 差分（陰影の 0.004° の下限を使わない＝近景の急斜面が鈍らない）。影の派生（TERR_SUN_SHADE）の gEN とは別名
	if (u_cg.w > 0.5 || u_gm.x > 1.5) {
		float dL = dTex, hxL = elev(v_ll + vec2(dL, 0.0)) - h0, hyL = elev(v_ll + vec2(0.0, dL)) - h0;
		gmEN = vec2(hxL / (dL * 111320.0 * max(cos(v_ll.y * 0.017453292519943295), 0.01)), hyL / (dL * 111320.0));
	}
	if (u_cg.w > 0.5) { shade = 1.0; cgK = cgLambert(v_ll, gmEN, u_cg.w); }
	// 標高ティント：land を高所ほど u_hypso へ寄せる（テーマのノブ＝未指定は y=0 で恒等）。陰影の前＝shade が上に乗る
	vec3 landC = mix(u_land, u_hypso, clamp(h0 * u_hypsoP.x, 0.0, 1.0) * u_hypsoP.y);
	landC = mix(landC, worldHypso(h0, v_ll), u_whK);   // 全球ハイプソ（低ズーム帯）＝globe パスと同色でピッチ不変
	// 深度は VS の applyLogDepth() が焼き済み（mesh/building と一貫。FSで書くと early-Z が死ぬ）
	// 陰影の立ち上がりは従来の 1〜100m 帯のまま（低地＝陰影なしの紙色）＝不透明化した分を床と同色で埋める（wgsl.js と同式・低ズームは旧式と恒等）
	float tS = smoothstep(1.0, 100.0, v_h);
	float ba = mix(u_landA, 1.0, max(u_whK, u_hasCog));   // 床の不透明度（B5）＝全球ハイプソ・COG は不透明
	vec4 g = gndOver(vec4(cogTexMix(landC * mix(1.0, shade, min(tS / t, 1.0)), v_cuv) * ba, ba), v_guv0, v_guv1, v_guv2, v_guv3);   // ユーザ COG／地面アトラス（ラスタ＋3D の塗り）＝陰影の上・フォグの下
	if (u_gm.x > 0.5) { vec4 m = gmColor(h0, gmEN, gmDh); g = vec4(g.rgb * (1.0 - m.a) + m.rgb * m.a, max(g.a, m.a)); }   // 地面の材質（Cesium の globe.material）＝画像の上・照明の下
	if (u_cg.w > 0.5) g.rgb *= u_cgC * cgK;
	vec3 col = g.rgb * (1.0 - v_fog) + u_fogColor * v_fog * g.a;   // ＝mix(colBase, fog, v_fog) を前乗算で
	col = mix(col, v_csFog.rgb * g.a, v_csFog.a);   // Cesium の霧（800 km より下・遠景球の csFogL と同じ式）
	fragColor = vec4(col * t * u_globeAlpha, g.a * t * u_globeAlpha);   // premultiplied（globe基色→地形へ滑らかに）× 球体の不透明度
}`;

// stencil-then-cover の塗り（earcut不要でロバスト）。ortho-map の 2-sided winding を透視mat4へ移植。
// stencilパス：ポリゴンの fan 三角形を色を書かず stencil へ（FRONT +1 / BACK -1）。球の前後半球も相殺。
// カリングなし＝巻き数を壊さず内側を正しく塗る（裏抜けは残るが LOD で本質的に消える）。
export const STENCIL_VS = `#version 300 es
precision highp float;
in vec2 a_delta;
${PROJECT}
${QELEV}
uniform float u_lift;   // 地形からのリフト(m)。塗り(fan)を地形にドレープ＝海抜0平面でなく地形表面へ（境界線と一致）
uniform float u_sphereClip;   // 1＝裏半球の頂点を地平円（可視半球の縁）へ射影クランプ（wdepr＝全球スケールのポリゴン用）。
                              // 裏側ポリゴンは円周上に縮退＝巻き数0で消え、地平線を跨ぐポリゴンは可視部だけを正しく囲む
                              // ＝投影の折返しが円盤内に作る±1の巻き数斑（GL/WebGPUで符号が逆＝ref方式では殺しきれない
                              // 裏半球の幻影・2026-09-02 実測）を根絶。既定0＝従来のoverlay（局所ポリゴン）は完全不変。
void main() {
	// 塗り(fan)を FILL_VS と同じ標高変位で地形にドレープ。elev 無しだと海抜0の平面に貼られ、
	// 地形に沿う境界線と乖離して浮く（本人報告 2026-08-12・豊浦町ハイライト）。WebGPU vsStencil と対。
	vec2 ll = u_origin + a_delta;
	vec3 rel = deltaToRel(a_delta);
	vec3 dir = u_originPt + rel;
	float df = 1.0 - smoothstep(u_fogFar * 0.8, u_fogFar * 2.0, distance(u_eye, dir));
	float h = (elevQ(ll) + u_lift) * u_elevScale * df;   // 案A＝overlay 塗りも描画メッシュ面に乗せる
	vec3 relW = rel + h * liftDir(ll, dir);
	if (u_sphereClip > 0.5) {
		vec3 P = u_originPt + relW;                  // 絶対位置（単位球近傍）
		float e2 = dot(u_eye, u_eye);
		if (dot(P, u_eye) < 1.0) {                   // 裏半球（可視条件は dot(P,E)>1＝接円）
			vec3 Pp = P - u_eye * (dot(P, u_eye) / e2);   // E 直交成分＝地平円の向き
			float lp = length(Pp);
			vec3 t = lp > 1e-6 ? Pp / lp : normalize(vec3(-u_eye.z, 0.0, u_eye.x));
			P = u_eye / e2 + sqrt(max(1.0 - 1.0 / e2, 0.0)) * t;   // 地平円（中心 E/|E|²・半径 √(1-1/|E|²)）上へ
			relW = P - u_originPt;
		}
	}
	gl_Position = u_clipT + u_mvp * vec4(relW, 0.0);   // RTE：塗りは巻き数で決まるので fan の形は問わない・地形にドレープ
}`;
export const STENCIL_FS = `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(0.0); }`;   // colorMask off で無視される
// coverパス：フルスクリーンを描き、stencil≠0 の画素だけ塗る（GLOBE_VS を流用）。
export const COVER_FS = `#version 300 es
precision highp float;
uniform vec4 u_fill;
out vec4 o;
void main() { o = vec4(u_fill.rgb * u_fill.a, u_fill.a); }`;   // premultiplied

// 球体本体：フルスクリーン三角形の各画素でカメラ光線×単位球。当たれば land色、外れれば宇宙(discard)。
export const GLOBE_VS = `#version 300 es
precision highp float;
out vec2 v_ndc;
void main() {
	vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
	v_ndc = p;
	gl_Position = vec4(p, 0.0, 1.0);
}`;

export const GLOBE_FS = `#version 300 es
precision highp float;
// 全画面レイキャスト（#65・2026-09-27）：視線の基底は CPU f64（camera.js viewRays）＝invMvp（f32）の積和をしない。
// 交点は近い根を t＝2c/(−b＋√h)（c＝|E|²−1 は CPU f64）＝桁落ちなし。後ろ向き（q≤0）＝t<0。A＝目・d＝視線（clip w＝1 の長さ）
uniform vec3 u_rayF, u_rayX, u_rayY, u_rayE;
uniform float u_rayC;
uniform vec3 u_rayO, u_rayEO;   // 錨：シーン原点の β単位球の点 O・目−O（f64 で引く）＝交点 δ＝u_rayEO＋t·d（原点相対・f32 で mm 級）
uniform vec4 u_rayLL;           // (原点 lon, lat（deg・測地）, β0（rad）, cos β0)
vec3 rayDir(vec2 ndc) { return u_rayF + ndc.x * u_rayX + ndc.y * u_rayY; }
float sphereT(float bb, float disc) { if (disc < 0.0 || (bb >= 0.0 && u_rayC >= 0.0)) return -1.0; float q = -bb + sqrt(disc); return q > 0.0 ? 2.0 * u_rayC / q : -1.0; }   // 外から上向き（bb≥0）は前に交点なし：q＝−b＋√(b²−4c) は c≈0（目が地面すれすれ）で丸めの ±1ulp になり、実 GPU の sqrt では空の画素が地面に化けた（2026-10-28 Cesium 花火）
// δ から経緯度の差（deg・測地）を桁落ちなしで（wgsl.js deltaLL と同式）：δlon＝atan2(δz·Ox−δx·Oz, ρO²+δx·Ox+δz·Oz)・δβ は ρ の差も s/(ρP+ρO) で
vec2 deltaLL(vec3 dl, float ell) {
	vec3 O = u_rayO; float rhoO = u_rayLL.w, beta0 = u_rayLL.z;
	float dlon = atan(dl.z * O.x - dl.x * O.z, rhoO * rhoO + dl.x * O.x + dl.z * O.z);
	float s = 2.0 * (O.x * dl.x + O.z * dl.z) + dl.x * dl.x + dl.z * dl.z;
	float rhoP = sqrt(max(rhoO * rhoO + s, 0.0));
	float drho = s / max(rhoP + rhoO, 1e-12);
	float dbeta = atan(dl.y * rhoO - drho * O.y, rhoP * rhoO + (O.y + dl.y) * O.y);
	float b1 = beta0 + dbeta;
	float corr = ell * (0.0016792203863837047 * (sin(2.0 * b1) - sin(2.0 * beta0)) + 0.0000014098905530233192 * (sin(4.0 * b1) - sin(4.0 * beta0)));
	return vec2(dlon, dbeta + corr) * 57.29577951308232;
}
uniform vec4 u_land;
uniform vec4 u_atmo;   // 大気色 rgb + 強さ(a)
// style の sky（B4・MapLibre の setSky）＝簡易の空：地平線の horizon-color から天頂の sky-color へのグラデーション（球に当たらない光線だけ・不透明）。
// 無指定（u_skyOn=0）＝従来の宇宙へ抜けるリム光とビット同一。u_skyBlend＝(sky-horizon-blend, horizon-fog-blend, atmosphere-blend, 0)
uniform float u_skyOn;
uniform vec3 u_skyColor;
uniform vec3 u_horizonColor;
uniform vec3 u_skyFogColor;
uniform vec4 u_skyBlend;
// Cesium の大気（view.csAtmo・../csatmo.ts）＝(点ける 0/1, 地面の大気の効き 0..1, 空の大気 0/1, 霧の濃さ＝csFogDensity)。点けると従来の霞・リム光・sky の代わり
uniform vec4 u_csAtm;
${CS_ATMO_GLSL}// 全球ハイプソ（NEラスタの美しさを標高から計算で作る＝ラスタタイル配布ゼロ）：
// レイ→球→測地緯度→elev() は CONTOUR_FS と同式。R90 全球窓（z<6.5 は bounds=[-180,-90,360,180]）を引く。
// 配色本体は WORLD_HYPSO（TERRAIN_FS と共有＝ピッチで色が変わらない）。
uniform sampler2D u_elevTex;
uniform vec4 u_elevBounds;
uniform float u_hasElev;
uniform float u_ell;      // 1=楕円体（β→測地復元。球=0＝恒等）
uniform vec3 u_seaC;      // 海の平色（NE流の淡青）
${GM}
in vec2 v_ndc;
out vec4 fragColor;
const float R2D = 57.29577951308232;
// far床＝近窓の外を受ける第2アトラス（世界帯z<8はR90全球固定窓＝terrain.jsのB形態）。
// R90/R10境界5.5化で「近窓=全球」の前提が崩れ、窓外の陸が標高0＝海色に抜けた（スカンジナビア/シベリア
// 実測 9/2＝本人発見「タイラーのバグ」）。terrain elev() と同じフォールバック＝カバーの床。
uniform sampler2D u_farElevTex;
uniform vec4 u_farBounds;
uniform float u_hasFar;
uniform float u_elevEdgeFade;   // 近窓縁＝far値へ溶かす幅(deg)。R90全球窓=0（縁は極/±180のみ）
float elevFar(vec2 ll) {
	if (u_hasFar < 0.5) return 0.0;
	ll.x -= 360.0 * floor((ll.x + 180.0) / 360.0);   // 経度を -180..180 へ（原点相対の経度は ±180 を越えうる）
	vec2 uv = (ll - u_farBounds.xy) / u_farBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
	return texture(u_farElevTex, uv).r;
}
float elevUV(vec2 uv, vec2 ll) {   // uv＝原点相対で作った近窓の uv（#65）・ll＝far 床の受け（粗くて可）
	if (u_elevBounds.z > 359.0) uv.x = fract(uv.x);   // 全球の窓（R90）は経度が一周＝原点から 180° 超回った先の uv を折り返す（gpu/wgsl.js gElevUV と同じ・2026-10-01）
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return elevFar(ll);
	float fade = 1.0;
	if (u_elevEdgeFade > 0.0) {
		vec2 w = vec2(u_elevEdgeFade) / u_elevBounds.zw;
		fade = min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
	}
	return mix(elevFar(ll), texture(u_elevTex, uv).r, fade);
}
float elevAt(vec2 ll) { return elevUV((ll - u_elevBounds.xy) / u_elevBounds.zw, ll); }
${WORLD_HYPSO}
${COG}
${GND}
uniform vec4 u_cogOff;    // 球の床の COG uv 係数（f64 前計算・#65）＝(原点の uv, 1/span)：uv＝off＋δll·inv（旧＝絶対経緯度→uv を廃止）
uniform vec4 u_gndOff0;   // 地面アトラス（前景/近/中/遠）＝同形
uniform vec4 u_gndOff1;
uniform vec4 u_gndOff2;
uniform vec4 u_gndOff3;
uniform vec4  u_cg;          // 地面の照明（setGroundLighting・Cesium の globe.enableLighting・2026-10-26）：xyz＝光へ向く単位ベクトル（世界）・w＝0 無し／1 地形の法線／2 楕円体の上向き
uniform vec4  u_cgP;         // (lambert の倍率, 足す値, 効き 0..1＝距離のフェード済み, 大気の夜側の明るさ 0.05..1・負＝暗くしない)
uniform vec3  u_cgC;         // 光の色（czm_lightColor）
// 経緯度（deg）の点の東・北・上（世界軸＝ECEF の (x, z, y)）での lambert：n＝勾配（東・北・m/m）から、mode 2 は上向き
float cgLambert(vec2 ll, vec2 gEN, float mode) {
	vec2 lr = ll * 0.017453292519943295;
	float cl = cos(lr.y), sl = sin(lr.y), co = cos(lr.x), so = sin(lr.x);
	vec3 L = vec3(dot(u_cg.xyz, vec3(-so, 0.0, co)), dot(u_cg.xyz, vec3(-sl * co, cl, -sl * so)), dot(u_cg.xyz, vec3(cl * co, sl, cl * so)));   // 東・北・上
	vec3 n = mode > 1.5 ? vec3(0.0, 0.0, 1.0) : normalize(vec3(-gEN, 1.0));
	float diff = clamp(max(dot(n, L), 0.0) * u_cgP.x + u_cgP.y, 0.0, 1.0);
	return mix(1.0, diff, u_cgP.z);
}
uniform float u_globeAlpha;   // 球体の不透明度（表示パネル「基図」を globe/terrain まで拡張＝本人裁定 2026-09-13。1=不透明・premultiplied なので rgb にも掛ける）
uniform vec4 u_ugC;    // 地下から見た球の裏面（Cesium の globe.undergroundColor）：rgb＋α・α<0＝切（目が地面の下の時だけ renderer が点ける）
uniform vec4 u_ugNF;   // undergroundColorAlphaByDistance＝(near, nearValue, far, farValue)・距離は世界単位
void main() {
	vec3 A = u_rayE, d = rayDir(v_ndc);   // #65：視線は CPU f64 の基底
	float aa = dot(d, d), bb = 2.0 * dot(A, d), cc = u_rayC;
	float disc = bb * bb - 4.0 * aa * cc;
	float aDotd = bb * 0.5, tstar = -aDotd / aa;
	float t = sphereT(bb, disc);   // 近い根を桁落ちなしで（disc<0 か後ろ向き＝−1）
	bool ug = false;   // 目が球の中（地下）＝前方の遠い根＝球の裏面（Cesium は裏面を undergroundColor で塗る）
	if (t < 0.0 && u_ugC.a >= 0.0 && cc < 0.0 && disc >= 0.0) { t = (-bb + sqrt(disc)) / (2.0 * aa); ug = true; }
	if (t < 0.0) {                                 // 前方に球ヒット無し＝空：地平の霞から宇宙へ連続に減衰
		if (u_csAtm.x > 0.5) {   // Cesium の空の大気（殻の奥の面で計る・星の上に α で重なる）
			if (u_csAtm.z < 0.5) discard;
			vec4 cs = csSkyL(A * CS_R, normalize(d), 0.0, u_cg.xyz, u_cg.w > 0.5 ? u_cgP.w : -1.0);   // lit by the sun with the globe's lighting (Cesium's dynamic atmosphere)
			if (cs.a <= 0.002) discard;
			fragColor = cs;
			return;
		}
		// ここには2種の光線が来る：(a)球ミス(disc<0)、(b)延長線は背後の地球に当たるが前方は素通り(t<0)。
		// 旧実装は両方 discard 系＝高チルト・低高度で「見上げ境界」「背後ヒット円錐」が画面を横切り、
		// ハロー帯が横一線でスパッと黒に切れて空が2段になった（ズームを上げるほど(b)の黒が下りてくる）。
		// 前方光線の球中心最接近距離：tstar<=0（水平より上向き＝(b)は必ずこちら）は視点自身が最接近＝length(A)。
		float lenA = length(A);
		float m = tstar > 0.0 ? sqrt(max((cc + 1.0) - aDotd * aDotd / aa, 0.0)) : lenA;
		float g = smoothstep(1.09, 1.0, m);
		// 高度角フェード：見上げるほど大気は薄く＝天頂へ滑らかに宇宙色。低高度では m≈lenA が一様なので、
		// これが無いと今度は空全体が一枚の紺に塗り潰される。
		float alt = dot(normalize(d), A / lenA);   // 視線の高度（上向きの余弦・地平線は水平より少し下）
		g *= 1.0 - smoothstep(0.0, 0.55, alt);
		if (u_skyOn > 0.5) {
			// 簡易の空（B4）：地平線（球に接する視線＝sin(俯角)=sqrt(1−1/|A|²)）を 0・天頂を 1 とした高さ u で horizon-color → sky-color。
			// sky-horizon-blend＝混ざる幅（1＝天頂まで・0＝地平線でスパッと）。地平線の際は fog-color を horizon-fog-blend の分だけ重ねる（15% の高さで消える）。
			// atmosphere-blend＝従来のリム光（大気の霞）を空の上に重ねる度合い。空は不透明＝星空は隠れる（MapLibre と同じ）
			float hz = -sqrt(max(1.0 - 1.0 / (lenA * lenA), 0.0));
			float u = clamp((alt - hz) / max(1.0 - hz, 1e-6), 0.0, 1.0);
			float w = u_skyBlend.x;
			float k = w <= 0.0 ? step(1e-6, u) : smoothstep(0.0, w, u);
			vec3 col = mix(u_horizonColor, u_skyColor, k);
			col = mix(col, u_skyFogColor, u_skyBlend.y * (1.0 - smoothstep(0.0, 0.15, u)));
			vec3 limbCol = mix(u_land.rgb, u_atmo.rgb, u_atmo.a * 0.9);
			float a = max(g, 0.0); a = a * a * mix(u_atmo.a, 1.0, a) * u_skyBlend.z;
			fragColor = vec4(col * (1.0 - a) + mix(u_atmo.rgb, limbCol, max(g, 0.0)) * a, 1.0);   // premultiplied・不透明
			return;
		}
		if (g <= 0.0 || u_atmo.a <= 0.0) discard;   // 大気の強さ 0（MapLibre の口＝sky の無い style）＝リム光も描かない（B5・旧＝強さ 0 でも床色の帯が宇宙へ滲んだ）
		// 縁(g=1)は球面リム内側の霞と同色・不透明＝地平線で色が連続。外側へ大気色→透明へフェード。
		vec3 limbCol = mix(u_land.rgb, u_atmo.rgb, u_atmo.a * 0.9);
		float a = g * g * mix(u_atmo.a, 1.0, g);
		fragColor = vec4(mix(u_atmo.rgb, limbCol, g) * a, a);   // premultiplied
		return;
	}
	vec3 P = A + t * d;                            // 面上の点（単位球＝法線）＝絶対（霞・粗い用途）
	vec2 dll = deltaLL(u_rayEO + t * d, u_ell);   // 原点相対の経緯度差（deg・測地）＝uv の正本（#65）
	vec2 ll = u_rayLL.xy + dll;                    // 絶対経緯度（粗くて可＝ハイプソ・気候）
	vec3 base = u_land.rgb;
	if (u_whK > 0.001 && u_hasElev > 0.5) {        // 全球ハイプソ：標高→配色＋陰影（NEラスタの計算版）
		float e = elevAt(ll);
		// hillshade：1テクセル差分・NW光（TERRAIN_FS と同族）。R90 テクセル≈20km なので係数は桁で弱める
		float dstep = u_elevBounds.w / float(textureSize(u_elevTex, 0).y);
		float hx = elevAt(ll + vec2(dstep, 0.0)) - e;
		float hy = elevAt(ll + vec2(0.0, dstep)) - e;
		float shade = clamp(0.86 + (-hx + hy) * 0.00013, 0.62, 1.08);
		if (u_cg.w > 0.5) shade = 1.0;   // 地面の照明（Cesium）＝陰影は lambert が受け持つ
		// 陸海の境：R90/GEBCO の海はクランプで厳密に 0＝閾は低く攻められる（0.5-30m だと華北平原・
		// 長江デルタ級の低平地が海色に沈む＝本人指摘 2026-08-30）。0.2→4m＝干拓地級だけ海側に残る
		// （蘭ポルダー等の 0m 以下はクランプで 0＝負値解禁（海の深度ランプ）とセットの将来課題）
		float landK = smoothstep(0.2, 4.0, e);
		vec3 hyp = mix(u_seaC, worldHypso(e, ll) * shade, landK);
		base = mix(base, hyp, u_whK);
	}
	// 床の不透明度（B5）＝u_land.a（background 層の無い MapLibre の地図＝0＝透明・頁の色が見える。全球ハイプソ・COG は不透明）。a=1 なら従来とビット同一
	float ba = mix(u_land.a, 1.0, u_whK);
	if (u_hasCog > 0.5) {   // ユーザ COG＝基球でも羽織る（地形パスは低地 t フェードで穴が開くためここが床）。uv＝原点相対の係数（#65）
		base = cogTexMix(base, u_cogOff.xy + dll * u_cogOff.zw); ba = 1.0;
	}
	vec4 g = vec4(base * ba, ba);   // 前乗算の床
	if (u_gndN > 0.5) {   // 地面アトラス＝基球の床（地形パスの低地 t フェードの穴と真俯瞰 2D の下地）。uv＝原点相対の係数（#65＝写真の床がズーム摂動で揺れない）
		g = gndOver(g, u_gndOff0.xy + dll * u_gndOff0.zw, u_gndOff1.xy + dll * u_gndOff1.zw, u_gndOff2.xy + dll * u_gndOff2.zw, u_gndOff3.xy + dll * u_gndOff3.zw);
	}
	if (u_gm.x > 0.5) {   // 地面の材質（Cesium の globe.material）＝球の床（低地の t フェードの穴と真俯瞰）にも地形面と同じ式で。標高が無い所は Cesium と同じく高さ 0 の色
		float e = 0.0; vec2 gEN = vec2(0.0);
		if (u_hasElev > 0.5) {
			e = elevAt(ll); float dstep = u_elevBounds.w / float(textureSize(u_elevTex, 0).y);
			gEN = vec2((elevAt(ll + vec2(dstep, 0.0)) - e) / (dstep * 111320.0 * max(cos(ll.y * 0.017453292519943295), 0.01)), (elevAt(ll + vec2(0.0, dstep)) - e) / (dstep * 111320.0));
		}
		vec4 m = gmColor(e, gEN, fwidth(e)); g = vec4(g.rgb * (1.0 - m.a) + m.rgb * m.a, max(g.a, m.a));
	}
	if (u_cg.w > 0.5) g.rgb *= u_cgC * cgLambert(ll, vec2(0.0), 2.0);   // 地面の照明（Cesium の globe.enableLighting）：遠景球は楕円体の上向きで（Cesium も法線の無い地形は位置の法線）
	vec3 viewDir = normalize(A - P);              // 面→カメラ
	float ndv = clamp(dot(P, viewDir), 0.0, 1.0);
	float haze = pow(1.0 - ndv, 3.0);             // 縁ほど強い内側リムの霞
	float hz = haze * u_atmo.a * 0.9;
	vec3 col = g.rgb * (1.0 - hz) + u_atmo.rgb * hz * g.a;   // ＝mix(base, atmo, hz) を前乗算で（a=1 で同値）
	if (u_csAtm.x > 0.5) {   // Cesium の地面の大気（遠くから）と霧（800 km より下・u_csAtm.w＝濃さ）＝従来の霞の代わり
		float night = u_cg.w > 0.5 ? u_cgP.w : -1.0;
		vec3 cs = csGroundL(g.rgb / max(g.a, 1e-4), A * CS_R, P * CS_R, u_csAtm.y, u_cg.xyz, night);
		col = csFogL(cs, A * CS_R, P * CS_R, u_csAtm.w, u_cg.xyz, night) * g.a;
	}
	if (ug) {   // 裏面：霞・大気は掛けない（面の裏から見る）＝床の色に undergroundColor を距離の α で重ねる（Cesium GlobeFS の alphaBlend）
		float k = clamp((t * sqrt(aa) - u_ugNF.x) / max(u_ugNF.z - u_ugNF.x, 1e-12), 0.0, 1.0);
		float ua = u_ugC.a * mix(u_ugNF.y, u_ugNF.w, k);
		col = u_ugC.rgb * ua * g.a + g.rgb * (1.0 - ua);
	}
	fragColor = vec4(col * u_globeAlpha, g.a * u_globeAlpha);   // 球体の不透明度（地中の震源等を透かす）
	// 球が透ける時（globe:false・translucency）は Cesium と同じく空の大気の殻が地面の向こうに見える（SkyAtmosphere は地面を知らない＝殻の奥の面）
	if (u_csAtm.x > 0.5 && u_csAtm.z > 0.5 && u_globeAlpha < 1.0) { vec4 cs = csSky2(A * CS_R, normalize(d), u_globeAlpha > 0.0 ? 2.0 : 1.0); fragColor += cs * (1.0 - fragColor.a); }
}`;

// 海面下の陸地（wdepr）カバー：stencil-then-cover の cover 側をフラット色でなく「landK=1 強制のハイプソ本体」で
// 塗る＝海→海面下→陸の描画順（2026-09-01 本人設計）。ポリゴン内は画素単位で worldHypso（標高ランプ×気候
// cross-blend×hillshade）＝ポルダーは湿潤の緑・カッタラ/デスバレーは乾燥帯の砂系に自動で分かれ、
// ポリゴン境界が e≳4m（landK≈1）の土地に落ちれば globe パスの通常塗りと同色＝継ぎ目が消える。
// レイ→球→測地緯度→elevAt→shade は GLOBE_FS と同式（色が画素単位で厳密に一致することが本体）。
export const WDEPR_FS = `#version 300 es
precision highp float;
// 全画面レイキャスト（#65・2026-09-27）：視線の基底は CPU f64（camera.js viewRays）＝invMvp（f32）の積和をしない。
// 交点は近い根を t＝2c/(−b＋√h)（c＝|E|²−1 は CPU f64）＝桁落ちなし。後ろ向き（q≤0）＝t<0。A＝目・d＝視線（clip w＝1 の長さ）
uniform vec3 u_rayF, u_rayX, u_rayY, u_rayE;
uniform float u_rayC;
uniform vec3 u_rayO, u_rayEO;   // 錨：シーン原点の β単位球の点 O・目−O（f64 で引く）＝交点 δ＝u_rayEO＋t·d（原点相対・f32 で mm 級）
uniform vec4 u_rayLL;           // (原点 lon, lat（deg・測地）, β0（rad）, cos β0)
vec3 rayDir(vec2 ndc) { return u_rayF + ndc.x * u_rayX + ndc.y * u_rayY; }
float sphereT(float bb, float disc) { if (disc < 0.0 || (bb >= 0.0 && u_rayC >= 0.0)) return -1.0; float q = -bb + sqrt(disc); return q > 0.0 ? 2.0 * u_rayC / q : -1.0; }   // 外から上向き（bb≥0）は前に交点なし：q＝−b＋√(b²−4c) は c≈0（目が地面すれすれ）で丸めの ±1ulp になり、実 GPU の sqrt では空の画素が地面に化けた（2026-10-28 Cesium 花火）
// δ から経緯度の差（deg・測地）を桁落ちなしで（wgsl.js deltaLL と同式）：δlon＝atan2(δz·Ox−δx·Oz, ρO²+δx·Ox+δz·Oz)・δβ は ρ の差も s/(ρP+ρO) で
vec2 deltaLL(vec3 dl, float ell) {
	vec3 O = u_rayO; float rhoO = u_rayLL.w, beta0 = u_rayLL.z;
	float dlon = atan(dl.z * O.x - dl.x * O.z, rhoO * rhoO + dl.x * O.x + dl.z * O.z);
	float s = 2.0 * (O.x * dl.x + O.z * dl.z) + dl.x * dl.x + dl.z * dl.z;
	float rhoP = sqrt(max(rhoO * rhoO + s, 0.0));
	float drho = s / max(rhoP + rhoO, 1e-12);
	float dbeta = atan(dl.y * rhoO - drho * O.y, rhoP * rhoO + (O.y + dl.y) * O.y);
	float b1 = beta0 + dbeta;
	float corr = ell * (0.0016792203863837047 * (sin(2.0 * b1) - sin(2.0 * beta0)) + 0.0000014098905530233192 * (sin(4.0 * b1) - sin(4.0 * beta0)));
	return vec2(dlon, dbeta + corr) * 57.29577951308232;
}
uniform vec4 u_land;
uniform vec4 u_atmo;
uniform vec3 u_whDeep;   // 海面下の締め（乗算ティント既定 [0.84,0.92,0.82]＝worldpal.js）。globe側の式には非関与
uniform sampler2D u_elevTex;
uniform vec4 u_elevBounds;
uniform float u_ell;
in vec2 v_ndc;
out vec4 fragColor;
const float R2D = 57.29577951308232;
// far床＝近窓の外を受ける第2アトラス（世界帯z<8はR90全球固定窓＝terrain.jsのB形態）。
// R90/R10境界5.5化で「近窓=全球」の前提が崩れ、窓外の陸が標高0＝海色に抜けた（スカンジナビア/シベリア
// 実測 9/2＝本人発見「タイラーのバグ」）。terrain elev() と同じフォールバック＝カバーの床。
uniform sampler2D u_farElevTex;
uniform vec4 u_farBounds;
uniform float u_hasFar;
uniform float u_elevEdgeFade;   // 近窓縁＝far値へ溶かす幅(deg)。R90全球窓=0（縁は極/±180のみ）
float elevFar(vec2 ll) {
	if (u_hasFar < 0.5) return 0.0;
	ll.x -= 360.0 * floor((ll.x + 180.0) / 360.0);   // 経度を -180..180 へ（原点相対の経度は ±180 を越えうる）
	vec2 uv = (ll - u_farBounds.xy) / u_farBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
	return texture(u_farElevTex, uv).r;
}
float elevUV(vec2 uv, vec2 ll) {   // uv＝原点相対で作った近窓の uv（#65）・ll＝far 床の受け（粗くて可）
	if (u_elevBounds.z > 359.0) uv.x = fract(uv.x);   // 全球の窓（R90）は経度が一周＝原点から 180° 超回った先の uv を折り返す（gpu/wgsl.js gElevUV と同じ・2026-10-01）
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return elevFar(ll);
	float fade = 1.0;
	if (u_elevEdgeFade > 0.0) {
		vec2 w = vec2(u_elevEdgeFade) / u_elevBounds.zw;
		fade = min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
	}
	return mix(elevFar(ll), texture(u_elevTex, uv).r, fade);
}
float elevAt(vec2 ll) { return elevUV((ll - u_elevBounds.xy) / u_elevBounds.zw, ll); }
${WORLD_HYPSO}
${COG}
uniform vec4 u_elevOff;   // 近窓の標高 uv 係数（f64 前計算・#65）＝(原点の uv, 1/span)
uniform vec4  u_cg;          // 地面の照明（setGroundLighting・Cesium の globe.enableLighting・2026-10-26）：xyz＝光へ向く単位ベクトル（世界）・w＝0 無し／1 地形の法線／2 楕円体の上向き
uniform vec4  u_cgP;         // (lambert の倍率, 足す値, 効き 0..1＝距離のフェード済み, 大気の夜側の明るさ 0.05..1・負＝暗くしない)
uniform vec3  u_cgC;         // 光の色（czm_lightColor）
// 経緯度（deg）の点の東・北・上（世界軸＝ECEF の (x, z, y)）での lambert：n＝勾配（東・北・m/m）から、mode 2 は上向き
float cgLambert(vec2 ll, vec2 gEN, float mode) {
	vec2 lr = ll * 0.017453292519943295;
	float cl = cos(lr.y), sl = sin(lr.y), co = cos(lr.x), so = sin(lr.x);
	vec3 L = vec3(dot(u_cg.xyz, vec3(-so, 0.0, co)), dot(u_cg.xyz, vec3(-sl * co, cl, -sl * so)), dot(u_cg.xyz, vec3(cl * co, sl, cl * so)));   // 東・北・上
	vec3 n = mode > 1.5 ? vec3(0.0, 0.0, 1.0) : normalize(vec3(-gEN, 1.0));
	float diff = clamp(max(dot(n, L), 0.0) * u_cgP.x + u_cgP.y, 0.0, 1.0);
	return mix(1.0, diff, u_cgP.z);
}
uniform float u_globeAlpha;   // 球体の不透明度（表示パネル「基図」を globe/terrain まで拡張＝本人裁定 2026-09-13。1=不透明・premultiplied なので rgb にも掛ける）
void main() {
	vec3 A = u_rayE, d = rayDir(v_ndc);   // #65：視線は CPU f64 の基底
	float aa = dot(d, d), bb = 2.0 * dot(A, d), cc = u_rayC;
	float disc = bb * bb - 4.0 * aa * cc;
	float t = sphereT(bb, disc);   // 球ミス・後ろ向き＝−1
	if (t < 0.0) discard;
	vec3 P = A + t * d;
	vec2 dll = deltaLL(u_rayEO + t * d, u_ell);   // 原点相対（#65）
	vec2 ll = u_rayLL.xy + dll;
	vec2 uv = u_elevOff.xy + dll * u_elevOff.zw;
	float e = elevUV(uv, ll);
	float dstep = u_elevBounds.w / float(textureSize(u_elevTex, 0).y);
	float hx = elevUV(uv + vec2(dstep * u_elevOff.z, 0.0), ll + vec2(dstep, 0.0)) - e;
	float hy = elevUV(uv + vec2(0.0, dstep * u_elevOff.w), ll + vec2(0.0, dstep)) - e;
	float shade = clamp(0.86 + (-hx + hy) * 0.00013, 0.62, 1.08);
	// 以降は GLOBE_FS の末尾と厳密同式（landK=1 だけが違い）：紙とのwhK混合も大気ヘイズも同じに通し、
	// α=1 の不透明で置く＝ポリゴン境界の e≳4m では画素値が globe と bit 一致し縁が完全に消える。
	vec3 hyp = worldHypso(e, ll) * shade;   // landK=1 強制＝「陸」の上塗り（海色ゲート・虫食いの根治）
	// 海面下の締め（NE流「最深帯」）：0→-60m で僅かに暗く・緑側へ。気候によらず効く＝湿潤は深緑・乾燥はオリーブ
	//（landK=1 だけだと乾燥帯の海面下がランプ差僅少でほぼ消える＝カッタラ/デスバレーが読めなくなる対策）
	hyp = mix(hyp, hyp * u_whDeep, clamp(-e / 60.0, 0.0, 1.0));
	vec3 base = mix(u_land.rgb, hyp, u_whK);
	vec3 viewDir = normalize(A - P);
	float ndv = clamp(dot(P, viewDir), 0.0, 1.0);
	float haze = pow(1.0 - ndv, 3.0);
	fragColor = vec4(mix(base, u_atmo.rgb, haze * u_atmo.a * 0.9) * u_globeAlpha, u_globeAlpha);   // 球体の不透明度に従う
}`;

// 10度レチクル（v1 ortho-map の geoGraticule10/Canvas2D 移植・2026-09-01 本人指名「v1と同じ」）：
// フルスクリーンでレイ→球→測地経緯度（GLOBE_FS と同式）→10°格子への距離を fwidth で解析AA＝
// v1 の geoPath と同じなめらかな細線・データゼロ・全レイヤの上（v1 も Canvas2D で地図の上に重ねていた）。
// d3.geoGraticule10 と同じ約束：経線/緯線とも ±80° で打ち切り・90° 毎の経線だけ極まで届く。
export const GRAT_FS = `#version 300 es
precision highp float;
// 全画面レイキャスト（#65・2026-09-27）：視線の基底は CPU f64（camera.js viewRays）＝invMvp（f32）の積和をしない。
// 交点は近い根を t＝2c/(−b＋√h)（c＝|E|²−1 は CPU f64）＝桁落ちなし。後ろ向き（q≤0）＝t<0。A＝目・d＝視線（clip w＝1 の長さ）
uniform vec3 u_rayF, u_rayX, u_rayY, u_rayE;
uniform float u_rayC;
uniform vec3 u_rayO, u_rayEO;   // 錨：シーン原点の β単位球の点 O・目−O（f64 で引く）＝交点 δ＝u_rayEO＋t·d（原点相対・f32 で mm 級）
uniform vec4 u_rayLL;           // (原点 lon, lat（deg・測地）, β0（rad）, cos β0)
vec3 rayDir(vec2 ndc) { return u_rayF + ndc.x * u_rayX + ndc.y * u_rayY; }
float sphereT(float bb, float disc) { if (disc < 0.0 || (bb >= 0.0 && u_rayC >= 0.0)) return -1.0; float q = -bb + sqrt(disc); return q > 0.0 ? 2.0 * u_rayC / q : -1.0; }   // 外から上向き（bb≥0）は前に交点なし：q＝−b＋√(b²−4c) は c≈0（目が地面すれすれ）で丸めの ±1ulp になり、実 GPU の sqrt では空の画素が地面に化けた（2026-10-28 Cesium 花火）
// δ から経緯度の差（deg・測地）を桁落ちなしで（wgsl.js deltaLL と同式）：δlon＝atan2(δz·Ox−δx·Oz, ρO²+δx·Ox+δz·Oz)・δβ は ρ の差も s/(ρP+ρO) で
vec2 deltaLL(vec3 dl, float ell) {
	vec3 O = u_rayO; float rhoO = u_rayLL.w, beta0 = u_rayLL.z;
	float dlon = atan(dl.z * O.x - dl.x * O.z, rhoO * rhoO + dl.x * O.x + dl.z * O.z);
	float s = 2.0 * (O.x * dl.x + O.z * dl.z) + dl.x * dl.x + dl.z * dl.z;
	float rhoP = sqrt(max(rhoO * rhoO + s, 0.0));
	float drho = s / max(rhoP + rhoO, 1e-12);
	float dbeta = atan(dl.y * rhoO - drho * O.y, rhoP * rhoO + (O.y + dl.y) * O.y);
	float b1 = beta0 + dbeta;
	float corr = ell * (0.0016792203863837047 * (sin(2.0 * b1) - sin(2.0 * beta0)) + 0.0000014098905530233192 * (sin(4.0 * b1) - sin(4.0 * beta0)));
	return vec2(dlon, dbeta + corr) * 57.29577951308232;
}
uniform float u_ell;
uniform float u_alpha;   // 出現度（ズーム帯フェード×基礎アルファ）。0=不可視（呼び側でドロー自体を省略）
uniform vec4 u_gratC;    // レチクル色 rgb＋α係数（テーマノブ grat。既定 [1,1,1,1]＝従来の白）
in vec2 v_ndc;
out vec4 fragColor;
const float R2D = 57.29577951308232;
void main() {
	vec3 A = u_rayE, d = rayDir(v_ndc);   // #65：視線は CPU f64 の基底
	float aa = dot(d, d), bb = 2.0 * dot(A, d), cc = u_rayC;
	float disc = bb * bb - 4.0 * aa * cc;
	float t = sphereT(bb, disc);   // 球ミス・後ろ向き＝−1
	if (t < 0.0) discard;
	vec3 P = A + t * d;
	float bl = asin(clamp(P.y, -1.0, 1.0));
	float latD = bl * R2D + u_ell * (0.0016792203863837047 * sin(2.0 * bl) + 0.0000014098905530233192 * sin(4.0 * bl)) * R2D;
	vec2 ll = vec2(atan(P.z, P.x) * R2D, latD);
	// 10°格子への距離(度)：±180 の折返しは 180 が格子線そのもの＝fract パターンは連続で無害。
	// 線＝画素距離 g/fwidth のスムーズステップ（≈0.7px・0.5px AA＝v1 geoPath の細線）。
	// ×度距離の上限ゲート＝極（経線収束）と atan 継ぎ目で fwidth が爆発して線が面に化けるのを防ぐ。
	vec2 fw = max(fwidth(ll), vec2(1e-6));
	vec2 g10 = abs(fract(ll / 10.0 + 0.5) - 0.5) * 10.0;
	float mer = (1.0 - smoothstep(0.25, 0.75, g10.x / fw.x)) * (1.0 - smoothstep(0.8, 1.6, g10.x));
	float par = (1.0 - smoothstep(0.25, 0.75, g10.y / fw.y)) * (1.0 - smoothstep(0.8, 1.6, g10.y)) * step(abs(latD), 80.0);   // 緯線は ±80 まで
	float in80 = step(abs(latD), 80.0);
	float g90 = abs(fract(ll.x / 90.0 + 0.5) - 0.5) * 90.0;
	float mer90 = (1.0 - smoothstep(0.25, 0.75, g90 / fw.x)) * (1.0 - smoothstep(0.8, 1.6, g90));
	mer = mer * in80 + mer90 * (1.0 - in80);   // 経線＝±80 までは10°毎・その先(極冠)は90°毎だけ極まで
	float a = max(mer, par) * u_alpha * u_gratC.a;
	if (a <= 0.003) discard;
	fragColor = vec4(u_gratC.rgb * a, a);   // premultiplied（既定=白＝v1 の rgba(255,255,255,α) と同族）
}`;

// 星空（z<4の世界ビュー・v1 ortho-map の星空アクセサリー移植）：
// ・星は無限遠の方向＝mvp×vec4(dir, 0)（w=0で平行移動が消える＝視差ゼロの天球）。
// ・無限遠は必ず far 平面の外＝clip.z をそのまま使うと全滅するので z=0 に固定（深度無関係の背景。globeパスより先に描く）。
// ・天球→地球固定は恒星時：星の地球経度 = RA - GMST。u_gmst=(cos,sin) の y軸回り回転を頂点で払う＝バッファは不変・時刻はuniform1個。
export const STARS_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_cel;    // 天球単位ベクトル（RA/Dec 焼き込み・歳差は装飾精度で無視）
layout(location=1) in vec4 a_col;    // rgb（B-V色）+ 基礎alpha（等級由来）
layout(location=2) in float a_size;  // 点直径(device px)
uniform mat4 u_mvp;
uniform vec2 u_gmst;   // (cos, sin)
uniform float u_fade;  // z4→z3.5 のフェードイン
uniform float u_sky;   // 遠近表現（v1の sr=対角×(0.4+0.3z) の移植）：天球の拡大はズームに線形＝地球(2^z)より
                       // ずっと緩やか＝ズームインで地球だけが近づき星空は奥に留まる。画面中心まわりのNDCスケール。
out vec4 v_col;
void main() {
	vec3 d = vec3(a_cel.x * u_gmst.x + a_cel.z * u_gmst.y, a_cel.y, a_cel.z * u_gmst.x - a_cel.x * u_gmst.y);
	vec4 p = u_mvp * vec4(d, 0.0);
	gl_Position = vec4(p.xy * u_sky, 0.0, p.w);   // w<0（背後）は自然にクリップ
	gl_PointSize = a_size;
	v_col = vec4(a_col.rgb, a_col.a * u_fade);
}`;
export const STARS_FS = `#version 300 es
precision highp float;
in vec4 v_col;
out vec4 fragColor;
void main() {
	float r = length(gl_PointCoord - 0.5) * 2.0;
	float a = v_col.a * smoothstep(1.0, 0.3, r);   // 柔らかい円盤＝回転中のシマーを抑える
	fragColor = vec4(v_col.rgb * a, a);            // premultiplied
}`;
// 星座線：STARS_VS を共用（gl.LINES＝gl_PointCoord は使えないので専用FS）。色は定数attribで注入。
export const STARLINE_FS = `#version 300 es
precision highp float;
in vec4 v_col;
out vec4 fragColor;
void main() { fragColor = vec4(v_col.rgb * v_col.a, v_col.a); }`;

// 夜面（現在時刻の太陽＝平行光源・v1 nightJSON の GL 移植）：フルスクリーンで球をレイキャストし、
// dot(P, 太陽方向) が負の半球を夜紺で減光。黄昏帯は smoothstep（太陽高度 +4.6°〜-10°付近）＝薄明のグラデ。
// 全レイヤ描画後に重ねる＝陸・海・陰影がまとめて夜に沈む（v1 が地図の上に夜多角形を塗ったのと同じ）。
export const NIGHT_FS = `#version 300 es
precision highp float;
// 全画面レイキャスト（#65・2026-09-27）：視線の基底は CPU f64（camera.js viewRays）＝invMvp（f32）の積和をしない。
// 交点は近い根を t＝2c/(−b＋√h)（c＝|E|²−1 は CPU f64）＝桁落ちなし。後ろ向き（q≤0）＝t<0。A＝目・d＝視線（clip w＝1 の長さ）
uniform vec3 u_rayF, u_rayX, u_rayY, u_rayE;
uniform float u_rayC;
uniform vec3 u_rayO, u_rayEO;   // 錨：シーン原点の β単位球の点 O・目−O（f64 で引く）＝交点 δ＝u_rayEO＋t·d（原点相対・f32 で mm 級）
uniform vec4 u_rayLL;           // (原点 lon, lat（deg・測地）, β0（rad）, cos β0)
vec3 rayDir(vec2 ndc) { return u_rayF + ndc.x * u_rayX + ndc.y * u_rayY; }
float sphereT(float bb, float disc) { if (disc < 0.0 || (bb >= 0.0 && u_rayC >= 0.0)) return -1.0; float q = -bb + sqrt(disc); return q > 0.0 ? 2.0 * u_rayC / q : -1.0; }   // 外から上向き（bb≥0）は前に交点なし：q＝−b＋√(b²−4c) は c≈0（目が地面すれすれ）で丸めの ±1ulp になり、実 GPU の sqrt では空の画素が地面に化けた（2026-10-28 Cesium 花火）
// δ から経緯度の差（deg・測地）を桁落ちなしで（wgsl.js deltaLL と同式）：δlon＝atan2(δz·Ox−δx·Oz, ρO²+δx·Ox+δz·Oz)・δβ は ρ の差も s/(ρP+ρO) で
vec2 deltaLL(vec3 dl, float ell) {
	vec3 O = u_rayO; float rhoO = u_rayLL.w, beta0 = u_rayLL.z;
	float dlon = atan(dl.z * O.x - dl.x * O.z, rhoO * rhoO + dl.x * O.x + dl.z * O.z);
	float s = 2.0 * (O.x * dl.x + O.z * dl.z) + dl.x * dl.x + dl.z * dl.z;
	float rhoP = sqrt(max(rhoO * rhoO + s, 0.0));
	float drho = s / max(rhoP + rhoO, 1e-12);
	float dbeta = atan(dl.y * rhoO - drho * O.y, rhoP * rhoO + (O.y + dl.y) * O.y);
	float b1 = beta0 + dbeta;
	float corr = ell * (0.0016792203863837047 * (sin(2.0 * b1) - sin(2.0 * beta0)) + 0.0000014098905530233192 * (sin(4.0 * b1) - sin(4.0 * beta0)));
	return vec2(dlon, dbeta + corr) * 57.29577951308232;
}
uniform vec3 u_sun;     // 太陽方向（地球固定・単位ベクトル）
uniform float u_alpha;  // 夜面の濃さ（星空と同じ z4→3.5 フェード込み）
in vec2 v_ndc;
out vec4 fragColor;
void main() {
	vec3 A = u_rayE, d = rayDir(v_ndc);   // #65：視線は CPU f64 の基底
	float aa = dot(d, d), bb = 2.0 * dot(A, d), cc = u_rayC;
	float disc = bb * bb - 4.0 * aa * cc;
	float t = sphereT(bb, disc);   // 球ミス・後ろ向き＝−1
	if (t < 0.0) discard;
	vec3 P = A + t * d;
	float night = smoothstep(0.08, -0.18, dot(P, u_sun));
	float a = night * u_alpha;
	if (a <= 0.001) discard;
	fragColor = vec4(vec3(0.0, 0.02, 0.078) * a, a);   // v1 rgba(0,5,20,0.5) の夜紺（premultiplied）
}`;

// 等高線：真俯瞰(チルト≈0)でだけ、標高テクスチャから茶(セピア)の等高線を敷く。3Dの誇張は出さず、平面で標高を語る
// ＝紙の地形図の等高線。フルスクリーン各画素でカメラ光線×単位球→lon/lat→elev→iso線を fwidth でAA。GLOBE_VS を流用。
// 寂しい地域(山/田舎)に土地の表情を与える＝どの場所も等しく描かれる（公平感）。ベクタの下に敷き、道路/区界は上に乗る。
export const CONTOUR_FS = `#version 300 es
precision highp float;
// 全画面レイキャスト（#65・2026-09-27）：視線の基底は CPU f64（camera.js viewRays）＝invMvp（f32）の積和をしない。
// 交点は近い根を t＝2c/(−b＋√h)（c＝|E|²−1 は CPU f64）＝桁落ちなし。後ろ向き（q≤0）＝t<0。A＝目・d＝視線（clip w＝1 の長さ）
uniform vec3 u_rayF, u_rayX, u_rayY, u_rayE;
uniform float u_rayC;
uniform vec3 u_rayO, u_rayEO;   // 錨：シーン原点の β単位球の点 O・目−O（f64 で引く）＝交点 δ＝u_rayEO＋t·d（原点相対・f32 で mm 級）
uniform vec4 u_rayLL;           // (原点 lon, lat（deg・測地）, β0（rad）, cos β0)
vec3 rayDir(vec2 ndc) { return u_rayF + ndc.x * u_rayX + ndc.y * u_rayY; }
float sphereT(float bb, float disc) { if (disc < 0.0 || (bb >= 0.0 && u_rayC >= 0.0)) return -1.0; float q = -bb + sqrt(disc); return q > 0.0 ? 2.0 * u_rayC / q : -1.0; }   // 外から上向き（bb≥0）は前に交点なし：q＝−b＋√(b²−4c) は c≈0（目が地面すれすれ）で丸めの ±1ulp になり、実 GPU の sqrt では空の画素が地面に化けた（2026-10-28 Cesium 花火）
// δ から経緯度の差（deg・測地）を桁落ちなしで（wgsl.js deltaLL と同式）：δlon＝atan2(δz·Ox−δx·Oz, ρO²+δx·Ox+δz·Oz)・δβ は ρ の差も s/(ρP+ρO) で
vec2 deltaLL(vec3 dl, float ell) {
	vec3 O = u_rayO; float rhoO = u_rayLL.w, beta0 = u_rayLL.z;
	float dlon = atan(dl.z * O.x - dl.x * O.z, rhoO * rhoO + dl.x * O.x + dl.z * O.z);
	float s = 2.0 * (O.x * dl.x + O.z * dl.z) + dl.x * dl.x + dl.z * dl.z;
	float rhoP = sqrt(max(rhoO * rhoO + s, 0.0));
	float drho = s / max(rhoP + rhoO, 1e-12);
	float dbeta = atan(dl.y * rhoO - drho * O.y, rhoP * rhoO + (O.y + dl.y) * O.y);
	float b1 = beta0 + dbeta;
	float corr = ell * (0.0016792203863837047 * (sin(2.0 * b1) - sin(2.0 * beta0)) + 0.0000014098905530233192 * (sin(4.0 * b1) - sin(4.0 * beta0)));
	return vec2(dlon, dbeta + corr) * 57.29577951308232;
}
uniform sampler2D u_elevTex;
uniform vec4 u_elevBounds;   // originLng, originLat, spanLng, spanLat（deg）
uniform float u_hasElev;     // 0/1
uniform float u_interval;    // 主曲線間隔(m)
uniform float u_major;       // 計曲線間隔(m)
uniform float u_alpha;       // 全体の濃さ（pitch で 0 へフェード）
uniform vec3 u_cColor;       // 茶(セピア)
uniform float u_ell;         // 1=楕円体（レイ交点の asin=β → 測地緯度へ復元して elev を引く。球=0＝恒等）
in vec2 v_ndc;
out vec4 fragColor;
const float R2D = 57.29577951308232;
uniform vec4 u_elevOff;      // 標高 uv 係数（f64 前計算・#65）＝(原点の uv, 1/span)：uv＝off＋δll·inv
float elevAt(vec2 uv) {      // uv＝原点相対で作る（絶対経緯度を経ない）
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
	return texture(u_elevTex, uv).r;
}
float band(float g) {                                   // iso線：整数の g で 1、離れると 0（fwidth で画面一定幅・AA）
	float dd = abs(fract(g + 0.5) - 0.5);
	float fw = fwidth(g);
	float w = fw * 0.5 + 1e-5;                          // 係数＝線の細さ（細すぎるとサブピクセルで破線化＝汚い）
	// 勾配ゼロ抑制：整数m量子化の平坦な街区が等高線値ちょうどに乗ると面ごと点火する（都市部の薄茶四角）。
	// 紙の地形図の作法どおり「平坦地に等高線の面は無い」＝勾配が消える所では線も消す（1e-4 g≈3mm/px相当）。
	return (1.0 - smoothstep(0.0, w, dd)) * smoothstep(0.0, 1e-4, fw);
}
void main() {
	if (u_alpha <= 0.002 || u_hasElev < 0.5) discard;
	vec3 A = u_rayE, d = rayDir(v_ndc);   // #65：視線は CPU f64 の基底
	float aa = dot(d, d), bb = 2.0 * dot(A, d), cc = u_rayC;
	float disc = bb * bb - 4.0 * aa * cc;
	float t = sphereT(bb, disc);   // 球ミス・後ろ向き＝−1
	if (t < 0.0) discard;
	vec2 dll = deltaLL(u_rayEO + t * d, u_ell);         // 交点＝原点相対 δ → 経緯度の差（deg・測地）（#65）
	float e = elevAt(u_elevOff.xy + dll * u_elevOff.zw);
	float landMask = smoothstep(0.5, 4.0, e);           // 海/データ無し(≈0)は等高線を出さない
	if (landMask <= 0.0) discard;
	float line = max(band(e / u_interval) * 0.2, band(e / u_major) * 0.4);   // さらに淡く（主曲線ごく薄・計曲線も薄め）
	float a = line * landMask * u_alpha;
	if (a <= 0.003) discard;
	fragColor = vec4(u_cColor * a, a);                  // premultiplied
}`;

// 塗りの直描き＝2D（地形なし）だけ。3D（地形あり）の塗りは地面アトラスへ焼いて FS が画素標本化する（ATLAS_FILL_VS/FS・
// 2026-09-21）＝かつての標高ドレープ・水面リフト(+30/+10m)・水域の厳密対数深度（v_w/gl_FragDepth）は塗りには不要となり撤去。
// 層の *-translate（S-P1-4/5）：地面の上でずらす（MapLibre の translatePosMatrix と同じく傾けた画面では縮む）。
// u_tr＝(東 px, 南 px, 今の zoom の 1px の弧（度・256px の世界の赤道）, 0)。z＝0 でずらさない。球は縦横とも同じ尺＝経度だけ cos φ で割る
const FX_TR = /* glsl */`
uniform vec4 u_tr;
vec2 trLL(vec2 ll) { return vec2(u_tr.x / max(cos(ll.y * 0.017453293), 1e-3), -u_tr.y) * u_tr.z; }
uniform vec4 u_pz;    // ズーム連続（V-Ph3＝S-P1-2・paintzoom.ts）＝x 色を差し替える（1）・y 線幅を差し替える（1）・z 半幅（CSS px）・w floor(z) の半幅（破線の尺）。0＝頂点の値
uniform vec4 u_pzC;   // 差し替える色（RGBA・不透明度を掛けた値）`;
// paint 表の (b) 類（painttable.ts・vt perf plan §5）：u_pt＝1 の描く列は色の語が表の行（下位 16bit）＝表（RGBA32F・行ごとに 2 texel・0＝色・1＝予約）から読む。
// 塗りの頂点の色は正規化した RGBA8 の属性のまま読む＝行＝r＋g×256（バイトに戻す）。md の変種だけ（表を作るのは scene worker の常駐の時）
const PT = /* glsl */`
uniform float u_pt;
uniform highp sampler2D u_ptTex;
vec4 ptColor(int r) { int w = textureSize(u_ptTex, 0).x, t = r * 2; return texelFetch(u_ptTex, ivec2(t % w, t / w), 0); }
float ptHalf(int r) { int w = textureSize(u_ptTex, 0).x, t = r * 2 + 1; return texelFetch(u_ptTex, ivec2(t % w, t / w), 0).x; }   // 線の半幅（u_pt＝2 の列・段 2b）
int ptRowOf(vec4 c) { return int(c.r * 255.0 + 0.5) + int(c.g * 255.0 + 0.5) * 256; }`;
export const FILL_VS = `#version 300 es
precision highp float;
in vec2 a_delta;
in vec4 a_color;
${PROJECT}
out vec4 v_color;
out float v_front;
out float v_fog;
out vec2 v_ll;    // 絶対 lon/lat(deg)＝FS 標高ゲート（u_seaGate）用
${FX_TR}
uniform float u_patK;   // fill-pattern（S-P1-4/5）＝floor(z) の世界（256px）の 1 度の px（経度）。0＝模様なし
out vec2 v_pat;         // 模様の px（原点からの差＝メルカトルの px・縦は中ほどの緯度の cos で割る）
uniform vec4 u_cogOffInv;   // COG uv＝off+dLL×inv（off=(origin−west)/span を JS f64 前計算＝f32 ジッタ回避）
out vec2 v_cuv;
uniform vec4 u_gndOffInv0;  // 地面アトラス（前景/近/中/遠）＝同じ変換
uniform vec4 u_gndOffInv1;
uniform vec4 u_gndOffInv2;
uniform vec4 u_gndOffInv3;
out vec2 v_guv0;
out vec2 v_guv1;
out vec2 v_guv2;
out vec2 v_guv3;
void main() {
	vec2 dLL = a_delta;                       // 原点相対 (deg)。multidraw は mdize が u_tileOff を足す
	dLL += trLL(u_origin + dLL);              // fill-translate（S-P1-4/5）
	v_pat = vec2(dLL.x, -dLL.y / cos((u_origin.y + dLL.y * 0.5) * 0.017453293)) * u_patK;
	vec2 ll = u_origin + dLL;                  // elev 参照用の絶対（粗くて可）
	v_ll = ll;
	v_cuv = u_cogOffInv.xy + dLL * u_cogOffInv.zw;
	v_guv0 = u_gndOffInv0.xy + dLL * u_gndOffInv0.zw;
	v_guv1 = u_gndOffInv1.xy + dLL * u_gndOffInv1.zw;
	v_guv2 = u_gndOffInv2.xy + dLL * u_gndOffInv2.zw;
	v_guv3 = u_gndOffInv3.xy + dLL * u_gndOffInv3.zw;
	vec3 rel = deltaToRel(dLL);               // 頂点3D − 原点3D（小・正確）
	vec3 dir = u_originPt + rel;              // 絶対単位球点（front/fog 用＝粗くて可）
	v_color = u_pz.x > 0.5 ? u_pzC : a_color;   // ズーム連続の色（V-Ph3＝S-P1-2）
	v_front = dot(u_eye, u_eye) < 1.0 ? 1.0 : dot(dir, u_eye) - 1.0;          // >0 で手前半球（cull＝粗くて可）
	v_fog = fogOf(dir);
	gl_Position = u_clipT + u_mvp * vec4(rel, 0.0);   // RTE：mvp*[w,1] を相殺なしで（海抜0の球面）
	applyLogDepth();   // 深度テストOFF（2D）では無害
}`;

export const FILL_FS = `#version 300 es
precision highp float;
uniform vec3 u_fogColor;
uniform float u_seaGate;      // 1＝図郭外フォールバック水域：標高が陸(h>0)の画素は塗らない
                              // ＝「水域は地理院・陸は標高(GEBCO/R10)」の管轄裁定を画素単位で行う
${ELEV}
${COG}
${GND}
in vec2 v_guv0;
in vec2 v_guv1;
in vec2 v_guv2;
in vec2 v_guv3;
uniform float u_baseAlpha;   // 基図の濃さ（表示パネルのスライダー）。COG は下層（globe/terrain）にも合成済み＝紙と線だけが引く
in vec2 v_cuv;
in vec4 v_color;
in float v_front;
in float v_fog;
in vec2 v_ll;
in vec2 v_pat;
uniform sampler2D u_patTex;   // fill-pattern（S-P1-4/5）＝記号帳の画像 1 枚（REPEAT）
uniform vec4 u_patP;          // (原点の模様の位相 x, y（px）, 1/幅, 1/高さ（px＝画像の px÷pixelRatio）)。z＝0 で模様なし
out vec4 fragColor;
void main() {
	if (v_front < -0.0015) discard;         // 裏半球は描かない（接線に標高許容＝地平線に頭を出す山上の塗りも描く）
	if (u_seaGate > 0.5 && elev(v_ll) > 0.0) discard;   // 図郭外＝陸は塗り残す（紙色+等高線に委ねる）
	// 霧はフェードアウト（透明化）：紙色で塗り潰すと、地平線の先＝球に隠れるべき塗りが空に不透明で浮く。
	// 1.2倍＝霧83%で完全消滅：地形の霞（fog=1で紙色の帯）より一歩先に消え、暗い空に尻尾が残らない
	float af = v_color.a * clamp(1.0 - 1.2 * v_fog, 0.0, 1.0) * u_baseAlpha;
	vec3 rgb = v_color.rgb;
	if (u_patP.z > 0.0) {   // 模様＝画像の色と α（MapLibre と同じく fill-color は読まない・fill-opacity は掛ける）。画像は前乗算で届く
		vec4 t = texture(u_patTex, fract((u_patP.xy + v_pat) * u_patP.zw));
		af *= t.a; rgb = t.a > 0.0 ? t.rgb / t.a : vec3(0.0);
	}
	if (af <= 0.003) discard;
	fragColor = vec4(mix(gndMix(cogTexMix(rgb, v_cuv), v_guv0, v_guv1, v_guv2, v_guv3), u_fogColor, v_fog) * af, af);  // premultiplied・ユーザCOG／地面アトラス（2D のラスタ重ね）＝塗りの上・線/建物/ラベルの下
}`;

// capsule 方式：両端をスクリーン空間へ投影して定px幅・丸端で描く。透視でも幅が一定。
// 本体は classic（インスタンス属性）と multi_draw（テクスチャpull）で共用＝式の乖離を構造的に防ぐ。
// 変種側が用意するローカル: o(シーン原点+タイル原点差 deg), p1/p2(原点相対 lon/lat), corner(end 0/1, side ±1),
// hw0(半幅 CSS px), off0(line-offset＝x:CSS px・右が正, y/z:始点/終点を線分の向きへ x×t 滑らせる＝角の継ぎ), col0(rgba),
// p0/p3(端と継ぎ＝前の線分の始点・次の線分の終点・原点相対＝並びのすぐ前後の線分から読む・S-P1-1), jf0(旗＝build.ts の JF_*)、
// dist0(破線＝始点までの線に沿う距離・z24 の px・S-P1-3)。
// 破線の uniform（u_dashP・u_dashI）は FS と共用＝LINE_DASH
const LINE_DASH = /* glsl */`${FX_TR}
uniform vec2 u_blur;      // line-blur（画素）・circle-blur（y＝1：半径の割合）＝縁から内へ薄める（S-P1-4/5）。x＝0 でぼかさない
uniform vec4 u_dashP;     // 破線（S-P1-3）＝(周期 P, 線の区間の数（0＝破線でない）, 丸い端 1／0, floor(zoom) の px ÷ z24 の px)
uniform vec4 u_dashI[2];  // 線の区間 [a, b]×4（線幅の倍数・scene.ts の dashIntervals）
uniform vec2 u_pzO;       // ズーム連続のずらし（paintzoom.ts）＝x 差し替える（1）・y 今の z のずらし（CSS px）。0＝頂点の値
uniform vec4 u_lt;        // 線の色の見本（G-3）＝x 1＝line-gradient（色の語は線分の始点・終点の進み unorm16×2・色は u_ltTex を画素の進みで引く）。0＝色の語が色
                          // x 2＝line-pattern（G-4）＝u_ltTex は模様の画像（前乗算）・y＝破線と同じ尺（floor(zoom) の px ÷ z24 の px）・z＝層の line-opacity`;
const LINE_VARY = /* glsl */`${LINE_DASH}
uniform float u_lift;   // 接地リフト(m)。都市帯（深度テスト×DTM起伏）で線を地形メッシュ面の上へ逃がす（fill の u_lift と同意味論）
uniform float u_cj;     // 端と継ぎ（S-P1-1）＝cap | join<<2 | round(miter-limit×8)<<4（build.ts の lineCapJoin）。0＝丸い端と丸い継ぎ＝p0/p3/jf0 を読まない（従来の capsule）
flat out vec2 v_a;
flat out vec2 v_b;
flat out float v_half;
flat out vec4 v_ja;     // 端 A の継ぎの切り口（二等分線）：点 xy・線分の側を向く法線 zw
flat out vec4 v_jb;     // 端 B の同じ物
flat out vec4 v_jk;     // 端の形 x＝A・y＝B（0 丸＝capsule・1 butt・2 square・3 miter・4 bevel・5 丸い継ぎ）・zw＝bevel の切り線の距離（符号＝外側の向き）
flat out vec2 v_dd;     // 破線：始点の位相・線分の長さ（線幅の倍数）
flat out vec2 v_gp;     // line-gradient（G-3）：始点・終点の進み（0..1）
out vec2 v_pos;
out vec4 v_color;
out float v_front;
out float v_fog;
// 継ぎの 3 点を画面へ（高さは継ぎ目の高さで揃える＝継ぎ目を共有する 2 本の線分が同じ値を得る）
vec2 jScr(vec2 o, vec2 p, float h, inout float ok) {
	vec3 rel = deltaToRel(p);
	vec4 c = u_clipT + u_mvp * vec4(rel + h * liftDir(o + p, u_originPt + rel), 0.0);
	if (c.w <= 0.0) ok = 0.0;
	return toScreen(c);
}
// 端 1 つの形（MapLibre の LineBucket と同じ選び方）。x→jt→y＝前の点・この端・次の点（start＝始点の端）。
// link＝0：端（line-cap）・1：隣と継ぐ・2：閉じた環の継ぎ目（隣が並びの前後に無い＝丸に倒す）。
// 継ぎは二等分線で切る：j＝切り口（点・線分の側を向く法線）・bev＝bevel の切り線・ext＝四角形を端から伸ばす長さ
float lineEnd(vec2 o, vec2 x, vec2 jt, vec2 y, float h, float hp, bool start, float link, out vec4 j, out float bev, out float ext) {
	float capK = mod(u_cj, 4.0), joinK = mod(floor(u_cj / 4.0), 4.0), ml = floor(u_cj / 16.0) / 8.0;
	j = vec4(0.0); bev = 0.0; ext = hp + 1.0;
	if (link == 0.0) {   // 端
		if (capK == 1.0) { ext = 1.0; return 1.0; }   // butt＝端で切る（AA の 1px だけ伸ばす）
		return capK == 2.0 ? 2.0 : 0.0;
	}
	if (link == 2.0) return 0.0;
	float ok = 1.0;
	vec2 sx = jScr(o, x, h, ok), sj = jScr(o, jt, h, ok), sy = jScr(o, y, h, ok);
	vec2 d0 = sj - sx, d1 = sy - sj;
	float l0 = length(d0), l1 = length(d1);
	if (ok < 0.5 || l0 < 1e-4 || l1 < 1e-4) return 0.0;   // カメラの背後・画面で長さ 0＝丸（capsule）に倒す
	d0 /= l0; d1 /= l1;
	vec2 s = d0 + d1; float ls = length(s);
	if (ls < 1e-3) return 0.0;   // 折り返し（180°）＝丸に倒す
	vec2 n = s / ls;             // 二等分線の法線（前→次の向き）
	vec2 N = start ? n : -n;     // 線分の側を向く
	j = vec4(sj, N);
	if (joinK == 0.0) return 5.0;
	float c = dot(n, d1), mlen = 1.0 / max(c, 1e-6);   // 曲がりの半角の cos・マイターの長さ（半幅の何倍）
	bev = sign(dot(d0 - d1, vec2(-N.y, N.x))) * hp * c;   // 外の角どうしを結ぶ線＝二等分線の点から外へ hp·c
	// miter は限界を超えたら bevel・bevel は限界未満なら miter（見分けられない＝MapLibre と同じ）
	if (bev == 0.0 || (joinK == 1.0 ? mlen <= ml : mlen < ml)) { ext = hp * max(1.0, sqrt(max(mlen * mlen - 1.0, 0.0))) + 1.0; return 3.0; }
	return 4.0;
}`;
const LINE_MAIN = /* glsl */`
	v_gp = u_lt.x > 0.5 && u_lt.x < 1.5 ? vec2(col0.x + col0.y * 256.0, col0.z + col0.w * 256.0) * (255.0 / 65535.0) : vec2(0.0);   // line-gradient（G-3）＝色の語の 4 バイト（/255）→ unorm16×2
	float hwD = u_pz.y > 0.5 ? u_pz.w : hw0;   // 破線の尺の線幅＝floor(z) の線幅（MapLibre の floorwidth）・差し替えない層は作ったタイルの z の値
	if (u_pz.y > 0.5) hw0 = u_pz.z;   // ズーム連続（V-Ph3＝S-P1-2）＝今の z の線幅と色
	if (u_pz.x > 0.5) col0 = u_pzC;
	if (u_pzO.x > 0.5) off0.x = u_pzO.y;
	if (u_tr.z != 0.0) { vec2 tr = trLL(o + p1); p0 += tr; p1 += tr; p2 += tr; p3 += tr; }   // line-translate（S-P1-4/5）＝線分ごとに同じだけ（継ぎの相手も）
	vec2 la1 = o + p1, la2 = o + p2;   // elev 参照用の絶対（粗くて可）。o=u_origin ゆえ p1/p2 が原点相対 delta
	vec3 rela = deltaToRel(p1), relb = deltaToRel(p2);   // 頂点3D − 原点3D（小・正確）
	vec3 da = u_originPt + rela, db = u_originPt + relb; // 絶対単位球点（front/fog/df 用＝粗くて可）
	// 接地リフト u_lift(m)：都市帯（深度テスト×DTM起伏）では、線ドレープ（頂点毎バイリニア）と
	// 地形サーフェス（72m級格子の三角形）の近似差＋疎頂点区間の直線化で、線が地形面を数十cm〜数m
	// 出入りする＝潜った区間が深度に食われ道路がギザギザになる（札幌 z16.9 実測）。数mのリフトで
	// 上へ逃がす。山岳帯は renderer が 0 を渡す＝従来の見た目のまま。
	// 標高変位は地形と同じ距離フェード（TERRAIN_VS の df と同式）＝遠景の平ら化に追随。
	// これが無いと平ら化された山脈の上に線だけがフル標高で浮き、「地平線に漂う点線の鎖」になる
	float dfa = 1.0 - smoothstep(u_fogFar * 0.8, u_fogFar * 2.0, distance(u_eye, da));
	float dfb = 1.0 - smoothstep(u_fogFar * 0.8, u_fogFar * 2.0, distance(u_eye, db));
	float ha = (elevQ(la1) + u_lift) * u_elevScale * dfa, hb = (elevQ(la2) + u_lift) * u_elevScale * dfb;   // 案A
	vec3 relWa = rela + ha * liftDir(la1, da), relWb = relb + hb * liftDir(la2, db);   // (dir*(1+h)) − 原点3D を相殺なしで（楕円体＝測地法線）
	vec3 wa = u_originPt + relWa, wb = u_originPt + relWb;       // 絶対（fog 用＝粗くて可）
	vec4 ca = u_clipT + u_mvp * vec4(relWa, 0.0), cb = u_clipT + u_mvp * vec4(relWb, 0.0);   // RTE：mvp*[w,1] を相殺なしで
	float fa = dot(da, u_eye) - 1.0, fb = dot(db, u_eye) - 1.0;
	if (ca.w <= 0.0 || cb.w <= 0.0) { v_front = -1.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }  // カメラ背後
	vec2 sa = toScreen(ca), sb = toScreen(cb);
	vec2 d = sb - sa; float len = length(d);
	vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
	vec2 perp = vec2(-dir.y, dir.x);   // 画面は y 下向き＝進行方向の右
	// line-offset（#49）：端点を画面空間で perp＋dir×t だけ動かす（t＝build.js miterSlides の角の継ぎ＝隣の線分の端点と同じ所へ）
	float offPx = off0.x * u_dpr;
	sa += (perp + dir * off0.y) * offPx; sb += (perp + dir * off0.z) * offPx;
	float hw = hw0 * u_dpr + 1.0;        // +1px の AA/丸端余白
	// 端と継ぎ（S-P1-1）：丸でない層（u_cj≠0）だけ端ごとに形を決め、四角形を端から伸ばす長さ（eA・eB）を変える
	float eA = hw, eB = hw;
	v_ja = vec4(0.0); v_jb = vec4(0.0); v_jk = vec4(0.0);
	if (u_cj > 0.5) {
		float hp = hw0 * u_dpr, bA, bB;
		float fl = jf0, lA = mod(fl, 2.0) == 1.0 ? 1.0 : mod(floor(fl / 4.0), 2.0) == 1.0 ? 2.0 : 0.0, lB = mod(floor(fl / 2.0), 2.0) == 1.0 ? 1.0 : floor(fl / 8.0) == 1.0 ? 2.0 : 0.0;
		v_jk.x = lineEnd(o, p0, p1, p2, ha, hp, true, lA, v_ja, bA, eA);
		v_jk.y = lineEnd(o, p1, p2, p3, hb, hp, false, lB, v_jb, bB, eB);
		v_jk.zw = vec2(bA, bB);
	}
	// 破線（S-P1-3）：模様の位相は地面の長さ（z24 の px）を floor(zoom) の px にして線幅で割る＝MapLibre の tileRatio／floorwidth と同じ。
	// 線分の長さは経緯度から（縦は中点の緯度のメルカトル＝scene.ts の segLen24 と同式）。line-pattern（G-4）の横の位相も同じ（尺は u_lt.y）
	v_dd = vec2(0.0);
	if (u_dashP.y > 0.5 || u_lt.x > 1.5) {
		float my = (p2.y - p1.y) * 0.017453293 / cos((o.y + (p1.y + p2.y) * 0.5) * 0.017453293) / 6.2831853;
		v_dd = vec2(dist0, length(vec2((p2.x - p1.x) / 360.0, my)) * 4294967296.0) * ((u_dashP.y > 0.5 ? u_dashP.w : u_lt.y) / max(2.0 * hwD, 1e-3));
	}
	vec2 base = corner.x < 0.5 ? sa : sb;
	float capSign = corner.x < 0.5 ? -1.0 : 1.0;
	vec2 pos = base + perp * (hw * corner.y) + dir * (capSign * (corner.x < 0.5 ? eA : eB));
	v_a = sa; v_b = sb; v_half = hw0 * u_dpr; v_pos = pos;
	v_color = col0; v_front = min(fa, fb);
	v_fog = fogOf((wa + wb) * 0.5);
	// 端点の深度は対数系（applyLogDepth と同式）＝地形・建物と同じ深度空間（山岳ビューで尾根の向こうを遮蔽）
	float wz = (corner.x < 0.5) ? ca.w : cb.w;
	float zc = log2p1(max(wz, 1e-30)) * u_logCoef - 1.0;   // 1.0+w の桁落ちを避ける（PROJECT の log2p1）
	vec2 ndc = vec2(pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - pos.y / u_viewport.y * 2.0);
	gl_Position = vec4(ndc, zc, 1.0);
`;
export const LINE_VS = `#version 300 es
precision highp float;
in vec2 a_p1;
in vec2 a_p2;
in vec2 a_corner;   // (end 0/1, side -1/+1)
in float a_half;    // CSS px
in vec3 a_off;      // line-offset（#49）[CSS px, tS, tE]・持たない層は属性を切る＝既定値 0
in vec2 a_p0;       // 端と継ぎ（S-P1-1）：前の線分の始点・次の線分の終点（renderer が P1／P2 のバッファを 1 線分ずらして読ませる）・旗（JF_*）
in vec2 a_p3;
in float a_jf;      // 持たない層は属性を切る（u_cj＝0 で読まない）
in float a_dist;    // 破線（S-P1-3）の始点までの線に沿う距離（z24 の px）・持たない層は属性を切る（u_dashP.y＝0 で読まない）
in vec4 a_color;
uniform float u_dpr;
${PROJECT}
${QELEV}
${LINE_VARY}
void main() {
	vec2 o = u_origin;
	vec2 p1 = a_p1, p2 = a_p2, corner = a_corner;
	float hw0 = a_half; vec3 off0 = a_off; vec4 col0 = a_color; vec2 p0 = a_p0, p3 = a_p3; float jf0 = a_jf, dist0 = a_dist;
${LINE_MAIN}
}`;

// --- multi_draw（タイルバッファGPU常駐）用の変種 ---
// 頂点はタイル原点相対のまま常駐し、gl_DrawID → u_tileOff[]（タイル原点−シーン原点）で再ベース＝
// merge の CPU memcpy と setScene の全バッファ再生成を丸ごと廃す。u_tileOff は uniform 配列（UBO不要の規模）。
export const MD_MAX_DRAWS = 128;   // 1回の multiDraw に載せる最大タイル数（超過は呼び出し側がチャンク分割）

// 既存シェーダの機械変換（対象文字列が消えたらロード時に即 throw ＝サイレントな取りこぼしを防ぐ）
function mdize(src: string, subs: readonly (readonly [string, string])[]): string {
	let s = src.replace("#version 300 es", "#version 300 es\n#extension GL_ANGLE_multi_draw : require");
	for (const [from, to] of subs) {
		if (!s.includes(from)) throw new Error("mdize: 置換対象が見つからない: " + from);
		s = s.split(from).join(to);
	}
	return s;
}
// 加算順は classic（merge済み頂点）と厳密に揃える：小さい値同士（タイル原点差＋タイル相対頂点）を先に足し、
// 大きい u_origin は最後に1回だけ＝大きい桁での丸めが classic と同じ1回で済む（外側から足すと z18+ で数px级の格子化が出る）。
export const FILL_MD_VS = mdize(FILL_VS, [
	["in vec4 a_color;", `in vec4 a_color;\nuniform vec2 u_tileOff[${MD_MAX_DRAWS}];${PT}`],
	["v_color = u_pz.x > 0.5 ? u_pzC : a_color;", "v_color = u_pz.x > 0.5 ? u_pzC : u_pt > 0.5 ? ptColor(ptRowOf(a_color)) : a_color;"],   // paint 表の (b) 類
	["vec2 dLL = a_delta;", "vec2 dLL = u_tileOff[gl_DrawID] + a_delta;"],   // タイル原点差（小）を先に足す＝原点相対 delta を確定
]);
export const BUILDING_MD_VS = mdize(BUILDING_VS, [
	["in vec2 a_anchor;", `in vec2 a_anchor;\nuniform vec2 u_tileOff[${MD_MAX_DRAWS}];`],
	["vec2 dLL = a_pos.xy;", "vec2 dLL = u_tileOff[gl_DrawID] + a_pos.xy;"],       // タイル原点差（小）を先に足す
	["vec2 dAnchor = a_anchor;", "vec2 dAnchor = u_tileOff[gl_DrawID] + a_anchor;"],
]);
// 線は属性を持たない multiDrawArrays（6頂点/線分）：WEBGL_multi_draw に baseInstance が無く、
// インスタンス属性の常駐プール化ができないため、線分データはテクスチャで持ち gl_VertexID から引く。
// RGBA32UI（float の bit を uint で格納）＝RGBA32F だと色のパックbitが NaN 正規化で壊れる恐れがある。
export const LINE_MD_VS = `#version 300 es
#extension GL_ANGLE_multi_draw : require
precision highp float;
precision highp usampler2D;
// 線分プール（2texel/線分）: [bits(p1.x), bits(p1.y), bits(p2.x), bits(p2.y)] [colRGBA8パック, bits(half)（下位 4 bit＝端と継ぎの旗・S-P1-1）, bits(off), snorm16×2(tS/2,tE/2)]
// 破線の列（u_dashP.y＞0・S-P1-3）は 語 6 が bits(始点までの線に沿う距離)・語 7 は角の継ぎ（ずらしは層で 1 つの値＝u_pzO・ずらさない層は 0）
uniform usampler2D u_segTex;
uniform vec2 u_tileOff[${MD_MAX_DRAWS}];${PT}
uniform float u_dpr;
${PROJECT}
${QELEV}
${LINE_VARY}
const vec2 CORN[6] = vec2[6](vec2(0., -1.), vec2(0., 1.), vec2(1., -1.), vec2(1., -1.), vec2(0., 1.), vec2(1., 1.));   // renderer の CORNERS と同一
void main() {
	int seg = gl_VertexID / 6;
	vec2 corner = CORN[gl_VertexID - seg * 6];
	int tw = textureSize(u_segTex, 0).x;
	int t0 = seg * 2;
	uvec4 A = texelFetch(u_segTex, ivec2(t0 % tw, t0 / tw), 0);
	uvec4 B = texelFetch(u_segTex, ivec2((t0 + 1) % tw, (t0 + 1) / tw), 0);
	vec2 off = u_tileOff[gl_DrawID];
	// タイル原点差はここ（小さい値同士）で足す＝大きい u_origin の加算は LINE_MAIN 内で1回だけ（classic と同じ丸め回数）
	vec2 p1 = vec2(uintBitsToFloat(A.x), uintBitsToFloat(A.y)) + off;
	vec2 p2 = vec2(uintBitsToFloat(A.z), uintBitsToFloat(A.w)) + off;
	vec4 col0 = u_pt > 0.5 ? ptColor(int(B.x & 65535u)) : vec4(float(B.x & 255u), float((B.x >> 8) & 255u), float((B.x >> 16) & 255u), float(B.x >> 24)) / 255.0;   // paint 表の (b) 類＝語 4 が行
	float hw0 = uintBitsToFloat(B.y);
	vec3 off0 = vec3(uintBitsToFloat(B.z), unpackSnorm2x16(B.w) * 2.0);
	float dist0 = 0.0;
	if (u_dashP.y > 0.5 || u_lt.x > 1.5) { dist0 = uintBitsToFloat(B.z); off0.x = 0.0; }   // 線の模様（G-4）も語 6 が距離
	// 端と継ぎ（S-P1-1）：旗は半幅の下位 4 bit。継ぐ相手は同じ塊のすぐ前後の線分（旗が立つ時だけ読む）＝p1/p2 と同じ足し算でビット同値
	vec2 p0 = p1, p3 = p2; float jf0 = 0.0;
	if (u_cj > 0.5) {
		jf0 = float(B.y & 15u); hw0 = uintBitsToFloat(B.y & ~15u);
		if ((B.y & 1u) != 0u) { int tp = t0 - 2; uvec4 P = texelFetch(u_segTex, ivec2(tp % tw, tp / tw), 0); p0 = vec2(uintBitsToFloat(P.x), uintBitsToFloat(P.y)) + off; }
		if ((B.y & 2u) != 0u) { int tn = t0 + 2; uvec4 N = texelFetch(u_segTex, ivec2(tn % tw, tn / tw), 0); p3 = vec2(uintBitsToFloat(N.z), uintBitsToFloat(N.w)) + off; }
	}
	if (u_pt > 1.5) { hw0 = ptHalf(int(B.x & 65535u)); if (u_cj > 0.5) hw0 = uintBitsToFloat(floatBitsToUint(hw0) & ~15u); }   // 線幅も表（段 2b）＝語 5 と同じく旗の 4 bit を落とす（焼いた半幅と bit 同値）
	vec2 o = u_origin;
${LINE_MAIN}
}`;

export const LINE_FS = `#version 300 es
precision highp float;
uniform float u_baseAlpha;   // 基図の濃さ（fill と同じスライダー）
uniform vec3 u_fogColor;
uniform vec2 u_viewport;     // 継ぎの切り口は画素の中心（gl_FragCoord）で測る＝補間した v_pos の三角形ごとの丸めの差で継ぎ目に二度塗り・塗り残しを出さない
flat in vec2 v_a;
flat in vec2 v_b;
flat in float v_half;
flat in vec4 v_ja;
flat in vec4 v_jb;
flat in vec4 v_jk;
flat in vec2 v_dd;
flat in vec2 v_gp;
uniform sampler2D u_ltTex;   // 線の色の見本（G-3＝line-gradient の 256 段・RGBA8・前乗算しない）・線の模様（G-4＝画像・前乗算）。使わない層も unit 16（PAT_UNIT）を指す＝型の合う標本器
${LINE_DASH}
in vec2 v_pos;
in vec4 v_color;
in float v_front;
in float v_fog;
out vec4 fragColor;
// 端の先の覆い（S-P1-1）：k＝端の形（LINE_VARY の v_jk）・e＝端からの距離（先へ正）・q＝端からの位置・j＝切り口・bev＝bevel の切り線。
// 丸い形の時だけ dist（芯からの距離）を端の点からの距離に替える
float lineTail(float k, float e, vec2 q, vec4 j, float bev, float hw, inout float dist) {
	if (k == 0.0 || k == 5.0) { dist = length(q); return 1.0; }   // 丸い端・丸い継ぎ
	if (k == 1.0) return clamp(0.5 - e * 2.0, 0.0, 1.0);          // butt＝端で切る
	if (k == 2.0) return clamp((hw - e) * 2.0 + 0.5, 0.0, 1.0);   // square＝半幅だけ出す
	if (k == 4.0) return clamp((abs(bev) - sign(bev) * dot(q, vec2(-j.w, j.z))) * 2.0 + 0.5, 0.0, 1.0);   // bevel＝外の角どうしを結ぶ線で切る
	return 1.0;   // miter＝切り口まで伸ばした帯そのもの
}
void main() {
	if (v_front < -0.0015) discard;   // 接線に標高許容（地平線に頭を出す山上の線も描く。遮蔽は深度とフォグ）
	vec2 pa = v_pos - v_a, ba = v_b - v_a;
	float dist, cov = 1.0;
	if (v_jk.x == 0.0 && v_jk.y == 0.0) {   // 丸い端・丸い継ぎ＝capsule（線分までの距離）
		float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
		dist = length(pa - ba * t);
	} else {   // 端と継ぎ（S-P1-1）：継ぎは二等分線の向こうを捨てる（隣の線分の受け持ち＝同じ線で切るので隙も重なりも無い）
		// 線の上の画素（ちょうど 0）は始点の側（次の線分）が取る＝終点の側は 0 も捨てる
		vec2 fp = vec2(gl_FragCoord.x, u_viewport.y - gl_FragCoord.y);
		if (v_jk.x >= 3.0 && dot(fp - v_ja.xy, v_ja.zw) < 0.0) discard;
		if (v_jk.y >= 3.0 && dot(fp - v_jb.xy, v_jb.zw) <= 0.0) discard;
		float L = length(ba);
		if (L < 1e-3 && (v_jk.x == 1.0 || v_jk.x == 2.0)) discard;   // 長さ 0 の線分の角い端＝描かない（MapLibre は重なった点を捨てる）
		vec2 dir = L > 1e-6 ? ba / L : vec2(1.0, 0.0);
		float u = dot(pa, dir);
		dist = abs(dot(pa, vec2(-dir.y, dir.x)));
		float hw0 = max(v_half, 0.5);
		// 端の先の位置は、継ぎなら切り口の点から（両隣で同じ点）・端なら自分の端点から
		if (u < 0.0) cov = lineTail(v_jk.x, -u, v_pos - (v_jk.x >= 3.0 ? v_ja.xy : v_a), v_ja, v_jk.z, hw0, dist);
		else if (u > L) cov = lineTail(v_jk.y, u - L, v_pos - (v_jk.y >= 3.0 ? v_jb.xy : v_b), v_jb, v_jk.w, hw0, dist);
	}
	// 破線（S-P1-3）：画素の線に沿う位相 x を模様の周期に畳み、線の区間までの距離で切る。butt・square＝区間の端で切る（MapLibre の addRegularDash）・
	// round＝区間の芯からの距離を半幅で丸く切る（長さ 0 の線＝点・MapLibre の addRoundDash）。線分の外（端と継ぎ）は端点の位相のまま
	if (u_dashP.y > 0.5) {
		float Ls = length(ba), k = Ls > 1e-3 ? v_dd.y / Ls : 0.0;   // 線幅の倍数／画素（地面の尺＝傾いた画面では縮む＝MapLibre と同じ）
		if (k > 1e-7) {
			float x = v_dd.x + clamp(dot(pa, ba / Ls), 0.0, Ls) * k;
			x -= u_dashP.x * floor(x / u_dashP.x);
			float s = -1e9;   // 線の区間までの符号つき距離（画素・内が正）
			for (int i = 0; i < 4; i++) {
				if (float(i) >= u_dashP.y) break;
				vec2 ab = i == 0 ? u_dashI[0].xy : i == 1 ? u_dashI[0].zw : i == 2 ? u_dashI[1].xy : u_dashI[1].zw;
				for (int m = -1; m <= 1; m++) {
					float xm = x + float(m) * u_dashP.x;
					if (u_dashP.z > 0.5) s = max(s, -length(vec2(max(max(ab.x - xm, xm - ab.y), 0.0) / k, dist)));
					else s = max(s, min(xm - ab.x, ab.y - xm) / k);
				}
			}
			if (u_dashP.z > 0.5) dist = -s;
			else cov *= clamp(s * 2.0 + 0.5, 0.0, 1.0);
		}
	}
	// 細線のシャープ化（製図の定石）：幾何幅は最低±0.5px を保証し、それ未満の細さは透明度（カバレッジ）で表現。
	// サブピクセル幅をそのまま描くと±0.5pxのAAフェザーが本体より太くなり「淡くボケた2pxの線」＝低ズームの滲みになる。
	// さらにフェザー自体を±0.25pxへ半減（×2.0）＝エッジの立ち上がりを締める。Retina(dpr2)ではCSS 0.125px相当。
	// 結果は「常にカリッと・細いほど薄く」＝シャープで主張しない線。
	float hw = max(v_half, 0.5);
	float edge = clamp((hw - dist) * 2.0 + 0.5, 0.0, 1.0);
	// ぼかし（S-P1-4/5）：line-blur＝縁（＋半画素）から内へ blur＋1 画素で線形（MapLibre の blur2）・circle-blur＝半径の (1−blur) から縁へ smoothstep（MapLibre の circle）
	if (u_blur.x > 0.0) edge = u_blur.y > 0.5 ? 1.0 - smoothstep(hw * (1.0 - u_blur.x), hw, dist) : clamp((hw + 0.5 - dist) / (u_blur.x + 1.0), 0.0, 1.0);
	float alpha = edge * cov * min(v_half * 2.0, 1.0);
	if (alpha <= 0.0) discard;
	// 霧はフェードアウト（透明化）：塗り潰し式だと地平線の先の線が「空に浮く白線」になる（球の自遮蔽の代役）。
	// 1.2倍＝霧83%で完全消滅：地形の霞の帯より先に消え、暗い空に線の尻尾（残影）が残らない
	// line-gradient（G-3）：画素の進み＝線分の上の位置で始点・終点の進みを補う（線分の外＝端と継ぎは端点の値）→ 見本の 256 段の真ん中を引く
	vec4 lc = v_color;
	if (u_lt.x > 1.5) {   // line-pattern（G-4）＝MapLibre の line_pattern：横＝線に沿う位相（floor(zoom) の線幅の倍数）×画像の高さ÷幅、縦＝線の幅（右が下）。線分の外（端と継ぎ）は位相を延ばす＝隣の線分と続く。line-color は読まない
		float Ls = length(ba), k = Ls > 1e-3 ? v_dd.y / Ls : 0.0;
		vec2 ts = vec2(textureSize(u_ltTex, 0));
		float x = v_dd.x + dot(pa, ba) / max(Ls, 1e-6) * k, sd = Ls > 1e-6 ? dot(pa, vec2(-ba.y, ba.x)) / Ls : 0.0;
		vec4 t = texture(u_ltTex, vec2(fract(x * ts.y / ts.x), clamp(0.5 + sd / (2.0 * max(v_half, 0.5)), 0.5 / ts.y, 1.0 - 0.5 / ts.y)));
		lc = vec4(t.a > 0.0 ? t.rgb / t.a : vec3(0.0), t.a * u_lt.z);
	} else if (u_lt.x > 0.5) lc = texture(u_ltTex, vec2(mix(v_gp.x, v_gp.y, clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0)) * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
	float a = lc.a * alpha * clamp(1.0 - 1.2 * v_fog, 0.0, 1.0) * u_baseAlpha;
	if (a <= 0.003) discard;
	vec3 rgb = mix(lc.rgb, u_fogColor, v_fog);
	fragColor = vec4(rgb * a, a);
}`;


// 画像タイル層のアトラス合成（raster.js・RTT ドレープ・2026-09-21）：タイル（メルカトル）を経緯度整列の窓へ描く。
// 頂点＝タイル北西隅からの dLL（格子の行は逆メルカトルの緯度＝warp はメッシュが担う）・u_tileOff＝タイル北西隅−窓の南西隅（CPU f64）。
// 出力は前乗算（under 不透明→over 半透明の順に over 合成）。地形・球・塗りの FS が rasMix で画素標本化する。
export const RASTER_ATLAS_VS = `#version 300 es
precision highp float;
in vec2 a_delta;
in vec2 a_uv;
uniform vec2 u_tileOff;
uniform vec2 u_winInv;
uniform vec4 u_uvT;   // 祖先フォールバックの部分 uv (u0,v0,su,sv)
out vec2 v_uv;
void main() {
	vec2 p = (u_tileOff + a_delta) * u_winInv;
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
	v_uv = u_uvT.xy + a_uv * u_uvT.zw;
}`;
export const RASTER_ATLAS_FS = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform float u_opacity;
in vec2 v_uv;
out vec4 fragColor;
void main() {
	vec4 c = texture(u_tex, v_uv);
	float a = c.a * u_opacity;
	fragColor = vec4(c.rgb * a, a);   // premultiplied
}`;

// ベクタ塗りを地面アトラスへ焼く（RTT ドレープ・3D 限定・2026-09-21）：頂点＝シーン原点相対 dLL（塗りの VBO そのまま）→ 窓の正規化座標。
// u_atlOff＝シーン原点−窓南西隅（CPU f64）・u_atlInv＝1/窓幅。図郭外の水域ゲート（陸は塗らない）は FS が標高テクスチャで同じ判定。
// 出力は前乗算。multi_draw 変種は mdize（u_tileOff[gl_DrawID] を先に足す＝塗り本体と同じ加算順）。
export const ATLAS_FILL_VS = `#version 300 es
precision highp float;
in vec2 a_delta;
in vec4 a_color;
uniform vec2 u_origin;
uniform vec2 u_atlOff;
uniform vec2 u_atlInv;
out vec4 v_color;
out vec2 v_ll;
void main() {
	vec2 dLL = a_delta;
	vec2 p = (u_atlOff + dLL) * u_atlInv;
	gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
	v_color = a_color;
	v_ll = u_origin + dLL;
}`;
export const ATLAS_FILL_MD_VS = mdize(ATLAS_FILL_VS, [
	["in vec4 a_color;", `in vec4 a_color;\nuniform vec2 u_tileOff[${MD_MAX_DRAWS}];${PT}`],
	["v_color = a_color;", "v_color = u_pt > 0.5 ? ptColor(ptRowOf(a_color)) : a_color;"],   // paint 表の (b) 類
	["vec2 dLL = a_delta;", "vec2 dLL = u_tileOff[gl_DrawID] + a_delta;"],
]);
export const ATLAS_FILL_FS = `#version 300 es
precision highp float;
uniform float u_seaGate;    // 1＝図郭外フォールバック水域：標高が陸(h>0)の画素は塗らない
uniform float u_baseAlpha;  // 基図の濃さ（表示パネルのスライダー）
${ELEV}
in vec4 v_color;
in vec2 v_ll;
out vec4 fragColor;
void main() {
	if (u_seaGate > 0.5 && elev(v_ll) > 0.0) discard;
	float a = v_color.a * u_baseAlpha;
	if (a <= 0.003) discard;
	fragColor = vec4(v_color.rgb * a, a);   // premultiplied
}`;

// 標高セルの GPU 再標本化（perf plan P1 step 1・2026-09-27）＝gpu/wgsl.js ELEV_RESAMPLE_WGSL と同式（elevation.js downsampleFlipped／cropResample・worldatlas.js worldAtlasCell の写し）。
// 生タイルは整数テクスチャ（R16I・Int16）か浮動小数テクスチャ（R32F・Float32）＝サンプラ型で 2 本のプログラム（ELEV_RESAMPLE_FS(kind)）。
// 標本位置は uint の整数分数（gx = (Ax + Bx·(2i+1)) / Dx）＝JS の f64 と同じ位置。出力＝R16F アトラス（EXT_color_buffer_float）のセル矩形へ 3 頂点 1 発。
export const ELEV_RESAMPLE_VS = `#version 300 es
void main() { gl_Position = vec4(float(int(uint(gl_VertexID) & 1u) * 4 - 1), float(int(uint(gl_VertexID) >> 1u) * 4 - 1), 0.0, 1.0); }`;
export const ELEV_RESAMPLE_FS = (kind: number): string => `#version 300 es
precision highp float; precision highp int; precision highp isampler2D; precision highp sampler2D;
uniform ${kind === 0 ? "isampler2D" : "sampler2D"} u_raw;   // 生タイル（row0＝北・texel(x,y)＝data[y*w+x]）
uniform uvec4 u_dim;   // w, h, kind, mode(0=down 1=box 2=crop 3=float)
uniform vec4  u_a;     // mode 3: ax, bx, ay, by
uniform vec4  u_lo;    // mode 3: gx∈[x,y]・gy∈[z,w]
uniform uvec4 u_o;     // ox, oy（セル原点 texel）, N, k
uniform uvec4 u_box;   // mode 1: AW, rowN0, col0, 0／mode 0: M（読まない最外周の画素数）・w＝1 で海底（mode 0/2）
uniform uvec4 u_ix;    // mode 0/2: Ax, Bx, Dx, shift（gx = (Ax + Bx·(2i+1))/Dx − shift＝画素中心の −½ を符号なしで書くための下駄・2026-10-02）
uniform uvec4 u_iy;    // mode 0/2: Ay, By, Dy, shift
out vec4 fragColor;
float rdRaw(uint idx) { ivec2 p = ivec2(int(idx % u_dim.x), int(idx / u_dim.x)); return ${kind === 0 ? "float(texelFetch(u_raw, p, 0).r)" : "texelFetch(u_raw, p, 0).r"}; }
float rd(uint idx) { float v = rdRaw(idx); if (!(v >= (u_box.w == 1u ? -11500.0 : -420.0) && v <= 9000.0)) return 0.0; return v; }   // box.w＝1：海底（GEBCO の負値を通す）
void main() {
	uint i = uint(gl_FragCoord.x) - u_o.x; uint j = uint(gl_FragCoord.y) - u_o.y;
	uint w = u_dim.x; uint h = u_dim.y; uint mode = u_dim.w;
	float v;
	if (mode == 1u) {
		uint k = u_o.w; uint C = u_o.z * k;
		uint srcRow = u_box.y + (C - 1u - j * k);
		float sum = 0.0;
		for (uint jj = 0u; jj < k; jj++) { uint s = (srcRow - jj) * u_box.x + u_box.z + i * k; for (uint ii = 0u; ii < k; ii++) sum += rdRaw(s + ii); }
		v = sum / float(k * k);
	} else {
		uint x0; float fx; uint y0; float fy;
		if (mode == 3u) {
			float gx = clamp(u_a.x + u_a.y * (float(i) + 0.5), u_lo.x, u_lo.y);
			float gy = clamp(u_a.z + u_a.w * (float(j) + 0.5), u_lo.z, u_lo.w);
			x0 = uint(clamp(floor(gx), 0.0, float(w - 2u))); fx = clamp(gx - float(x0), 0.0, 1.0);
			y0 = uint(clamp(floor(gy), 0.0, float(h - 2u))); fy = clamp(gy - float(y0), 0.0, 1.0);
		} else {
			uint nx = u_ix.x + u_ix.y * (2u * i + 1u); uint qx = nx / u_ix.z; uint rx = nx - qx * u_ix.z;
			uint ny = u_iy.x + u_iy.y * (2u * j + 1u); uint qy = ny / u_iy.z; uint ry = ny - qy * u_iy.z;
			bool negx = qx < u_ix.w; bool negy = qy < u_iy.w;   // gx < 0（タイル西端・南端の半画素）＝画素 0 でクランプ（CPU の x0=0・fx=0 と同じ）
			qx = negx ? 0u : qx - u_ix.w; qy = negy ? 0u : qy - u_iy.w;
			x0 = qx; fx = negx ? 0.0 : float(rx) / float(u_ix.z); y0 = qy; fy = negy ? 0.0 : float(ry) / float(u_iy.z);
			if (mode == 0u) {
				uint M = u_box.x;
				if (qx < M) { x0 = M; fx = 0.0; } else if (qx > w - 1u - M || (qx == w - 1u - M && rx > 0u)) { x0 = w - 1u - M; fx = 0.0; }
				if (qy < M) { y0 = M; fy = 0.0; } else if (qy > h - 1u - M || (qy == h - 1u - M && ry > 0u)) { y0 = h - 1u - M; fy = 0.0; }
			} else {
				if (qx > w - 2u) { x0 = w - 2u; fx = 1.0; }
				if (qy > h - 2u) { y0 = h - 2u; fy = 1.0; }
			}
		}
		uint r0 = (h - 1u - y0) * w; uint r1 = r0 - w;
		float a = rd(r0 + x0); float b = rd(r0 + x0 + 1u); float c = rd(r1 + x0); float d = rd(r1 + x0 + 1u);
		float t = a + (b - a) * fx;
		v = t + ((c + (d - c) * fx) - t) * fy;
	}
	fragColor = vec4(u_box.w == 1u ? v : max(v, 0.0), 0.0, 0.0, 1.0);
}`;

// ── 断面とクリッピング平面の WebGL2 版（P0 #3・2026-10-25）＝WebGPU の CLIP_WGSL・CLIP_STEPS（gpu/wgsl.ts）と同じ作法・同じ並び。
// 切っている時だけ使う派生（本体の文字列は 1 バイトも変えない）。面と多角形は uniform block ClipP（std140）＝clip.ts packClip の並びそのまま
// （pl[6]・p・capT・capB・edgeC・pe・pn・pv[64]＝1216B）。p.y＝縁の帯の幅は renderer が dpr を掛けて詰める（device px）。
// 距離は VS で頂点ごと・面ごとに出して補間し、最小は FS で取る（両端が箱の外の大きな三角形を中身ごと消さない）。微分（fwidth）は discard より前。
const CLIP_GLSL = /* glsl */`
layout(std140) uniform ClipP { vec4 pl[6]; vec4 p; vec4 capT; vec4 capB; vec4 edgeC; vec4 pe; vec4 pn; vec4 pv[64]; } CL;
vec2 polyXY(vec3 rel) { return vec2(dot(CL.pe.xyz, rel) + CL.pe.w, dot(CL.pn.xyz, rel) + CL.pn.w); }
float polyD(vec2 q) {   // 多角形までの符号付きの距離（残る側が正・内外は偶奇）
	int n = int(CL.p.z);
	if (n == 0) return 1e30;
	float d2 = 1e30;
	bool inside = false;
	for (int i = 0; i < 64; i++) {
		if (i >= n) break;
		vec2 a = CL.pv[i].xy, b = CL.pv[i].zw;
		if ((a.y > q.y) != (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
		vec2 v = b - a; float t = clamp(dot(q - a, v) / max(dot(v, v), 1e-30), 0.0, 1.0); vec2 w = q - a - t * v;
		d2 = min(d2, dot(w, w));
	}
	float d = sqrt(d2);
	if (inside != (CL.p.w > 0.5)) d = -d;
	return d;
}
float clipD(vec3 rel, int i) { return i < int(CL.p.x) ? dot(CL.pl[i].xyz, rel) + CL.pl[i].w : 1e30; }
vec4 clipA(vec3 rel) { return vec4(clipD(rel, 0), clipD(rel, 1), clipD(rel, 2), clipD(rel, 3)); }
vec4 clipB(vec3 rel) { return vec4(clipD(rel, 4), clipD(rel, 5), polyXY(rel)); }
float clipMin(vec4 a, vec4 b) { return min(min(min(min(a.x, a.y), min(a.z, a.w)), min(b.x, b.y)), polyD(b.zw)); }
float clipDist(vec3 rel) {   // 画素で位置が分かる時（球の床）＝全部の面と多角形の最小
	float d = 1e30;
	for (int i = 0; i < 6; i++) d = min(d, clipD(rel, i));
	return min(d, polyD(polyXY(rel)));
}
`;
const PREC = "precision highp float;\n";
const withClip = (src: string): string => { if (src.split(PREC).length < 2) throw new Error("glsl clip: precision line missing"); return src.replace(PREC, PREC + CLIP_GLSL); };
const VS_OUT = "out vec4 v_cdA;\nout vec4 v_cdB;\n", FS_IN = "in vec4 v_cdA;\nin vec4 v_cdB;\n";
const CD_SET = (rel: string): string => `v_cdA = clipA(${rel}); v_cdB = clipB(${rel});`;
const EDGE_HEAD = "\tfloat cm = clipMin(v_cdA, v_cdB); float cw = fwidth(cm);\n\tif (cm < 0.0) discard;\n\tif (CL.p.y > 0.0 && cm < CL.p.y * cw) { fragColor = vec4(CL.edgeC.rgb, 1.0); return; }\n";
const DISCARD = "\tif (clipMin(v_cdA, v_cdB) < 0.0) discard;\n";
type Pairs = readonly (readonly [string, string])[];
const clipGL = (src: string, pairs: Pairs, label: string): string => withClip(derive(src, pairs, label));
// 地形（帯は最後に＝この後に地面アトラスの texture がある）
const TERR_VS_C: Pairs = [["out vec2 v_guv3;\n", "out vec2 v_guv3;\n" + VS_OUT], ["\tv_front = dot(u_eye, u_eye) < 1.0 ? 1.0 : dot(dir, u_eye) - 1.0;\n\tv_fog = fogOf(u_originPt + relW);", `\t${CD_SET("relW")}\n\tv_front = dot(u_eye, u_eye) < 1.0 ? 1.0 : dot(dir, u_eye) - 1.0;\n\tv_fog = fogOf(u_originPt + relW);`]];
export const TERRAIN_CLIP_VS = clipGL(TERRAIN_VS, TERR_VS_C, "TERRAIN_CLIP_VS");
export const TERRAIN_CLIP_FS = clipGL(TERRAIN_FS, [
	["in float v_h;\n", "in float v_h;\n" + FS_IN],
	["\tfloat mpp = fwidth(v_ll.y) * 111320.0;", "\tfloat cm = clipMin(v_cdA, v_cdB); float cw = fwidth(cm);\n\tif (cm < 0.0) discard;\n\tbool edgeOn = CL.p.y > 0.0 && cm < CL.p.y * cw;\n\tfloat mpp = fwidth(v_ll.y) * 111320.0;"],
	["\tfragColor = vec4(col * t * u_globeAlpha, g.a * t * u_globeAlpha);", "\tif (edgeOn) { fragColor = vec4(CL.edgeC.rgb, 1.0); return; }\n\tfragColor = vec4(col * t * u_globeAlpha, g.a * t * u_globeAlpha);"],
], "TERRAIN_CLIP_FS");
// 基図の押し出し建物（向きが揃っていない＝疑似の蓋は付けず帯だけ）
const BLD_VS_C: Pairs = [["out vec2  v_ll;", "out vec4 v_cdA;\nout vec4 v_cdB;\nout vec2  v_ll;"], ["\tv_shade = a_shade;\n", `\t${CD_SET("relW")}\n\tv_shade = a_shade;\n`]];
export const BUILDING_CLIP_VS = clipGL(BUILDING_VS, BLD_VS_C, "BUILDING_CLIP_VS");
export const BUILDING_MD_CLIP_VS = clipGL(BUILDING_MD_VS, BLD_VS_C, "BUILDING_MD_CLIP_VS");
export const BUILDING_CLIP_FS = clipGL(BUILDING_FS, [
	["in vec2  v_ll;\n", "in vec2  v_ll;\n" + FS_IN],
	["void main() {\n\tif (v_front < 0.0) discard;\n", "void main() {\n" + EDGE_HEAD + "\tif (v_front < 0.0) discard;\n"],
], "BUILDING_CLIP_FS");
// 建物メッシュ・模型：u_clO＝メッシュの原点 − 切る原点（main・CPU f64 の差）。閉じた建物（裏面を捨てる物）は切り口から覗く裏面を蓋の色で（疑似の蓋）
const MESH_VS_C: Pairs = [
	["out float v_fog;\n", "out float v_fog;\n" + VS_OUT + "uniform vec3 u_clO;\n"],
	["\tgl_Position = u_clipMesh + u_mvp * vec4(ap + h * liftDir(vec2(lon, lat), dir), 0.0);", `\tvec3 lp = ap + h * liftDir(vec2(lon, lat), dir);\n\t${CD_SET("u_clO + lp")}\n\tgl_Position = u_clipMesh + u_mvp * vec4(lp, 0.0);`],
];
const MESH_CAP: readonly [string, string] = ["\tif (u_cullBack > 0.5 && fe < -0.02) discard;", "\tif (u_cullBack > 0.5 && fe < -0.02) { if (CL.capB.w > 0.5) { fragColor = vec4(CL.capB.rgb, 1.0); return; } discard; }"];
export const MESH_CLIP_VS = clipGL(MESH_VS, MESH_VS_C, "MESH_CLIP_VS");
export const MESH_TEX_CLIP_VS = clipGL(MESH_TEX_VS, MESH_VS_C, "MESH_TEX_CLIP_VS");
export const MESH_CLIP_FS = clipGL(MESH_FS, [
	["in float v_fog;\n", "in float v_fog;\n" + FS_IN],
	["\tvec3 gn = cross(dFdx(v_toEye), dFdy(v_toEye));\n", "\tvec3 gn = cross(dFdx(v_toEye), dFdy(v_toEye));\n" + EDGE_HEAD],
	MESH_CAP,
], "MESH_CLIP_FS");
export const MESH_TEX_CLIP_FS = clipGL(MESH_TEX_FS, [
	["in float v_fog;\n", "in float v_fog;\n" + FS_IN],
	["\tvec4 txr = paintT(texture(u_tex, v_uv)); vec4 tx = txr * v_col;\n", "\tvec4 txr = paintT(texture(u_tex, v_uv)); vec4 tx = txr * v_col;\n" + EDGE_HEAD],   // 標本は discard より前（ミップの微分）
	MESH_CAP,
], "MESH_TEX_CLIP_FS");
// 基図の塗りと線（シーンの原点ごと）
const FILL_VS_C: Pairs = [["out vec2 v_guv3;\n", "out vec2 v_guv3;\n" + VS_OUT], ["\tgl_Position = u_clipT + u_mvp * vec4(rel, 0.0);", `\t${CD_SET("rel")}\n\tgl_Position = u_clipT + u_mvp * vec4(rel, 0.0);`]];
export const FILL_CLIP_VS = clipGL(FILL_VS, FILL_VS_C, "FILL_CLIP_VS");
export const FILL_MD_CLIP_VS = clipGL(FILL_MD_VS, FILL_VS_C, "FILL_MD_CLIP_VS");
export const FILL_CLIP_FS = clipGL(FILL_FS, [
	["in vec2 v_guv3;\n", "in vec2 v_guv3;\n" + FS_IN],
	["void main() {\n\tif (v_front < -0.0015) discard;", "void main() {\n" + DISCARD + "\tif (v_front < -0.0015) discard;"],
], "FILL_CLIP_FS");
const LINE_VS_C: Pairs = [["out float v_fog;\n", "out float v_fog;\n" + VS_OUT], ["\tv_fog = fogOf((wa + wb) * 0.5);\n", `\tv_fog = fogOf((wa + wb) * 0.5);\n\tvec3 cpos = corner.x < 0.5 ? relWa : relWb;   // 端点ごと＝線分に沿って線形（幅の張り出しは同じ値）\n\t${CD_SET("cpos")}\n`]];
export const LINE_CLIP_VS = clipGL(LINE_VS, LINE_VS_C, "LINE_CLIP_VS");
export const LINE_MD_CLIP_VS = clipGL(LINE_MD_VS, LINE_VS_C, "LINE_MD_CLIP_VS");
export const LINE_CLIP_FS = clipGL(LINE_FS, [
	["in vec2 v_pos;\n", "in vec2 v_pos;\n" + FS_IN],
	["void main() {\n\tif (v_front < -0.0015) discard;", "void main() {\n" + DISCARD + "\tif (v_front < -0.0015) discard;"],
], "LINE_CLIP_FS");
// 球の床（海抜 0）＝交点の原点相対 δ（u_rayEO＋t·d）で測る＝空と大気のリムは切らない
export const GLOBE_CLIP_FS = clipGL(GLOBE_FS, [
	["\tvec2 dll = deltaLL(u_rayEO + t * d, u_ell);", "\tif (clipDist(u_rayEO + t * d) < 0.0) discard;\n\tvec2 dll = deltaLL(u_rayEO + t * d, u_ell);"],
], "GLOBE_CLIP_FS");
// 地形の蓋（WebGPU の CLIP_CAP_WGSL と同じ手順）：面ごとに窓を覆う四角を描き、画素で地表より下かつ海抜 0 より上の所を土の色に。
// 他の面の外・多角形で消す側・地平線の向こう・窓の外は捨てる。深度は画素ごとに対数（頂点の z はクリップのためだけ）。
// 四角は u_capQ[i*3..]＝(中心の原点相対, 軸 A, 軸 B)・u_capG＝(原点の格子座標 xy, 格子/度 xy)・u_capH＝(G−1, 遠窓の回, 0, 0)
const PROJECT_NOLOG = (() => { const a = PROJECT.indexOf("void applyLogDepth()"), b = PROJECT.indexOf("}\n", a); if (a < 0 || b < 0) throw new Error("glsl cap: applyLogDepth missing"); return PROJECT.slice(0, a) + PROJECT.slice(b + 2); })();
const CAP_COMMON = /* glsl */`
uniform vec4 u_capQ[18];
uniform vec4 u_capG;
uniform vec4 u_capH;
uniform vec4 u_mesh;
`;
export const CLIP_CAP_VS = `#version 300 es
precision highp float;
${PROJECT_NOLOG}
${CAP_COMMON}
out vec3 v_x;
flat out int v_pi;
void main() {
	vec2 cs[6] = vec2[6](vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0), vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0));
	vec2 c = cs[gl_VertexID];
	int q = gl_InstanceID * 3;
	vec3 X = u_capQ[q].xyz + c.x * u_capQ[q + 1].xyz + c.y * u_capQ[q + 2].xyz;
	vec4 p = u_clipT + u_mvp * vec4(X, 0.0);
	p.z = 0.0;   // 深度は FS（目の後ろへ回った隅＝w<0 は −w≤z≤w を満たさず切られる＝見えている所は残る）
	gl_Position = p;
	v_x = X; v_pi = gl_InstanceID;
}`;
export const CLIP_CAP_FS = withClip(`#version 300 es
precision highp float;
${PROJECT_NOLOG}
${CAP_COMMON}
in vec3 v_x;
flat in int v_pi;
out vec4 fragColor;
vec2 capLL(vec3 dl) {   // 原点相対 δ → 経緯度の差（deg・測地）＝GLOBE_FS の deltaLL と同式（錨は u_originPt）
	vec3 O = u_originPt; float rhoO = length(O.xz), beta0 = atan(O.y, rhoO);
	float dlon = atan(dl.z * O.x - dl.x * O.z, rhoO * rhoO + dl.x * O.x + dl.z * O.z);
	float s = 2.0 * (O.x * dl.x + O.z * dl.z) + dl.x * dl.x + dl.z * dl.z;
	float rhoP = sqrt(max(rhoO * rhoO + s, 0.0));
	float drho = s / max(rhoP + rhoO, 1e-12);
	float dbeta = atan(dl.y * rhoO - drho * O.y, rhoP * rhoO + (O.y + dl.y) * O.y);
	float b1 = beta0 + dbeta;
	float corr = u_ell * (0.0016792203863837047 * (sin(2.0 * b1) - sin(2.0 * beta0)) + 0.0000014098905530233192 * (sin(4.0 * b1) - sin(4.0 * beta0)));
	return vec2(dlon, dbeta + corr) * 57.29577951308232;
}
float capDf(vec2 dll) { vec3 dir = u_originPt + deltaToRel(dll); return 1.0 - smoothstep(u_fogFar * 0.8, u_fogFar * 2.0, distance(u_eye, dir)); }   // 地形の頂点と同じ遠景の平ら化
float capVert(vec2 gi) { vec2 ll = u_mesh.xy + u_mesh.zw * (gi / u_capH.x); return elev(ll) * capDf(ll - u_origin); }
float log1pS(float w) { if (w < 0.1) return w * (1.0 - w * (0.5 - w * (0.33333334 - w * (0.25 - w * (0.2 - w * (0.16666667 - w * 0.14285715)))))); return log(1.0 + w); }
void main() {
	vec3 X = v_x;
	int n = int(CL.p.x);
	for (int i = 0; i < 6; i++) { if (i >= n) break; if (i != v_pi && dot(CL.pl[i].xyz, X) + CL.pl[i].w < 0.0) discard; }   // 他の面の外（箱の角）
	if (polyD(polyXY(X)) < 0.0) discard;   // 多角形で消す側
	// 足と高さ：動径の足から始めて、測地法線に沿って 2 回詰める
	vec3 O = u_originPt;
	vec2 dll = capLL(X);
	float z = 0.0;
	for (int k = 0; k < 2; k++) {
		vec3 u = deltaToRel(dll);
		vec3 L = liftDir(u_origin + dll, O + u);
		z = dot(X - u, L) / dot(L, L);
		dll = capLL(X - z * L);
	}
	float zm = z / max(u_elevScale, 1e-30);
	if (zm < 0.0) discard;   // 海抜 0 より下
	if (dot(O + deltaToRel(dll), u_eye) - 1.0 < -0.0015) discard;   // 地平線の向こう
	float N = u_capH.x;
	vec2 gc = u_capG.xy + dll * u_capG.zw;
	if (u_capH.y > 0.5) { vec2 uvN = (u_origin + dll - u_elevBounds.xy) / u_elevBounds.zw; if (uvN.x >= 0.0 && uvN.x <= 1.0 && uvN.y >= 0.0 && uvN.y <= 1.0) discard; }   // 遠窓の回＝近窓の内側は近の担当
	if (gc.x < 0.0 || gc.y < 0.0 || gc.x > N || gc.y > N) discard;
	vec2 g = min(gc, vec2(N - 1e-4)), gi = floor(g), gf = g - gi;   // 地表＝地形メッシュと同じ三角形
	float ht;
	if (gf.x + gf.y < 1.0) { float h00 = capVert(gi); ht = h00 + gf.x * (capVert(gi + vec2(1.0, 0.0)) - h00) + gf.y * (capVert(gi + vec2(0.0, 1.0)) - h00); }
	else { float h11 = capVert(gi + vec2(1.0)); ht = h11 + (1.0 - gf.x) * (capVert(gi + vec2(0.0, 1.0)) - h11) + (1.0 - gf.y) * (capVert(gi + vec2(1.0, 0.0)) - h11); }
	if (zm > ht) discard;   // 地表より上＝空
	fragColor = vec4(mix(CL.capT.rgb, u_fogColor, fogOf(O + X)), 1.0);
	vec4 pc = u_clipT + u_mvp * vec4(X, 0.0);
	gl_FragDepth = clamp(log1pS(max(pc.w, 1e-30)) * 1.4426950 * u_logCoef * 0.5, 0.0, 1.0);
}`);

// ── 建物の影の WebGL2 版（P0 #3・2026-10-25）＝WebGPU の SHADOW_WGSL（gpu/wgsl.ts）と同じ段（カスケード）・同じ PCSS・同じ uniform の並び（ShadowP・std140・binding 1）。
// 点けている間だけ使う派生（本体の文字列は 1 バイトも変えない）。深度は 2D 配列（層 0＝基の窓）・同じテクスチャを比較つき（u_shTex）と素（u_shRaw）の 2 つの標本器で読む。
// 深度の向き：renderer が落とす側の行列の z を 2z−w に直す＝深度バッファの値が WebGPU と同じ 0..1（受け手は SH.mvp の z をそのまま比べる）。
// GL のテクスチャは行 0 が下＝uv.y＝0.5＋y/2（WebGPU は 0.5−y/2）。
const SH_BLOCK = /* glsl */`
layout(std140) uniform ShadowP { mat4 mvp; vec4 clipT; vec4 anchor; vec4 p; vec4 cs[3]; vec4 cb[3]; vec4 q; } SH;
vec4 shClip(vec3 relA) { return SH.clipT + SH.mvp * vec4(relA, 0.0); }
`;
const SH_FS = /* glsl */`
uniform highp sampler2DArrayShadow u_shTex;
uniform highp sampler2DArray u_shRaw;
const vec2 SH_PD[16] = vec2[16](
	vec2(-0.94201624, -0.39906216), vec2(0.94558609, -0.76890725), vec2(-0.09418410, -0.92938870), vec2(0.34495938, 0.29387760),
	vec2(-0.91588581, 0.45771432), vec2(-0.81544232, -0.87912464), vec2(-0.38277543, 0.27676845), vec2(0.97484398, 0.75648379),
	vec2(0.44323325, -0.97511554), vec2(0.53742981, -0.47373420), vec2(-0.26496911, -0.41893023), vec2(0.79197514, 0.19090188),
	vec2(-0.24188840, 0.99706507), vec2(-0.81409955, 0.91437590), vec2(0.19984126, 0.78641367), vec2(0.14383161, -0.14100790));
float shPcss(vec2 uv, int layer, float d, int i) {
	float g = SH.cb[i].w, tx = SH.cb[i].y;
	vec2 dim = vec2(textureSize(u_shRaw, 0).xy);
	float zs = 0.0, zn = 0.0;
	for (int k = 0; k < 16; k++) {
		vec2 o = SH_PD[k] * (tx * SH.q.w);
		ivec2 q = clamp(ivec2((uv + o) * dim), ivec2(0), ivec2(dim) - 1);
		float z = texelFetch(u_shRaw, ivec3(q, layer), 0).r;
		if (z < d + length(o) * g) { zs += z; zn += 1.0; }
	}
	if (zn < 0.5) return 1.0;   // 周りに遮る物が無い＝日向
	float w = clamp((d - zs / zn) * SH.q.y * SH.q.z / SH.cb[i].z, 1.0, 8.0) * tx;   // 半影の幅（uv）
	float s = 0.0;
	for (int k = 0; k < 16; k++) { vec2 o = SH_PD[k] * w; s += texture(u_shTex, vec4(uv + o, float(layer), d + length(o) * g)); }
	return s / 16.0;
}
vec2 shAt(vec3 pb, int i) {   // 段 i の日向の度合い（x）と窓の縁までの距離（y・≤0＝窓の外）
	vec4 c = SH.cs[i];
	vec2 xy = pb.xy * c.x + c.yz;
	vec2 uv = vec2(xy.x * 0.5 + 0.5, xy.y * 0.5 + 0.5);
	float e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
	if (e <= 0.0) return vec2(1.0, e);
	float lit = shPcss(uv, int(c.w), pb.z - SH.cb[i].x, i);
	if (i + 1 >= int(SH.q.x)) lit = mix(1.0, lit, 1.0 - smoothstep(SH.p.w, 1.0, length(xy)));   // 基の窓＝縁を丸く日向へ
	return vec2(lit, e);
}
float shLit(vec4 sc) {   // 1＝日向・0＝影
	if (sc.w <= 0.0) return 1.0;
	vec3 pb = sc.xyz / sc.w;
	if (pb.z <= 0.0 || pb.z >= 1.0) return 1.0;
	int n = int(SH.q.x);
	for (int i = 0; i < 3; i++) {
		if (i >= n) break;
		vec2 a = shAt(pb, i);
		if (a.y <= 0.0) continue;
		if (i + 1 < n && a.y < 0.04) { vec2 b = shAt(pb, i + 1); if (b.y > 0.0) return mix(b.x, a.x, a.y / 0.04); }   // 段の縁の帯＝次の段と混ぜる
		return a.x;
	}
	return 1.0;
}
vec3 shShade(vec3 col, vec4 sc) { return col * mix(SH.p.x, 1.0, shLit(sc)); }
`;
const withSh = (src: string, fs: boolean): string => { if (src.split(PREC).length < 2) throw new Error("glsl shadow: precision line missing"); return src.replace(PREC, PREC + SH_BLOCK + (fs ? SH_FS : "")); };
const SC_OUT = "out vec4 v_sc;\n", SC_IN = "in vec4 v_sc;\n";
const SH_REL = "(u_originPt - SH.anchor.xyz)";
/** 影の受け手の派生（fam＝描く物の族・src＝本体か切る派生の文字列） */
export type ShadowFam = "terrain" | "fill" | "line" | "bld" | "mesh" | "meshTex" | "globe";
const SH_VS: Record<ShadowFam, Pairs> = {
	terrain: [["out vec2 v_guv3;\n", "out vec2 v_guv3;\n" + SC_OUT], ["\tv_front = dot(u_eye, u_eye) < 1.0 ? 1.0 : dot(dir, u_eye) - 1.0;\n", `\tv_sc = shClip(relW + ${SH_REL});\n\tv_front = dot(u_eye, u_eye) < 1.0 ? 1.0 : dot(dir, u_eye) - 1.0;\n`]],
	fill: [["out vec2 v_guv3;\n", "out vec2 v_guv3;\n" + SC_OUT], ["\tgl_Position = u_clipT + u_mvp * vec4(rel, 0.0);", `\tv_sc = shClip(rel + ${SH_REL});\n\tgl_Position = u_clipT + u_mvp * vec4(rel, 0.0);`]],
	line: [["out float v_fog;\n", "out float v_fog;\n" + SC_OUT], ["\tv_fog = fogOf((wa + wb) * 0.5);\n", `\tv_fog = fogOf((wa + wb) * 0.5);\n\tv_sc = shClip((corner.x < 0.5 ? relWa : relWb) + ${SH_REL});\n`]],
	bld: [["out vec2  v_ll;", SC_OUT + "out vec2  v_ll;"], ["\tv_shade = a_shade;\n", `\tv_sc = shClip(relW + ${SH_REL});\n\tv_shade = a_shade;\n`]],
	mesh: [["out float v_fog;\n", "out float v_fog;\n" + SC_OUT], ["\tgl_Position = u_clipMesh + u_mvp * vec4(", "\tv_sc = shClip(u_meshOrigin - SH.anchor.xyz + ap + h * liftDir(vec2(lon, lat), dir));   // バッチ原点−main 原点（f32 差＝バッチ内一定）\n\tgl_Position = u_clipMesh + u_mvp * vec4("]],
	meshTex: [],
	globe: [],
};
SH_VS.meshTex = SH_VS.mesh;
// 影の間の地形の陰影＝北西の固定光でなく影と同じ太陽の方位（WebGPU の TERRAIN_SH_WGSL と同式）
const TERR_SUN_SHADE = "\tvec3 sdir = -normalize(vec3(SH.mvp[0].z, SH.mvp[1].z, SH.mvp[2].z));\n\tvec2 lr = v_ll * 0.017453292519943295;\n\tfloat cl = cos(lr.y), sl = sin(lr.y), co = cos(lr.x), so = sin(lr.x);\n\tvec2 sH = vec2(dot(sdir, vec3(-so, 0.0, co)), dot(sdir, vec3(-sl * co, cl, -sl * so)));   // 太陽の方位（東・北）\n\tvec2 aH = sH / max(length(sH), 1e-6);\n\tvec2 gEN = vec2(hx / (d * 111320.0 * max(cl, 0.01)), hy / (d * 111320.0));   // 勾配（東・北・m/m）\n\tfloat shade = clamp(0.82 - 0.44 * dot(gEN, aH), 0.45, 1.15);";
const SH_FSP: Record<ShadowFam, Pairs> = {
	terrain: [["in float v_h;\n", "in float v_h;\n" + SC_IN], ["\tfloat shade = clamp(0.82 + (-hx + hy) * 0.0007 * shadeK, 0.45, 1.15);", TERR_SUN_SHADE], ["\tvec3 col = g.rgb * (1.0 - v_fog)", "\tg.rgb = shShade(g.rgb, v_sc);\n\tvec3 col = g.rgb * (1.0 - v_fog)"]],
	fill: [["in vec2 v_guv3;\n", "in vec2 v_guv3;\n" + SC_IN], ["fragColor = vec4(mix(gndMix(cogTexMix(rgb, v_cuv), v_guv0, v_guv1, v_guv2, v_guv3), u_fogColor, v_fog) * af, af);", "fragColor = vec4(mix(shShade(gndMix(cogTexMix(rgb, v_cuv), v_guv0, v_guv1, v_guv2, v_guv3), v_sc), u_fogColor, v_fog) * af, af);"]],
	line: [["in vec2 v_pos;\n", "in vec2 v_pos;\n" + SC_IN], ["\tvec3 rgb = mix(lc.rgb, u_fogColor, v_fog);", "\tvec3 rgb = mix(shShade(lc.rgb, v_sc), u_fogColor, v_fog);"]],
	bld: [["in vec2  v_ll;\n", "in vec2  v_ll;\n" + SC_IN], ["\tvec3 c = mix(u_bldColor * v_shade, u_fogColor, v_fog);", "\tvec3 c = mix(shShade(u_bldColor * v_shade, v_sc), u_fogColor, v_fog);"]],
	mesh: [["in float v_fog;\n", "in float v_fog;\n" + SC_IN], ["\tvec3 c = mix(base, u_fogColor, v_fog);", "\tvec3 c = mix(shShade(base, v_sc), u_fogColor, v_fog);"]],
	meshTex: [["in float v_fog;\n", "in float v_fog;\n" + SC_IN], ["\tvec3 c = mix(base, u_fogColor, v_fog);", "\tvec3 c = mix(shShade(base, v_sc), u_fogColor, v_fog);"]],
	globe: [["\tvec3 viewDir = normalize(A - P);", "\tg.rgb = shShade(g.rgb, shClip(u_rayEO + t * d + (u_rayO - SH.anchor.xyz)));   // 球の床（海抜 0）＝低地と真俯瞰の地面\n\tvec3 viewDir = normalize(A - P);"]],
};
export const shadowVS = (fam: ShadowFam, src: string): string => fam === "globe" ? src : withSh(derive(src, SH_VS[fam], `SH_VS:${fam}`), false);
export const shadowFS = (fam: ShadowFam, src: string): string => withSh(derive(src, SH_FSP[fam], `SH_FS:${fam}`), true);
// 影を落とす側：本体（か切る派生）の頂点計算そのまま・対数深度だけ外す（正射影 w=1＝行列の z が線形の深度）。FS は深度だけ（切る間は面の外を捨てる・模型の MASK は α で抜く）
export const castVS = (src: string): string => derive(src, [["\tapplyLogDepth();", ""]], "castVS");
export const CAST_FS = "#version 300 es\nprecision highp float;\nvoid main() {}";
export const CAST_CLIP_FS = withClip("#version 300 es\nprecision highp float;\n" + FS_IN + "void main() {\n" + DISCARD + "}");
const CAST_TEX = "uniform sampler2D u_tex;\nuniform float u_alphaCut;\nin vec2 v_uv;\nin vec4 v_col;\n";
export const CAST_TEX_FS = "#version 300 es\nprecision highp float;\n" + CAST_TEX + "void main() { if (texture(u_tex, v_uv).a * v_col.a < u_alphaCut) discard; }";
export const CAST_TEX_CLIP_FS = withClip("#version 300 es\nprecision highp float;\n" + CAST_TEX + FS_IN + "void main() {\n" + DISCARD + "\tif (texture(u_tex, v_uv).a * v_col.a < u_alphaCut) discard;\n}");
