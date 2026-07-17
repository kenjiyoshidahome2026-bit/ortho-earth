// 透視カメラ（チルト対応）。経緯度→単位球3D→u_mvp でクリップ座標へ。
// 頂点はシーン原点(u_origin)からの経緯度差分。fill は clip 直行、line/capsule はスクリーン空間で幅付け。

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
// 標高テクスチャ（GEBCO/ALOS, R32F meters）。範囲内なら高さ(m)、外は0。
uniform sampler2D u_elevTex;
uniform vec4 u_elevBounds;   // originLng, originLat, spanLng, spanLat（アトラス被覆）
uniform float u_elevScale;   // (誇張 / 地球半径m) : m → 単位球
uniform float u_hasElev;     // 0/1
uniform float u_elevEdgeFade;   // 窓の縁のフェード幅(deg)。0=無効（R90全球窓）。R10/R01窓の外（標高0）との崖を馴染ませる
float elevFadeAt(vec2 uv) {
	if (u_elevEdgeFade <= 0.0) return 1.0;
	vec2 w = vec2(u_elevEdgeFade) / u_elevBounds.zw;
	return min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
}
float elev(vec2 ll) {
	if (u_hasElev < 0.5) return 0.0;
	vec2 uv = (ll - u_elevBounds.xy) / u_elevBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
	return texture(u_elevTex, uv).r * elevFadeAt(uv);   // アトラスは南上げ格納＝v直接
}
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
out vec2  v_ll;      // 絶対 lon/lat(deg)＝PLATEAU bbox 内を伏せる判定用
void main() {
	vec2 ll = u_origin + a_pos.xy;
	v_ll = ll;
	vec3 dir = lonlatTo3D(ll);
	float base = elev(u_origin + a_anchor) * u_elevScale;     // 基準点の標高で足元を揃える（屋根水平・壁垂直）
	vec3 w = dir * (1.0 + base + a_pos.z);                     // 地形の上に建物高さを積む
	v_shade = a_shade;
	v_front = dot(dir, u_eye) - 1.0;
	v_fog = fogOf(w);
	gl_Position = u_mvp * vec4(w, 1.0);
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
bool maskedBy(vec4 bbox, sampler2D mask, vec2 ll) {
	vec2 uv = (ll - bbox.xy) / (bbox.zw - bbox.xy);   // bbox 内 0..1
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
	// 標高リフトはしない：ALOS DSM はビル天端を含み建物の縁で数十〜100m級の不連続があるため、頂点ごとに
	// elev() で持ち上げると同一建物内の頂点が異なる量だけ動き屋根が引き裂かれる（実機で形状崩壊を確認済み）。
	// 地形サーフェスとの深度衝突は「地形は深度を書かない背景」(renderer側depthMask(false))で解いており、
	// メッシュは焼き込み済みの単位球接地(r=1)のまま描く（基図と同じ街の相対配置は保たれる）。
	// RTE：原点と delta を別々に射影して加算。原点=画面上の錨(粗)、delta=小さく float32 精度フル → z-fight/淵マダラ/座標ちらつきを断つ
	gl_Position = u_mvp * vec4(u_meshOrigin, 1.0) + u_mvp * vec4(a_pos, 0.0);
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
	if (v_front < 0.0) discard;                                   // 裏半球
	vec3 n = normalize(v_n);                                      // glTF 実法線
	float fe = dot(n, normalize(v_toEye));
	// 裏面カリング（実法線で判定＝巻き順非依存）＝淵の front/back z-fight とトグル反転を断つ。
	// 閾値 -0.02＝int8量子化(誤差~0.4°, sin≈0.007)の許容帯。0.0 ちょうどだと視線すれすれの壁が
	// 量子化誤差で描く/捨てるを行き来してちらつく（すれすれ帯の裏面は幅~1px＝描いても実害なし）。
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
in vec2 a_ll;      // 絶対 lon/lat
${PROJECT}
out vec2 v_ll;
out float v_front;
out float v_fog;
out float v_h;
void main() {
	vec3 dir = lonlatTo3D(a_ll);
	// 遠景は変位を距離フェードで平ら化＝grazing(すれすれ角)で粗いメッシュ格子が縦壁に見えるのを消す。
	// 開始はフォグがほぼ霞み切る距離から＝可視域の山（中央・北アルプス等）は立体のまま、
	// シルエットが霞に溶けた先だけ平ら化（fogNear基準だと100km先の山脈が丸ごと潰れて見えなくなる）。
	float df = 1.0 - smoothstep(u_fogFar * 0.8, u_fogFar * 2.0, distance(u_eye, dir));
	float h = elev(a_ll) * df;
	v_h = h;
	v_ll = a_ll;
	vec3 w = dir * (1.0 + h * u_elevScale);
	v_front = dot(dir, u_eye) - 1.0;
	v_fog = fogOf(w);
	gl_Position = u_mvp * vec4(w, 1.0);
	applyLogDepth();
}`;

export const TERRAIN_FS = `#version 300 es
precision highp float;
uniform vec3 u_fogColor;
uniform vec3 u_land;
uniform vec3 u_hypso;    // 標高ティント色（高所を land からこの色へ寄せる＝控えめな標高彩色）
uniform vec2 u_hypsoP;   // x=1/最大標高(m)（この高さで寄せ切る） y=寄せ量(0=無効…1=全置換)
uniform sampler2D u_elevTex;
uniform vec4 u_elevBounds;
uniform float u_hasElev;
uniform float u_elevEdgeFade;   // 窓の縁のフェード幅(deg)。変位(VSのelev)と同じ式＝陰影と地形が同時に消える
in vec2 v_ll;
in float v_front;
in float v_fog;
in float v_h;
out vec4 fragColor;
float elevF(vec2 ll) {
	if (u_hasElev < 0.5) return 0.0;
	vec2 uv = (ll - u_elevBounds.xy) / u_elevBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
	float f = 1.0;
	if (u_elevEdgeFade > 0.0) {
		vec2 w = vec2(u_elevEdgeFade) / u_elevBounds.zw;
		f = min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
	}
	return texture(u_elevTex, uv).r * f;
}
void main() {
	if (v_front < -0.0015) discard;   // 海抜0の接線より少し先まで許容＝地平線の先に頭を出す高山（〜9km球換算）を描く。遮蔽は深度とフォグが担う
	// 海〜低地は地形を透明化し、海岸線は精細なベクタに委ねる。低地から滑らかに陰影を立ち上げ、
	// 粗い標高メッシュが海岸で作る「崖」のガタつき・平野のノイズを消す。
	float t = smoothstep(1.0, 100.0, v_h);
	if (t <= 0.0) discard;
	// 北西光の hillshade（前方差分＝中央差分の半分のフェッチ）。
	// 歩幅＝アトラス1texel（下限は従来の0.004°≈450m＝近景は不変）。固定歩幅はズームアウトで
	// texel未満に落ち「鈍った勾配×小さい歩幅」で陰影がベタ灰色に消えていた（広域の塗りの甘さ）。
	// texel差分＝アトラスが持つ最小起伏を常に同じゲインで見せる＝どのスケールでも塗りが痩せない。
	vec2 tsz = vec2(textureSize(u_elevTex, 0));
	float d = max(0.004, u_elevBounds.w / tsz.y);
	float h0 = elevF(v_ll);
	float hx = elevF(v_ll + vec2(d, 0.0)) - h0;
	float hy = elevF(v_ll + vec2(0.0, d)) - h0;
	float shade = clamp(0.82 + (-hx + hy) * 0.0007, 0.45, 1.15);
	// 標高ティント：land を高所ほど u_hypso へ寄せる（テーマのノブ＝未指定は y=0 で恒等）。陰影の前＝shade が上に乗る
	vec3 landC = mix(u_land, u_hypso, clamp(h0 * u_hypsoP.x, 0.0, 1.0) * u_hypsoP.y);
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
void main() {
	vec2 ll = u_origin + a_delta;
	gl_Position = u_mvp * vec4(lonlatTo3D(ll), 1.0);   // 球面(半径1)へ。塗りは巻き数で決まるので fan の形は問わない
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
in vec2 v_ndc;
out vec4 fragColor;
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
	vec3 viewDir = normalize(A - P);              // 面→カメラ
	float ndv = clamp(dot(P, viewDir), 0.0, 1.0);
	float haze = pow(1.0 - ndv, 3.0);             // 縁ほど強い内側リムの霞
	vec3 col = mix(u_land.rgb, u_atmo.rgb, haze * u_atmo.a * 0.9);
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
	float w = fwidth(g) * 0.5 + 1e-5;                   // 係数＝線の細さ（細すぎるとサブピクセルで破線化＝汚い）
	return 1.0 - smoothstep(0.0, w, dd);
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
	vec3 P = A + t * d;                                 // 単位球上の点
	vec2 ll = vec2(atan(P.z, P.x) * R2D, asin(clamp(P.y, -1.0, 1.0)) * R2D);   // lon,lat(deg)
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
out vec4 v_color;
out float v_front;
out float v_fog;
void main() {
	vec2 ll = u_origin + a_delta;
	vec3 dir = lonlatTo3D(ll);
	// 標高変位は地形と同じ距離フェード（TERRAIN_VS の df と同式）＝遠景で地形が平ら化された時に
	// 塗りだけ山の高さに浮くのを防ぐ（浮くと地平線の上に塗りの切れ端が漂う）
	float df = 1.0 - smoothstep(u_fogFar * 0.8, u_fogFar * 2.0, distance(u_eye, dir));
	vec3 w = dir * (1.0 + elev(ll) * u_elevScale * df);   // 標高変位（地形に貼りつく）
	v_color = a_color;
	v_front = dot(dir, u_eye) - 1.0;          // >0 で手前半球
	v_fog = fogOf(w);
	gl_Position = u_mvp * vec4(w, 1.0);
	applyLogDepth();   // 山岳ビュー(z<13)は深度テストON＝地形(対数深度)が尾根の向こうを遮蔽。テストOFF時は無害
}`;

export const FILL_FS = `#version 300 es
precision highp float;
uniform vec3 u_fogColor;
in vec4 v_color;
in float v_front;
in float v_fog;
out vec4 fragColor;
void main() {
	if (v_front < -0.0015) discard;         // 裏半球は描かない（接線に標高許容＝地平線に頭を出す山上の塗りも描く）
	// 霧はフェードアウト（透明化）：紙色で塗り潰すと、地平線の先＝球に隠れるべき塗りが空に不透明で浮く。
	// 1.2倍＝霧83%で完全消滅：地形の霞（fog=1で紙色の帯）より一歩先に消え、暗い空に尻尾が残らない
	float af = v_color.a * clamp(1.0 - 1.2 * v_fog, 0.0, 1.0);
	if (af <= 0.003) discard;
	fragColor = vec4(mix(v_color.rgb, u_fogColor, v_fog) * af, af);  // premultiplied
}`;

// capsule 方式：両端をスクリーン空間へ投影して定px幅・丸端で描く。透視でも幅が一定。
// 本体は classic（インスタンス属性）と multi_draw（テクスチャpull）で共用＝式の乖離を構造的に防ぐ。
// 変種側が用意するローカル: o(シーン原点+タイル原点差 deg), p1/p2(原点相対 lon/lat), corner(end 0/1, side ±1),
// hw0(半幅 CSS px), col0(rgba)。
const LINE_VARY = /* glsl */`
flat out vec2 v_a;
flat out vec2 v_b;
flat out float v_half;
out vec2 v_pos;
out vec4 v_color;
out float v_front;
out float v_fog;`;
const LINE_MAIN = /* glsl */`
	vec2 la1 = o + p1, la2 = o + p2;
	vec3 da = lonlatTo3D(la1), db = lonlatTo3D(la2);
	// 線は傾き時に深度テストを切って地形の上に描く（renderer側）ので、持ち上げ不要＝浮きゼロ。
	float lift = 0.0;
	// 標高変位は地形と同じ距離フェード（TERRAIN_VS の df と同式）＝遠景の平ら化に追随。
	// これが無いと平ら化された山脈の上に線だけがフル標高で浮き、「地平線に漂う点線の鎖」になる
	float dfa = 1.0 - smoothstep(u_fogFar * 0.8, u_fogFar * 2.0, distance(u_eye, da));
	float dfb = 1.0 - smoothstep(u_fogFar * 0.8, u_fogFar * 2.0, distance(u_eye, db));
	vec3 wa = da * (1.0 + elev(la1) * u_elevScale * dfa + lift), wb = db * (1.0 + elev(la2) * u_elevScale * dfb + lift);
	vec4 ca = u_mvp * vec4(wa, 1.0), cb = u_mvp * vec4(wb, 1.0);
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
	["vec2 ll = u_origin + a_delta;", "vec2 ll = u_origin + (u_tileOff[gl_DrawID] + a_delta);"],
]);
export const BUILDING_MD_VS = mdize(BUILDING_VS, [
	["in vec2 a_anchor;", `in vec2 a_anchor;\nuniform vec2 u_tileOff[${MD_MAX_DRAWS}];`],
	["vec2 ll = u_origin + a_pos.xy;", "vec2 ll = u_origin + (u_tileOff[gl_DrawID] + a_pos.xy);"],
	["elev(u_origin + a_anchor)", "elev(u_origin + (u_tileOff[gl_DrawID] + a_anchor))"],
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
