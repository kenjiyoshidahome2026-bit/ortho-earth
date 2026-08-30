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
	vec2 uv = (ll - u_farBounds.xy) / u_farBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
	float f = 1.0;
	if (u_farEdgeFade > 0.0) {   // 遠窓自身の縁は従来どおり 0 へフェード（その先は覆いが無い）
		vec2 w = vec2(u_farEdgeFade) / u_farBounds.zw;
		f = min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
	}
	return texture(u_farElevTex, uv).r * f;
}
float elev(vec2 ll) {
	if (u_hasElev < 0.5) return 0.0;
	vec2 uv = (ll - u_elevBounds.xy) / u_elevBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return elevFar(ll);
	return mix(elevFar(ll), texture(u_elevTex, uv).r, elevFadeAt(uv));   // アトラスは南上げ格納＝v直接
}
`;

export const PROJECT = /* glsl */`
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
// 三角形内は線形補間＝厳密な対数曲線と微差が出るが、terrain/建物/PLATEAU とも三角形が小さく実害なし。
// window深度は 0.5*(z/w+1) = log2(1+w)*u_logCoef*0.5 ＝旧FS版と同一式（全パスで一貫＝深度の互換維持）。
void applyLogDepth() {
	gl_Position.z = (log2(max(1.0 + gl_Position.w, 1e-6)) * u_logCoef - 1.0) * gl_Position.w;
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
export const BUILDING_VS = `#version 300 es
precision highp float;
in vec3 a_pos;      // dlon, dlat, hWorld（原点からの経緯度差分＋高さ・単位球スケール）
in float a_shade;   // 陰影（屋根1/壁0.76）
in vec2 a_anchor;   // 建物の基準点（原点からの経緯度差分）。一棟の全頂点で単一標高＝垂直プリズム
${PROJECT}
out float v_shade;
out float v_front;
out float v_fog;
out vec2  v_ll;      // シーン原点相対の lon/lat 差分(deg)＝PLATEAU マスク uv 用。⚠絶対経緯度を varying で運ばない：
                     // f32 の ulp は経度139°で~1.4m＝25mマスクセルの境界で画素ジッタ→深ズーム(z20)で櫛状の
                     // まだら discard（点描ゴースト・2026-08-02 中野実測）。大きい定数部は uniform 側で f64 前計算。
void main() {
	vec2 dLL = a_pos.xy;                       // 原点相対 (deg)。multidraw は mdize が u_tileOff を足す
	vec2 dAnchor = a_anchor;                   // 基準点の原点相対 (deg)
	vec2 ll = u_origin + dLL;
	v_ll = dLL;
	vec3 rel = deltaToRel(dLL);               // 頂点3D − 原点3D（小・正確）
	vec3 dir = u_originPt + rel;              // 絶対単位球点（front/fog 用＝粗くて可）
	float base = elev(u_origin + dAnchor) * u_elevScale;     // 基準点の標高で足元を揃える（屋根水平・壁垂直）
	float h = base + a_pos.z;                  // 地形標高 + 建物高さ
	vec3 relW = rel + h * liftDir(ll, dir);    // (dir*(1+h)) − 原点3D を相殺なしで（地形の上に建物を積む。楕円体＝測地法線）
	v_shade = a_shade;
	v_front = dot(dir, u_eye) - 1.0;
	v_fog = fogOf(u_originPt + relW);
	gl_Position = u_clipT + u_mvp * vec4(relW, 0.0);
	gl_PointSize = 7.0;   // GL_POINTS 描画時のみ有効（線/面描画では無視）＝draped の点データ用
	applyLogDepth();
}`;

// 隣接区境をまたぐと PLATEAU 地区が同時に複数(最大4)アクティブになるため、bbox/mask をスロット化。
// GLSL ES 3.00 は sampler 配列の動的添字を許さないので4本を個別 uniform にしアンロールで判定。
export const BUILDING_FS = `#version 300 es
precision highp float;
uniform vec3 u_bldColor;
uniform vec3 u_fogColor;
uniform int u_plateauCount;         // 0..4：アクティブな PLATEAU 地区数
uniform vec4 u_plateauBbox0;        // [minLon,minLat,maxLon,maxLat] deg。マスクの UV 正規化に使う
uniform vec4 u_plateauBbox1;
uniform vec4 u_plateauBbox2;
uniform vec4 u_plateauBbox3;
uniform sampler2D u_plateauMask0;   // PLATEAU 実フットプリントの被覆マスク（立ってるセル＝LOD2 が担う）
uniform sampler2D u_plateauMask1;
uniform sampler2D u_plateauMask2;
uniform sampler2D u_plateauMask3;
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
	if ((u_plateauCount > 0 && maskedBy(u_plateauBbox0, u_plateauMask0, v_ll)) ||
	    (u_plateauCount > 1 && maskedBy(u_plateauBbox1, u_plateauMask1, v_ll)) ||
	    (u_plateauCount > 2 && maskedBy(u_plateauBbox2, u_plateauMask2, v_ll)) ||
	    (u_plateauCount > 3 && maskedBy(u_plateauBbox3, u_plateauMask3, v_ll))) discard;
	// 深度は VS の applyLogDepth() が焼き済み（gl_FragDepth を書くと early-Z が無効になるためFSでは触れない）
	vec3 c = mix(u_bldColor * v_shade, u_fogColor, v_fog);
	fragColor = vec4(c, 1.0);
}`;

// PLATEAU LOD2 建物メッシュ（任意三角形）。頂点は ortho 単位球座標へ変換済み。
// 面法線は FS で dFdx/dFdy から算出＝CPU法線/un-index 不要のフラット陰影。裏半球カリング＋深度で前後解決。
export const PLATEAU_VS = `#version 300 es
precision highp float;
in vec3 a_pos;      // 重心(u_meshOrigin)相対の delta（RTE-lite：小さい値＝float32 仮数がフルに効く＝建物ディテールを高精度に）
in vec3 a_normal;   // glTF 実法線を ortho へ変換済
uniform vec3 u_meshOrigin;   // メッシュ重心＝単位球の錨。絶対位置 = u_meshOrigin + a_pos
uniform vec4 u_clipMesh;     // mvp*[u_meshOrigin,1]（CPU double）＝MVP相殺回避の錨（旧: シェーダ内 float32 で算出＝錨が相殺）
uniform vec4 u_liftBounds;   // DTM(裸地=DEM10B)保証域 [lng0,lat0,spanLng,spanLat]。外＝接地リフトしない（DSM=ビル天端でリフトすると屋根が斜面に裂ける）
${PROJECT}
out vec3  v_n;      // 実法線
out vec3  v_toEye;  // 視線ベクトル（巻き順に依存せず法線を表向きへ）
out float v_front;  // >0 で手前半球
out float v_fog;
void main() {
	vec3 wp = u_meshOrigin + a_pos;                              // 絶対位置（陰影・フォグ・半球判定用＝粗くて可）
	vec3 dir = normalize(wp);
	v_n = a_normal;
	v_toEye = u_eye - wp;
	v_front = dot(dir, u_eye) - 1.0;
	v_fog = fogOf(wp);
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
	gl_Position = u_clipMesh + u_mvp * vec4(a_pos + h * liftDir(vec2(lon, lat), dir), 0.0);   // 楕円体＝測地法線で接地リフト
	applyLogDepth();
}`;

export const PLATEAU_FS = `#version 300 es
precision highp float;
uniform vec3 u_bldColor;
uniform vec3 u_fogColor;
uniform float u_cullBack;   // 1=裏面discard（建物＝閉じた体積）、0=両面（橋梁＝ケーブル/柵の開いた薄面。dedupで片面化済みのため）
in vec3  v_n;
in vec3  v_toEye;
in float v_front;
in float v_fog;
out vec4 fragColor;
void main() {
	// 面の幾何法線＝スクリーン微分（discard より前＝隣接ヘルパー画素が生きているうちに取る）。
	// v_toEye = eye − pos で eye は定数＝微分は −dPos、cross で符号が相殺し位置微分の面法線と等価＝varying追加不要。
	vec3 gn = cross(dFdx(v_toEye), dFdy(v_toEye));
	if (v_front < 0.0) discard;                                   // 裏半球
	vec3 n = normalize(v_n);                                      // glTF 実法線（陰影用＝従来のまま）
	// 裏面カリングは幾何法線で判定＝面内で一定値＝画素毎の揺れが構造的に消える。旧・補間int8法線の
	// dot閾値(-0.02)は「すれすれ帯≈1px」前提が深ズーム(z20)で数十pxに化け、閾値をまたぐ画素だけ
	// discard される「点描ゴースト」になった（2026-08-02 実測・中野z20）。向き（表裏）は属性法線で
	// 採決＝巻き順非依存・面単位で一定。退化面（微分ゼロ）だけ旧判定へフォールバック。
	float g2 = dot(gn, gn);
	float fe = g2 > 1e-18 ? dot(normalize(gn * sign(dot(gn, n))), normalize(v_toEye)) : dot(n, normalize(v_toEye));
	if (u_cullBack > 0.5 && fe < -0.02) discard;
	if (fe < 0.0) n = -n;                                         // 両面時は法線を視線側へ＝裏から見ても陰影が成立
	vec3 L = normalize(vec3(-0.35, 0.85, 0.30));                  // 斜め上の光＝屋根が立つ
	float d = clamp(dot(n, L) * 0.28 + 0.76, 0.72, 1.0);         // 基図建物の屋根1.0/壁0.76に合わせる（up向き屋根→~1.0、垂直壁→~0.76）
	vec3 c = mix(u_bldColor * d, u_fogColor, v_fog);
	fragColor = vec4(c, 1.0);
}`;

// 地形サーフェス：標高で変位した格子メッシュ。hillshade は FS で per-pixel に計算＝
// VS の標高フェッチを5回/頂点（変位1+中央差分勾配4）→1回に削減（格子236万頂点＝毎フレーム~950万フェッチの削減）。
// FS側は可視フラグメント数ぶんの3フェッチ＝総量でも減る上、頂点補間よりシャープな陰影になる。
export const TERRAIN_VS = `#version 300 es
precision highp float;
in vec2 a_uv;      // 単位格子 [0,1]²（メッシュは G だけに依存＝窓が動いても作り直さない）
uniform vec4 u_mesh;   // xy=窓の原点(lon,lat)  zw=窓の幅(deg)
${PROJECT}
out vec2 v_ll;
out float v_front;
out float v_fog;
out float v_h;
void main() {
	vec2 a_ll = u_mesh.xy + u_mesh.zw * a_uv;   // 絶対 lon/lat（旧・頂点属性を単位格子＋uniform へ）
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
	v_front = dot(dir, u_eye) - 1.0;
	v_fog = fogOf(u_originPt + relW);
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
const WORLD_HYPSO = /* glsl */`
uniform float u_whK;
uniform sampler2D u_climTex;   // 気候場 720x360（Köppen-Geiger/Beck et al. CC-BY を焼き縮め）R=乾燥度 G=極地/氷床
uniform float u_hasClim;       // 0=未着（緯度近似フォールバック） 1=気候場で本物の cross-blend
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
		vec2 c2 = texture(u_climTex, vec2(ll.x / 360.0 + 0.5, 0.5 - latD / 180.0)).rg;
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
	vec3 low = mix(vec3(0.582, 0.716, 0.531), vec3(0.839, 0.796, 0.639), arid);
	vec3 mid = mix(vec3(0.752, 0.790, 0.578), vec3(0.855, 0.788, 0.612), arid);
	vec3 c = mix(low, mid, smoothstep(0.0, 400.0, e));
	c = mix(c, vec3(0.871, 0.831, 0.659), smoothstep(400.0, 1300.0, e));
	c = mix(c, vec3(0.788, 0.718, 0.635), smoothstep(1300.0, 2800.0, e));
	c = mix(c, vec3(0.925, 0.925, 0.937), smoothstep(2800.0, 4800.0, e));
	// 雪/氷：気候場の極地チャンネル（EF=1・ET≈0.55）＋高緯度×氷床標高（グリーンランド内陸の保険）
	float snow = pol + smoothstep(56.0, 62.0, latD) * smoothstep(1100.0, 1900.0, e);
	c = mix(c, vec3(0.945, 0.953, 0.962), clamp(snow, 0.0, 1.0));
	return mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))), 0.10);
}
`;

export const TERRAIN_FS = `#version 300 es
precision highp float;
uniform vec3 u_fogColor;
uniform vec3 u_land;
uniform vec3 u_hypso;    // 標高ティント色（高所を land からこの色へ寄せる＝控えめな標高彩色）
uniform vec2 u_hypsoP;   // x=1/最大標高(m)（この高さで寄せ切る） y=寄せ量(0=無効…1=全置換)
uniform float u_farPass;   // 1=遠景メッシュパス：近窓の内側は近メッシュの担当＝discard（二重描画・z-fight回避）
${ELEV}
${WORLD_HYPSO}
in vec2 v_ll;
in float v_front;
in float v_fog;
in float v_h;
out vec4 fragColor;
void main() {
	if (v_front < -0.0015) discard;   // 海抜0の接線より少し先まで許容＝地平線の先に頭を出す高山（〜9km球換算）を描く。遮蔽は深度とフォグが担う
	if (u_farPass > 0.5) {   // 遠景パスは近窓の内側を塗らない。縁の座標一致は連続な elev()（近縁が遠層値へ溶ける）が保証
		vec2 uvN = (v_ll - u_elevBounds.xy) / u_elevBounds.zw;
		if (uvN.x >= 0.0 && uvN.x <= 1.0 && uvN.y >= 0.0 && uvN.y <= 1.0) discard;
	}
	// 海〜低地は地形を透明化し、海岸線は精細なベクタに委ねる。低地から滑らかに陰影を立ち上げ、
	// 粗い標高メッシュが海岸で作る「崖」のガタつき・平野のノイズを消す。
	float t = smoothstep(1.0, 100.0, v_h);
	if (t <= 0.0) discard;
	// 北西光の hillshade（前方差分＝中央差分の半分のフェッチ）。
	// 歩幅＝アトラス1texel（下限は従来の0.004°≈450m＝近景は不変）。固定歩幅はズームアウトで
	// texel未満に落ち「鈍った勾配×小さい歩幅」で陰影がベタ灰色に消えていた（広域の塗りの甘さ）。
	// texel差分＝アトラスが持つ最小起伏を常に同じゲインで見せる＝どのスケールでも塗りが痩せない。
	// 遠層域は下限 0.004°≈450m がそのまま R10 texel（463m）＝遠景の歩幅として妥当（別計算しない）。
	vec2 tsz = vec2(textureSize(u_elevTex, 0));
	float d = max(0.004, u_elevBounds.w / tsz.y);
	float h0 = elev(v_ll);
	float hx = elev(v_ll + vec2(d, 0.0)) - h0;
	float hy = elev(v_ll + vec2(0.0, d)) - h0;
	float shade = clamp(0.82 + (-hx + hy) * 0.0007, 0.45, 1.15);
	// 標高ティント：land を高所ほど u_hypso へ寄せる（テーマのノブ＝未指定は y=0 で恒等）。陰影の前＝shade が上に乗る
	vec3 landC = mix(u_land, u_hypso, clamp(h0 * u_hypsoP.x, 0.0, 1.0) * u_hypsoP.y);
	landC = mix(landC, worldHypso(h0, v_ll), u_whK);   // 全球ハイプソ（低ズーム帯）＝globe パスと同色でピッチ不変
	// 深度は VS の applyLogDepth() が焼き済み（plateau/building と一貫。FSで書くと early-Z が死ぬ）
	vec3 col = mix(landC * shade, u_fogColor, v_fog);
	fragColor = vec4(col * t, t);           // premultiplied（globe基色→地形へ滑らかに）
}`;

// stencil-then-cover の塗り（earcut不要でロバスト）。ortho-map の 2-sided winding を透視mat4へ移植。
// stencilパス：ポリゴンの fan 三角形を色を書かず stencil へ（FRONT +1 / BACK -1）。球の前後半球も相殺。
// カリングなし＝巻き数を壊さず内側を正しく塗る（裏抜けは残るが LOD で本質的に消える）。
export const STENCIL_VS = `#version 300 es
precision highp float;
in vec2 a_delta;
${PROJECT}
uniform float u_lift;   // 地形からのリフト(m)。塗り(fan)を地形にドレープ＝海抜0平面でなく地形表面へ（境界線と一致）
void main() {
	// 塗り(fan)を FILL_VS と同じ標高変位で地形にドレープ。elev 無しだと海抜0の平面に貼られ、
	// 地形に沿う境界線と乖離して浮く（本人報告 2026-08-12・豊浦町ハイライト）。WebGPU vsStencil と対。
	vec2 ll = u_origin + a_delta;
	vec3 rel = deltaToRel(a_delta);
	vec3 dir = u_originPt + rel;
	float df = 1.0 - smoothstep(u_fogFar * 0.8, u_fogFar * 2.0, distance(u_eye, dir));
	float h = (elev(ll) + u_lift) * u_elevScale * df;
	vec3 relW = rel + h * liftDir(ll, dir);
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
uniform mat4 u_invMvp;
uniform vec4 u_land;
uniform vec4 u_atmo;   // 大気色 rgb + 強さ(a)
// 全球ハイプソ（NEラスタの美しさを標高から計算で作る＝ラスタタイル配布ゼロ）：
// レイ→球→測地緯度→elev() は CONTOUR_FS と同式。R90 全球窓（z<6.5 は bounds=[-180,-90,360,180]）を引く。
// 配色本体は WORLD_HYPSO（TERRAIN_FS と共有＝ピッチで色が変わらない）。
uniform sampler2D u_elevTex;
uniform vec4 u_elevBounds;
uniform float u_hasElev;
uniform float u_ell;      // 1=楕円体（β→測地復元。球=0＝恒等）
uniform vec3 u_seaC;      // 海の平色（NE流の淡青）
in vec2 v_ndc;
out vec4 fragColor;
const float R2D = 57.29577951308232;
float elevAt(vec2 ll) {
	vec2 uv = (ll - u_elevBounds.xy) / u_elevBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
	return texture(u_elevTex, uv).r;
}
${WORLD_HYPSO}
void main() {
	vec4 np = u_invMvp * vec4(v_ndc, -1.0, 1.0);
	vec4 fp = u_invMvp * vec4(v_ndc, 1.0, 1.0);
	vec3 A = np.xyz / np.w, B = fp.xyz / fp.w, d = B - A;
	float aa = dot(d, d), bb = 2.0 * dot(A, d), cc = dot(A, A) - 1.0;
	float disc = bb * bb - 4.0 * aa * cc;
	float aDotd = bb * 0.5, tstar = -aDotd / aa;
	float t = disc >= 0.0 ? (-bb - sqrt(disc)) / (2.0 * aa) : -1.0;
	if (t < 0.0) {                                 // 前方に球ヒット無し＝空：地平の霞から宇宙へ連続に減衰
		// ここには2種の光線が来る：(a)球ミス(disc<0)、(b)延長線は背後の地球に当たるが前方は素通り(t<0)。
		// 旧実装は両方 discard 系＝高チルト・低高度で「見上げ境界」「背後ヒット円錐」が画面を横切り、
		// ハロー帯が横一線でスパッと黒に切れて空が2段になった（ズームを上げるほど(b)の黒が下りてくる）。
		// 前方光線の球中心最接近距離：tstar<=0（水平より上向き＝(b)は必ずこちら）は視点自身が最接近＝length(A)。
		float lenA = length(A);
		float m = tstar > 0.0 ? sqrt(max((cc + 1.0) - aDotd * aDotd / aa, 0.0)) : lenA;
		float g = smoothstep(1.09, 1.0, m);
		// 高度角フェード：見上げるほど大気は薄く＝天頂へ滑らかに宇宙色。低高度では m≈lenA が一様なので、
		// これが無いと今度は空全体が一枚の紺に塗り潰される。
		g *= 1.0 - smoothstep(0.0, 0.55, dot(normalize(d), A / lenA));
		if (g <= 0.0) discard;
		// 縁(g=1)は球面リム内側の霞と同色・不透明＝地平線で色が連続。外側へ大気色→透明へフェード。
		vec3 limbCol = mix(u_land.rgb, u_atmo.rgb, u_atmo.a * 0.9);
		float a = g * g * mix(u_atmo.a, 1.0, g);
		fragColor = vec4(mix(u_atmo.rgb, limbCol, g) * a, a);   // premultiplied
		return;
	}
	vec3 P = A + t * d;                            // 面上の点（単位球＝法線）
	vec3 base = u_land.rgb;
	if (u_whK > 0.001 && u_hasElev > 0.5) {        // 全球ハイプソ：標高→配色＋陰影（NEラスタの計算版）
		float bl = asin(clamp(P.y, -1.0, 1.0));    // β(rad)
		float latD = bl * R2D + u_ell * (0.0016792203863837047 * sin(2.0 * bl) + 0.0000014098905530233192 * sin(4.0 * bl)) * R2D;   // β→測地（CONTOUR_FS と同式）
		vec2 ll = vec2(atan(P.z, P.x) * R2D, latD);
		float e = elevAt(ll);
		// hillshade：1テクセル差分・NW光（TERRAIN_FS と同族）。R90 テクセル≈20km なので係数は桁で弱める
		float dstep = u_elevBounds.w / float(textureSize(u_elevTex, 0).y);
		float hx = elevAt(ll + vec2(dstep, 0.0)) - e;
		float hy = elevAt(ll + vec2(0.0, dstep)) - e;
		float shade = clamp(0.86 + (-hx + hy) * 0.00013, 0.62, 1.08);
		// 陸海の境：R90/GEBCO の海はクランプで厳密に 0＝閾は低く攻められる（0.5-30m だと華北平原・
		// 長江デルタ級の低平地が海色に沈む＝本人指摘 2026-08-30）。0.2→4m＝干拓地級だけ海側に残る
		// （蘭ポルダー等の 0m 以下はクランプで 0＝負値解禁（海の深度ランプ）とセットの将来課題）
		float landK = smoothstep(0.2, 4.0, e);
		vec3 hyp = mix(u_seaC, worldHypso(e, ll) * shade, landK);
		base = mix(base, hyp, u_whK);
	}
	vec3 viewDir = normalize(A - P);              // 面→カメラ
	float ndv = clamp(dot(P, viewDir), 0.0, 1.0);
	float haze = pow(1.0 - ndv, 3.0);             // 縁ほど強い内側リムの霞
	vec3 col = mix(base, u_atmo.rgb, haze * u_atmo.a * 0.9);
	fragColor = vec4(col, 1.0);
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
uniform mat4 u_invMvp;
uniform vec3 u_sun;     // 太陽方向（地球固定・単位ベクトル）
uniform float u_alpha;  // 夜面の濃さ（星空と同じ z4→3.5 フェード込み）
in vec2 v_ndc;
out vec4 fragColor;
void main() {
	vec4 np = u_invMvp * vec4(v_ndc, -1.0, 1.0);
	vec4 fp = u_invMvp * vec4(v_ndc, 1.0, 1.0);
	vec3 A = np.xyz / np.w, B = fp.xyz / fp.w, d = B - A;
	float aa = dot(d, d), bb = 2.0 * dot(A, d), cc = dot(A, A) - 1.0;
	float disc = bb * bb - 4.0 * aa * cc;
	if (disc < 0.0) discard;
	float t = (-bb - sqrt(disc)) / (2.0 * aa);
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
uniform mat4 u_invMvp;
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
float elevAt(vec2 ll) {
	vec2 uv = (ll - u_elevBounds.xy) / u_elevBounds.zw;
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
	vec4 np = u_invMvp * vec4(v_ndc, -1.0, 1.0);
	vec4 fp = u_invMvp * vec4(v_ndc, 1.0, 1.0);
	vec3 A = np.xyz / np.w, B = fp.xyz / fp.w, d = B - A;
	float aa = dot(d, d), bb = 2.0 * dot(A, d), cc = dot(A, A) - 1.0;
	float disc = bb * bb - 4.0 * aa * cc;
	if (disc < 0.0) discard;                            // 球ミス
	float t = (-bb - sqrt(disc)) / (2.0 * aa);
	if (t < 0.0) discard;
	vec3 P = A + t * d;                                 // 単位球（β球）上の点
	float bl = asin(clamp(P.y, -1.0, 1.0));            // β(rad)
	float latD = bl * R2D + u_ell * (0.0016792203863837047 * sin(2.0 * bl) + 0.0000014098905530233192 * sin(4.0 * bl)) * R2D;   // β→測地（glsl geoLat と同式）
	vec2 ll = vec2(atan(P.z, P.x) * R2D, latD);         // lon,lat(deg・測地)
	float e = elevAt(ll);
	float landMask = smoothstep(0.5, 4.0, e);           // 海/データ無し(≈0)は等高線を出さない
	if (landMask <= 0.0) discard;
	float line = max(band(e / u_interval) * 0.2, band(e / u_major) * 0.4);   // さらに淡く（主曲線ごく薄・計曲線も薄め）
	float a = line * landMask * u_alpha;
	if (a <= 0.003) discard;
	fragColor = vec4(u_cColor * a, a);                  // premultiplied
}`;

export const FILL_VS = `#version 300 es
precision highp float;
in vec2 a_delta;
in vec4 a_color;
${PROJECT}
uniform float u_lift;   // 水面リフト(m)：水域(fill)だけ山岳レジームで+30m＝DSMの水面ノイズ瘤を沈めつつ
                        // 尾根(数百m級)の遮蔽は保つ（深度テスト免除=後書きの廃止）。通常塗りは 0。
uniform float u_seaGate;   // 1＝図郭外フォールバック水域（empty-sea op）：頂点は海抜0の球面に置き
                           // （全面クアッドの隅が山に乗ると水面ごと傾くため）、FS が elev>0 を discard
out vec4 v_color;
out float v_front;
out float v_fog;
out float v_w;    // clip w（perspective-correct 補間＝フラグメントで真の視距離。水域の厳密深度用）
out vec2 v_ll;    // 絶対 lon/lat(deg)＝FS 標高ゲート（u_seaGate）用
void main() {
	vec2 dLL = a_delta;                       // 原点相対 (deg)。multidraw は mdize が u_tileOff を足す
	vec2 ll = u_origin + dLL;                  // elev 参照用の絶対（粗くて可）
	v_ll = ll;
	vec3 rel = deltaToRel(dLL);               // 頂点3D − 原点3D（小・正確）
	vec3 dir = u_originPt + rel;              // 絶対単位球点（front/fog/df 用＝粗くて可）
	// 標高変位は地形と同じ距離フェード（TERRAIN_VS の df と同式）＝遠景で地形が平ら化された時に
	// 塗りだけ山の高さに浮くのを防ぐ（浮くと地平線の上に塗りの切れ端が漂う）
	float df = 1.0 - smoothstep(u_fogFar * 0.8, u_fogFar * 2.0, distance(u_eye, dir));
	float h = u_seaGate > 0.5 ? 0.0 : (elev(ll) + u_lift) * u_elevScale * df;
	vec3 relW = rel + h * liftDir(ll, dir);   // (dir*(1+h)) − 原点3D を相殺なしで（標高で地形に貼りつく。楕円体＝測地法線）
	v_color = a_color;
	v_front = dot(dir, u_eye) - 1.0;          // >0 で手前半球（cull＝粗くて可）
	v_fog = fogOf(u_originPt + relW);
	gl_Position = u_clipT + u_mvp * vec4(relW, 0.0);   // RTE：mvp*[w,1] を相殺なしで
	applyLogDepth();   // 山岳ビュー(z<13)は深度テストON＝地形(対数深度)が尾根の向こうを遮蔽。テストOFF時は無害
	v_w = gl_Position.w;
}`;

export const FILL_FS = `#version 300 es
precision highp float;
uniform vec3 u_fogColor;
uniform float u_logCoef;
uniform float u_exactDepth;   // 1＝フラグメント厳密対数深度（terrainDepth 中の水域のみ）
uniform float u_seaGate;      // 1＝図郭外フォールバック水域：標高が陸(h>0)の画素は塗らない
                              // ＝「水域は地理院・陸は標高(GEBCO/R10)」の管轄裁定を画素単位で行う
${ELEV}
in vec4 v_color;
in float v_front;
in float v_fog;
in float v_w;
in vec2 v_ll;
out vec4 fragColor;
void main() {
	if (v_front < -0.0015) discard;         // 裏半球は描かない（接線に標高許容＝地平線に頭を出す山上の塗りも描く）
	if (u_seaGate > 0.5 && elev(v_ll) > 0.0) discard;   // 図郭外＝陸は塗り残す（紙色+等高線に委ねる）
	// 霧はフェードアウト（透明化）：紙色で塗り潰すと、地平線の先＝球に隠れるべき塗りが空に不透明で浮く。
	// 1.2倍＝霧83%で完全消滅：地形の霞（fog=1で紙色の帯）より一歩先に消え、暗い空に尻尾が残らない
	float af = v_color.a * clamp(1.0 - 1.2 * v_fog, 0.0, 1.0);
	if (af <= 0.003) discard;
	fragColor = vec4(mix(v_color.rgb, u_fogColor, v_fog) * af, af);  // premultiplied
	// 水域の厳密深度：applyLogDepth（VS焼き）は「三角形が小さい」前提の頂点線形補間＝湖全体を跨ぐ
	// 水ポリの巨大三角形では真の対数曲線から数百m相当外れ、掠め視線で地形が偽って手前勝ちする
	// ＝湖中の偽島（琵琶湖 75° 実測・真俯瞰で消える・R01/R10 とも発症＝データ非依存の深度補間誤差）。
	// v_w は perspective-correct 補間＝平面水面の真の clip w → 真の対数深度を書き直す。
	// gl_FragDepth の静的使用で fill 全描画の early-Z は失うが、fill は深度を書かない・FS も軽い＝実害なし。
	gl_FragDepth = (u_exactDepth > 0.5)
		? clamp((log2(max(1.0 + v_w, 1e-6)) * u_logCoef - 1.0) * 0.5 + 0.5, 0.0, 1.0)
		: gl_FragCoord.z;
}`;

// capsule 方式：両端をスクリーン空間へ投影して定px幅・丸端で描く。透視でも幅が一定。
// 本体は classic（インスタンス属性）と multi_draw（テクスチャpull）で共用＝式の乖離を構造的に防ぐ。
// 変種側が用意するローカル: o(シーン原点+タイル原点差 deg), p1/p2(原点相対 lon/lat), corner(end 0/1, side ±1),
// hw0(半幅 CSS px), col0(rgba)。
const LINE_VARY = /* glsl */`
uniform float u_lift;   // 接地リフト(m)。都市帯（深度テスト×DTM起伏）で線を地形メッシュ面の上へ逃がす（fill の u_lift と同意味論）
flat out vec2 v_a;
flat out vec2 v_b;
flat out float v_half;
out vec2 v_pos;
out vec4 v_color;
out float v_front;
out float v_fog;`;
const LINE_MAIN = /* glsl */`
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
	float ha = (elev(la1) + u_lift) * u_elevScale * dfa, hb = (elev(la2) + u_lift) * u_elevScale * dfb;
	vec3 relWa = rela + ha * liftDir(la1, da), relWb = relb + hb * liftDir(la2, db);   // (dir*(1+h)) − 原点3D を相殺なしで（楕円体＝測地法線）
	vec3 wa = u_originPt + relWa, wb = u_originPt + relWb;       // 絶対（fog 用＝粗くて可）
	vec4 ca = u_clipT + u_mvp * vec4(relWa, 0.0), cb = u_clipT + u_mvp * vec4(relWb, 0.0);   // RTE：mvp*[w,1] を相殺なしで
	float fa = dot(da, u_eye) - 1.0, fb = dot(db, u_eye) - 1.0;
	if (ca.w <= 0.0 || cb.w <= 0.0) { v_front = -1.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }  // カメラ背後
	vec2 sa = toScreen(ca), sb = toScreen(cb);
	vec2 d = sb - sa; float len = length(d);
	vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
	vec2 perp = vec2(-dir.y, dir.x);
	float hw = hw0 * u_dpr + 1.0;        // +1px の AA/丸端余白
	vec2 base = corner.x < 0.5 ? sa : sb;
	float capSign = corner.x < 0.5 ? -1.0 : 1.0;
	vec2 pos = base + perp * (hw * corner.y) + dir * (capSign * hw);
	v_a = sa; v_b = sb; v_half = hw0 * u_dpr; v_pos = pos;
	v_color = col0; v_front = min(fa, fb);
	v_fog = fogOf((wa + wb) * 0.5);
	// 端点の深度は対数系（applyLogDepth と同式）＝地形・建物と同じ深度空間（山岳ビューで尾根の向こうを遮蔽）
	float wz = (corner.x < 0.5) ? ca.w : cb.w;
	float zc = log2(max(1.0 + wz, 1e-6)) * u_logCoef - 1.0;
	vec2 ndc = vec2(pos.x / u_viewport.x * 2.0 - 1.0, 1.0 - pos.y / u_viewport.y * 2.0);
	gl_Position = vec4(ndc, zc, 1.0);
`;
export const LINE_VS = `#version 300 es
precision highp float;
in vec2 a_p1;
in vec2 a_p2;
in vec2 a_corner;   // (end 0/1, side -1/+1)
in float a_half;    // CSS px
in vec4 a_color;
uniform float u_dpr;
${PROJECT}
${LINE_VARY}
void main() {
	vec2 o = u_origin;
	vec2 p1 = a_p1, p2 = a_p2, corner = a_corner;
	float hw0 = a_half; vec4 col0 = a_color;
${LINE_MAIN}
}`;

// --- multi_draw（タイルバッファGPU常駐）用の変種 ---
// 頂点はタイル原点相対のまま常駐し、gl_DrawID → u_tileOff[]（タイル原点−シーン原点）で再ベース＝
// merge の CPU memcpy と setScene の全バッファ再生成を丸ごと廃す。u_tileOff は uniform 配列（UBO不要の規模）。
export const MD_MAX_DRAWS = 128;   // 1回の multiDraw に載せる最大タイル数（超過は呼び出し側がチャンク分割）

// 既存シェーダの機械変換（対象文字列が消えたらロード時に即 throw ＝サイレントな取りこぼしを防ぐ）
function mdize(src, subs) {
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
	["in vec4 a_color;", `in vec4 a_color;\nuniform vec2 u_tileOff[${MD_MAX_DRAWS}];`],
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
// 線分プール（2texel/線分）: [bits(p1.x), bits(p1.y), bits(p2.x), bits(p2.y)] [colRGBA8パック, bits(half), 0, 0]
uniform usampler2D u_segTex;
uniform vec2 u_tileOff[${MD_MAX_DRAWS}];
uniform float u_dpr;
${PROJECT}
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
	vec4 col0 = vec4(float(B.x & 255u), float((B.x >> 8) & 255u), float((B.x >> 16) & 255u), float(B.x >> 24)) / 255.0;
	float hw0 = uintBitsToFloat(B.y);
	vec2 o = u_origin;
${LINE_MAIN}
}`;

export const LINE_FS = `#version 300 es
precision highp float;
uniform vec3 u_fogColor;
flat in vec2 v_a;
flat in vec2 v_b;
flat in float v_half;
in vec2 v_pos;
in vec4 v_color;
in float v_front;
in float v_fog;
out vec4 fragColor;
void main() {
	if (v_front < -0.0015) discard;   // 接線に標高許容（地平線に頭を出す山上の線も描く。遮蔽は深度とフォグ）
	vec2 pa = v_pos - v_a, ba = v_b - v_a;
	float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
	float dist = length(pa - ba * t);
	// 細線のシャープ化（製図の定石）：幾何幅は最低±0.5px を保証し、それ未満の細さは透明度（カバレッジ）で表現。
	// サブピクセル幅をそのまま描くと±0.5pxのAAフェザーが本体より太くなり「淡くボケた2pxの線」＝低ズームの滲みになる。
	// さらにフェザー自体を±0.25pxへ半減（×2.0）＝エッジの立ち上がりを締める。Retina(dpr2)ではCSS 0.125px相当。
	// 結果は「常にカリッと・細いほど薄く」＝シャープで主張しない線。
	float hw = max(v_half, 0.5);
	float alpha = clamp((hw - dist) * 2.0 + 0.5, 0.0, 1.0) * min(v_half * 2.0, 1.0);
	if (alpha <= 0.0) discard;
	// 霧はフェードアウト（透明化）：塗り潰し式だと地平線の先の線が「空に浮く白線」になる（球の自遮蔽の代役）。
	// 1.2倍＝霧83%で完全消滅：地形の霞の帯より先に消え、暗い空に線の尻尾（残影）が残らない
	float a = v_color.a * alpha * clamp(1.0 - 1.2 * v_fog, 0.0, 1.0);
	if (a <= 0.003) discard;
	vec3 rgb = mix(v_color.rgb, u_fogColor, v_fog);
	fragColor = vec4(rgb * a, a);
}`;
