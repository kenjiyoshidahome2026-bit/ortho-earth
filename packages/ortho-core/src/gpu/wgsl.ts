import { CS_ATMO_WGSL } from "../csatmo.ts";
import { csWgsl, type CsSpec } from "../csshader.ts";
// WebGPU(WGSL) シェーダ＝gl/glsl.js の忠実移植。
// Phase 1: globe / fill / line（基図コア）。Phase 2: 標高（elev）・地形サーフェス・深度・建物押し出し・等高線。
// 数学は GLSL 版と1:1（sinP テイラー・deltaToRel の桁落ち回避 RTE・capsule SDF・対数深度・hillshade）。
// GL との差分は座標系と束ね方だけ：
//  ・クリップ z が GL の [-1,1] でなく [0,1] ＝対数深度は z01 = 0.5·log2(1+w)·coef を直接書く
//    （GL の window 深度 0.5·(z_ndc+1) と同値＝深度の互換維持。glsl.js applyLogDepth 参照）。
//  ・uniform は per-draw の gl.uniform* でなく UBO：@group(0)=Frame（スロット毎＝base/main/terrain/bld）
//    ＋標高テクスチャ、@group(1)=DrawP（描画役割毎の小物＝seaGate/lift/色ノブ）。詰め順は renderer.js と厳密対応。
//  ・VS の標高サンプルは textureSampleLevel（頂点ステージは暗黙 LOD 不可＝明示 LOD 0）。
// ⚠移植の轍：smoothstep の引数逆転（GLSL は黙認・WGSL は未定義動作の明記）は 1-smoothstep(正順) に書き換える。

// 共通フレーム uniform（1スロット=272B・512B 境界で base/main/terrain/bld の4領域を1バッファに同居）。
// params = (fogNear, fogFar, logCoef, dpr) / elevP = (elevScaleEff, hasElev, edgeFade, 0)。
// スロットの使い分け＝GL 版 setCommonUniforms＋per-program 上書きの写し：
//   base/main … fill/line（fogFar=fogFarCap 上書き済みの値・origin はシーン毎）
//   terrain  … 遠山ブルー（fogColor=distColor・near/far は地形専用式・origin=main と同じ）
//   bld      … 建物（fog 既定 2.5×/14×・origin=main と同じ）
// 全画面レイキャストの視線と球との交点（#65・2026-09-27）：視線は CPU f64 の基底（camera.js viewRays）＝invMvp（f32）の積和をしない。
// 交点は近い根を t＝2c/(−b＋√h) で（c＝|E|²−1 は CPU f64）＝桁落ちなし。後ろ向き（q≤0）＝t<0。A＝目・d＝視線（clip w＝1 の長さ）
const RAY = /* wgsl */`
struct SphereHit { A: vec3f, d: vec3f, t: f32, aa: f32, bb: f32, cc: f32, disc: f32 };
fn sphereRay(ndc: vec2f, rF: vec4f, rX: vec4f, rY: vec4f, eyeC: vec4f) -> SphereHit {
	let d = rF.xyz + ndc.x * rX.xyz + ndc.y * rY.xyz;
	let A = eyeC.xyz; let cc = eyeC.w;
	let aa = dot(d, d); let bb = 2.0 * dot(A, d);
	let disc = bb * bb - 4.0 * aa * cc;
	var t = -1.0;
	if (disc >= 0.0 && !(bb >= 0.0 && cc >= 0.0)) { let q = -bb + sqrt(disc); if (q > 0.0) { t = 2.0 * cc / q; } }   // 外から上向き＝交点なし（c≈0 で q が丸めの ±ulp＝空が地面に化けた・2026-10-28）
	return SphereHit(A, d, t, aa, bb, cc, disc);
}
// 交点の原点相対 δ（＝EO＋t·d・f32 で mm 級）から経緯度の差（deg・測地）を桁落ちなしで：O＝原点（β単位球）・rhoO＝cos β0・beta0（rad）・ell＝楕円体ゲート。
// δlon＝atan2(δz·Ox−δx·Oz, ρO²+δx·Ox+δz·Oz)（atan の差の恒等式＝O² の項は代数的に消える）。
// δβ＝atan2(δy·ρO−dρ·Oy, ρP·ρO+Py·Oy)・dρ＝ρP−ρO＝s/(ρP+ρO)・s＝2(Ox·δx+Oz·δz)+δx²+δz²（ρ の差も桁落ちなし）。測地の補正は差（sin の差）で
fn deltaLL(dl: vec3f, O: vec3f, rhoO: f32, beta0: f32, ell: f32) -> vec2f {
	let dlon = atan2(dl.z * O.x - dl.x * O.z, rhoO * rhoO + dl.x * O.x + dl.z * O.z);
	let s = 2.0 * (O.x * dl.x + O.z * dl.z) + dl.x * dl.x + dl.z * dl.z;
	let rhoP = sqrt(max(rhoO * rhoO + s, 0.0));
	let drho = s / max(rhoP + rhoO, 1e-12);
	let dbeta = atan2(dl.y * rhoO - drho * O.y, rhoP * rhoO + (O.y + dl.y) * O.y);
	let b1 = beta0 + dbeta;
	let corr = ell * (0.0016792203863837047 * (sin(2.0 * b1) - sin(2.0 * beta0)) + 0.0000014098905530233192 * (sin(4.0 * b1) - sin(4.0 * beta0)));
	return vec2f(dlon, dbeta + corr) * 57.29577951308232;
}
`;
// 地面の材質（setGroundMaterial・CesiumJS の globe.material・2026-10-28）：地形面と球の床の画像の上に、標高／傾斜／方位の
// ランプ（1 列の色の表）・等高線・「陸だけ」を重ねる（gl/glsl.ts GM と同式）。gm＝(種類 0 なし／1 標高／2 傾斜／3 方位／4 等高線だけ, 最低標高 m,
// 1/(最高−最低), 陸だけ)・gmC＝等高線の色 rgba・gmP＝(間隔 m, 太さ px, 不透明度, 0)。h＝標高 m・gEN＝勾配（東・北 m/m）・dh＝fwidth(h)
const GM_WGSL = (fn: string, tex: string, samp: string): string => /* wgsl */`
fn ${fn}(h: f32, gEN: vec2f, dh: f32, gm: vec4f, gmC: vec4f, gmP: vec4f) -> vec4f {
	let k = gm.x;
	var m = vec4f(0.0);
	if (k < 3.5) {
		var v = clamp((h - gm.y) * gm.z, 0.0, 1.0);
		if (k > 1.5 && k < 2.5) { v = acos(inverseSqrt(1.0 + dot(gEN, gEN))) / 1.5707963267948966; }
		else if (k > 2.5) { v = fract(atan2(-gEN.y, -gEN.x) / 6.283185307179586 + 1.0); }
		m = textureSampleLevel(${tex}, ${samp}, vec2f(v, 0.5), 0.0);
	}
	if (gmC.a > 0.0 && (h - floor(h / gmP.x) * gmP.x) < dh * gmP.y) { m = gmC; }   // 等高線（Cesium の ElevationContour）＝標高の画素差 × 太さ の帯
	if (gm.w > 0.5 && h <= 0.0) { m.a = 0.0; }   // 陸だけ（WaterMask の逆）＝標高 0 以下（海面）は塗らない
	m.a *= gmP.z;
	return m;
}`;
const FRAME = /* wgsl */`
struct Frame {
	mvp: mat4x4f,
	rayF: vec4f,       // 全画面レイキャスト（#65・旧 invMvp の枠）：視線の基底（CPU f64・camera.js viewRays）v(ndc)＝F＋x·X＋y·Y。等高線が読む
	rayX: vec4f,
	rayY: vec4f,
	eyeC: vec4f,       // xyz＝目の位置・w＝|E|²−1（f64）＝sphereRay の c
	clipT: vec4f,      // mvp*[originPt,1]（CPU double）＝RTE の錨
	trig: vec4f,       // (cosLon, sinLon, cosLat, sinLat) of origin
	originPt: vec3f,   // lonlatTo3D(origin)
	eye: vec3f,        // カメラ位置（単位球ワールド）
	origin: vec2f,     // シーン原点 lon/lat (deg)
	viewport: vec2f,   // canvas 幅高 (device px)
	fogColor: vec3f,   // 霞む先の色（fill/line/bld=land基色・terrain=遠山ブルー）
	params: vec4f,     // fogNear, fogFar, logCoef, dpr
	elevBounds: vec4f, // originLng, originLat, spanLng, spanLat（アトラス被覆）
	elevP: vec4f,      // elevScaleEff((誇張/半径)×pitchフェード), hasElev(0/1), edgeFade(deg), 0
	mesh: vec4f,       // 地形メッシュの窓：xy=原点(lon,lat) zw=幅(deg)。頂点は単位格子 uv＝窓替えで作り直さない（terrain/terrainFar slot のみ非0）
	farBounds: vec4f,  // 遠景層（far）アトラス被覆＝近窓の外を受け持つ粗い R10 第2アトラス（深ズーム×チルトで常設）
	farP: vec4f,       // hasFar(0/1), farEdgeFade(deg), farPass(1=遠景メッシュパス・terrainFar slot のみ), Cesium の霧の濃さ（csFogDensity・地形と模型の頂点で csFogV）
	ellTrig: vec4f,    // 楕円体 dβ 錨 (cos2φ0, sin2φ0, cos4φ0, sin4φ0)（CPU double・原点の測地緯度）。球=vec4(0)＝補正が厳密0
	ellP: vec4f,       // x=1:楕円体（変位方向・β→φ復元のゲート）0:球, yzw=0
	cogP: vec4f,       // ユーザ COG uv 係数（f64 前計算＝f32 絶対経緯度ジッタ根治）: fill系 slot=(off.xy, 1/span)・terrain系 slot=(off.xy, mesh.zw/span)
	gnd0: vec4f,       // 地面アトラス（近窓）uv 係数＝cogP と同形（fill系＝(off.xy, 1/span)・terrain系＝(off.xy, mesh.zw/span)）
	gnd1: vec4f,       // 同・中窓
	gnd2: vec4f,       // 同・遠窓
	gnd3: vec4f,       // 同・4 段目（前景あり＝[前景,近,中,遠]・無し＝[近,中,遠,−]）
	eyeO: vec4f,       // xyz＝目−originPt（f64 で引く＝原点相対の目）・w＝原点の β（rad）。等高線の交点 δ＝eyeO＋t·d（#65）
	elevOff: vec4f,    // 等高線の標高 uv 係数（f64 前計算）：(原点の uv, 1/span)＝uv＝off＋δll·inv
	sun: vec4f,        // 太陽（#46 段 0・2026-09-26）：xyz＝方向の単位ベクトル（地球固定・y=北極＝shadow.js sunVector と同軸）・w＝昼の度合い（原点の太陽高度 −6°→+6° の smoothstep）。夜は減光した固定光へ落とす量の鍵＝段 2 の PBR が読む。段 0 では運ぶだけ
	cg: vec4f,         // 地面の照明（setGroundLighting・2026-10-26）：xyz＝光へ向く単位ベクトル（世界）・w＝0 無し／1 地形の法線／2 楕円体の上向き（cgLambert）。sun の後ろ＝packFrame の詰め順（sun 116・cg 120）と一致させる
	cgP: vec4f,        // (lambert の倍率, 足す値, 効き 0..1＝距離のフェード済み, 大気の夜側の明るさ 0.05..1・負＝暗くしない)
	cgC: vec4f,        // 光の色（czm_lightColor）
	nearBounds: vec4f, // 近景層（near・順 1a 2026-10-28）＝目の足元の細密窓（1 セル）の被覆。末尾に足す＝前の欄の詰め順は不変（tests/frame-layout.mjs）
	nearP: vec4f,      // hasNear(0/1), nearEdgeFade(deg), 0, 0
};
@group(0) @binding(0) var<uniform> F: Frame;
${RAY}
@group(0) @binding(1) var elevTex: texture_2d<f32>;
@group(0) @binding(2) var elevSamp: sampler;
@group(0) @binding(3) var farElevTex: texture_2d<f32>;
@group(0) @binding(13) var csEnvTex: texture_cube<f32>;   // the model's specular environment (Cesium ImageBasedLighting.specularEnvironmentMaps, a prefiltered cube, mip = roughness; a dummy cube when none)
@group(0) @binding(14) var csEnvSamp: sampler;
@group(0) @binding(12) var nearElevTex: texture_2d<f32>;   // 近景層（elev() が静的参照＝bgl0/bglOvFrame の全レイアウトに必須・未使用は dummy）
// ユーザ COG（等経緯度整列 RGBA・geopbf/cog が warp 済み）。FRAME を含む全モジュールが宣言＝bgl0 が常に充足
// （未使用モジュールでは宣言だけ＝コスト無し）。bbox=[west,south,spanLon,spanLat] 絶対deg・p.x=has・行0=北＝v反転。
@group(0) @binding(4) var cogTex0: texture_2d<f32>;
@group(0) @binding(5) var<uniform> CG0: Cog0P;
// 見比べ（2 枚組・2026-10-27）＝p.y＝組か・p.z＝境の u・p.w＝半テクセル（gl/glsl.ts の COG と同式）
struct Cog0P { bbox: vec4f, p: vec4f };
fn cogPairV(uv: vec2f, p: vec4f) -> f32 {
	let v = 1.0 - uv.y;
	if (p.y < 0.5) { return v; }
	return clamp(v * 0.5, p.w, 0.5 - p.w) + select(0.0, 0.5, uv.x >= p.z);
}
fn cogTexMix0(col: vec3f, uv: vec2f) -> vec3f {
	if (CG0.p.x < 0.5) { return col; }
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return col; }
	let c = textureSampleLevel(cogTex0, elevSamp, vec2f(uv.x, cogPairV(uv, CG0.p)), 0.0);
	return mix(col, c.rgb, c.a);
}
// 地面アトラス（RTT ドレープ・2026-09-21）：ラスタ基図→ベクタ塗り（3D 時）→ラスタ重ね を renderer が 3 段窓（近/中/遠・前乗算）へ合成し、
// COG と同じ場所で画素標本化（地形面そのものに写る）。行0＝北（WebGPU のレンダーターゲット）＝v 反転。3 枚とも無条件に標本化してから選ぶ（uniformity）。
@group(0) @binding(6) var gndTex0: texture_2d<f32>;
@group(0) @binding(7) var gndTex1: texture_2d<f32>;
@group(0) @binding(8) var gndTex2: texture_2d<f32>;
@group(0) @binding(9) var<uniform> GD0: GndP;
@group(0) @binding(10) var gndSamp: sampler;
@group(0) @binding(11) var gndTex3: texture_2d<f32>;
struct GndP { w0: vec4f, w1: vec4f, w2: vec4f, w3: vec4f, p: vec4f };   // w*=[W,S,spanLon,spanLat]・p.x=有効な窓の数（0..4・細かい順）
fn gndMix0(col: vec3f, uv0: vec2f, uv1: vec2f, uv2: vec2f, uv3: vec2f) -> vec3f {
	if (GD0.p.x < 0.5) { return col; }   // 地面アトラス無し＝標本化しない（perf plan P6・2026-09-27）。GD0 は var<uniform>＝一様な分岐＝以後の textureSample は合法。GL の gndMix と同順（旧＝4 本標本化してから捨てていた）
	let c0 = textureSample(gndTex0, gndSamp, vec2f(clamp(uv0.x, 0.0, 1.0), 1.0 - clamp(uv0.y, 0.0, 1.0)));
	let c1 = textureSample(gndTex1, gndSamp, vec2f(clamp(uv1.x, 0.0, 1.0), 1.0 - clamp(uv1.y, 0.0, 1.0)));
	let c2 = textureSample(gndTex2, gndSamp, vec2f(clamp(uv2.x, 0.0, 1.0), 1.0 - clamp(uv2.y, 0.0, 1.0)));
	let c3 = textureSample(gndTex3, gndSamp, vec2f(clamp(uv3.x, 0.0, 1.0), 1.0 - clamp(uv3.y, 0.0, 1.0)));
	// 窓の縁 4% はひとつ外の窓へクロスフェード＝解像度の段差を溶かす（gl/glsl.js gndMix と同式）
	let w0 = gndEdge(uv0);
	let w1 = select(0.0, gndEdge(uv1), GD0.p.x > 1.5);
	let w2 = select(0.0, gndEdge(uv2), GD0.p.x > 2.5);
	let w3 = select(0.0, gndEdge(uv3), GD0.p.x > 3.5);
	let c = mix(mix(mix(mix(vec4f(0.0), c3, w3), c2, w2), c1, w1), c0, w0);
	return col * (1.0 - c.a) + c.rgb;   // 前乗算＝over 合成
}
fn gndEdge(uv: vec2f) -> f32 {   // 窓内 1・縁 4% で 0 へ・外 0
	let d = min(uv, vec2f(1.0) - uv);
	return clamp(min(d.x, d.y) / 0.04, 0.0, 1.0);
}
// 描画役割毎の小物（renderer.js が役割別スロットに詰める）：
//   fill/line … p0 = (seaGate, lift(m・線の接地リフト。塗りは 3D では地面アトラス側＝未使用), 0, α)
//   terrain  … p0 = (land.rgb, 0)  p1 = (hypso.rgb, hypso量)  p2 = (1/hypso最大標高, 0, 0, 0)
//   building … p0 = (bldColor.rgb, 0)
//   contour  … p0 = (cColor.rgb, 主曲線間隔m)  p1 = (計曲線間隔m, 濃さ, 0, 0)
//   fill/line の層の画面効果（style 互換 S-P1-1/3/4/5・2026-10-22・gl の u_tr/u_blur/u_cj/u_dashP/u_dashI/u_patP/u_patK と同じ意味）＝
//   tr = (東 px, 南 px, 今の zoom の 1px の弧（度）, 破線でずらす md の列のずらし（CSS px・線分プールの語 6 が距離＝paintzoom.ts の層で 1 つの値）)  lx = (blur（px か半径の割合）, blur の種類 0 線/1 円, cj＝cap|join<<2|round(ml×8)<<4, patK＝模様の 1 度の px)
//   dashP = (周期 P, 線の区間の数（0＝破線でない）, 丸い端 1/0, floor(zoom) の px ÷ z24 の px)  dashI0/1 = 区間 [a,b]×4  patP = (原点の位相 x, y, 1/幅, 1/高さ・z＝0 で模様なし)
//   役割だけのスロット（paramBG）は全部 0＝今までの絵。層ごとの値は renderer の lxBind が別のスロットに詰める
struct DrawP { p0: vec4f, p1: vec4f, p2: vec4f, tr: vec4f, lx: vec4f, dashP: vec4f, dashI0: vec4f, dashI1: vec4f, patP: vec4f };
@group(1) @binding(0) var<uniform> P: DrawP;
const D2R: f32 = 0.017453292519943295;
// 層の *-translate（S-P1-4/5）：地面の上でずらす（gl FX_TR の trLL と同式）＝経度だけ cos φ で割る。P.tr.z＝0 で 0
fn trLL(ll: vec2f) -> vec2f { return vec2f(P.tr.x / max(cos(ll.y * D2R), 1e-3), -P.tr.y) * P.tr.z; }
// GPU の sin() は微小角で信用できない（glsl.js sinP と同一のテイラー切替）
fn sinP(x: f32) -> f32 {
	let x2 = x * x;
	return select(sin(x), x * (1.0 - x2 * (1.0 / 6.0) * (1.0 - x2 * (1.0 / 20.0))), abs(x) < 0.1);
}
fn cosP(x: f32) -> f32 { let s = sinP(0.5 * x); return 1.0 - 2.0 * s * s; }
// ── 楕円体（?ell=1・段階B）＝glsl.js と1:1：dlat（測地緯度差分）→dβ（更成緯度差分）の閉形式差分。
// 球＝F.ellTrig=vec4(0) で補正が厳密0。F.trig は β の三角を運ぶ（renderer packFrame が配る）。
const ELL_NU: f32 = 0.0016792203863837047;
const ELL_NU2: f32 = 0.0000014098905530233192;
const ELL_INV_R: f32 = 1.0033640898209764;
fn dBeta(dp: f32) -> f32 {
	if (F.ellP.x < 0.5) { return dp; }   // 球＝恒等を早期return（uniform分岐）＝補正の三角関数を毎頂点払わない
	let sd = sinP(dp); let cd = cosP(dp); let s2d = sinP(2.0 * dp); let c2d = cosP(2.0 * dp);
	return dp - 2.0 * ELL_NU  * (F.ellTrig.x * cd  - F.ellTrig.y * sd)  * sd
	          + 2.0 * ELL_NU2 * (F.ellTrig.z * c2d - F.ellTrig.w * s2d) * s2d;
}
// 標高の変位方向：球＝β動径（従来の dir）・楕円体＝測地法線の β空間像（glsl.js liftDir と同式）
fn liftDir(ll: vec2f, dir: vec3f) -> vec3f {
	if (F.ellP.x < 0.5) { return dir; }
	let p = ll.y * D2R; let l = ll.x * D2R; let cp = cos(p);
	return vec3f(cp * cos(l), sin(p) * ELL_INV_R, cp * sin(l));
}
// β→φ 復元（deg）＝レイキャスト系（asin=β）から elev() を引く時に通す。球=恒等（glsl.js geoLat と同式）
fn geoLat(betaDeg: f32) -> f32 {
	let b = betaDeg * D2R;
	return betaDeg + F.ellP.x * degrees(ELL_NU * sin(2.0 * b) + ELL_NU2 * sin(4.0 * b));
}
// 頂点3D − originPt を桁落ちなしで直接作る（cos(θ)-1=-2sin²(θ/2)）＝glsl.js deltaToRel と同式
// dlat は dBeta で β差分へ（球では恒等）＝以降は純粋な球面幾何（β単位球）
fn deltaToRel(dDeg: vec2f) -> vec3f {
	let da = dDeg.x * D2R; let db = dBeta(dDeg.y * D2R);
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
fn fogOf(w: vec3f) -> f32 {
	return clamp((distance(F.eye, w) - F.params.x) / max(F.params.y - F.params.x, 1e-6), 0.0, 1.0);
}
// クリップ z ← 対数深度（WebGPU z01）。GL 版 applyLogDepth の window 深度と同値
fn logDepthZ(w: f32) -> f32 {
	return log1pS(max(w, 1e-30)) * 1.4426950 * F.params.z * 0.5 * w;   // 1.0+w を f32 で作らない（下の log1pS）：目が数 m まで寄った 1 m 級の模型は表と裏が同じ深度になり裏が透けた（2026-10-28）
}
// 画素ごとの深度（frag_depth・#62）＝z_ndc＝logDepthZ(w)/w＝0.5·logCoef·log2(1+w)。1+w を f32 で作ると w が 1.2e-7（≈0.76m）刻みに量子化され、
// 画素ごとに書くと 0.76m の階段になる（AO が横縞の壁として見た＝実 GPU 2026-09-29）。log1p を級数で（AO の expm1s と対・w<0.1＝7 次・相対 1e-9）
fn log1pS(w: f32) -> f32 { if (w < 0.1) { return w * (1.0 - w * (0.5 - w * (0.33333334 - w * (0.25 - w * (0.2 - w * (0.16666667 - w * 0.14285715)))))); } return log(1.0 + w); }
fn fragDepthOf(w: f32) -> f32 { return log1pS(max(w, 1e-30)) * 1.4426950 * F.params.z * 0.5; }
// sRGB ⇄ リニア（#46 段 0）。模型の baseColor は rgba8unorm-srgb ビューで読む＝標本化の時点でリニア。照明の計算はリニアで、出口で符号化する。
// 出力面は素の bgra8/rgba8（sRGB ビューにしない＝基図・地形・建物は今までどおり表示空間の値をそのまま書く）。
fn srgbEncode(c: vec3f) -> vec3f {
	let x = max(c, vec3f(0.0));
	return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308));
}
fn srgbDecode(c: vec3f) -> vec3f {
	let x = max(c, vec3f(0.0));
	return select(pow((x + 0.055) / 1.055, vec3f(2.4)), x / 12.92, x <= vec3f(0.04045));
}
// ── PBR の部品（#46 段 2・2026-09-26）。単位は「原点で水平な白が 1」（CPU が E_ref で正規化＝自動露出）。
// 環境光＝空の放射輝度（段 1 と同じ散乱式・CPU で天球を積分）の SH9（照度の係数 A_l と 1/E_ref を CPU が畳み済み）＝局所系（x=東・y=北・z=上）で評価。
// 太陽＝F.sun.xyz（地球固定）・強さ lp.rgb（透過率込み・正規化）。夜（F.sun.w→0）は段 0 の固定光（局所系・北寄り 64°）へ連続に落とす（lp.w＝固定光の重み）。
// fill＝昼でも固定光を少し混ぜて陰の壁を読めるようにする（地図の読みやすさ・view.pbrFill・sh[0].w）。
const PBR_PI: f32 = 3.14159265;
fn pbrLocal(pos: vec3f) -> mat3x3f {   // 列＝東・北・上
	let up = normalize(pos);
	let e0 = cross(vec3f(0.0, 1.0, 0.0), up);
	let east = select(normalize(e0), vec3f(1.0, 0.0, 0.0), dot(e0, e0) < 1e-12);
	return mat3x3f(east, cross(up, east), up);
}
fn pbrSH(sh: array<vec4f, 9>, nl: vec3f) -> vec3f {   // 照度 E(n)/E_ref（実数 SH の基底・係数は CPU 側で A_l/E_ref 込み）
	let x = nl.x; let y = nl.y; let z = nl.z;
	return max(sh[0].xyz * 0.282095 + sh[1].xyz * (0.488603 * y) + sh[2].xyz * (0.488603 * z) + sh[3].xyz * (0.488603 * x)
		+ sh[4].xyz * (1.092548 * x * y) + sh[5].xyz * (1.092548 * y * z) + sh[6].xyz * (0.315392 * (3.0 * z * z - 1.0))
		+ sh[7].xyz * (1.092548 * x * z) + sh[8].xyz * (0.546274 * (x * x - y * y)), vec3f(0.0));
}
fn pbrFixed(nl: vec3f) -> f32 {   // 段 0 の固定光（局所系）＝屋根 0.9・陰の壁 0.62
	return 0.62 + 0.28 * clamp(dot(nl, normalize(vec3f(0.0, 0.44, 0.90))), 0.0, 1.0);
}
fn pbrEnvBRDF(F0: vec3f, rough: f32, nv: f32) -> vec3f {   // Karis の解析近似（LUT 無し）
	let r = rough * vec4f(-1.0, -0.0275, -0.572, 0.022) + vec4f(1.0, 0.0425, 1.04, -0.04);
	let a004 = min(r.x * r.x, exp2(-9.28 * nv)) * r.x + r.y;
	let AB = vec2f(-1.04, 1.04) * a004 + r.zw;
	return F0 * AB.x + AB.y;
}
// Cesium の模型の照明（@ortho-earth/cesium の setMeshLighting・2026-10-26）＝gl/glsl.ts csLit と同式：czm_pbrLighting（直接光）＋環境光（SH9 の拡散＋反射の向きの SH9 の鏡面・Karis の brdf 近似）
// → czm_pbrNeutralTonemapping → pow(1/2.2)。SH は Cesium の立方体図の系（x 東・y 上・z 南）＝局所系（東・北・上）から写す
fn csSH(sh: array<vec4f, 9>, n: vec3f) -> vec3f {
	let L = sh[0].xyz + sh[1].xyz * n.y + sh[2].xyz * n.z + sh[3].xyz * n.x + sh[4].xyz * (n.y * n.x) + sh[5].xyz * (n.y * n.z)
		+ sh[6].xyz * (3.0 * n.z * n.z - 1.0) + sh[7].xyz * (n.z * n.x) + sh[8].xyz * (n.x * n.x - n.y * n.y);
	return max(L, vec3f(0.0));
}
fn csTonemap(c0: vec3f) -> vec3f {
	let x = min(c0.r, min(c0.g, c0.b));
	let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
	var color = c0 - offset;
	let peak = max(color.r, max(color.g, color.b));
	if (peak < 0.76) { return color; }
	let dd = 0.24; let newPeak = 1.0 - dd * dd / (peak + dd - 0.76);
	color *= newPeak / peak;
	let g = 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0);
	return mix(color, vec3f(newPeak), g);
}
struct CsIn { base: vec3f, n: vec3f, pos: vec3f, v: vec3f, metallic: f32, rough: f32, ao: f32, emissive: vec3f, sunK: f32 };
fn csLit(i: CsIn, sh: array<vec4f, 9>, csL: vec4f, csC: vec4f, csI: vec4f) -> vec3f {   // base＝リニア。戻り＝表示空間（sRGB）
	let l = normalize(csL.xyz); let h = normalize(i.v + l);
	let M = pbrLocal(i.pos);
	let nl3 = transpose(M) * i.n; let rl3 = transpose(M) * reflect(-i.v, i.n);
	let nC = vec3f(nl3.x, nl3.z, -nl3.y); let rC = vec3f(rl3.x, rl3.z, -rl3.y);
	let diffuse = i.base * (1.0 - i.metallic); let f0 = mix(vec3f(0.04), i.base, i.metallic);
	let VdotH = clamp(dot(i.v, h), 0.0, 1.0); let NdotL = clamp(dot(i.n, l), 0.001, 1.0); let NdotV = clamp(dot(i.n, i.v), 0.0, 1.0); let NdotH = clamp(dot(i.n, h), 0.0, 1.0);
	let f90 = vec3f(clamp(max(f0.r, max(f0.g, f0.b)) * 25.0, 0.0, 1.0));
	let vs = 1.0 - VdotH; let F = f0 + (f90 - f0) * vs * vs * vs * vs * vs;
	let a = i.rough * i.rough; let a2 = a * a;
	let GGX = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2) + NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
	let G = select(0.0, 0.5 / GGX, GGX > 0.0);
	let f = (NdotH * a2 - NdotH) * NdotH + 1.0;
	let D = a2 / (PBR_PI * f * f);
	var color = ((vec3f(1.0) - F) * diffuse / PBR_PI + F * G * D) * NdotL * csC.rgb * i.sunK + i.emissive;
	let rr = i.rough * vec4f(-1.0, -0.0275, -0.572, 0.022) + vec4f(1.0, 0.0425, 1.04, -0.04);
	let a004 = min(rr.x * rr.x, exp2(-9.28 * NdotV)) * rr.x + rr.y;
	let AB = vec2f(-1.04, 1.04) * a004 + rr.zw;
	let f90i = max(vec3f(1.0 - i.rough), f0); let vn = 1.0 - NdotV; let Fn = f0 + (f90i - f0) * vn * vn * vn * vn * vn;
	let FssEss = Fn * AB.x + AB.y;
	let avgF = f0 + (vec3f(1.0) - f0) / 21.0; let Ems = 1.0 - AB.x - AB.y;
	let FmsEms = FssEss * avgF * Ems / (vec3f(1.0) - avgF * Ems);
	color += (csSH(sh, nC) * (FmsEms + (vec3f(1.0) - FssEss - FmsEms) * diffuse) * csI.x + select(csSH(sh, rC) * csC.w, textureSampleLevel(csEnvTex, csEnvSamp, rC, i.rough * csI.w).rgb, csI.z > 0.5) * FssEss * csI.y) * i.ao;
	return pow(max(csTonemap(color), vec3f(0.0)), vec3f(1.0 / 2.2));
}
struct PbrIn { base: vec3f, n: vec3f, pos: vec3f, v: vec3f, metallic: f32, rough: f32, ao: f32, sunK: f32, lp: vec4f, fill: f32 };
// 戻り＝リニアの放射輝度（正規化）。metallic 0・rough 1・ao 1＝拡散だけ（素の建物メッシュ）
fn pbrShade(i: PbrIn, sh: array<vec4f, 9>) -> vec3f {
	let M = pbrLocal(i.pos);
	let nl3 = transpose(M) * i.n;
	let s = F.sun.xyz;
	let nv = max(dot(i.n, i.v), 1e-4); let nl = max(dot(i.n, s), 0.0);
	let h = normalize(i.v + s); let nh = max(dot(i.n, h), 0.0); let vh = max(dot(i.v, h), 0.0);
	let F0 = mix(vec3f(0.04), i.base, i.metallic);
	let a = max(i.rough * i.rough, 0.002); let a2 = a * a;
	let dd = nh * nh * (a2 - 1.0) + 1.0;
	let D = a2 / (PBR_PI * dd * dd);
	let k = (i.rough + 1.0) * (i.rough + 1.0) / 8.0;
	let G = (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
	let Fr = F0 + (vec3f(1.0) - F0) * pow(1.0 - vh, 5.0);
	let spec = D * G * Fr / (4.0 * nv * nl + 1e-4);
	let kd = (vec3f(1.0) - Fr) * (1.0 - i.metallic);
	let sunE = i.lp.rgb * i.sunK;
	let Esky = pbrSH(sh, nl3) * i.ao;
	let r = reflect(-i.v, i.n);
	let envSpec = pbrSH(sh, transpose(M) * r) * pbrEnvBRDF(F0, i.rough, nv) * i.ao;
	let phys = kd * i.base * (nl * sunE + Esky) + PBR_PI * spec * nl * sunE + envSpec * (1.0 - i.metallic * 0.0);
	let wP = (1.0 - i.fill) * (1.0 - i.lp.w);   // 物理の重み＝昼×(1−fill)。残りは固定光
	return phys * wP + i.base * pbrFixed(nl3) * (1.0 - wP);
}
// 標高サンプラ（アトラス範囲内なら高さm・外は0）。窓の縁の edgeFade 込み＝glsl.js ELEV と同式。
// textureSampleLevel＝頂点/フラグメント両ステージで合法（暗黙 LOD 不要。mip 無し＝GL の texture() と同値）
fn elevFadeAt(uv: vec2f) -> f32 {
	if (F.elevP.z <= 0.0) { return 1.0; }
	let w = vec2f(F.elevP.z) / F.elevBounds.zw;
	return min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
}
// 遠景層＝近窓の縁は「0 へ落とす」でなく「遠層の値へ溶かす」（ズームインで近窓が縮んでも遠方の山が
// 消えない一般則）。遠層なし（farP.x=0）は elevFar=0 で従来式 near×fade に厳密一致＝挙動不変。glsl.js ELEV と同式。
fn elevFar(ll: vec2f) -> f32 {
	if (F.farP.x < 0.5) { return 0.0; }
	let uv = (ll - F.farBounds.xy) / F.farBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 0.0; }
	var f = 1.0;
	if (F.farP.y > 0.0) {   // 遠窓自身の縁は従来どおり 0 へフェード（その先は覆いが無い）
		let w = vec2f(F.farP.y) / F.farBounds.zw;
		f = min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
	}
	return textureSampleLevel(farElevTex, elevSamp, uv, 0.0).r * f;
}
// 近景層（near）＝近窓の内側に重ねる細密窓。縁は近窓の値へ溶かす（far の一般則の内側版）。無し（nearP.x=0）は base＝挙動不変。glsl.ts ELEV と同式
fn elevNear(ll: vec2f, base: f32) -> f32 {
	if (F.nearP.x < 0.5) { return base; }
	let uv = (ll - F.nearBounds.xy) / F.nearBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return base; }
	let w = vec2f(F.nearP.y) / F.nearBounds.zw;
	let f = min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
	return mix(base, textureSampleLevel(nearElevTex, elevSamp, uv, 0.0).r, f);
}
fn elev(ll: vec2f) -> f32 {
	if (F.elevP.y < 0.5) { return 0.0; }
	let uv = (ll - F.elevBounds.xy) / F.elevBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return elevFar(ll); }
	return elevNear(ll, mix(elevFar(ll), textureSampleLevel(elevTex, elevSamp, uv, 0.0).r, elevFadeAt(uv)));
}
// 案A（gl/glsl.js QELEV と 1:1）: 線・塗りのドレープ標高を「地形メッシュと同じ折れ線面」に量子化＝
// 同じ格子頂点で elev() を取り同じ三角形分割（対角 a-c-b / b-c-d）で補間＝描画されている面に厳密に乗る。
// fill系 slot は packFrame が F.mesh=近メッシュ窓・F.ellP.y=G を配る（地形なしは G=0＝素の elev()）。
fn elevQ(ll: vec2f) -> f32 {
	let G = F.ellP.y;
	if (G < 1.5) { return elev(ll); }
	// 近景層（順 1a）の窓の内側は近景メッシュパス（同じ単位格子を窓へ縮めた物）が地面＝その格子で量子化（主パスはそこを discard 済み・2026-10-28）
	var win = F.mesh;
	if (F.nearP.x > 0.5) { let gn = (ll - F.nearBounds.xy) / F.nearBounds.zw; if (gn.x >= 0.0 && gn.x <= 1.0 && gn.y >= 0.0 && gn.y <= 1.0) { win = F.nearBounds; } }
	let g = (ll - win.xy) / win.zw;
	if (g.x < 0.0 || g.x > 1.0 || g.y < 0.0 || g.y > 1.0) { return elev(ll); }
	let N = G - 1.0;
	let gc = min(g * N, vec2f(N - 1e-4));
	let gi = floor(gc);
	let gf = gc - gi;
	let st = win.zw / N;
	let b0 = win.xy + gi * st;
	let h00 = elev(b0);
	let h10 = elev(b0 + vec2f(st.x, 0.0));
	let h01 = elev(b0 + vec2f(0.0, st.y));
	let h11 = elev(b0 + st);
	if (gf.x + gf.y < 1.0) { return h00 + gf.x * (h10 - h00) + gf.y * (h01 - h00); }
	return h11 + (1.0 - gf.x) * (h01 - h11) + (1.0 - gf.y) * (h10 - h11);
}
`;

// ?gndfast=0 の逃げ道（perf plan P6）＝gndMix0 を旧順序（4 本標本化してから GD0.p.x で捨てる）へ機械変換する。renderer の mkMod が rOpts.gndFast===false の時だけ通す。
// 変換漏れ（原本の書式が変わった）は例外で知らせる＝黙って新順序のまま走らない
const GND_FAST_HEAD = "\tif (GD0.p.x < 0.5) { return col; }   // 地面アトラス無し＝標本化しない（perf plan P6・2026-09-27）。GD0 は var<uniform>＝一様な分岐＝以後の textureSample は合法。GL の gndMix と同順（旧＝4 本標本化してから捨てていた）\n";
const GND_SAMPLE_TAIL = "\tlet c3 = textureSample(gndTex3, gndSamp, vec2f(clamp(uv3.x, 0.0, 1.0), 1.0 - clamp(uv3.y, 0.0, 1.0)));\n";
export function gndMixSlow(code: string): string {
	if (!code.includes("fn gndMix0(")) return code;   // FRAME を含まないモジュール（AO・深度の書き出し等）はそのまま
	if (!code.includes(GND_FAST_HEAD) || !code.includes(GND_SAMPLE_TAIL)) throw new Error("gndMixSlow: rewrite markers missing = the gndMix0 source format changed");   // runtime 文字列は英語（verify:regionless の和文の爪車）
	return code.replace(GND_FAST_HEAD, "").replace(GND_SAMPLE_TAIL, GND_SAMPLE_TAIL + "\tif (GD0.p.x < 0.5) { return col; }\n");
}

// 塗り（earcut 三角形・premultiplied）。FILL_VS/FILL_FS の移植：図郭外フォールバック水域（seaGate＝FS標高ゲート）。
// 直描きは 2D（地形なし）だけ＝3D の塗りは地面アトラスへ焼く（ATLAS_FILL_WGSL・2026-09-21）。かつての標高ドレープ・
// 水面リフト・水域の厳密対数深度（fsExact）は塗りには不要となり撤去。
export const FILL_WGSL = /* wgsl */`
${FRAME}
struct FillOut {
	@builtin(position) pos: vec4f,
	@location(0) color: vec4f,
	@location(1) front: f32,
	@location(2) fog: f32,
	@location(3) ll: vec2f,
	@location(4) pat: vec2f,   // fill-pattern（S-P1-4/5）＝模様の px（原点からの差＝メルカトルの px・縦は中ほどの緯度の cos で割る）
	@location(5) cuv: vec2f,   // COG uv（F.cogP＝f64 前計算係数×原点相対 dLL）
	@location(6) guv0: vec2f,  // 地面アトラス uv（前景/近/中/遠＝F.gnd0..3・同じ前計算）
	@location(7) guv1: vec2f,
	@location(8) guv2: vec2f,
	@location(9) guv3: vec2f,
};
@group(1) @binding(1) var patTex: texture_2d<f32>;   // fill-pattern（S-P1-4/5）＝記号帳の画像 1 枚（repeat）・模様の無い層は 1×1 の透明
@group(1) @binding(2) var patSamp: sampler;
@vertex fn vs(@location(0) a_delta: vec2f, @location(1) a_color: vec4f) -> FillOut {
	var o: FillOut;
	let dLL = a_delta + trLL(F.origin + a_delta);   // fill-translate（S-P1-4/5）＝原点相対 delta をずらす（md は a_tile を足した後）
	o.pat = vec2f(dLL.x, -dLL.y / cos((F.origin.y + dLL.y * 0.5) * D2R)) * P.lx.w;
	let ll = F.origin + dLL;                  // elev 参照用の絶対（粗くて可）
	let rel = deltaToRel(dLL);                // 頂点3D − 原点3D（小・正確）
	let dir = F.originPt + rel;               // 絶対単位球点（front/fog 用＝粗くて可）
	var p = F.clipT + F.mvp * vec4f(rel, 0.0);   // RTE：mvp*[w,1] を相殺なしで（海抜0の球面）
	p.z = logDepthZ(p.w);
	o.pos = p;
	o.color = a_color;
	o.front = select(dot(dir, F.eye) - 1.0, 1.0, dot(F.eye, F.eye) < 1.0);
	o.fog = fogOf(dir);
	o.ll = ll;
	o.cuv = F.cogP.xy + dLL * F.cogP.zw;
	o.guv0 = F.gnd0.xy + dLL * F.gnd0.zw;
	o.guv1 = F.gnd1.xy + dLL * F.gnd1.zw;
	o.guv2 = F.gnd2.xy + dLL * F.gnd2.zw;
	o.guv3 = F.gnd3.xy + dLL * F.gnd3.zw;
	return o;
}
fn fillColor(in0: FillOut) -> vec4f {
	var in = in0;
	// 霧はフェードアウト（透明化）＝地平線の先の塗りが空に浮かない（glsl.js FILL_FS と同式）
	// ×P.p0.w＝グローバルα（シーン差し替えクロスフェード用。通常は1）
	var af = in.color.a * clamp(1.0 - 1.2 * in.fog, 0.0, 1.0) * P.p0.w;
	// 模様（S-P1-4/5）＝画像の色と α（MapLibre と同じく fill-color は読まない・fill-opacity は掛ける）。画像は前乗算で届く。P は uniform＝標本化は一様な分岐
	let pt = textureSample(patTex, patSamp, fract((P.patP.xy + in.pat) * P.patP.zw));
	if (P.patP.z > 0.0) { af *= pt.a; in.color = vec4f(select(vec3f(0.0), pt.rgb / max(pt.a, 1e-6), pt.a > 0.0), in.color.a); }
	if (af <= 0.003) { discard; }
	return vec4f(mix(gndMix0(cogTexMix0(in.color.rgb, in.cuv), in.guv0, in.guv1, in.guv2, in.guv3), F.fogColor, in.fog) * af, af);   // ユーザ COG／地面アトラス（2D のラスタ重ね）＝塗りの上・線/建物/ラベルの下
}
@fragment fn fs(in: FillOut) -> @location(0) vec4f {
	if (in.front < -0.0015) { discard; }
	if (P.p0.x > 0.5 && elev(in.ll) > 0.0) { discard; }   // 図郭外＝陸は塗り残す（紙色+等高線に委ねる）
	return fillColor(in);
}
`;

// 線（capsule SDF・インスタンス6頂点）。LINE_VS/LINE_FS の移植：標高ドレープ（端点毎 df）＋接地リフト(P.p0.y)。
// corner=(end 0/1, side ±1) は頂点ステップ、p1/p2/color/half/off はインスタンスステップ。
// 端と継ぎ（S-P1-1）・破線（S-P1-3）・translate とぼかし（S-P1-4/5）は 2026-10-22 に gl の LINE_VARY／LINE_MAIN／LINE_FS から 1:1 で写した
// （層の値は P.lx/P.dashP/P.dashI/P.tr＝描く列の uniform）。基の署名は 6 属性（オーバーレイの線が使う）＝p0/p3/jf/dist は 0 の既定＝丸い端・丸い継ぎ・実線。
// 基図の classic は lineXWgsl（属性 6〜8 で前後の点と旗・距離）・md は mdLineWgsl（線分プールの隣のレコード）が LINEX の行を差し替える。
export const LINE_WGSL = /* wgsl */`
${FRAME}
struct LineOut {
	@builtin(position) pos: vec4f,
	@location(0) @interpolate(flat) a: vec2f,
	@location(1) @interpolate(flat) b: vec2f,
	@location(2) @interpolate(flat) halfw: f32,
	@location(3) sp: vec2f,
	@location(4) color: vec4f,
	@location(5) front: f32,
	@location(10) @interpolate(flat) ja: vec4f,   // 端 A の継ぎの切り口（二等分線）：点 xy・線分の側を向く法線 zw（S-P1-1）
	@location(11) @interpolate(flat) jb: vec4f,   // 端 B の同じ物
	@location(12) @interpolate(flat) jk: vec4f,   // 端の形 x＝A・y＝B（0 丸＝capsule・1 butt・2 square・3 miter・4 bevel・5 丸い継ぎ）・zw＝bevel の切り線の距離（符号＝外側の向き）
	@location(13) @interpolate(flat) dd: vec2f,   // 破線（S-P1-3）：始点の位相・線分の長さ（線幅の倍数）
	@location(14) @interpolate(flat) gp: vec2f,   // line-gradient（G-3）：始点・終点の進み（0..1）
	@location(6) fog: f32,
};
// 線の色の見本（G-3＝line-gradient の 256 段・RGBA8・前乗算しない）＝塗りの模様と同じ group(1) の binding 1/2（P.patP.x＝1 の層だけ読む・他は 1×1 の透明）。
// P.patP.x＝2 は line-pattern（G-4）＝模様の画像（塗りの模様と同じテクスチャ）・patP.y＝破線と同じ尺・patP.z＝層の line-opacity
@group(1) @binding(1) var ltTex: texture_2d<f32>;
@group(1) @binding(2) var ltSamp: sampler;
fn toScreen(c: vec4f) -> vec2f {
	let ndc = c.xy / c.w;
	return vec2f((ndc.x * 0.5 + 0.5) * F.viewport.x, (1.0 - (ndc.y * 0.5 + 0.5)) * F.viewport.y);
}
// 継ぎの 3 点を画面へ（高さは継ぎ目の高さで揃える＝継ぎ目を共有する 2 本の線分が同じ値を得る）。z＝1 なら有効（カメラの背後は 0）
fn jScr(p: vec2f, h: f32) -> vec3f {
	let rel = deltaToRel(p);
	let c = F.clipT + F.mvp * vec4f(rel + h * liftDir(F.origin + p, F.originPt + rel), 0.0);
	return vec3f(toScreen(c), select(1.0, 0.0, c.w <= 0.0));
}
struct LineEnd { k: f32, j: vec4f, bev: f32, ext: f32 };
// 端 1 つの形（gl LINE_VARY の lineEnd と同式＝MapLibre の LineBucket と同じ選び方）。x→jt→y＝前の点・この端・次の点（start＝始点の端）。
// link＝0：端（line-cap）・1：隣と継ぐ・2：閉じた環の継ぎ目（隣が並びの前後に無い＝丸に倒す）。
// 継ぎは二等分線で切る：j＝切り口（点・線分の側を向く法線）・bev＝bevel の切り線・ext＝四角形を端から伸ばす長さ
fn lineEnd(x: vec2f, jt: vec2f, y: vec2f, h: f32, hp: f32, start: bool, link: u32) -> LineEnd {
	let cj = u32(P.lx.z);
	let capK = cj & 3u; let joinK = (cj >> 2u) & 3u; let ml = f32(cj >> 4u) / 8.0;
	var r: LineEnd; r.k = 0.0; r.j = vec4f(0.0); r.bev = 0.0; r.ext = hp + 1.0;
	if (link == 0u) {   // 端
		if (capK == 1u) { r.ext = 1.0; r.k = 1.0; return r; }   // butt＝端で切る（AA の 1px だけ伸ばす）
		r.k = select(0.0, 2.0, capK == 2u); return r;
	}
	if (link == 2u) { return r; }
	let sx = jScr(x, h); let sj = jScr(jt, h); let sy = jScr(y, h);
	var d0 = sj.xy - sx.xy; var d1 = sy.xy - sj.xy;
	let l0 = length(d0); let l1 = length(d1);
	if (sx.z * sj.z * sy.z < 0.5 || l0 < 1e-4 || l1 < 1e-4) { return r; }   // カメラの背後・画面で長さ 0＝丸（capsule）に倒す
	d0 = d0 / l0; d1 = d1 / l1;
	let sv = d0 + d1; let ls = length(sv);
	if (ls < 1e-3) { return r; }   // 折り返し（180°）＝丸に倒す
	let n = sv / ls;               // 二等分線の法線（前→次の向き）
	let N = select(-n, n, start);  // 線分の側を向く
	r.j = vec4f(sj.xy, N);
	if (joinK == 0u) { r.k = 5.0; return r; }
	let c = dot(n, d1); let mlen = 1.0 / max(c, 1e-6);   // 曲がりの半角の cos・マイターの長さ（半幅の何倍）
	r.bev = sign(dot(d0 - d1, vec2f(-N.y, N.x))) * hp * c;   // 外の角どうしを結ぶ線＝二等分線の点から外へ hp·c
	// miter は限界を超えたら bevel・bevel は限界未満なら miter（見分けられない＝MapLibre と同じ）
	if (r.bev == 0.0 || select(mlen < ml, mlen <= ml, joinK == 1u)) { r.ext = hp * max(1.0, sqrt(max(mlen * mlen - 1.0, 0.0))) + 1.0; r.k = 3.0; return r; }
	r.k = 4.0; return r;
}
@vertex fn vs(
	@location(0) corner: vec2f,
	@location(1) p1: vec2f, @location(2) p2: vec2f,
	@location(3) col: vec4f, @location(4) halfPx: f32, @location(5) offT: vec3f,
) -> LineOut {
	var o: LineOut;
	var hw0 = halfPx; var off0 = offT; var q1 = p1; var q2 = p2;
	o.gp = select(vec2f(0.0), vec2f(col.x + col.y * 256.0, col.z + col.w * 256.0) * (255.0 / 65535.0), P.patP.x > 0.5 && P.patP.x < 1.5);   // line-gradient（G-3）＝色の語の 4 バイト → unorm16×2（gl LINE_MAIN と同式）
	var q0 = p1; var q3 = p2; var jf0 = 0u; var dist0 = 0.0;   // LINEX：端と継ぎの相手の点と旗・破線の距離（classic の X 派生と md の派生が差し替える）
	if (P.tr.z != 0.0) { let tr = trLL(F.origin + q1); q0 += tr; q1 += tr; q2 += tr; q3 += tr; }   // line-translate（S-P1-4/5）＝線分ごとに同じだけ（継ぎの相手も）
	let la1 = F.origin + q1; let la2 = F.origin + q2;   // elev 参照用の絶対（粗くて可）
	let rela = deltaToRel(q1); let relb = deltaToRel(q2);
	let da = F.originPt + rela; let db = F.originPt + relb;
	// 標高変位は地形と同じ距離フェード＝遠景の平ら化に追随（無いと地平線に「漂う点線の鎖」）
	let dfa = 1.0 - smoothstep(F.params.y * 0.8, F.params.y * 2.0, distance(F.eye, da));
	let dfb = 1.0 - smoothstep(F.params.y * 0.8, F.params.y * 2.0, distance(F.eye, db));
	let ha = (elevQ(la1) + P.p0.y) * F.elevP.x * dfa;   // 案A
	let hb = (elevQ(la2) + P.p0.y) * F.elevP.x * dfb;
	let relWa = rela + ha * liftDir(la1, da); let relWb = relb + hb * liftDir(la2, db);   // 楕円体＝測地法線
	let wa = F.originPt + relWa; let wb = F.originPt + relWb;
	let ca = F.clipT + F.mvp * vec4f(relWa, 0.0);
	let cb = F.clipT + F.mvp * vec4f(relWb, 0.0);
	let fa = dot(da, F.eye) - 1.0; let fb = dot(db, F.eye) - 1.0;
	if (ca.w <= 0.0 || cb.w <= 0.0) {        // カメラ背後（var o はゼロ初期化済）
		o.front = -1.0; o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o;
	}
	var sa = toScreen(ca); var sb = toScreen(cb);
	let d = sb - sa; let len = length(d);
	var dirS = vec2f(1.0, 0.0);
	if (len > 1e-6) { dirS = d / len; }
	let perp = vec2f(-dirS.y, dirS.x);   // 画面は y 下向き＝進行方向の右
	// line-offset（#49・glsl.js LINE_MAIN と同式）：端点を perp＋dir×t だけ（t＝角の継ぎ）
	let offPx = off0.x * F.params.w;
	sa += (perp + dirS * off0.y) * offPx; sb += (perp + dirS * off0.z) * offPx;
	let hw = hw0 * F.params.w + 1.0;      // +1px の AA/丸端余白
	// 端と継ぎ（S-P1-1）：丸でない層（P.lx.z≠0）だけ端ごとに形を決め、四角形を端から伸ばす長さ（eA・eB）を変える
	var eA = hw; var eB = hw;
	o.ja = vec4f(0.0); o.jb = vec4f(0.0); o.jk = vec4f(0.0);
	if (P.lx.z > 0.5) {
		let hp = hw0 * F.params.w;
		let lA = select(select(0u, 2u, (jf0 & 4u) != 0u), 1u, (jf0 & 1u) != 0u);   // JF_PREV／JF_RING_PREV（build.ts）
		let lB = select(select(0u, 2u, (jf0 & 8u) != 0u), 1u, (jf0 & 2u) != 0u);   // JF_NEXT／JF_RING_NEXT
		let ra = lineEnd(q0, q1, q2, ha, hp, true, lA);
		let rb = lineEnd(q1, q2, q3, hb, hp, false, lB);
		o.ja = ra.j; o.jb = rb.j; o.jk = vec4f(ra.k, rb.k, ra.bev, rb.bev); eA = ra.ext; eB = rb.ext;
	}
	// 破線（S-P1-3）：模様の位相は地面の長さ（z24 の px）を floor(zoom) の px にして線幅で割る＝MapLibre の tileRatio／floorwidth と同じ。
	// 線分の長さは経緯度から（縦は中点の緯度のメルカトル＝scene.ts の segLen24 と同式）
	o.dd = vec2f(0.0);
	if (P.dashP.y > 0.5 || P.patP.x > 1.5) {   // line-pattern（G-4）の横の位相も同じ（尺は P.patP.y）
		let my = (q2.y - q1.y) * D2R / cos((F.origin.y + (q1.y + q2.y) * 0.5) * D2R) / 6.2831853;
		o.dd = vec2f(dist0, length(vec2f((q2.x - q1.x) / 360.0, my)) * 4294967296.0) * (select(P.patP.y, P.dashP.w, P.dashP.y > 0.5) / max(2.0 * hw0, 1e-3));
	}
	var base = sb; var capSign = 1.0; var ext = eB;
	if (corner.x < 0.5) { base = sa; capSign = -1.0; ext = eA; }
	let posS = base + perp * (hw * corner.y) + dirS * (capSign * ext);
	o.a = sa; o.b = sb; o.halfw = hw0 * F.params.w; o.sp = posS;
	o.color = col; o.front = min(fa, fb);
	o.fog = fogOf((wa + wb) * 0.5);
	// 端点の深度は対数系＝地形・建物と同じ深度空間（山岳ビューで尾根の向こうを遮蔽）
	let wz = select(cb.w, ca.w, corner.x < 0.5);
	let ndc = vec2f(posS.x / F.viewport.x * 2.0 - 1.0, 1.0 - posS.y / F.viewport.y * 2.0);
	o.pos = vec4f(ndc, log1pS(max(wz, 1e-30)) * 1.4426950 * F.params.z * 0.5, 1.0);
	return o;
}
// 端の先の覆い（S-P1-1）：k＝端の形（jk）・e＝端からの距離（先へ正）・q＝端からの位置・j＝切り口・bev＝bevel の切り線。丸い形の時だけ dist（芯からの距離）を端の点からの距離に替える
fn lineTail(k: f32, e: f32, q: vec2f, j: vec4f, bev: f32, hw: f32, dist: ptr<function, f32>) -> f32 {
	if (k == 0.0 || k == 5.0) { *dist = length(q); return 1.0; }   // 丸い端・丸い継ぎ
	if (k == 1.0) { return clamp(0.5 - e * 2.0, 0.0, 1.0); }          // butt＝端で切る
	if (k == 2.0) { return clamp((hw - e) * 2.0 + 0.5, 0.0, 1.0); }   // square＝半幅だけ出す
	if (k == 4.0) { return clamp((abs(bev) - sign(bev) * dot(q, vec2f(-j.w, j.z))) * 2.0 + 0.5, 0.0, 1.0); }   // bevel＝外の角どうしを結ぶ線で切る
	return 1.0;   // miter＝切り口まで伸ばした帯そのもの
}
@fragment fn fs(in: LineOut) -> @location(0) vec4f {
	if (in.front < -0.0015) { discard; }
	let pa = in.sp - in.a; let ba = in.b - in.a;
	var dist = 0.0; var cov = 1.0;
	if (in.jk.x == 0.0 && in.jk.y == 0.0) {   // 丸い端・丸い継ぎ＝capsule（線分までの距離）
		let t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
		dist = length(pa - ba * t);
	} else {   // 端と継ぎ（S-P1-1）：継ぎは二等分線の向こうを捨てる（隣の線分の受け持ち＝同じ線で切るので隙も重なりも無い）
		// 切り口は画素の中心（framebuffer 座標＝左上原点・y 下向き＝toScreen と同じ向き）で測る＝補間した sp の三角形ごとの丸めの差で継ぎ目に二度塗り・塗り残しを出さない。
		// 線の上の画素（ちょうど 0）は始点の側（次の線分）が取る＝終点の側は 0 も捨てる
		let fp = in.pos.xy;
		if (in.jk.x >= 3.0 && dot(fp - in.ja.xy, in.ja.zw) < 0.0) { discard; }
		if (in.jk.y >= 3.0 && dot(fp - in.jb.xy, in.jb.zw) <= 0.0) { discard; }
		let L = length(ba);
		if (L < 1e-3 && (in.jk.x == 1.0 || in.jk.x == 2.0)) { discard; }   // 長さ 0 の線分の角い端＝描かない（MapLibre は重なった点を捨てる）
		var dir = vec2f(1.0, 0.0);
		if (L > 1e-6) { dir = ba / L; }
		let u = dot(pa, dir);
		dist = abs(dot(pa, vec2f(-dir.y, dir.x)));
		let hw0 = max(in.halfw, 0.5);
		// 端の先の位置は、継ぎなら切り口の点から（両隣で同じ点）・端なら自分の端点から
		if (u < 0.0) { cov = lineTail(in.jk.x, -u, in.sp - select(in.a, in.ja.xy, in.jk.x >= 3.0), in.ja, in.jk.z, hw0, &dist); }
		else if (u > L) { cov = lineTail(in.jk.y, u - L, in.sp - select(in.b, in.jb.xy, in.jk.y >= 3.0), in.jb, in.jk.w, hw0, &dist); }
	}
	// 破線（S-P1-3）：画素の線に沿う位相 x を模様の周期に畳み、線の区間までの距離で切る。butt・square＝区間の端で切る（MapLibre の addRegularDash）・
	// round＝区間の芯からの距離を半幅で丸く切る（長さ 0 の線＝点・MapLibre の addRoundDash）。線分の外（端と継ぎ）は端点の位相のまま
	if (P.dashP.y > 0.5) {
		let Ls = length(ba);
		var k = 0.0;
		if (Ls > 1e-3) { k = in.dd.y / Ls; }   // 線幅の倍数／画素（地面の尺＝傾いた画面では縮む＝MapLibre と同じ）
		if (k > 1e-7) {
			var x = in.dd.x + clamp(dot(pa, ba / Ls), 0.0, Ls) * k;
			x -= P.dashP.x * floor(x / P.dashP.x);
			var s = -1e9;   // 線の区間までの符号つき距離（画素・内が正）
			for (var i = 0; i < 4; i++) {
				if (f32(i) >= P.dashP.y) { break; }
				var ab = P.dashI1.zw;
				if (i == 0) { ab = P.dashI0.xy; } else if (i == 1) { ab = P.dashI0.zw; } else if (i == 2) { ab = P.dashI1.xy; }
				for (var m = -1; m <= 1; m++) {
					let xm = x + f32(m) * P.dashP.x;
					if (P.dashP.z > 0.5) { s = max(s, -length(vec2f(max(max(ab.x - xm, xm - ab.y), 0.0) / k, dist))); }
					else { s = max(s, min(xm - ab.x, ab.y - xm) / k); }
				}
			}
			if (P.dashP.z > 0.5) { dist = -s; } else { cov *= clamp(s * 2.0 + 0.5, 0.0, 1.0); }
		}
	}
	// 細線のシャープ化（glsl.js LINE_FS と同式）：幾何幅±0.5px保証＋細さはカバレッジ・フェザー半減
	let hw = max(in.halfw, 0.5);
	var edge = clamp((hw - dist) * 2.0 + 0.5, 0.0, 1.0);
	// ぼかし（S-P1-4/5）：line-blur＝縁（＋半画素）から内へ blur＋1 画素で線形（MapLibre の blur2）・circle-blur＝半径の (1−blur) から縁へ smoothstep（MapLibre の circle）
	if (P.lx.x > 0.0) { edge = select(clamp((hw + 0.5 - dist) / (P.lx.x + 1.0), 0.0, 1.0), 1.0 - smoothstep(hw * (1.0 - P.lx.x), hw, dist), P.lx.y > 0.5); }
	let alpha = edge * cov * min(in.halfw * 2.0, 1.0);
	if (alpha <= 0.0) { discard; }
	// line-gradient（G-3・gl LINE_FS と同式）：画素の進み＝線分の上の位置で始点・終点の進みを補う → 見本の 256 段の真ん中を引く（Level＝一様な流れを要さない）
	var lc = in.color;
	if (P.patP.x > 1.5) {   // line-pattern（G-4・gl LINE_FS と同式）：横＝線に沿う位相（floor(zoom) の線幅の倍数）×画像の高さ÷幅、縦＝線の幅（右が下）。線分の外（端と継ぎ）は位相を延ばす＝隣の線分と続く。line-color は読まない
		let Ls = length(ba);
		var k = 0.0;
		if (Ls > 1e-3) { k = in.dd.y / Ls; }
		let ts = vec2f(textureDimensions(ltTex, 0));
		let x = in.dd.x + dot(pa, ba) / max(Ls, 1e-6) * k;
		let sd = select(0.0, dot(pa, vec2f(-ba.y, ba.x)) / max(Ls, 1e-6), Ls > 1e-6);
		let t = textureSampleLevel(ltTex, ltSamp, vec2f(fract(x * ts.y / ts.x), clamp(0.5 + sd / (2.0 * max(in.halfw, 0.5)), 0.5 / ts.y, 1.0 - 0.5 / ts.y)), 0.0);
		lc = vec4f(select(vec3f(0.0), t.rgb / max(t.a, 1e-6), t.a > 0.0), t.a * P.patP.z);
	} else if (P.patP.x > 0.5) { lc = textureSampleLevel(ltTex, ltSamp, vec2f(mix(in.gp.x, in.gp.y, clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0)) * (255.0 / 256.0) + 0.5 / 256.0, 0.5), 0.0); }
	let a = lc.a * alpha * clamp(1.0 - 1.2 * in.fog, 0.0, 1.0) * P.p0.w;   // p0.w＝クロスフェード×基図の濃さ
	if (a <= 0.003) { discard; }
	let ga = a * P.p0.w;   // ×グローバルα（クロスフェード用・通常1）
	return vec4f(mix(lc.rgb, F.fogColor, in.fog) * ga, ga);
}
`;

// 地形サーフェス（TERRAIN_VS/FS の移植）：標高変位した格子メッシュ・hillshade は FS per-pixel（前方差分・
// texel歩幅）・海〜低地は透明化・遠景は距離フェードで平ら化・標高ティント（hypso）。深度は書く（尾根の遮蔽）。
// 全球ハイプソ（gl/glsl.js WORLD_HYPSO の1:1移植・純関数＝バインド無し）：標高×気候の cross-blend。
// clim＝気候場テクスチャの (乾燥度, 極地) サンプル値（呼び出し側が自前バインドで引く）。hasClim=0 は
// 緯度近似フォールバック（気候場未着の1-2フレーム用）。逆順 smoothstep は 1-smoothstep(正順) へ書換済（WGSL未定義）。
const WORLD_HYPSO_WGSL = /* wgsl */`
// テーマパレット（正準既定＝worldpal.js・view.worldHypso で部分上書き）。struct はここ・var<uniform> WP は
// 注入先モジュールが自分の group/binding で宣言（globe=group(0)binding(4)・terrain=group(2)binding(2)＝同一バッファ）。
// vec3 は align16 の踏み抜き防止で全部 vec4f（rgb のみ使用・grat だけ w=α係数）＝10×vec4f=160B
struct WorldPal {
	lowHumid: vec4f, lowArid: vec4f,   // 低地 湿潤/乾燥
	midHumid: vec4f, midArid: vec4f,   // 〜400m 湿潤/乾燥
	ramp1: vec4f, ramp2: vec4f, peak: vec4f, snow: vec4f,   // 400-1300 / 1300-2800 / 2800-4800 / 氷床
	belowSea: vec4f,   // wdepr 専用＝海面下の締め（乗算ティント）
	grat: vec4f,       // レチクル rgb＋α係数
};
fn wetBox(ll: vec2f, b: vec4f) -> f32 {   // b=(lon0,lon1,lat0,lat1)・縁3°ソフト
	return smoothstep(b.x - 3.0, b.x + 3.0, ll.x) * (1.0 - smoothstep(b.y - 3.0, b.y + 3.0, ll.x))
	     * smoothstep(b.z - 3.0, b.z + 3.0, ll.y) * (1.0 - smoothstep(b.w - 3.0, b.w + 3.0, ll.y));
}
fn worldHypsoColor(e: f32, ll: vec2f, clim: vec2f, hasClim: f32) -> vec3f {
	let latD = ll.y;
	var arid: f32; var pol: f32;
	if (hasClim > 0.5) {
		arid = clim.x; pol = clim.y;
	} else {
		let al = abs(latD);
		arid = smoothstep(10.0, 17.0, al) * (1.0 - smoothstep(32.0, 45.0, al));
		var wet = wetBox(ll, vec4f(95.0, 148.0, 17.0, 40.0));
		wet = max(wet, wetBox(ll, vec4f(118.0, 150.0, 40.0, 55.0)));
		wet = max(wet, wetBox(ll, vec4f(-100.0, -70.0, 24.0, 40.0)));
		wet = max(wet, wetBox(ll, vec4f(-63.0, -35.0, -35.0, -15.0)));
		wet = max(wet, wetBox(ll, vec4f(74.0, 95.0, 8.0, 30.0)));
		arid = arid * (1.0 - wet);
		pol = 1.0 - smoothstep(-64.0, -58.0, latD);
	}
	let lowc = mix(WP.lowHumid.rgb, WP.lowArid.rgb, arid);
	let midc = mix(WP.midHumid.rgb, WP.midArid.rgb, arid);
	var c = mix(lowc, midc, smoothstep(0.0, 400.0, e));
	c = mix(c, WP.ramp1.rgb, smoothstep(400.0, 1300.0, e));
	c = mix(c, WP.ramp2.rgb, smoothstep(1300.0, 2800.0, e));
	c = mix(c, WP.peak.rgb, smoothstep(2800.0, 4800.0, e));
	let snow = pol + smoothstep(56.0, 62.0, latD) * smoothstep(1100.0, 1900.0, e);
	c = mix(c, WP.snow.rgb, clamp(snow, 0.0, 1.0));
	return mix(c, vec3f(dot(c, vec3f(0.299, 0.587, 0.114))), 0.10);
}
fn climUV(ll: vec2f) -> vec2f { return vec2f(fract(ll.x / 360.0 + 0.5), 0.5 - ll.y / 180.0); }   // 経度は一周で折り返す（原点相対の経度は ±180 を越えうる）
`;

export const TERRAIN_WGSL = /* wgsl */`
${FRAME}
// 地面の照明（setGroundLighting・Cesium の globe.enableLighting・2026-10-26）：経緯度（deg）の点の東・北・上（世界軸＝ECEF の (x, z, y)）での lambert。
//   cg＝xyz 光へ向く単位ベクトル（世界）・w 0 無し／1 地形の法線（gEN＝勾配 東・北 m/m）／2 楕円体の上向き。cgP＝(倍率, 足す値, 効き 0..1＝距離のフェード済み, 大気の夜側の明るさ)
fn cgLambert(ll: vec2f, gEN: vec2f, cg: vec4f, cgP: vec4f) -> f32 {
	let lr = ll * 0.017453292519943295;
	let cl = cos(lr.y); let sl = sin(lr.y); let co = cos(lr.x); let so = sin(lr.x);
	let L = vec3f(dot(cg.xyz, vec3f(-so, 0.0, co)), dot(cg.xyz, vec3f(-sl * co, cl, -sl * so)), dot(cg.xyz, vec3f(cl * co, sl, cl * so)));
	let n = select(normalize(vec3f(-gEN, 1.0)), vec3f(0.0, 0.0, 1.0), cg.w > 1.5);
	let diff = clamp(max(dot(n, L), 0.0) * cgP.x + cgP.y, 0.0, 1.0);
	return mix(1.0, diff, cgP.z);
}
${WORLD_HYPSO_WGSL}
${CS_ATMO_WGSL}
// 気候場（全球ハイプソの cross-blend）＝terrain 専用 group(2)。未着は dummy（hasClim=P.p2.z=0 で不使用）
@group(2) @binding(0) var climTex: texture_2d<f32>;
@group(2) @binding(1) var climSamp: sampler;
@group(2) @binding(3) var gmRamp: texture_2d<f32>;   // 地面の材質のランプ（n×1・無ければ dummy＝P.tr.x=0 で不使用）
${GM_WGSL("gmColor", "gmRamp", "climSamp")}
@group(2) @binding(2) var<uniform> WP: WorldPal;   // 世界パレット＝globe 側 binding(4) と同一バッファ（同色契約）
struct TerrOut {
	@builtin(position) pos: vec4f,
	@location(0) ll: vec2f,
	@location(1) front: f32,
	@location(2) fog: f32,
	@location(3) h: f32,
	@location(4) cuv: vec2f,   // COG uv（terrain slot の F.cogP＝メッシュ窓→bbox の f64 前計算係数×a_uv）
	@location(5) guv0: vec2f,  // 地面アトラス uv（前景/近/中/遠＝F.gnd0..3）
	@location(6) guv1: vec2f,
	@location(7) guv2: vec2f,
	@location(12) csFog: vec4f,   // Cesium の霧（頂点で色と量・csFogV）＝派生（影 9・切り抜き 10〜11・cw 15）と重ならない番号
	@location(8) guv3: vec2f,
};
// 画素の地上寸法(m)の目安＝緯度の画面微分（fwidth＝x/y 両方向の和・方位に依らず拾う）。経度は使わない：
// 絶対経度の f32 刻み（135°で 1.7m）が深ズームの画素と同オーダー＝揺れる。緯度は 0.4m 刻み・深ズームは下限 2m に埋もれる
fn terrMpp(ll: vec2f) -> f32 { return fwidth(ll.y) * 111320.0; }
@vertex fn vs(@location(0) a_uv: vec2f) -> TerrOut {
	var o: TerrOut;
	let a_ll = F.mesh.xy + F.mesh.zw * a_uv;   // 単位格子 uv→絶対 lon/lat（頂点属性でなく uniform 窓＝窓替えで作り直さない）
	let dDeg = a_ll - F.origin;               // 原点相対 (deg)。renderer は main シーン原点を渡す
	let rel = deltaToRel(dDeg);
	let dir = F.originPt + rel;
	// 遠景は変位を距離フェードで平ら化＝grazing で粗い格子が縦壁に見えるのを消す（glsl.js と同式）
	let df = 1.0 - smoothstep(F.params.y * 0.8, F.params.y * 2.0, distance(F.eye, dir));
	let h = elev(a_ll) * df;
	o.h = h;
	o.ll = a_ll;
	o.cuv = F.cogP.xy + a_uv * F.cogP.zw;
	o.guv0 = F.gnd0.xy + a_uv * F.gnd0.zw;
	o.guv1 = F.gnd1.xy + a_uv * F.gnd1.zw;
	o.guv2 = F.gnd2.xy + a_uv * F.gnd2.zw;
	o.guv3 = F.gnd3.xy + a_uv * F.gnd3.zw;
	let relW = rel + (h * F.elevP.x) * liftDir(a_ll, dir);   // 楕円体＝測地法線
	o.front = select(dot(dir, F.eye) - 1.0, 1.0, dot(F.eye, F.eye) < 1.0);
	o.fog = fogOf(F.originPt + relW);
	o.csFog = csFogV(F.eye * CS_R, (F.originPt + relW) * CS_R, F.farP.w, F.cg.xyz, select(-1.0, 1.0, F.cg.w > 0.5 && F.cgP.w >= 0.0));
	var p = F.clipT + F.mvp * vec4f(relW, 0.0);
	p.z = logDepthZ(p.w);
	o.pos = p;
	return o;
}
@fragment fn fs(in: TerrOut) -> @location(0) vec4f {
	let mpp = terrMpp(in.ll);   // 画素の地上寸法(m)＝下の低地フェード帯の上端。微分は discard より前（一様制御フロー）
	if (in.front < -0.0015) { discard; }   // 接線より少し先まで許容＝地平線に頭を出す高山。遮蔽は深度とフォグ
	if (F.farP.z > 0.5 && F.farP.z < 1.5) {   // 遠景メッシュパス：近窓の内側は近メッシュの担当＝discard（縁の連続は elev() が保証）
		let uvN = (in.ll - F.elevBounds.xy) / F.elevBounds.zw;
		if (uvN.x >= 0.0 && uvN.x <= 1.0 && uvN.y >= 0.0 && uvN.y <= 1.0) { discard; }
	}
	if (F.farP.z < 0.5 && F.nearP.x > 0.5) {   // 主パス：近景層の窓の内側は近景メッシュパス（farP.z=2）の担当＝discard（縁の連続は elevNear の溶かし）
		let uvF = (in.ll - F.nearBounds.xy) / F.nearBounds.zw;
		if (uvF.x >= 0.0 && uvF.x <= 1.0 && uvF.y >= 0.0 && uvF.y <= 1.0) { discard; }
	}
	// 海〜低地は地形を透明化し海岸線は精細なベクタに委ねる（粗いメッシュの海岸の崖・平野ノイズを消す）。
	// 帯の上端＝画素 2 個分の標高（1〜100m）：透けた先は海抜0の球の床（同じ地面アトラスを貼る）＝チルトで
	// h·tanθ ずれた二重像になる（京都 40m×60° で堀が 70m ずれて水色の四角が浮く）。ずれが 2px 未満の高さでだけ透かす＝
	// 低ズーム（1px≧50m）は従来の 1〜100m のまま・寄るほど帯が縮む。gl/glsl.js TERRAIN_FS と同式。
	let t = smoothstep(1.0, clamp(2.0 * mpp, 2.0, 100.0), in.h);
	if (t <= 0.0) { discard; }
	// 北西光の hillshade（前方差分）。歩幅＝アトラス1texel（下限0.004°≈R10 texel＝遠層域の歩幅としても妥当）
	let tsz = vec2f(textureDimensions(elevTex, 0));
	var d = max(0.004, F.elevBounds.w / tsz.y);
	var dTex = F.elevBounds.w / tsz.y;   // アトラス 1 texel（勾配・材質用）
	var shadeK = 1.0;
	if (F.farP.z > 1.5) {   // 近景メッシュパス：歩幅は近景層の 1 texel（下限 0.004° を外す）・陰影の利得は歩幅比で揃える（gl と同式）
		dTex = F.nearBounds.w / f32(textureDimensions(nearElevTex, 0).y);
		shadeK = 0.004 / max(dTex, 1e-6); d = dTex;
	}
	let h0 = elev(in.ll);
	let hx = elev(in.ll + vec2f(d, 0.0)) - h0;
	let hy = elev(in.ll + vec2f(0.0, d)) - h0;
	var shade = clamp(0.82 + (-hx + hy) * 0.0007 * shadeK, 0.45, 1.15);
	var cgK = 1.0;   // 地面の照明（Cesium）＝北西の陰影の代わりに太陽の lambert を画像ごと掛ける
	let gmDh = fwidth(h0);   // 地面の材質の等高線＝標高の画素差（一様な制御の流れで）
	var gmEN = vec2f(0.0);   // 勾配（東・北 m/m）＝地面の照明と材質（傾斜・方位）が使う。アトラスの 1 texel 差分（陰影の 0.004° の下限を使わない＝近景の急斜面が鈍らない）
	if (F.cg.w > 0.5 || P.tr.x > 1.5) {
		let dL = dTex; let hxL = elev(in.ll + vec2f(dL, 0.0)) - h0; let hyL = elev(in.ll + vec2f(0.0, dL)) - h0;
		gmEN = vec2f(hxL / (dL * 111320.0 * max(cos(in.ll.y * 0.017453292519943295), 0.01)), hyL / (dL * 111320.0));
	}
	if (F.cg.w > 0.5) { shade = 1.0; cgK = cgLambert(in.ll, gmEN, F.cg, F.cgP); }
	// 標高ティント：land を高所ほど hypso 色へ寄せる（テーマのノブ・未指定は量0で恒等）。陰影の前
	var landC = mix(P.p0.rgb, P.p1.rgb, clamp(h0 * P.p2.x, 0.0, 1.0) * P.p1.w);
	// 全球ハイプソ（低ズーム帯・p2.y=出現度/p2.z=hasClim）＝globe パスと同色でピッチ不変（gl 側と同式）
	if (P.p2.y > 0.001) {
		let clim = textureSampleLevel(climTex, climSamp, climUV(in.ll), 0.0).rg;
		landC = mix(landC, worldHypsoColor(h0, in.ll, clim, P.p2.z), P.p2.y);
	}
	// 陰影の立ち上がりは従来の 1〜100m 帯のまま（低地＝陰影なしの紙色）：不透明化した分（t≧tS）を「床と同色＝陰影なし」で埋める
	// ＝ t·X + (1−t)·床 が旧 tS·地形 + (1−tS)·床 と一致（床≈landC）。低ズーム（t＝tS）は旧式と恒等
	let tS = smoothstep(1.0, 100.0, in.h);
	var colBase = gndMix0(cogTexMix0(landC * mix(1.0, shade, min(tS / t, 1.0)), in.cuv), in.guv0, in.guv1, in.guv2, in.guv3);
	if (P.tr.x > 0.5) { let m = gmColor(h0, gmEN, gmDh, P.tr, P.lx, P.dashP); colBase = mix(colBase, m.rgb, m.a); }   // 地面の材質（Cesium の globe.material）＝画像の上・照明の下
	if (F.cg.w > 0.5) { colBase *= F.cgC.rgb * cgK; }   // ユーザ COG／地面アトラス（ラスタ＋3D の塗り）＝陰影の上・フォグの下
	var col = mix(colBase, F.fogColor, in.fog);
	col = mix(col, in.csFog.rgb, in.csFog.a);   // Cesium の霧（800 km より下・globe の csFogL と同じ式）
	return vec4f(col * t * P.p2.w, t * P.p2.w);   // premultiplied（globe基色→地形へ滑らかに）× 球体の不透明度（p2.w）
}
`;

// 建物（BUILDING_VS/FS の移植）：フットプリント押し出し・基準点(anchor)の単一標高で足元を揃える（屋根水平・
// 壁垂直）。メッシュ被覆マスクは Phase 2 未搭載（u_meshCount=0 相当）＝メッシュ移植時に追加。
export const BUILDING_WGSL = /* wgsl */`
${FRAME}
// メッシュ被覆マスク（group(2)）：実フットプリントが立つ区（最大4）を uv 正規化で参照し、基図の押し出し
// 建物を伏せる＝同一体積の全面 z-fight を断ちつつ範囲外は残す（GL BUILDING_FS の u_meshMaskN 移植）。
// mparams.count=0（メッシュ無し）なら discard は起きない＝素通し。
struct MaskP { count: vec4u, bbox: array<vec4f, 4> };
@group(2) @binding(0) var<uniform> M: MaskP;
@group(2) @binding(1) var maskTex0: texture_2d<f32>;
@group(2) @binding(2) var maskTex1: texture_2d<f32>;
@group(2) @binding(3) var maskTex2: texture_2d<f32>;
@group(2) @binding(4) var maskTex3: texture_2d<f32>;
@group(2) @binding(5) var maskSamp: sampler;
fn maskedBy(offInv: vec4f, uvOK: vec2f, hit: f32) -> bool {   // offInv.xy=(origin−bboxMin)/span・zw=1/span（空きスロット=uv圏外）
	return uvOK.x >= 0.0 && uvOK.x <= 1.0 && uvOK.y >= 0.0 && uvOK.y <= 1.0 && hit > 0.5;
}
struct BldOut {
	@builtin(position) pos: vec4f,
	@location(0) shade: f32,
	@location(1) front: f32,
	@location(2) fog: f32,
	@location(3) ll: vec2f,   // 絶対 lon/lat＝被覆マスクの uv 参照
};
@vertex fn vs(@location(0) a_pos: vec3f, @location(1) a_shade: f32, @location(2) a_anchor: vec2f) -> BldOut {
	var o: BldOut;
	let rel = deltaToRel(a_pos.xy);
	let dir = F.originPt + rel;
	let base = elevQ(F.origin + a_anchor) * F.elevP.x;   // 基準点の標高で足元を揃える（案A＝描画メッシュ面）
	let h = base + a_pos.z;                              // 地形標高 + 建物高さ
	let relW = rel + h * liftDir(F.origin + a_pos.xy, dir);   // 楕円体＝測地法線
	o.shade = a_shade;
	o.front = select(dot(dir, F.eye) - 1.0, 1.0, dot(F.eye, F.eye) < 1.0);
	o.fog = fogOf(F.originPt + relW);
	// ⚠絶対経緯度を varying で運ばない：f32 ulp≈1.4m(経度139°)がマスクセル境界の画素ジッタ＝深ズームの点描ゴースト。
	// 原点相対の小値を渡し、大きい定数部は MaskP 側（CPU f64 前計算の off）に持たせる（glsl.js BUILDING_VS と同文）。
	o.ll = a_pos.xy;
	var p = F.clipT + F.mvp * vec4f(relW, 0.0);
	p.z = logDepthZ(p.w);
	o.pos = p;
	return o;
}
@fragment fn fs(in: BldOut) -> @location(0) vec4f {
	if (in.front < 0.0) { discard; }
	// 実フットプリントが立つセルだけ基図建物を伏せる（矩形でなく被覆マスク＝空白地帯なし）。GLSL ES の
	// sampler 配列動的添字不可に倣い 4本アンロール（uv は各 bbox 正規化・textureSampleLevel＝FS でも明示 LOD）。
	if (M.count.x > 0u) {
		let uv0 = M.bbox[0].xy + in.ll * M.bbox[0].zw;   // (off,inv)方式＝uv=off+rel×inv（off/invはCPUのf64前計算）
		if (maskedBy(M.bbox[0], uv0, textureSampleLevel(maskTex0, maskSamp, uv0, 0.0).r)) { discard; }
	}
	if (M.count.x > 1u) {
		let uv1 = M.bbox[1].xy + in.ll * M.bbox[1].zw;   // (off,inv)方式＝uv=off+rel×inv（off/invはCPUのf64前計算）
		if (maskedBy(M.bbox[1], uv1, textureSampleLevel(maskTex1, maskSamp, uv1, 0.0).r)) { discard; }
	}
	if (M.count.x > 2u) {
		let uv2 = M.bbox[2].xy + in.ll * M.bbox[2].zw;   // (off,inv)方式＝uv=off+rel×inv（off/invはCPUのf64前計算）
		if (maskedBy(M.bbox[2], uv2, textureSampleLevel(maskTex2, maskSamp, uv2, 0.0).r)) { discard; }
	}
	if (M.count.x > 3u) {
		let uv3 = M.bbox[3].xy + in.ll * M.bbox[3].zw;   // (off,inv)方式＝uv=off+rel×inv（off/invはCPUのf64前計算）
		if (maskedBy(M.bbox[3], uv3, textureSampleLevel(maskTex3, maskSamp, uv3, 0.0).r)) { discard; }
	}
	let c = mix(P.p0.rgb * in.shade, F.fogColor, in.fog);
	return vec4f(c * P.p0.w, P.p0.w);   // ×グローバルα（クロスフェード・通常1＝不変）
}
`;

// 建物メッシュ（LOD2 等）（MESH_VS/FS の移植）。頂点は重心(u_meshOrigin)相対 delta（RTE-lite＝
// 小さい値＝float32 仮数フル活用）、法線は int8 量子化（FS で normalize＝精度 1/127 で十分）。
// 投影は基図(fill/line/terrain)と別＝重心相対（scene 原点相対でない）：絶対位置 = meshOrigin + a_pos、
// clip 錨は u_clipMesh（CPU double・相殺回避）。接地リフトは DTM 保証域(P.p0=liftBounds)内だけ。
// フレーム共通 uniform は建物 bld スロットの Frame を流用（mvp/eye/fog/elev が同一）＝group(0)=bld。
// group(1)=DrawP（p0=liftBounds・p1=bldColor）、group(2)=per-batch（meshOrigin+cullBack・clipMesh）。
export const MESH_WGSL = /* wgsl */`
${FRAME}
${CS_ATMO_WGSL}
struct PB { meshOrigin: vec4f, clipMesh: vec4f, alpha: vec4f, pbr0: vec4f, emis: vec4f, lp: vec4f, sh: array<vec4f, 9>, pad: vec4f, ln: vec4f, lt: array<vec4f, 32>, xf: mat3x3f, xt: vec4f, sl0: vec4f, sl1: vec4f, cs: vec4f, csL: vec4f, csC: vec4f, csI: vec4f, eyeRel: vec4f, tint: vec4f, tintB: vec4f, sil: vec4f };   // tint/tintB＝Cesium の Model.color（float 240〜245）：tint＝色 rgba・tintB.x＝混ぜ方（−1 無し・0 HIGHLIGHT・1 REPLACE・間 MIX の量）・tintB.y＝輪郭線の太さ（device px）・sil＝輪郭線の色 rgba（float 248〜251・Model.silhouetteColor）   // eyeRel＝F.eye − meshOrigin（CPU double・float 236〜238）＝toEye を原点相対で組む（近接の裏面判定）   // csL/csC/csI＝Cesium の模型の照明（setMeshLighting・float 224〜235）：csL＝(光へ向く世界系の単位ベクトル, on)・csC＝(光の色×強さ HDR, 一様な環境で L00 が 1 になる倍率)・csI＝(拡散の係数, 鏡面の係数, 鏡面の環境の立方体図あり, その最大 mip)・sh[9] の xyz には Cesium の並びの SH9   // sl0/sl1＝style の light（setLight・float 212〜219）：sl0＝(東, 北, 上, on)・sl1＝(色 rgb, 強さ)／cs.x＝1 で頂点色は sRGB（押し出し＝表示空間の色・float 220）・cs.y＝街明かりの強さ（float 221）・cs.z＝1 で窓の明かりを canvas の α に印す（夜の色 grade の間・float 222）   // xf/xt＝バッチの剛体変換（glTF の rigid アニメ・W4・float 196〜211・xt.w＝on）   // pad＝clipO の枠（断面の派生が clipO に替える）・ln.x＝局所の光源の数（W2）・lt＝8 灯×(A,B,C,D)（light.js localLightsPayload と同じ並び）   // xyz+cullBack, clip錨, alpha.z＝noLift（1＝地形へ持ち上げない）・alpha.w＝drape（1＝DTM 保証域に縛らず持ち上げる・2026-09-22）。
// #46 段 2：pbr0=(metallic, roughness, normalScale, occlusionStrength)・emis=(発光 rgb, fx.pbr の旗)・lp=(太陽の強さ rgb 正規化, 固定光の重み)・sh=空の SH9（sh[0].w＝fill）
@group(2) @binding(0) var<uniform> B: PB;
struct PlOut {
	@builtin(position) pos: vec4f,
	@location(12) wl: vec3f,     // バッチ原点からの位置（m）＝街明かりの窓の格子（派生が使う 4〜8 と重ならない番号）
	@location(0) n: vec3f,       // 実法線（巻き順非依存で表向きへ）
	@location(1) toEye: vec3f,
	@location(2) front: f32,
	@location(13) csFog: vec4f,   // Cesium の霧（頂点で色と量・csFogV）＝派生（uv/col 4〜5・影 4/6・切り抜き 5〜8・wl 12・cw 15）と重ならない番号
	@location(3) fog: f32,
};
@vertex fn vs(@location(0) a_pos: vec3f, @location(1) a_normal: vec4f) -> PlOut {
	var o: PlOut;
	let ap = select(a_pos, B.xf * a_pos + B.xt.xyz, B.xt.w > 0.5);   // バッチの剛体変換（W4）＝原点相対のまま
	let wp = B.meshOrigin.xyz + ap;                    // 絶対位置（陰影/フォグ/半球判定＝粗くて可）
	let dir = normalize(wp);
	o.wl = ap * 6371000.0;   // 原点相対＝f32 でも mm 級（絶対位置の f32 は 0.4m 刻み＝窓の格子が揺れる）
	o.n = select(a_normal.xyz, B.xf * a_normal.xyz, B.xt.w > 0.5);
	o.toEye = B.eyeRel.xyz - ap;                      // ＝F.eye − wp を原点相対で（≈1 同士の差は float32 で 0.4 m 級の誤差＝数 m まで寄った 1 m 級の模型で裏面判定が乱れた・2026-10-28）
	o.front = select(dot(dir, F.eye) - 1.0, 1.0, dot(F.eye, F.eye) < 1.0);
	o.fog = fogOf(wp);
	o.csFog = csFogV(F.eye * CS_R, wp * CS_R, F.farP.w, F.cg.xyz, select(-1.0, 1.0, F.cg.w > 0.5 && F.cgP.w >= 0.0));
	// 接地リフト（DTM 保証域 P.p0=liftBounds 内だけ・境界 0.05° smoothstep）。域外/bounds無しは h=0（r=1 接地）
	let lat = geoLat(degrees(asin(clamp(dir.y, -1.0, 1.0))));   // β球点→測地緯度（elev/リフト域は測地の台帳。球=恒等）
	let lon = degrees(atan2(dir.z, dir.x));
	let lb = P.p0;   // [lng0, lat0, spanLng, spanLat]
	let inX = smoothstep(0.0, 0.05, min(lon - lb.x, lb.x + lb.z - lon));
	let inY = smoothstep(0.0, 0.05, min(lat - lb.y, lb.y + lb.w - lat));
	let h = elev(vec2f(lon, lat)) * F.elevP.x * select(inX * inY, 1.0, B.alpha.w > 0.5) * (1.0 - B.alpha.z);   // noLift＝平面に浮かせた統計・drape＝全域で地形に沿わせる
	var p = B.clipMesh + F.mvp * vec4f(ap + h * liftDir(vec2f(lon, lat), dir), 0.0);   // 楕円体＝測地法線
	p.z = logDepthZ(p.w);
	o.pos = p;
	return o;
}
// 局所の光源（第 3 波 W2・2026-10-12）＝陰影の係数に足す（gl/glsl.js localLights と同式）。pos＝画素の世界座標（単位球）
fn localLights(n: vec3f, pos: vec3f) -> vec3f {
	var acc = vec3f(0.0);
	let up = normalize(pos);
	let cnt = u32(B.ln.x + 0.5);
	for (var i = 0u; i < 8u; i++) {
		if (i >= cnt) { break; }
		let A = B.lt[i * 4u]; let Bc = B.lt[i * 4u + 1u]; let C = B.lt[i * 4u + 2u]; let D = B.lt[i * 4u + 3u];
		let kind = i32(A.w + 0.5);
		if (kind == 3) { acc += Bc.rgb * Bc.w; }
		else if (kind == 4) { acc += mix(C.rgb, Bc.rgb, dot(n, up) * 0.5 + 0.5) * Bc.w; }
		else {
			let dv = A.xyz - pos; let dist = length(dv); let L = dv / max(dist, 1e-9);
			var at = select(1.0, pow(clamp(1.0 - dist / C.w, 0.0, 1.0), D.z), C.w > 0.0);
			if (kind == 2) { at *= smoothstep(D.x, D.y, dot(-L, C.xyz)); }
			acc += Bc.rgb * Bc.w * at * max(dot(n, L), 0.0);
		}
	}
	return acc;
}
// 夜の街明かり（2026-10-24）＝壁に窓の格子（幅 3.4m × 階 3.6m・窓は横長 80%×45%）を敷き、窓ごとに点く/点かない・色を hash で決める（建物の用途は PLQ に無い＝見た目の夜景）。
// 点く割合は高さで変える（低層 28%→高層 50%・高い所ほど冷たい白の事務所の灯りが混じる）。強さ＝B.cs.y（素の建物メッシュのバッチだけ CPU が詰める・橋は 0）×
// 夜の度合い（太陽高度 +2°→−8°＝日没後の薄暮から点き始めて夜に満ちる）。窓が 1〜3 画素を切る遠くは「点いた割合」の平均へ溶かす（ちらつかない・遠景の高層群も夜に沈まない）。
// wx/wy＝wl の画面微分（fs の頭＝一様制御フローで取る）。戻り＝(色, 混ぜる量)
fn cwHash(c: vec3i) -> f32 {
	var h = (bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u) ^ (bitcast<u32>(c.z) * 83492791u);
	h = (h ^ (h >> 16u)) * 0x7feb352du; h = (h ^ (h >> 15u)) * 0x846ca68bu; h = h ^ (h >> 16u);
	return f32(h >> 8u) / 16777216.0;
}
fn cityWin(n: vec3f, wl: vec3f, wx: vec3f, wy: vec3f) -> vec4f {
	if (B.cs.y <= 0.0) { return vec4f(0.0); }
	let up = normalize(B.meshOrigin.xyz);
	let k = B.cs.y * (1.0 - smoothstep(-0.139, 0.035, dot(up, F.sun.xyz)));   // sin(−8°)〜sin(+2°)
	if (k <= 0.0) { return vec4f(0.0); }
	if (abs(dot(n, up)) > 0.35) { return vec4f(0.0); }   // 壁だけ（屋根・床は点けない）
	let t = normalize(cross(up, n));
	let sz = vec2f(3.4, 3.6);
	let hgt = dot(wl, up);   // バッチ原点（地面の近く）からの高さ m
	let uv = vec2f(dot(wl, t), hgt) / sz;
	let fw = max(vec2f(length(vec2f(dot(wx, t), dot(wy, t))), length(vec2f(dot(wx, up), dot(wy, up)))) / sz, vec2f(1e-4));
	let cell = vec2i(floor(uv)); let f = fract(uv);
	let face = i32(floor(dot(wl, n) * 0.5));   // 壁ごとに別の並び（壁の面の位置＝面内で一定）
	let h0 = cwHash(vec3i(cell, face)); let h1 = cwHash(vec3i(cell.x + 7919, cell.y - 104729, face + 31));
	let tall = smoothstep(25.0, 90.0, hgt);
	let rate = mix(0.28, 0.5, tall);
	let on = select(0.0, 1.0, h0 < rate);
	let ex = smoothstep(0.10 - fw.x, 0.10 + fw.x, f.x) * (1.0 - smoothstep(0.90 - fw.x, 0.90 + fw.x, f.x));
	let ey = smoothstep(0.28 - fw.y, 0.28 + fw.y, f.y) * (1.0 - smoothstep(0.73 - fw.y, 0.73 + fw.y, f.y));
	let warm = vec3f(1.0, 0.70, 0.36); let cool = vec3f(0.90, 0.94, 1.0);
	let col = mix(warm, cool, select(0.0, 1.0, h1 > mix(0.85, 0.55, tall))) * (0.75 + 0.25 * fract(h1 * 7.0));
	let far = smoothstep(0.35, 0.9, max(fw.x, fw.y));   // 窓の格子が 1〜3 画素を切る＝平均へ
	// 遠景の平均＝暗めの暖色を、4 列×4 階の塊ごとに明るさを揺らす（一様な乳白の面でなく「灯りの並ぶ高層」に読める・塊は数画素以上＝動いても揺れない）
	let blk = cwHash(vec3i(cell.x >> 2u, cell.y >> 2u, face + 97));
	let farCol = vec3f(0.95, 0.70, 0.40) * (0.35 + 0.65 * blk);
	let m = mix(on * ex * ey, rate * 1.1, far);
	return vec4f(mix(col, farCol, far), clamp(m * k, 0.0, 1.0));
}
@fragment fn fs(in: PlOut) -> @location(0) vec4f {
	let wlx = dpdx(in.wl); let wly = dpdy(in.wl);   // 街明かりの窓の画素幅（discard より前＝一様制御フロー）
	// 面の幾何法線＝スクリーン微分（FS冒頭＝uniform control flow・discard より前＝fwidth の轍と同じ掟）。
	// toEye = eye − pos で eye は定数＝微分は −dPos、cross で符号相殺＝位置微分の面法線と等価（varying追加不要）。
	let gnRaw = cross(dpdx(in.toEye), dpdy(in.toEye));
	if (in.front < 0.0) { discard; }
	if (B.tintB.w != 0.0 && sign(B.tintB.w) * (in.pos.x - (abs(B.tintB.w) - 1.0) * F.viewport.x) < 0.0) { discard; }   // Cesium splitDirection (tintB.w: sign = side kept, |w| - 1 = the split as a fraction of the width)
	var n = normalize(in.n);
	var ltBase = P.p1.rgb;   // 局所の光源（W2）が掛かる素の色（模型の派生＝頂点色×テクスチャ）
	// 裏面カリングは幾何法線＝面内で一定＝画素毎の揺れゼロ。旧・補間int8法線のdot閾値は「すれすれ帯≈1px」
	// 前提が深ズーム(z20)で崩れ点描ゴーストになった（glsl.js MESH_FS と同文・2026-08-02）。
	// 向きは属性法線で採決＝巻き順非依存。退化面（微分ゼロ）だけ旧判定へフォールバック。
	let g2 = dot(gnRaw, gnRaw);
	let fe = select(dot(n, normalize(in.toEye)), dot(normalize(gnRaw * sign(dot(gnRaw, n))), normalize(in.toEye)), g2 > 1e-18);
	// 裏面カリング。cullBack=B.meshOrigin.w
	if (B.meshOrigin.w > 0.5 && fe < -0.02) { discard; }
	if (fe < 0.0) { n = -n; }   // 両面時は法線を視線側へ＝裏から見ても陰影が成立
	// 光の向き＝接地の局所系（上＝その画素の動径・東・北）で固定（#46 段 0・2026-09-26）。旧＝地球固定の定数 (-0.35,0.85,0.30)＝
	// 置いた経度で当たる面が変わっていた（東京では北寄り・仰角 64° の光＝その向きを局所系で写した値が下の 0.44/0.90）。
	// 段 2 で太陽（F.sun）＋環境光へ寄せる（本人裁定）。gl/glsl.js は据え置き（WebGPU だけ）。
	let up = normalize(F.eye - in.toEye);   // = 画素の絶対位置の向き（toEye = eye − pos）
	let e0 = cross(vec3f(0.0, 1.0, 0.0), up);
	let east = select(normalize(e0), vec3f(1.0, 0.0, 0.0), dot(e0, e0) < 1e-12);   // 極では退化＝任意の水平
	let north = cross(up, east);
	let L = normalize(north * 0.44 + up * 0.90);   // 斜め上の光＝屋根が立つ
	var d = vec3f(clamp(dot(n, L) * 0.28 + 0.76, 0.72, 1.0));   // 基図建物の屋根1.0/壁0.76に合わせる
	if (B.sl0.w > 0.5) {   // style の light（MapLibre の setLight・2026-10-13）＝gl/glsl.js MESH_FS と同式：局所系で向きを写し mix(1−強さ, 1, max(dot, 0))×色。fx.pbr の経路（太陽＋環境光）には掛けない
		let Ls = normalize(east * B.sl0.x + north * B.sl0.y + up * B.sl0.z);
		d = B.sl1.rgb * mix(1.0 - B.sl1.w, 1.0, clamp(dot(n, Ls), 0.0, 1.0));
	}
	let sunK = 1.0;   // 影の受け手（MESH_SH）は shLit(in.sc) に差し替える＝太陽の項だけ影が消す（環境光は残る）
	var lit = P.p1.rgb * d;   // 従来（fx.pbr off）
	if (B.emis.w > 0.5) {   // #46 段 2＝太陽＋空の環境光（拡散だけ・rough 1・metallic 0）。夜は固定光へ
		var pi: PbrIn; pi.base = srgbDecode(P.p1.rgb); pi.n = n; pi.pos = F.eye - in.toEye; pi.v = normalize(in.toEye); pi.metallic = 0.0; pi.rough = 1.0; pi.ao = 1.0; pi.sunK = sunK; pi.lp = B.lp; pi.fill = B.sh[0].w;
		lit = srgbEncode(min(pbrShade(pi, B.sh), vec3f(1.0)));
	}
	if (B.csL.w > 1.5) { lit = P.p1.rgb; }   // Cesium の unlit（KHR_materials_unlit・法線無し）＝素の色
	else if (B.csL.w > 0.5) {   // Cesium の模型の照明（@ortho-earth/cesium の setMeshLighting）＝固定光・style の light・fx.pbr の代わり
		var ci: CsIn; ci.base = srgbDecode(P.p1.rgb); ci.n = n; ci.pos = F.eye - in.toEye; ci.v = normalize(in.toEye); ci.metallic = B.pbr0.x; ci.rough = B.pbr0.y; ci.ao = 1.0; ci.emissive = vec3f(0.0); ci.sunK = sunK;
		lit = csLit(ci, B.sh, B.csL, B.csC, B.csI);
	}
	if (B.ln.x > 0.5) { lit += ltBase * localLights(n, F.eye - in.toEye); }   // 局所の光源（W2）
	let cwin = cityWin(select(n, normalize(gnRaw * sign(dot(gnRaw, n))), g2 > 1e-18), in.wl, wlx, wly);   // 夜の街明かり（cs.y＝0 のバッチ＝模型などは何もしない）・向きは面の幾何法線（面内で一定＝角で丸めた頂点法線でも壁は壁）
	lit = mix(lit, cwin.rgb, cwin.w);
	let wm = cwin.w * B.cs.z * (1.0 - in.fog);   // 窓の印＝canvas の α を 1−wm に（後処理の夜の色が窓だけ暗くしない・cs.z＝grade の間だけ）
	var c = mix(lit, F.fogColor, in.fog);
	c = mix(c, in.csFog.rgb, in.csFog.a);   // Cesium の霧
	return vec4f(c, 1.0 - wm);
}
`;

// 星空劇場（z<4 の世界ビュー・STARS_VS/FS・STARLINE_FS・NIGHT_FS の移植）。
// ・星/惑星＝GL は gl_PointSize の点。WebGPU に点サイズが無い＝**インスタンス四角形**（6頂点/星・
//   corner を size×device px で screen 空間に広げ、FS で soft disc）。
// ・星座線/黄道/天の赤道＝gl.LINES → topology "line-list"（1px・GL と同じ）。色は per-buffer uniform（LC）。
// ・夜面＝フルスクリーン・単位球レイキャストで夜半球を夜紺で減光（globe/contour と同じ全画面パス）。
// 天球の向きは恒星時 GMST の y 軸回転（バッファ不変・時刻は uniform）。u_sky＝遠近表現（ズームに線形）。
export const SKY_WGSL = /* wgsl */`
struct Sky {
	mvp: mat4x4f,
	rayF: vec4f,       // 夜面レイキャスト（#65・旧 invMvp の枠）：視線の基底（CPU f64）
	rayX: vec4f,
	rayY: vec4f,
	eyeC: vec4f,       // xyz＝目・w＝|E|²−1
	gmst: vec2f,       // (cos, sin) 恒星時
	fadeSky: vec2f,    // (fade=出現α, sky=天球倍率)
	viewport: vec2f,   // device px（星の四角形展開）
	pad: vec2f,
	sun: vec3f,        // 夜面の太陽方向（地球固定・単位）
	alpha: f32,        // 夜面の濃さ
};
${RAY}
@group(0) @binding(0) var<uniform> SK: Sky;
@group(1) @binding(0) var<uniform> LC: vec4f;   // 星座線の色（per-buffer）
fn rotY(cel: vec3f) -> vec3f {   // 天球→地球固定＝GMST の y 軸回転（STARS_VS と同式）
	return vec3f(cel.x * SK.gmst.x + cel.z * SK.gmst.y, cel.y, cel.z * SK.gmst.x - cel.x * SK.gmst.y);
}
const QUAD = array<vec2f, 6>(vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(-0.5, 0.5), vec2f(-0.5, 0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5));
struct StarOut { @builtin(position) pos: vec4f, @location(0) col: vec4f, @location(1) uv: vec2f };
@vertex fn vsStar(@builtin(vertex_index) vi: u32, @location(0) a_cel: vec3f, @location(1) a_col: vec4f, @location(2) a_size: f32) -> StarOut {
	var o: StarOut;
	let d = rotY(a_cel);
	let p = SK.mvp * vec4f(d, 0.0);
	let corner = QUAD[vi];
	// GL: gl_Position=vec4(p.xy*sky,0,p.w) の点を、corner を size×2/viewport（NDC）で広げる（×p.w＝rasterの/w相殺）
	o.pos = vec4f(p.xy * SK.fadeSky.y + corner * (a_size * 2.0 / SK.viewport) * p.w, 0.0, p.w);
	o.uv = corner;
	o.col = vec4f(a_col.rgb, a_col.a * SK.fadeSky.x);
	return o;
}
@fragment fn fsStar(in: StarOut) -> @location(0) vec4f {
	let r = length(in.uv) * 2.0;                     // GL gl_PointCoord 相当（edge-mid=1・corner=1.41）
	let a = in.col.a * smoothstep(1.0, 0.3, r);      // 柔らかい円盤＝回転中のシマーを抑える
	return vec4f(in.col.rgb * a, a);                 // premultiplied
}
struct LineOut { @builtin(position) pos: vec4f, @location(0) col: vec4f };
@vertex fn vsLine(@location(0) a_cel: vec3f) -> LineOut {
	var o: LineOut;
	let d = rotY(a_cel);
	let p = SK.mvp * vec4f(d, 0.0);
	o.pos = vec4f(p.xy * SK.fadeSky.y, 0.0, p.w);    // w<0（背後）は自然にクリップ
	o.col = vec4f(LC.rgb, LC.a * SK.fadeSky.x);
	return o;
}
@fragment fn fsLine(in: LineOut) -> @location(0) vec4f {
	return vec4f(in.col.rgb * in.col.a, in.col.a);   // premultiplied
}
struct NOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vsNight(@builtin(vertex_index) vi: u32) -> NOut {
	var o: NOut;
	let p = vec2f(select(-1.0, 3.0, vi == 1u), select(-1.0, 3.0, vi == 2u));
	o.ndc = p;
	o.pos = vec4f(p, 0.0, 1.0);
	return o;
}
@fragment fn fsNight(in: NOut) -> @location(0) vec4f {
	let h = sphereRay(in.ndc, SK.rayF, SK.rayX, SK.rayY, SK.eyeC);   // #65
	if (h.t < 0.0) { discard; }
	let Pt = h.A + h.t * h.d;
	let night = smoothstep(0.08, -0.18, dot(Pt, SK.sun));   // 太陽直下から遠い半球ほど夜
	let a = night * SK.alpha;
	if (a <= 0.001) { discard; }
	return vec4f(vec3f(0.0, 0.02, 0.078) * a, a);           // v1 の夜紺（premultiplied）
}
`;

// overlay（外部ベクタ=geopbf/e-Stat/N02）の stencil-then-cover 塗り（STENCIL_VS/FS・COVER_FS の移植）。
// 塗りは巻き数（FRONT+1/BACK-1・NOTEQUAL 0）で決まる＝earcut 不要でロバスト。フレーム（origin/mvp/elev/fog）は
// per-scene で違う＝呼び出し側が dynamic offset で Frame(group0)＋DrawP(group1) を切替。塗り色は DrawP.p1。
// 線は LINE_WGSL を流用（同じ dynamic frame レイアウトで別パイプライン）＝ここには面（stencil/cover）だけ。
export const OVERLAY_WGSL = /* wgsl */`
${FRAME}
struct SOut { @builtin(position) pos: vec4f };
@vertex fn vsStencil(@location(0) a_delta: vec2f) -> SOut {
	var o: SOut;
	// 塗り(fan)を地形にドレープ＝FILL_WGSL と同じ標高変位。elev 無しだと塗りが海抜0の平面に貼られ、
	// 地形に沿う境界線と乖離して浮く（本人報告 2026-08-12・豊浦町ハイライト）。p0.y=線と同じリフト(3m)で一致。
	let ll = F.origin + a_delta;
	let rel = deltaToRel(a_delta);
	let dir = F.originPt + rel;
	let df = 1.0 - smoothstep(F.params.y * 0.8, F.params.y * 2.0, distance(F.eye, dir));
	let h = (elevQ(ll) + P.p0.y) * F.elevP.x * df;   // 案A＝overlay 塗りも描画メッシュ面に乗せる
	var relW = rel + h * liftDir(ll, dir);
	// p0.z=1（wdepr＝全球スケールのポリゴン）＝裏半球の頂点を地平円へ射影クランプ＝球体カリング
	// （gl/glsl.js STENCIL_VS u_sphereClip と対＝裏側は円周に縮退・地平線跨ぎは可視部だけを囲む＝
	// 投影折返しの±1巻き数斑を根絶）。通常 overlay は p0.z=0＝完全不変。
	if (P.p0.z > 0.5) {
		var Pt = F.originPt + relW;
		let e2 = dot(F.eye, F.eye);
		if (dot(Pt, F.eye) < 1.0) {
			let Pp = Pt - F.eye * (dot(Pt, F.eye) / e2);
			let lp = length(Pp);
			var t = normalize(vec3f(-F.eye.z, 0.0, F.eye.x));
			if (lp > 1e-6) { t = Pp / lp; }
			Pt = F.eye / e2 + sqrt(max(1.0 - 1.0 / e2, 0.0)) * t;
			relW = Pt - F.originPt;
		}
	}
	// 巻き数で塗る＝fan の形は問わない。クリップ座標のまま（GL[-w,w]→WebGPU[0,w] へ z 写像・深度は off）
	let c = F.clipT + F.mvp * vec4f(relW, 0.0);
	o.pos = vec4f(c.xy, (c.z + c.w) * 0.5, c.w);
	return o;
}
@fragment fn fsNull(in: SOut) -> @location(0) vec4f { return vec4f(0.0); }   // colorWriteMask 0 で無視
struct CoOut { @builtin(position) pos: vec4f };
@vertex fn vsCover(@builtin(vertex_index) vi: u32) -> CoOut {
	var o: CoOut;
	o.pos = vec4f(select(-1.0, 3.0, vi == 1u), select(-1.0, 3.0, vi == 2u), 0.5, 1.0);
	return o;
}
@fragment fn fsCover(in: CoOut) -> @location(0) vec4f {
	return vec4f(P.p1.rgb * P.p1.a, P.p1.a);   // premultiplied 塗り色（DrawP.p1）
}
`;

// 等高線（CONTOUR_FS の移植）：真俯瞰でだけ、フルスクリーン各画素でカメラ光線×単位球→lon/lat→elev→iso線を
// fwidth で AA。紙の地形図の等高線＝平面で標高を語る。ベクタの下に敷く。
export const CONTOUR_WGSL = /* wgsl */`
${FRAME}
struct COut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> COut {
	var o: COut;
	let p = vec2f(select(-1.0, 3.0, vi == 1u), select(-1.0, 3.0, vi == 2u));
	o.ndc = p;
	o.pos = vec4f(p, 0.0, 1.0);
	return o;
}
const R2D: f32 = 57.29577951308232;
fn elevAt(uv: vec2f) -> f32 {   // 等高線は edgeFade 無し（GL CONTOUR_FS と同じ・uv 範囲外=0）。uv＝原点相対（#65）
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 0.0; }
	return textureSampleLevel(elevTex, elevSamp, uv, 0.0).r;
}
fn band(g: f32) -> f32 {   // iso線：整数の g で 1（fwidth で画面一定幅・AA）。勾配ゼロ抑制＝平坦地に等高線の面は無い
	let dd = abs(fract(g + 0.5) - 0.5);
	let fw = fwidth(g);
	let w = fw * 0.5 + 1e-5;
	return (1.0 - smoothstep(0.0, w, dd)) * smoothstep(0.0, 1e-4, fw);
}
@fragment fn fs(in: COut) -> @location(0) vec4f {
	if (P.p1.y <= 0.002 || F.elevP.y < 0.5) { discard; }
	let h = sphereRay(in.ndc, F.rayF, F.rayX, F.rayY, F.eyeC);   // #65：視線は CPU f64 の基底・交点は原点相対 δ で持つ（絶対経緯度を経ない）
	if (h.t < 0.0) { discard; }
	let dl = F.eyeO.xyz + h.t * h.d;
	let dll = deltaLL(dl, F.originPt, F.trig.z, F.eyeO.w, F.ellP.x);   // 経緯度の差（deg・測地）
	let e = elevAt(F.elevOff.xy + dll * F.elevOff.zw);
	let landMask = smoothstep(0.5, 4.0, e);   // 海/データ無し(≈0)は等高線を出さない
	if (landMask <= 0.0) { discard; }
	let line = max(band(e / P.p0.w) * 0.2, band(e / P.p1.x) * 0.4);   // 主曲線ごく薄・計曲線も薄め
	let a = line * landMask * P.p1.y;
	if (a <= 0.003) { discard; }
	return vec4f(P.p0.rgb * a, a);   // premultiplied
}
`;

// 球体本体（フルスクリーン・レイキャスト）。GLOBE_VS/GLOBE_FS の忠実移植（Frame 非依存＝専用 UBO）。
// smoothstep の逆順引数（GLSL 黙認・WGSL 未定義）は 1-smoothstep(正順) へ等価書換済み。
export const GLOBE_WGSL = /* wgsl */`
struct Globe {
	rayF: vec4f,         // 全画面レイキャスト（#65・旧 invMvp の枠）：視線の基底（CPU f64・camera.js viewRays）
	rayX: vec4f,
	rayY: vec4f,
	eyeC: vec4f,         // xyz＝目の位置・w＝|E|²−1（f64）
	land: vec4f,
	atmo: vec4f,   // 大気色 rgb + 強さ(a)
	elevBounds: vec4f,   // 全球ハイプソ用（R90 全球窓の被覆）
	whP: vec4f,          // (出現度whK, hasElev, ell, hasClim)
	seaC: vec4f,         // 海の平色（NE流の淡青）
	farBounds: vec4f,    // far床（世界帯z<8=R90全球固定窓）の被覆＝近窓の外を受ける（タイラーのバグ根治 9/2）
	farP: vec4f,         // (hasFar, 近窓縁フェード幅deg, Cesium の霧の濃さ＝csFogDensity, 0)
	misc: vec4f,         // (globeAlpha=球体の不透明度・本人裁定 2026-09-13, Cesium の地面の大気の効き 0..1, Cesium の大気を点ける 0/1, Cesium の空の大気 0/1)＝view.csAtmo（../csatmo.ts）
	sun: vec4f,          // 大気散乱（#46 段 1）：xyz＝太陽の方向（地球固定）・w＝散乱を点ける度合い（fx.atmosphere × 全球ハイプソの出現度＝0 は従来のリム光と霞）
	anc: vec4f,          // 錨（#65）：xyz＝シーン原点の β単位球の点 O・w＝cos β0
	anc2: vec4f,         // xy＝原点 lon/lat（deg・測地）・z＝β0（rad）
	eyeO: vec4f,         // xyz＝目−O（f64 で引く）＝交点 δ＝eyeO＋t·d（原点相対・f32 で mm 級）
	atmP: vec4f,         // (太陽の強さ, 露出, 球の床の空気遠近の強さ 0..1＝地理の読みやすさのため既定は半分, 帯の幅 k＝殻を k 倍に広げ係数を 1/k＝色は物理のまま)
	cogOff: vec4f,       // 球の床の uv 係数（f64 前計算・#65）：ユーザ COG＝(原点の uv, 1/span)＝uv＝off＋δll·inv
	gndOff0: vec4f,      // 地面アトラス（前景/近/中/遠）＝同形
	gndOff1: vec4f,
	gndOff2: vec4f,
	gndOff3: vec4f,
	elevOff: vec4f,      // 近窓の標高（海面下 fsWdepr）＝同形
	cg: vec4f,           // 地面の照明（setGroundLighting・2026-10-26）＝Frame.cg と同形
	cgP: vec4f,
	cgC: vec4f,
	gm: vec4f,           // 地面の材質（setGroundMaterial・2026-10-28）＝terrain の P.tr/P.lx/P.dashP と同形（GM_WGSL）
	gmC: vec4f,
	gmP: vec4f,
	ugC: vec4f,          // 地下から見た球の裏面（Cesium の globe.undergroundColor）：rgb＋α・α<0＝切
	ugNF: vec4f,         // その α の距離 (near, nearValue, far, farValue)・距離は世界単位
};
@group(0) @binding(0) var<uniform> G: Globe;
// 地面の照明（setGroundLighting・Cesium の globe.enableLighting・2026-10-26）：経緯度（deg）の点の東・北・上（世界軸＝ECEF の (x, z, y)）での lambert。
//   cg＝xyz 光へ向く単位ベクトル（世界）・w 0 無し／1 地形の法線（gEN＝勾配 東・北 m/m）／2 楕円体の上向き。cgP＝(倍率, 足す値, 効き 0..1＝距離のフェード済み, 大気の夜側の明るさ)
fn cgLambert(ll: vec2f, gEN: vec2f, cg: vec4f, cgP: vec4f) -> f32 {
	let lr = ll * 0.017453292519943295;
	let cl = cos(lr.y); let sl = sin(lr.y); let co = cos(lr.x); let so = sin(lr.x);
	let L = vec3f(dot(cg.xyz, vec3f(-so, 0.0, co)), dot(cg.xyz, vec3f(-sl * co, cl, -sl * so)), dot(cg.xyz, vec3f(cl * co, sl, cl * so)));
	let n = select(normalize(vec3f(-gEN, 1.0)), vec3f(0.0, 0.0, 1.0), cg.w > 1.5);
	let diff = clamp(max(dot(n, L), 0.0) * cgP.x + cgP.y, 0.0, 1.0);
	return mix(1.0, diff, cgP.z);
}
${CS_ATMO_WGSL}
${RAY}
// 全球ハイプソ：標高（R90全球窓）＋気候場。未着/K=0 は dummy（whP が使用をゲート）
@group(0) @binding(1) var gElevTex: texture_2d<f32>;
@group(0) @binding(2) var gSamp: sampler;
@group(0) @binding(3) var gClimTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> WP: WorldPal;   // 世界パレット＝terrain 側 binding(2) と同一バッファ（同色契約）
@group(0) @binding(5) var gFarTex: texture_2d<f32>;   // far床（未使用時は dummy。farP.x=0 ガード）
// ユーザ COG（terrain 側 group(2) binding(3-4) と同じ素材・低地は terrain の t フェードで抜けるためここが床）
@group(0) @binding(6) var gCogTex: texture_2d<f32>;
@group(0) @binding(7) var<uniform> GCG: GCogP;
struct GCogP { bbox: vec4f, p: vec4f };   // p＝(has, 組か, 境の u, 半テクセル)＝Cog0P と同じバッファ
// 地面アトラス（近/中/遠）＝基球の床（真俯瞰 2D の下地・地形の低地フェードの穴）。絶対経緯度→uv・行0＝北
@group(0) @binding(8) var gGnd0: texture_2d<f32>;
@group(0) @binding(9) var gGnd1: texture_2d<f32>;
@group(0) @binding(10) var gGnd2: texture_2d<f32>;
@group(0) @binding(11) var<uniform> GGD: GGndP;
@group(0) @binding(12) var gGnd3: texture_2d<f32>;
@group(0) @binding(13) var gGmRamp: texture_2d<f32>;   // 地面の材質のランプ（無ければ dummy＝G.gm.x=0 で不使用）
${GM_WGSL("gGmColor", "gGmRamp", "gSamp")}
struct GGndP { w0: vec4f, w1: vec4f, w2: vec4f, w3: vec4f, p: vec4f };
${WORLD_HYPSO_WGSL}
const R2Dg: f32 = 57.29577951308232;
fn gElevFar(ll0: vec2f) -> f32 {   // far床＝近窓の外の受け（GL elevFar と同式）
	if (G.farP.x < 0.5) { return 0.0; }
	let ll = vec2f(ll0.x - 360.0 * floor((ll0.x + 180.0) / 360.0), ll0.y);   // 経度を -180..180 へ（原点相対の経度は ±180 を越えうる）
	let uv = (ll - G.farBounds.xy) / G.farBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 0.0; }
	return textureSampleLevel(gFarTex, gSamp, uv, 0.0).r;
}
fn gElevAt(ll: vec2f) -> f32 { return gElevUV((ll - G.elevBounds.xy) / G.elevBounds.zw, ll); }
fn gElevUV(uv0: vec2f, ll: vec2f) -> f32 {   // uv＝原点相対で作った近窓の uv（#65）・ll＝far 床の受け（粗くて可）
	// 全球の窓（R90＝経度幅 360°）は経度が一周＝uv.x を折り返す。原点（最初の視点）から 180° 超回った先は原点相対の uv/経度が窓の外
	//（例 原点 138°E→米州で 276°）に出て far 床（世界帯では未読込＝0）へ落ち、陸が海色に抜けた（本人 2026-10-01「回すと欠ける」）
	var uv = uv0;
	if (G.elevBounds.z > 359.0) { uv.x = fract(uv.x); }
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return gElevFar(ll); }
	var fade = 1.0;
	if (G.farP.y > 0.0) {   // 近窓縁＝far値へ溶かす（R90全球窓=0＝従来どおり）
		let w = vec2f(G.farP.y) / G.elevBounds.zw;
		fade = min(smoothstep(0.0, w.x, min(uv.x, 1.0 - uv.x)), smoothstep(0.0, w.y, min(uv.y, 1.0 - uv.y)));
	}
	return mix(gElevFar(ll), textureSampleLevel(gElevTex, gSamp, uv, 0.0).r, fade);
}
// ── 大気散乱（#46 段 1・2026-09-26）＝Rayleigh＋Mie の単散乱・Nishita 流のレイマーチ。単位＝地球半径（1.0）。誇張しない＝実寸の殻と実測の係数。
// 視線 ATM_N 段・各段から太陽への透過は ATM_NS 段。太陽の方向は G.sun.xyz（地球固定）。露出＝1−exp(−L×露出)・出口で sRGB 符号化。
// 点ける度合い G.sun.w＝0 なら呼ばれない（従来のリム光と霞）。fsWdepr も同じ関数＝球の床と画素一致。
// 帯の幅 k＝G.atmP.w（本人裁定 2026-09-26＝4）：殻の上端とスケール高を k 倍・散乱係数を 1/k＝光学的厚みは不変＝色と明るさは物理のまま、帯の幅だけ k 倍
//（実寸 100 km は z2 で 1〜2px＝「寂しい」。k=4 で 6〜8px・旧リム光 1.09R は k≈6 相当）
const ATM_RT0: f32 = 0.0157;                         // 大気の上端 ≈ 100 km（半径比）
const ATM_HR0: f32 = 0.001256;                       // Rayleigh のスケール高 8 km
const ATM_HM0: f32 = 0.000188;                       // Mie 1.2 km
const ATM_BR0: vec3f = vec3f(36.9, 86.0, 210.9);     // Rayleigh 散乱係数（5.8/13.5/33.1 e-6 /m × 6371 km）
const ATM_BM0: f32 = 133.8;                          // Mie 散乱（21e-6 /m）
const ATM_BME0: f32 = 147.2;                         // Mie 消散（散乱×1.1）
fn atmK() -> f32 { return max(G.atmP.w, 1.0); }
fn atmRt() -> f32 { return 1.0 + ATM_RT0 * atmK(); }
const ATM_G: f32 = 0.76;                             // Mie の非対称
const ATM_N: i32 = 8;
const ATM_NS: i32 = 3;
struct AtmR { L: vec3f, T: vec3f };
// 球（半径 r）と半直線 o+t·d（d は単位）の交点 (t0,t1)。交わらなければ (-1,-1)
fn atmShell(o: vec3f, d: vec3f, r: f32) -> vec2f {
	let b = dot(o, d); let c = dot(o, o) - r * r; let h = b * b - c;
	if (h < 0.0) { return vec2f(-1.0); }
	let sq = sqrt(h);
	return vec2f(-b - sq, -b + sq);
}
fn atmDensity(p: vec3f) -> vec2f { let h = max(length(p) - 1.0, 0.0) / atmK(); return vec2f(exp(-h / ATM_HR0), exp(-h / ATM_HM0)); }
// p から太陽の方向へ上端までの光学的厚み（Rayleigh, Mie）。地球に遮られれば ∞ 扱い
fn atmOptSun(p: vec3f, s: vec3f) -> vec2f {
	let b = dot(p, s);
	if (b < 0.0 && dot(p, p) - b * b < 1.0) { return vec2f(1e9); }   // 最接近が前方かつ球の中＝地球の影
	let sh = atmShell(p, s, atmRt());
	let ds = max(sh.y, 0.0) / f32(ATM_NS);
	var od = vec2f(0.0);
	for (var i = 0; i < ATM_NS; i++) { od += atmDensity(p + s * (ds * (f32(i) + 0.5))) * ds; }
	return od;
}
// o+t·d の t∈[t0,t1] を積分。戻り＝散乱光 L（リニア・放射輝度）と透過率 T（rgb）
fn atmScatter(o: vec3f, d: vec3f, t0: f32, t1: f32, s: vec3f) -> AtmR {
	let mu = dot(d, s);
	let phR = 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu);
	let g2 = ATM_G * ATM_G;
	let phM = 3.0 / (8.0 * 3.14159265) * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * ATM_G * mu, 1.5));
	let ds = (t1 - t0) / f32(ATM_N);
	let BR = ATM_BR0 / atmK(); let BM = ATM_BM0 / atmK(); let BME = ATM_BME0 / atmK();
	var odV = vec2f(0.0); var sumR = vec3f(0.0); var sumM = vec3f(0.0);
	for (var i = 0; i < ATM_N; i++) {
		let p = o + d * (t0 + ds * (f32(i) + 0.5));
		let dn = atmDensity(p) * ds;
		odV += dn;
		let od = odV + atmOptSun(p, s);
		let tr = exp(-(BR * od.x + vec3f(BME * od.y)));
		sumR += tr * dn.x; sumM += tr * dn.y;
	}
	var r: AtmR;
	r.L = (sumR * BR * phR + sumM * BM * phM) * G.atmP.x;
	r.T = exp(-(BR * odV.x + vec3f(BME * odV.y)));
	return r;
}
fn atmTone(L: vec3f) -> vec3f { return srgbEncodeG(vec3f(1.0) - exp(-L * G.atmP.y)); }
fn srgbEncodeG(c: vec3f) -> vec3f { let x = max(c, vec3f(0.0)); return select(1.055 * pow(x, vec3f(1.0 / 2.4)) - 0.055, x * 12.92, x <= vec3f(0.0031308)); }
fn srgbDecodeG(c: vec3f) -> vec3f { let x = max(c, vec3f(0.0)); return select(pow((x + 0.055) / 1.055, vec3f(2.4)), x / 12.92, x <= vec3f(0.04045)); }
// 球に当たった画素の空気遠近＝base（表示空間）を透過率で減らし散乱光を足す（リニアで合成し戻す）。k＝点ける度合い（従来の霞と混ぜる）
fn atmGround(base: vec3f, A: vec3f, Pt: vec3f, viewDir: vec3f, k: f32) -> vec3f {
	let ndv = clamp(dot(Pt, viewDir), 0.0, 1.0);
	let haze = pow(1.0 - ndv, 3.0);
	let old = mix(base, G.atmo.rgb, haze * G.atmo.a * 0.9);
	if (k <= 0.0) { return old; }
	let dn = normalize(Pt - A);
	let sh = atmShell(A, dn, atmRt());
	let t0 = max(sh.x, 0.0); let t1 = length(Pt - A);
	let r = atmScatter(A, dn, t0, t1, G.sun.xyz);
	let kg = G.atmP.z;   // 床の空気遠近の強さ（宇宙から見た陸の青い霞は物理どおりだと段彩が読みにくい＝既定は半分・view.atmGround で調整）
	// 露出のトーン（1−exp）は散乱光だけに掛ける＝地の色（表示用の段彩）は透過率で減らすだけ（トーンまで掛けると 0.91→0.6 に潰れる・2026-09-26 実機）
	let lin = srgbDecodeG(base) * mix(vec3f(1.0), r.T, kg) + (vec3f(1.0) - exp(-r.L * G.atmP.y)) * kg;
	let phys = srgbEncodeG(min(lin, vec3f(1.0)));
	return mix(old, phys, k);
}
struct GOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> GOut {
	var o: GOut;
	let p = vec2f(select(-1.0, 3.0, vi == 1u), select(-1.0, 3.0, vi == 2u));
	o.ndc = p;
	o.pos = vec4f(p, 0.0, 1.0);
	return o;
}
@fragment fn fs(in: GOut) -> @location(0) vec4f {
	let h = sphereRay(in.ndc, G.rayF, G.rayX, G.rayY, G.eyeC);   // #65：視線は CPU f64 の基底・交点は桁落ちなし
	let A = h.A; let d = h.d; let aa = h.aa; let bb = h.bb; let cc = h.cc;
	let aDotd = bb * 0.5; let tstar = -aDotd / aa;
	var t = h.t;
	var ug = false;   // 目が球の中（地下）＝前方の遠い根＝球の裏面（Cesium の globe.undergroundColor・gl と同じ）
	let disc = bb * bb - 4.0 * aa * cc;
	if (t < 0.0 && G.ugC.a >= 0.0 && cc < 0.0 && disc >= 0.0) { t = (-bb + sqrt(disc)) / (2.0 * aa); ug = true; }
	// 地面の材質の等高線用 fwidth(標高)＝ここ（空の return より前＝一様な制御の流れ）で。WGSL の掟：微分は画素ごとの分岐の後では呼べず、
	// Tint が 'fwidth' must only be called from uniform control flow でパイプラインごと落とす（Metal の実 WebGPU で地球が真っ黒）。naga は見逃す
	var gmDe = 0.0;
	if (G.gm.x > 0.5 && G.whP.y > 0.5) {
		let dllS = deltaLL(G.eyeO.xyz + max(t, 0.0) * d, G.anc.xyz, G.anc.w, G.anc2.z, G.whP.z);
		gmDe = fwidth(gElevAt(G.anc2.xy + dllS));
	}
	if (t < 0.0) {                             // 前方に球ヒット無し＝空：地平の霞から宇宙へ連続減衰
		if (G.misc.z > 0.5) {   // Cesium の空の大気（gl と同じ）
			if (G.misc.w < 0.5) { discard; }
			let cs = csSky(A * CS_R, normalize(d));
			if (cs.a <= 0.002) { discard; }
			return cs;
		}
		let lenA = length(A);
		var m = lenA;
		if (tstar > 0.0) { m = sqrt(max((cc + 1.0) - aDotd * aDotd / aa, 0.0)); }
		var g = 1.0 - smoothstep(1.0, 1.09, m);
		g = g * (1.0 - smoothstep(0.0, 0.55, dot(normalize(d), A / lenA)));
		let limbCol = mix(G.land.rgb, G.atmo.rgb, G.atmo.a * 0.9);
		let oa = g * g * mix(G.atmo.a, 1.0, g);
		let old = vec4f(mix(G.atmo.rgb, limbCol, g) * oa, oa);   // premultiplied（従来のリム光）
		let k = G.sun.w;
		if (k <= 0.0) { if (g <= 0.0 || G.atmo.a <= 0.0) { discard; } return old; }   // 大気の強さ 0（MapLibre の口＝sky の無い style）＝リム光も描かない（B5・gl と同じ）
		// 大気散乱（#46 段 1）：大気殻を通る区間だけ積分。殻の外＝宇宙＝discard（星がそのまま）。星は透過率のぶん透ける（α＝1−平均透過率）
		let dn = normalize(d);
		let sh = atmShell(A, dn, atmRt());
		var phys = vec4f(0.0);
		if (sh.y > 0.0) {
			let r = atmScatter(A, dn, max(sh.x, 0.0), sh.y, G.sun.xyz);
			let a = clamp(1.0 - (r.T.x + r.T.y + r.T.z) / 3.0, 0.0, 1.0);
			phys = vec4f(atmTone(r.L), a);
		}
		let o = mix(old, phys, k);
		if (o.a <= 0.002) { discard; }
		return o;
	}
	let Pt = A + t * d;                                                       // 絶対（霞・大気・低ズームの粗い用途）
	let dll = deltaLL(G.eyeO.xyz + t * d, G.anc.xyz, G.anc.w, G.anc2.z, G.whP.z);   // 原点相対の経緯度差（deg・測地）＝uv の正本（#65）
	let ll = G.anc2.xy + dll;                                                  // 絶対経緯度（粗くて可＝ハイプソ・気候）
	var base = G.land.rgb;
	if (G.whP.x > 0.001 && G.whP.y > 0.5) {   // 全球ハイプソ：標高×気候→配色＋陰影（gl/glsl.js GLOBE_FS と同式）
		let e = gElevAt(ll);
		let tsz = vec2f(textureDimensions(gElevTex, 0));
		let dstep = G.elevBounds.w / tsz.y;
		let hx = gElevAt(ll + vec2f(dstep, 0.0)) - e;
		let hy = gElevAt(ll + vec2f(0.0, dstep)) - e;
		let shade = select(clamp(0.86 + (-hx + hy) * 0.00013, 0.62, 1.08), 1.0, G.cg.w > 0.5);   // 地面の照明（Cesium）の間は陰影は lambert が受け持つ
		let landK = smoothstep(0.2, 4.0, e);   // 海(=0クランプ)↔陸の境（低平地を海に沈めない・干拓地級のみ海側）
		let clim = textureSampleLevel(gClimTex, gSamp, climUV(ll), 0.0).rg;
		let hyp = mix(G.seaC.rgb, worldHypsoColor(e, ll, clim, G.whP.w) * shade, landK);
		base = mix(base, hyp, G.whP.x);
	}
	if (GCG.p.x > 0.5) {   // ユーザ COG（uv＝原点相対の係数＝f32 の絶対経緯度を経ない・#65）
		let cuv = G.cogOff.xy + dll * G.cogOff.zw;
		if (cuv.x >= 0.0 && cuv.x <= 1.0 && cuv.y >= 0.0 && cuv.y <= 1.0) {
			var cv = 1.0 - cuv.y;
			if (GCG.p.y > 0.5) { cv = clamp(cv * 0.5, GCG.p.w, 0.5 - GCG.p.w) + select(0.0, 0.5, cuv.x >= GCG.p.z); }   // 見比べ（cogPairV と同式）
			let cc = textureSampleLevel(gCogTex, gSamp, vec2f(cuv.x, cv), 0.0);
			base = mix(base, cc.rgb, cc.a);
		}
	}
	if (GGD.p.x > 0.5) {   // 地面アトラス（球の床）：uv＝原点相対の係数（#65＝写真の床がズーム摂動で揺れない）
		let u0 = G.gndOff0.xy + dll * G.gndOff0.zw;
		let u1 = G.gndOff1.xy + dll * G.gndOff1.zw;
		let u2 = G.gndOff2.xy + dll * G.gndOff2.zw;
		let u3 = G.gndOff3.xy + dll * G.gndOff3.zw;
		let d0 = min(u0, vec2f(1.0) - u0); let d1 = min(u1, vec2f(1.0) - u1); let d2 = min(u2, vec2f(1.0) - u2); let d3 = min(u3, vec2f(1.0) - u3);
		let w0 = clamp(min(d0.x, d0.y) / 0.04, 0.0, 1.0);
		let w1 = select(0.0, clamp(min(d1.x, d1.y) / 0.04, 0.0, 1.0), GGD.p.x > 1.5);
		let w2 = select(0.0, clamp(min(d2.x, d2.y) / 0.04, 0.0, 1.0), GGD.p.x > 2.5);
		let w3 = select(0.0, clamp(min(d3.x, d3.y) / 0.04, 0.0, 1.0), GGD.p.x > 3.5);
		let g0 = textureSampleLevel(gGnd0, gSamp, vec2f(clamp(u0.x, 0.0, 1.0), 1.0 - clamp(u0.y, 0.0, 1.0)), 0.0);
		let g1 = textureSampleLevel(gGnd1, gSamp, vec2f(clamp(u1.x, 0.0, 1.0), 1.0 - clamp(u1.y, 0.0, 1.0)), 0.0);
		let g2 = textureSampleLevel(gGnd2, gSamp, vec2f(clamp(u2.x, 0.0, 1.0), 1.0 - clamp(u2.y, 0.0, 1.0)), 0.0);
		let g3 = textureSampleLevel(gGnd3, gSamp, vec2f(clamp(u3.x, 0.0, 1.0), 1.0 - clamp(u3.y, 0.0, 1.0)), 0.0);
		let gc = mix(mix(mix(mix(vec4f(0.0), g3, w3), g2, w2), g1, w1), g0, w0);
		base = base * (1.0 - gc.a) + gc.rgb;
	}
	if (G.gm.x > 0.5) {   // 地面の材質（Cesium の globe.material）＝球の床（低地の t フェードの穴と真俯瞰）にも地形面と同じ式で。標高が無い所は Cesium と同じく高さ 0 の色
		var e = 0.0; var gEN = vec2f(0.0);
		if (G.whP.y > 0.5) {
			e = gElevAt(ll); let dstep = G.elevBounds.w / vec2f(textureDimensions(gElevTex, 0)).y;
			gEN = vec2f((gElevAt(ll + vec2f(dstep, 0.0)) - e) / (dstep * 111320.0 * max(cos(ll.y * 0.017453292519943295), 0.01)), (gElevAt(ll + vec2f(0.0, dstep)) - e) / (dstep * 111320.0));
		}
		let m = gGmColor(e, gEN, gmDe, G.gm, G.gmC, G.gmP); base = mix(base, m.rgb, m.a);   // 標高の画素差は冒頭で（一様な制御の流れ）
	}
	if (G.cg.w > 0.5) { base *= G.cgC.rgb * cgLambert(ll, vec2f(0.0), vec4f(G.cg.xyz, 2.0), G.cgP); }   // 地面の照明（Cesium の globe.enableLighting）：遠景球は楕円体の上向きで
	let col = atmGround(base, A, Pt, normalize(A - Pt), G.sun.w);   // 空気遠近＝従来の霞か大気散乱（#46 段 1・G.sun.w）
	var colC = col;
	if (G.misc.z > 0.5) { let night = select(-1.0, G.cgP.w, G.cg.w > 0.5); colC = csFogL(csGroundL(base, A * CS_R, Pt * CS_R, G.misc.y, G.cg.xyz, night), A * CS_R, Pt * CS_R, G.farP.z, G.cg.xyz, night); }   // Cesium の地面の大気（遠くから）と霧（800 km より下・farP.z＝濃さ）＝従来の霞の代わり
	if (ug) {   // 裏面：霞・大気は掛けない＝床の色に undergroundColor を距離の α で重ねる（gl と同じ）
		let kd = clamp((t * sqrt(aa) - G.ugNF.x) / max(G.ugNF.z - G.ugNF.x, 1e-12), 0.0, 1.0);
		let ua = G.ugC.a * mix(G.ugNF.y, G.ugNF.w, kd);
		colC = G.ugC.rgb * ua + base * (1.0 - ua);
	}
	var outC = vec4f(colC * G.misc.x, G.misc.x);   // 球体の不透明度（地中の震源等を透かす）
	// 球が透ける時（globe:false・translucency）は Cesium と同じく空の大気の殻が地面の向こうに見える（gl と同じ）
	if (G.misc.z > 0.5 && G.misc.w > 0.5 && G.misc.x < 1.0) { let cs = csSky2(A * CS_R, normalize(d), select(1.0, 2.0, G.misc.x > 0.0)); outC += cs * (1.0 - outC.a); }
	return outC;
}
// 海面下の陸地（wdepr）カバー：stencil-then-cover の cover 側を「landK=1 強制のハイプソ本体」で塗る＝
// 海→海面下→陸の描画順（2026-09-01 本人設計・gl/glsl.js WDEPR_FS と対）。同モジュール＝globe と同一バインド
//（G/gElevTex/gSamp/gClimTex）を共有し、色は globe パスの陸側と画素単位で厳密一致＝ポリゴン境界が
// e≳4m（landK≈1）の土地に落ちれば継ぎ目が消える。α＝whP.x（whK フェード）。
@fragment fn fsWdepr(in: GOut) -> @location(0) vec4f {
	let h = sphereRay(in.ndc, G.rayF, G.rayX, G.rayY, G.eyeC);   // #65
	let A = h.A; let d = h.d; let aa = h.aa; let bb = h.bb; let disc = h.disc;
	if (disc < 0.0) { discard; }
	let t = (-bb - sqrt(disc)) / (2.0 * aa);
	if (t < 0.0) { discard; }
	let Pt = A + t * d;
	let dll = deltaLL(G.eyeO.xyz + t * d, G.anc.xyz, G.anc.w, G.anc2.z, G.whP.z);   // 原点相対（#65）
	let ll = G.anc2.xy + dll;
	let uv = G.elevOff.xy + dll * G.elevOff.zw;
	let e = gElevUV(uv, ll);
	let tsz = vec2f(textureDimensions(gElevTex, 0));
	let dstep = G.elevBounds.w / tsz.y;
	let hx = gElevUV(uv + vec2f(dstep * G.elevOff.z, 0.0), ll + vec2f(dstep, 0.0)) - e;
	let hy = gElevUV(uv + vec2f(0.0, dstep * G.elevOff.w), ll + vec2f(0.0, dstep)) - e;
	let shade = clamp(0.86 + (-hx + hy) * 0.00013, 0.62, 1.08);
	let clim = textureSampleLevel(gClimTex, gSamp, climUV(ll), 0.0).rg;
	// 以降は fs（globe）の末尾と厳密同式（landK=1 だけが違い）：紙とのwhK混合も大気ヘイズも同じに通し、
	// α=1 の不透明で置く＝ポリゴン境界の e≳4m では画素値が globe と bit 一致し縁が完全に消える。
	var hyp = worldHypsoColor(e, ll, clim, G.whP.w) * shade;   // landK=1 強制＝「陸」の上塗り
	// 海面下の締め（NE流「最深帯」）：0→-60m で僅かに暗く・緑側へ＝乾燥帯でも読める（gl WDEPR_FS と同式）
	hyp = mix(hyp, hyp * WP.belowSea.rgb, clamp(-e / 60.0, 0.0, 1.0));
	let base = mix(G.land.rgb, hyp, G.whP.x);
	return vec4f(atmGround(base, A, Pt, normalize(A - Pt), G.sun.w) * G.misc.x, G.misc.x);   // 球体の不透明度に従う・空気遠近は globe fs と同じ関数（画素一致）
}
// 10度レチクル（v1 ortho-map geoGraticule10/Canvas2D の移植・gl GRAT_FS と対）：レイ→球→測地経緯度→
// 10°格子への画素距離を fwidth で解析AA（≈0.7px 白細線）。度距離の上限ゲート＝極（経線収束）と atan 継ぎ目で
// fwidth が爆発して線が面に化けるのを防ぐ。d3.geoGraticule10 と同じ約束＝±80°打切り・90°毎の経線だけ極まで。
// 出現度＝G.seaC.w（レンダラが z帯フェード×基礎αを書く）。
@fragment fn fsGrat(in: GOut) -> @location(0) vec4f {
	let h = sphereRay(in.ndc, G.rayF, G.rayX, G.rayY, G.eyeC);   // #65
	let A = h.A; let d = h.d; let aa = h.aa; let bb = h.bb; let disc = h.disc;
	if (disc < 0.0) { discard; }
	let t = (-bb - sqrt(disc)) / (2.0 * aa);
	if (t < 0.0) { discard; }
	let Pt = A + t * d;
	let bl = asin(clamp(Pt.y, -1.0, 1.0));
	let latD = bl * R2Dg + G.whP.z * (0.0016792203863837047 * sin(2.0 * bl) + 0.0000014098905530233192 * sin(4.0 * bl)) * R2Dg;
	let ll = vec2f(atan2(Pt.z, Pt.x) * R2Dg, latD);
	let fw = max(fwidth(ll), vec2f(1e-6));
	let g10 = abs(fract(ll / 10.0 + 0.5) - 0.5) * 10.0;
	var mer = (1.0 - smoothstep(0.25, 0.75, g10.x / fw.x)) * (1.0 - smoothstep(0.8, 1.6, g10.x));
	let par = (1.0 - smoothstep(0.25, 0.75, g10.y / fw.y)) * (1.0 - smoothstep(0.8, 1.6, g10.y)) * step(abs(latD), 80.0);
	let in80 = step(abs(latD), 80.0);
	let g90 = abs(fract(ll.x / 90.0 + 0.5) - 0.5) * 90.0;
	let mer90 = (1.0 - smoothstep(0.25, 0.75, g90 / fw.x)) * (1.0 - smoothstep(0.8, 1.6, g90));
	mer = mer * in80 + mer90 * (1.0 - in80);
	let a = max(mer, par) * G.seaC.w * WP.grat.w;
	if (a <= 0.003) { discard; }
	return vec4f(WP.grat.rgb * a, a);   // premultiplied（既定=白）
}
`;

// テクスチャ/マテリアル付きの派生（glTF/GLB 直読み・2026-09-20）＝MESH_WGSL からの文字列派生（本体は不変・gl/glsl.js MESH_TEX_* と同じ考え）。
// 頂点に a_uv(f32x2)・a_col(unorm8x4＝baseColorFactor×COLOR_0＝glTF の規約どおりリニア)、group(3)＝サンプラ＋テクスチャ（rgba8unorm-srgb ビュー＝標本はリニア・出口で srgbEncode・#46 段 0）。色だけ「建物色」→「頂点色×テクスチャ」、α は alphaMode ごと（OPAQUE=無視・MASK=cutoff で discard・BLEND=前乗算で合成＝target の blend は既定で premultiplied）。
/** 置き換えの対：[錨（ちょうど 1 度だけ出る）, 置換]。 */
type WgslPair = readonly [string, string];
const deriveWgsl = (src: string, pairs: readonly WgslPair[], label: string): string => pairs.reduce((s, [a, b]) => { if (s.split(a).length !== 2) throw new Error(`wgsl derive(${label}): anchor missing/ambiguous: ${a.slice(0, 50)}`); return s.replace(a, b); }, src);
export const MESH_TEX_WGSL = deriveWgsl(MESH_WGSL, [
	["@group(2) @binding(0) var<uniform> B: PB;\n", "@group(2) @binding(0) var<uniform> B: PB;\nfn tintW(c: vec3f) -> vec3f { if (B.tintB.x < -0.5) { return c; } let m = mix(c, B.tint.rgb, B.tintB.x); return m * mix(B.tint.rgb, vec3f(1.0), ceil(B.tintB.x)); }   // Cesium の ModelColorStage（diffuse はリニア）\n@group(3) @binding(0) var texS: sampler;\n@group(3) @binding(1) var texT: texture_2d<f32>;\n@group(3) @binding(2) var texMR: texture_2d<f32>;\n@group(3) @binding(3) var texN: texture_2d<f32>;\n@group(3) @binding(4) var texOcc: texture_2d<f32>;\n@group(3) @binding(5) var texEm: texture_2d<f32>;\n@group(3) @binding(99) var texP: texture_2d<f32>;\n// the style colour of the feature under this texel (feature ID texture, nearest texel; alpha 0 = no colour), blended like tintW in display space (Cesium colorBlendMode)\nfn paintW(c: vec4f, uv: vec2f) -> vec4f { if (B.tintB.z < -0.5) { return c; } let sz = vec2i(textureDimensions(texP)); let p = textureLoad(texP, clamp(vec2i(floor(uv * vec2f(sz))), vec2i(0), sz - 1), 0); if (p.a < 0.5) { return c; } let m = mix(srgbEncode(c.rgb), p.rgb, B.tintB.z) * mix(p.rgb, vec3f(1.0), ceil(B.tintB.z)); return vec4f(srgbDecode(m), c.a); }\n"],
	["\t@location(3) fog: f32,\n};", "\t@location(3) fog: f32,\n\t@location(4) uv: vec2f,\n\t@location(5) col: vec4f,\n};"],
	["@vertex fn vs(@location(0) a_pos: vec3f, @location(1) a_normal: vec4f) -> PlOut {\n\tvar o: PlOut;\n", "@vertex fn vs(@location(0) a_pos: vec3f, @location(1) a_normal: vec4f, @location(2) a_uv: vec2f, @location(3) a_col: vec4f) -> PlOut {\n\tvar o: PlOut;\n\to.uv = a_uv; o.col = a_col;\n"],
	["\tlet gnRaw = cross(dpdx(in.toEye), dpdy(in.toEye));\n", "\tlet gnRaw = cross(dpdx(in.toEye), dpdy(in.toEye));\n\tlet txT = paintW(textureSample(texT, texS, in.uv), in.uv);   // uniform control flow（discard より前）・塗る絵（meshPaint）\n\tlet tx = vec4f(tintW(txT.rgb * select(in.col.rgb, srgbDecode(in.col.rgb), B.cs.x > 0.5)), txT.a * in.col.a);   // cs.x＝頂点色が sRGB（押し出し）＝リニアへ戻してから掛ける＝出口の srgbEncode で元の色（gl と同じ絵・2026-10-13）\n\tlet mr = textureSample(texMR, texS, in.uv); let nm = textureSample(texN, texS, in.uv); let oc = textureSample(texOcc, texS, in.uv); let em = textureSample(texEm, texS, in.uv);   // #46 段 2＝材質 4 枚（無い物は 1×1 の既定）\n\tlet dpx = dpdx(in.toEye); let dpy = dpdy(in.toEye); let dux = dpdx(in.uv); let duy = dpdy(in.uv);   // 法線マップの接線（微分＝ここで確定）\n"],
	["\tvar ltBase = P.p1.rgb;   // 局所の光源（W2）", "\tvar ltBase = srgbEncode(tx.rgb);   // 局所の光源（W2）"],
	["\tvar lit = P.p1.rgb * d;   // 従来（fx.pbr off）\n", "\tif (tx.a < B.alpha.x) { discard; }\n\tlet a = select(1.0, select(tx.a, 1.0, B.alpha.y > 1.5) * select(1.0, B.tint.a, B.tintB.x > -0.5), B.alpha.y > 0.5);   // alpha.y＝1 BLEND・2 Model.color の α だけで半透明\n\tvar lit = srgbEncode(tx.rgb) * d;   // 従来（fx.pbr off）＝tx はリニア（srgb ビュー）・陰影 d は表示空間\n"],
	["\t\tvar pi: PbrIn; pi.base = srgbDecode(P.p1.rgb); pi.n = n; pi.pos = F.eye - in.toEye; pi.v = normalize(in.toEye); pi.metallic = 0.0; pi.rough = 1.0; pi.ao = 1.0; pi.sunK = sunK; pi.lp = B.lp; pi.fill = B.sh[0].w;\n\t\tlit = srgbEncode(min(pbrShade(pi, B.sh), vec3f(1.0)));\n",
	 "\t\t// normal map via screen-space tangents (no TANGENT attribute; degenerate = plain normal). default 1x1 (128,128,255) = identity\n\t\tlet nmv = vec3f((nm.xy * 2.0 - 1.0) * B.pbr0.z, nm.z * 2.0 - 1.0);\n\t\tlet dp1 = -dpx; let dp2 = -dpy;\n\t\tlet dp2p = cross(dp2, n); let dp1p = cross(n, dp1);\n\t\tlet T = dp2p * dux.x + dp1p * duy.x; let Bt = dp2p * dux.y + dp1p * duy.y;\n\t\tlet mx = max(dot(T, T), dot(Bt, Bt));\n\t\tvar nn = n;\n\t\tif (mx > 1e-20) { let im = inverseSqrt(mx); nn = normalize(T * im * nmv.x + Bt * im * nmv.y + n * max(nmv.z, 0.05)); }\n\t\tvar pi: PbrIn; pi.base = tx.rgb; pi.n = nn; pi.pos = F.eye - in.toEye; pi.v = normalize(in.toEye); pi.metallic = clamp(B.pbr0.x * mr.b, 0.0, 1.0); pi.rough = clamp(B.pbr0.y * mr.g, 0.04, 1.0); pi.ao = mix(1.0, oc.r, B.pbr0.w); pi.sunK = sunK; pi.lp = B.lp; pi.fill = B.sh[0].w;\n\t\tlit = srgbEncode(min(pbrShade(pi, B.sh) + B.emis.rgb * em.rgb, vec3f(1.0)));   // emissive (srgb view = linear) added as is\n"],
	["\tif (B.csL.w > 1.5) { lit = P.p1.rgb; }", "\tif (B.csL.w > 1.5) { lit = srgbEncode(tx.rgb); }"],   // unlit＝テクスチャの素の色
	["\t\tvar ci: CsIn; ci.base = srgbDecode(P.p1.rgb); ci.n = n; ci.pos = F.eye - in.toEye; ci.v = normalize(in.toEye); ci.metallic = B.pbr0.x; ci.rough = B.pbr0.y; ci.ao = 1.0; ci.emissive = vec3f(0.0); ci.sunK = sunK;\n",
	 "\t\tlet cnm = vec3f((nm.xy * 2.0 - 1.0) * B.pbr0.z, nm.z * 2.0 - 1.0);   // 法線マップ（fx.pbr の経路と同じ接線）\n\t\tlet cdp1 = -dpx; let cdp2 = -dpy; let cdp2p = cross(cdp2, n); let cdp1p = cross(n, cdp1);\n\t\tlet cT = cdp2p * dux.x + cdp1p * duy.x; let cB = cdp2p * dux.y + cdp1p * duy.y; let cmx = max(dot(cT, cT), dot(cB, cB));\n\t\tvar cn = n; if (cmx > 1e-20) { let im = inverseSqrt(cmx); cn = normalize(cT * im * cnm.x + cB * im * cnm.y + n * max(cnm.z, 0.05)); }\n\t\tvar ci: CsIn; ci.base = tx.rgb; ci.n = cn; ci.pos = F.eye - in.toEye; ci.v = normalize(in.toEye); ci.metallic = clamp(B.pbr0.x * mr.b, 0.0, 1.0); ci.rough = clamp(B.pbr0.y * mr.g, 0.04, 1.0); ci.ao = mix(1.0, oc.r, B.pbr0.w); ci.emissive = B.emis.rgb * em.rgb; ci.sunK = sunK;\n"],
	["\tc = mix(c, in.csFog.rgb, in.csFog.a);   // Cesium の霧\n\treturn vec4f(c, 1.0 - wm);\n}\n", "\tc = mix(c, in.csFog.rgb, in.csFog.a);   // Cesium の霧\n\treturn vec4f(c * a, a);\n}\n"],
], "MESH_TEX_WGSL");
// 利用者のシェーダ（Cesium の CustomShader・2026-10-29）＝MESH_TEX_WGSL に、利用者の GLSL を WGSL へ写した物（csshader.ts csWgsl）を差し込む（gl/glsl.ts meshCustomGLSL と対）。
// group(3) の binding 6＝CU（J・V・misc＝(czm_frameNumber, 0, UNLIT, TRANSLUCENT)・利用者の uniform）・7〜＝利用者のテクスチャ（sampler と texture の対）。a_mc＝location 4・mc＝location 9。
// 材質は Cesium の MaterialStageFS と同じに組む（diffuse＝base×(1−金属)・specular＝f0・occlusion・emissive は材質 4 枚から）・照明は csLit を材質から取る形（csLitM）
export function meshCustomWGSL(spec: CsSpec): { code: string; textures: string[]; cuSize: number; layout: ReturnType<typeof csWgsl>["layout"] } {
	const w = csWgsl(spec, 3, 6);
	const s = MESH_TEX_WGSL, i = s.indexOf("fn csLit(i: CsIn, sh: array<vec4f, 9>, csL: vec4f, csC: vec4f, csI: vec4f) -> vec3f {"), j = s.indexOf("\n}\n", i);
	const csLitM = deriveWgsl(s.slice(i, j + 3), [
		["fn csLit(i: CsIn, sh: array<vec4f, 9>, csL: vec4f, csC: vec4f, csI: vec4f) -> vec3f {", "fn csLitM(i: CsIn, f0m: vec3f, sh: array<vec4f, 9>, csL: vec4f, csC: vec4f, csI: vec4f) -> vec3f {"],
		["let diffuse = i.base * (1.0 - i.metallic); let f0 = mix(vec3f(0.04), i.base, i.metallic);", "let diffuse = i.base; let f0 = f0m;"],
	], "csLitM");
	const code = deriveWgsl(MESH_TEX_WGSL, [
		["@group(3) @binding(5) var texEm: texture_2d<f32>;\n", "@group(3) @binding(5) var texEm: texture_2d<f32>;\n" + w.decl + csLitM],
		["\t@location(5) col: vec4f,\n};", "\t@location(5) col: vec4f,\n\t@location(9) mc: vec4f,\n\t@location(10) uvm: vec2f,\n};"],
		["@vertex fn vs(@location(0) a_pos: vec3f, @location(1) a_normal: vec4f, @location(2) a_uv: vec2f, @location(3) a_col: vec4f) -> PlOut {\n\tvar o: PlOut;\n\to.uv = a_uv; o.col = a_col;\n",
		 "@vertex fn vs(@location(0) a_pos: vec3f, @location(1) a_normal: vec4f, @location(2) a_uv: vec2f, @location(3) a_col: vec4f, @location(4) a_mc: vec4f, @location(5) a_uvm: vec2f) -> PlOut {\n\tvar o: PlOut;\n\to.uv = a_uv; o.col = a_col;\n\to.mc = a_mc; o.uvm = a_uvm;\n"],
		["\tlet ap = select(a_pos, B.xf * a_pos + B.xt.xyz, B.xt.w > 0.5);   // バッチの剛体変換（W4）＝原点相対のまま\n",
		 "\tvar ap = select(a_pos, B.xf * a_pos + B.xt.xyz, B.xt.w > 0.5);   // バッチの剛体変換（W4）＝原点相対のまま\n"
		 + (w.hasVs ? "\tcsVi.attributes = csAttrsOf(a_mc.xyz, B.meshOrigin.xyz + ap, CU.V * (ap - B.eyeRel.xyz) * 6378137.0, select(a_normal.xyz, B.xf * a_normal.xyz, B.xt.w > 0.5), a_uv, a_col, a_mc.w);\n"
			+ "\tcsVi.featureIds.featureId_0 = i32(a_mc.w + 0.5); csVi.metadata = csMetaOf(a_uvm);\n\tcsVo.positionMC = a_mc.xyz; csVo.pointSize = 1.0;\n\tvertexMain();\n"
			+ "\tap += CU.J * (csVo.positionMC - a_mc.xyz);\n\to.mc = vec4f(csVo.positionMC, a_mc.w);\n" : "")],
		["\tif (B.csL.w > 1.5) { lit = srgbEncode(tx.rgb); }",
		 "\tlet csUnlit = CU.misc.z > 0.5 || (B.csL.w > 1.5 && CU.misc.z > -0.5);\n\tlet csMet = select(clamp(B.pbr0.x * mr.b, 0.0, 1.0), 0.0, csUnlit);\n"
		 + "\tcsM.baseColor = tx; csM.diffuse = tx.rgb * (1.0 - csMet); csM.alpha = tx.a; csM.specular = mix(vec3f(0.04), tx.rgb, csMet); csM.roughness = clamp(B.pbr0.y * mr.g, 0.04, 1.0);\n"
		 + "\tcsM.normalEC = normalize(CU.V * n); csM.occlusion = mix(1.0, oc.r, B.pbr0.w); csM.emissive = B.emis.rgb * em.rgb;\n"
		 + (w.hasFs ? "\tcsFi.attributes = csAttrsOf(in.mc.xyz, F.eye - in.toEye, CU.V * (-in.toEye) * 6378137.0, n, in.uv, in.col, in.mc.w);\n\tcsFi.featureIds.featureId_0 = i32(in.mc.w + 0.5); csFi.metadata = csMetaOf(in.uvm);\n\tfragmentMain();\n" : "")
		 + "\tlet csN = normalize(transpose(CU.V) * csM.normalEC);\n\tvar csA = a;\n"
		 + "\tif (csUnlit) { lit = czm_linearToSrgb3(csM.diffuse); }   // UNLIT＝Cesium の lightingStage（diffuse を sRGB へ）\n"
		 + "\telse if (B.csL.w > 0.5) { var ci: CsIn; ci.base = csM.diffuse; ci.n = csN; ci.pos = F.eye - in.toEye; ci.v = normalize(in.toEye); ci.metallic = 0.0; ci.rough = csM.roughness; ci.ao = csM.occlusion; ci.emissive = csM.emissive; ci.sunK = sunK; lit = csLitM(ci, csM.specular, B.sh, B.csL, B.csC, B.csI); }\n"
		 + "\telse { lit = czm_linearToSrgb3(csM.diffuse) * d; }\n"
		 + "\tif (CU.misc.w > 0.5) { csA = clamp(csM.alpha, 0.0, 1.0); }\n"
		 + "\tif (true) { }"],   // 元の else if（csLit）・else を飲む
		["\treturn vec4f(c * a, a);\n}\n", "\treturn vec4f(c * csA, csA);\n}\n"],
	], "MESH_CS_WGSL");
	return { code, textures: w.textures, cuSize: w.layout.size, layout: w.layout };
}
// 模型の輪郭線（Cesium の Model.silhouetteColor／silhouetteSize・2026-10-29）＝同じ頂点を画面上で法線の向きへ tintB.y px 押し出して色で塗る殻。
// 模型の前に深度を書かずに描く＝模型が自分の上を塗り直し、外へはみ出した縁だけ残る（Cesium のステンシルの輪郭と同じ見え方）
export const MESH_SIL_WGSL = deriveWgsl(MESH_TEX_WGSL, [
	["\to.pos = p;\n\treturn o;\n}\n", "\tlet cn = (F.mvp * vec4f(o.n, 0.0)).xy;\n\tif (dot(cn, cn) > 1e-30) { p = vec4f(p.xy + normalize(cn) * B.tintB.y * 2.0 / F.viewport * p.w, p.zw); }\n\to.pos = p;\n\treturn o;\n}\n@fragment fn fsSil(in: PlOut) -> @location(0) vec4f {\n\tif (in.front < 0.0) { discard; }\n\treturn vec4f(B.sil.rgb * B.sil.a, B.sil.a);\n}\n"],
], "MESH_SIL_WGSL");


// 画像タイル層のアトラス合成（raster.js・RTT ドレープ・2026-09-21）＝gl/glsl.js RASTER_ATLAS_VS/FS と対。
// タイル（メルカトル）を経緯度整列の窓へ描く：頂点＝タイル北西隅からの dLL（格子の行は逆メルカトルの緯度）・A.off.xy＝タイル北西隅−窓南西隅（CPU f64）
// A.off.zw＝1/窓幅・A.uvT＝祖先の部分 uv・A.p.x＝不透明度。出力は前乗算。NDC y 上＝北（＝テクスチャ行0＝北＝標本化側で v 反転）。
export const RASTER_ATLAS_WGSL = /* wgsl */`
struct AP { off: vec4f, uvT: vec4f, p: vec4f };
@group(0) @binding(0) var<uniform> A: AP;
@group(1) @binding(0) var aS: sampler;
@group(1) @binding(1) var aT: texture_2d<f32>;
struct AOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@location(0) a_delta: vec2f, @location(1) a_uv: vec2f) -> AOut {
	var o: AOut;
	let p = (A.off.xy + a_delta) * A.off.zw;
	o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
	o.uv = A.uvT.xy + a_uv * A.uvT.zw;
	return o;
}
@fragment fn fs(in: AOut) -> @location(0) vec4f {
	let c = textureSample(aT, aS, in.uv);
	let a = c.a * A.p.x;
	return vec4f(c.rgb * a, a);
}
`;

// ベクタ塗りを地面アトラスへ焼く（RTT ドレープ・3D 限定・2026-09-21）＝gl/glsl.js ATLAS_FILL_VS/FS と対。頂点＝シーン原点相対 dLL（塗りの VBO そのまま）。
// group(0)＝Frame（origin・標高＝水域ゲート）・group(1)＝DrawP（未使用・レイアウト共有のため）・group(2)＝AtlP（dynamic offset：窓×スロット×ゲート）。
// A.off.xy＝シーン原点−窓南西隅（CPU f64）・A.off.zw＝1/窓幅・A.p.x＝seaGate・A.p.y＝baseAlpha。出力は前乗算。NDC y 上＝北。
export const ATLAS_FILL_WGSL = /* wgsl */`
${FRAME}
struct AtlP { off: vec4f, p: vec4f };
@group(2) @binding(0) var<uniform> A: AtlP;
struct AFOut { @builtin(position) pos: vec4f, @location(0) color: vec4f, @location(1) ll: vec2f };
@vertex fn vs(@location(0) a_delta: vec2f, @location(1) a_color: vec4f) -> AFOut {
	var o: AFOut;
	let p = (A.off.xy + a_delta) * A.off.zw;
	o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
	o.color = a_color;
	o.ll = F.origin + a_delta;
	return o;
}
@fragment fn fs(in: AFOut) -> @location(0) vec4f {
	if (A.p.x > 0.5 && elev(in.ll) > 0.0) { discard; }   // 図郭外＝陸は塗り残す
	let a = in.color.a * A.p.y;
	if (a <= 0.003) { discard; }
	return vec4f(in.color.rgb * a, a);
}
`;

// ── 建物の影（リアルタイム shadow map・2026-09-24）＝影を点けた時だけ使う派生シェーダ（本体は1バイトも変えない）。
// 受け手＝本体の文字列派生＋SHADOW_WGSL(g, b0)（g＝空いている group 番号・b0＝その group の最初の binding）。影なしの描画は従来の本体パイプラインのまま＝影響ゼロ。
// 模型は group 4 枚を使い切る＝影は group(2)（バッチごとの PB が binding 0）の binding 1〜3 に同居させる（#112 段 1・#111 の面も同じ置き方で使い回す）。
// SH.mvp/clipT＝太陽の正射影（shadow.js shadowWindow・CPU f64）。SH.anchor＝窓の中心（視点の注視点）の単位球点の f32 値（2026-10-27〜・旧＝main 原点）＝
// 受け手は「自分の Frame 原点からの相対位置 + (F.originPt − SH.anchor)」を渡す（main の原点が近ければ両方小さい・遠くても模型と床は自分の錨との差＝窓の幅以下）。
// SH.p＝(影の明るさ, 未使用, 未使用, 縁のフェードが始まる半径（基の窓の半幅に対する比）)。
// カスケード（2026-10-23）：深度は 2d-array（層 0＝基の窓・層 1〜＝カメラに近い地面だけの細かい窓）。受け手が渡す sc は基の窓のクリップ座標のまま＝
// 段 i のクリップ xy＝xy_b·s＋o（同じ基底・同じ奥行きなので z は共通）＝頂点の派生は 1 行も変えずに FS だけで段を選ぶ。
// SH.cs[i]＝(s, ox, oy, 層)・SH.cb[i]＝(深度の余白, 1texel(uv), 1texel(m), 面の傾きの上限（深度/uv）)・細かい順に並び最後が基の窓。SH.q＝(段の数, 奥行き(m), 半影の係数, 遮蔽物を探す半径(texel))。
// 選び方＝窓に入る一番細かい段。段の縁の帯（4%）は次の段と混ぜる＝解像度の段差を線として見せない。基の窓は従来どおり縁を丸く日向へ溶かす。
// 柔らかさ（PCSS）＝まず周り 16 点の深度を読んで遮る物までの距離を平均し、その距離×係数（太陽の視直径 0.53° と空の光）を半影の幅にして
// 16 点の比較で平均する＝建物の足元は硬く、影の先ほど柔らかい。幅は 1〜8 texel に収める。
const SHADOW_WGSL = (g: number, b0 = 0): string => /* wgsl */`
struct ShadowP { mvp: mat4x4f, clipT: vec4f, anchor: vec4f, p: vec4f, cs: array<vec4f, 3>, cb: array<vec4f, 3>, q: vec4f };
@group(${g}) @binding(${b0}) var<uniform> SH: ShadowP;
@group(${g}) @binding(${b0 + 1}) var shTex: texture_depth_2d_array;
@group(${g}) @binding(${b0 + 2}) var shSamp: sampler_comparison;
var<private> SH_PD: array<vec2f, 16> = array<vec2f, 16>(
	vec2f(-0.94201624, -0.39906216), vec2f(0.94558609, -0.76890725), vec2f(-0.09418410, -0.92938870), vec2f(0.34495938, 0.29387760),
	vec2f(-0.91588581, 0.45771432), vec2f(-0.81544232, -0.87912464), vec2f(-0.38277543, 0.27676845), vec2f(0.97484398, 0.75648379),
	vec2f(0.44323325, -0.97511554), vec2f(0.53742981, -0.47373420), vec2f(-0.26496911, -0.41893023), vec2f(0.79197514, 0.19090188),
	vec2f(-0.24188840, 0.99706507), vec2f(-0.81409955, 0.91437590), vec2f(0.19984126, 0.78641367), vec2f(0.14383161, -0.14100790));
fn shClip(relA: vec3f) -> vec4f { return SH.clipT + SH.mvp * vec4f(relA, 0.0); }
// 点をずらした先では受け手自身の深さも変わる＝ずらした距離×面の傾きの上限（SH.cb[i].w＝cot(高度)・深度/uv）を足して比べる。
// これが無いと、広い半影で平らな屋根や地面が自分の影を拾ってまだらになる（低い太陽では 1 texel 動くと深さが cot(高度) texel 変わる）。
// 画面の微分（receiver plane）は使えない＝受け手の多くが分岐の中で影を読むので dpdx が一様な流れに置けない。足元は幅 1 texel＝足す量も小さい
fn shPcss(uv: vec2f, layer: i32, d: f32, i: u32) -> f32 {
	let g = SH.cb[i].w;
	let tx = SH.cb[i].y;
	let dim = vec2f(textureDimensions(shTex));
	var zs = 0.0; var zn = 0.0;
	for (var k = 0; k < 16; k++) {
		let o = SH_PD[k] * (tx * SH.q.w);
		let q = clamp(vec2i((uv + o) * dim), vec2i(0), vec2i(dim) - 1);
		let z = textureLoad(shTex, q, layer, 0);
		if (z < d + length(o) * g) { zs += z; zn += 1.0; }
	}
	if (zn < 0.5) { return 1.0; }   // 周りに遮る物が無い＝日向（比較の 16 点も省く）
	let w = clamp((d - zs / zn) * SH.q.y * SH.q.z / SH.cb[i].z, 1.0, 8.0) * tx;   // 半影の幅（uv）＝遮る物までの距離(m)×係数 を texel に直して 1〜8
	var s = 0.0;
	for (var k = 0; k < 16; k++) { let o = SH_PD[k] * w; s += textureSampleCompareLevel(shTex, shSamp, uv + o, layer, d + length(o) * g); }
	return s / 16.0;
}
// 段 i の日向の度合い（x）と、窓の縁までの距離（y・uv・≤0＝窓の外）
fn shAt(pb: vec3f, i: u32) -> vec2f {
	let c = SH.cs[i];
	let xy = pb.xy * c.x + c.yz;
	let uv = vec2f(xy.x * 0.5 + 0.5, 0.5 - xy.y * 0.5);
	let e = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
	if (e <= 0.0) { return vec2f(1.0, e); }
	var lit = shPcss(uv, i32(c.w), pb.z - SH.cb[i].x, i);
	if (i + 1u >= u32(SH.q.x)) {   // 基の窓＝縁は中心からの距離で丸く日向へ溶かす（#112 段 3）
		lit = mix(1.0, lit, 1.0 - smoothstep(SH.p.w, 1.0, length(xy)));
	}
	return vec2f(lit, e);
}
fn shLit(sc: vec4f) -> f32 {   // 1＝日向・0＝影
	if (sc.w <= 0.0) { return 1.0; }
	let pb = sc.xyz / sc.w;
	if (pb.z <= 0.0 || pb.z >= 1.0) { return 1.0; }
	let n = u32(SH.q.x);
	for (var i = 0u; i < n; i++) {
		let a = shAt(pb, i);
		if (a.y <= 0.0) { continue; }
		if (i + 1u < n && a.y < 0.04) {   // 段の縁の帯＝次の段と混ぜる（次の段の外なら混ぜない）
			let b = shAt(pb, i + 1u);
			if (b.y > 0.0) { return mix(b.x, a.x, a.y / 0.04); }
		}
		return a.x;
	}
	return 1.0;
}
fn shShade(col: vec3f, sc: vec4f) -> vec3f { return col * mix(SH.p.x, 1.0, shLit(sc)); }
`;
export const TERRAIN_SH_WGSL = deriveWgsl(TERRAIN_WGSL, [
	["\t@location(8) guv3: vec2f,\n};", "\t@location(8) guv3: vec2f,\n\t@location(9) sc: vec4f,\n};"],
	["\tlet relW = rel + (h * F.elevP.x) * liftDir(a_ll, dir);   // 楕円体＝測地法線\n", "\tlet relW = rel + (h * F.elevP.x) * liftDir(a_ll, dir);   // 楕円体＝測地法線\n\to.sc = shClip(relW + (F.originPt - SH.anchor.xyz));\n"],
	["\tvar col = mix(colBase, F.fogColor, in.fog);", "\tvar col = mix(shShade(colBase, in.sc), F.fogColor, in.fog);"],
	// 影の間の陰影（#112 段 2・本人裁定）＝北西の固定光でなく影と同じ太陽の方位（SH.mvp の 3 行目＝光の進む向き/Z＝shadow.time にも従う）。
	// 強さは従来と同じ（勾配 1 あたり 0.44＝旧式 (−hx+hy)·0.0007 を歩幅 ≈445m で換算）＝平地は 0.82・向きだけ太陽へ回す。太陽の高度では強めない
	//（ランバートを平地で割ると低い太陽で日向の斜面が全部 1.15 に飽和し、窓の外の遠い山がまだらになった＝富士で確認）。日の当たらない斜面は地形の影が暗くする
	["\tvar shade = clamp(0.82 + (-hx + hy) * 0.0007 * shadeK, 0.45, 1.15);", "\tlet sdir = -normalize(vec3f(SH.mvp[0].z, SH.mvp[1].z, SH.mvp[2].z));\n\tlet lr = in.ll * 0.017453292519943295;\n\tlet cl = cos(lr.y); let sl = sin(lr.y); let co = cos(lr.x); let so = sin(lr.x);\n\tlet sH = vec2f(dot(sdir, vec3f(-so, 0.0, co)), dot(sdir, vec3f(-sl * co, cl, -sl * so)));   // 太陽の方位（東・北）\n\tlet aH = sH / max(length(sH), 1e-6);\n\tlet gEN = vec2f(hx / (d * 111320.0 * max(cl, 0.01)), hy / (d * 111320.0));   // 勾配（東・北・m/m）\n\tvar shade = clamp(0.82 - 0.44 * dot(gEN, aH), 0.45, 1.15);"],
], "TERRAIN_SH_WGSL") + SHADOW_WGSL(3);
export const FILL_SH_WGSL = deriveWgsl(FILL_WGSL, [
	["\t@location(9) guv3: vec2f,\n};", "\t@location(9) guv3: vec2f,\n\t@location(10) sc: vec4f,\n};"],
	["\to.pos = p;\n\to.color = a_color;", "\to.pos = p;\n\to.sc = shClip(rel + (F.originPt - SH.anchor.xyz));\n\to.color = a_color;"],
	["mix(gndMix0(cogTexMix0(in.color.rgb, in.cuv), in.guv0, in.guv1, in.guv2, in.guv3), F.fogColor, in.fog)", "mix(shShade(gndMix0(cogTexMix0(in.color.rgb, in.cuv), in.guv0, in.guv1, in.guv2, in.guv3), in.sc), F.fogColor, in.fog)"],
], "FILL_SH_WGSL") + SHADOW_WGSL(2);
export const LINE_SH_WGSL = deriveWgsl(LINE_WGSL, [
	["\t@location(6) fog: f32,\n};", "\t@location(6) fog: f32,\n\t@location(7) sc: vec4f,\n};"],
	["\to.fog = fogOf((wa + wb) * 0.5);\n", "\to.fog = fogOf((wa + wb) * 0.5);\n\to.sc = shClip(select(relWb, relWa, corner.x < 0.5) + (F.originPt - SH.anchor.xyz));\n"],
	["\treturn vec4f(mix(lc.rgb, F.fogColor, in.fog) * ga, ga);", "\treturn vec4f(mix(shShade(lc.rgb, in.sc), F.fogColor, in.fog) * ga, ga);"],
], "LINE_SH_WGSL") + SHADOW_WGSL(2);
export const BUILDING_SH_WGSL = deriveWgsl(BUILDING_WGSL, [
	["\t@location(3) ll: vec2f,   // 絶対 lon/lat＝被覆マスクの uv 参照\n};", "\t@location(3) ll: vec2f,   // 絶対 lon/lat＝被覆マスクの uv 参照\n\t@location(4) sc: vec4f,\n};"],
	["\tlet relW = rel + h * liftDir(F.origin + a_pos.xy, dir);   // 楕円体＝測地法線\n", "\tlet relW = rel + h * liftDir(F.origin + a_pos.xy, dir);   // 楕円体＝測地法線\n\to.sc = shClip(relW + (F.originPt - SH.anchor.xyz));\n"],
	["\tlet c = mix(P.p0.rgb * in.shade, F.fogColor, in.fog);", "\tlet c = mix(shShade(P.p0.rgb * in.shade, in.sc), F.fogColor, in.fog);"],
], "BUILDING_SH_WGSL") + SHADOW_WGSL(3);
export const MESH_SH_WGSL = deriveWgsl(MESH_WGSL, [
	["\t@location(3) fog: f32,\n};", "\t@location(3) fog: f32,\n\t@location(4) sc: vec4f,\n};"],
	["\tvar p = B.clipMesh + F.mvp * vec4f(ap + h * liftDir(vec2f(lon, lat), dir), 0.0);   // 楕円体＝測地法線\n", "\tlet lp = ap + h * liftDir(vec2f(lon, lat), dir);\n\to.sc = shClip(B.meshOrigin.xyz - SH.anchor.xyz + lp);   // バッチ原点−main 原点（f32 差＝バッチ内一定の ≤0.4m）\n\tvar p = B.clipMesh + F.mvp * vec4f(lp, 0.0);\n"],
	["\tlet sunK = 1.0;   // 影の受け手", "\tlet sunK = shLit(in.sc);   // 影の受け手"],
	["\tvar lit = P.p1.rgb * d;   // 従来（fx.pbr off）\n", "\tvar lit = shShade(P.p1.rgb * d, in.sc);   // 従来（fx.pbr off）＝全体を暗く\n"],
], "MESH_SH_WGSL") + SHADOW_WGSL(3);
// 模型・3D Tiles・I3S・押し出し（uv と頂点色を持つメッシュ＝MESH_TEX）の受け手（#112 段 1）。影の束縛は group(2) の binding 1〜3（PB と同居）
export const MESH_TEX_SH_WGSL = deriveWgsl(MESH_TEX_WGSL, [
	["\t@location(5) col: vec4f,\n};", "\t@location(5) col: vec4f,\n\t@location(6) sc: vec4f,\n};"],
	["\tvar p = B.clipMesh + F.mvp * vec4f(ap + h * liftDir(vec2f(lon, lat), dir), 0.0);   // 楕円体＝測地法線\n", "\tlet lp = ap + h * liftDir(vec2f(lon, lat), dir);\n\to.sc = shClip(B.meshOrigin.xyz - SH.anchor.xyz + lp);   // バッチ原点−main 原点（MESH_SH と同じ）\n\tvar p = B.clipMesh + F.mvp * vec4f(lp, 0.0);\n"],
	["\tlet sunK = 1.0;   // 影の受け手", "\tlet sunK = shLit(in.sc);   // 影の受け手"],
	["\tvar lit = srgbEncode(tx.rgb) * d;   // 従来（fx.pbr off）", "\tvar lit = shShade(srgbEncode(tx.rgb) * d, in.sc);   // 従来（fx.pbr off）"],
], "MESH_TEX_SH_WGSL") + SHADOW_WGSL(2, 1);
export const GLOBE_SH_WGSL = deriveWgsl(GLOBE_WGSL, [
	["\tlet col = atmGround(base, A, Pt, normalize(A - Pt), G.sun.w);", "\tbase = shShade(base, shClip(Pt - SH.anchor.xyz));   // 球の床（海抜0）＝低地と真俯瞰の地面\n\tlet col = atmGround(base, A, Pt, normalize(A - Pt), G.sun.w);"],
], "GLOBE_SH_WGSL") + SHADOW_WGSL(1);
// 影を落とす側（太陽からの深度だけ描く）：本体の頂点計算そのまま・対数深度だけ外す（正射影 w=1＝行列の z が線形の深度）。
// 基図の押し出し建物は被覆マスクの discard だけ残す（PLATEAU メッシュが立つ所で二重に影を落とさない）。メッシュは頂点だけのパイプライン。
export const BUILDING_CAST_WGSL = deriveWgsl(BUILDING_WGSL, [
	["\tp.z = logDepthZ(p.w);\n\to.pos = p;", "\to.pos = p;"],
	["@fragment fn fs(in: BldOut) -> @location(0) vec4f {\n\tif (in.front < 0.0) { discard; }", "@fragment fn fs(in: BldOut) {"],
	["\tlet c = mix(P.p0.rgb * in.shade, F.fogColor, in.fog);\n\treturn vec4f(c * P.p0.w, P.p0.w);   // ×グローバルα（クロスフェード・通常1＝不変）\n}", "}"],
], "BUILDING_CAST_WGSL");
export const MESH_CAST_WGSL = deriveWgsl(MESH_WGSL, [
	["\tp.z = logDepthZ(p.w);\n", ""],
], "MESH_CAST_WGSL");
// 模型の MASK（葉などの切り抜き・alphaCutoff）の落とす側（#112 段 4）＝模型の頂点計算そのまま・対数深度だけ外す＋α で抜く FS（本体の `tx.a < B.alpha.x` と同じ判定）。
// 葉が四角い影になっていた（頂点だけのパイプラインは α を見ない）。BLEND の模型は落とさない（本人裁定）
export const MESH_TEX_CAST_WGSL = deriveWgsl(MESH_TEX_WGSL, [
	["\tp.z = logDepthZ(p.w);\n", ""],
], "MESH_TEX_CAST_WGSL") + `
@fragment fn fsCast(in: PlOut) {
	let a = textureSample(texT, texS, in.uv).a * in.col.a;
	if (a < B.alpha.x) { discard; }
}
`;
// 地形も影を落とす（#112 段 2・影の窓の中だけ）＝本体の頂点計算そのまま（同じ窓・同じ距離フェード＝画面の地形と同じ形）・対数深度だけ外す。頂点だけのパイプライン
export const TERRAIN_CAST_WGSL = deriveWgsl(TERRAIN_WGSL, [
	["\tp.z = logDepthZ(p.w);\n\to.pos = p;", "\to.pos = p;"],
], "TERRAIN_CAST_WGSL");

// ── 断面とクリッピング平面（#111 段 0〜2・2026-09-29）＝切っている時だけ使う派生シェーダ（影と同じ約束＝本体は 1 バイトも変えない・WebGPU 専用）。
// 面＝CL.pl[i]＝(n.xyz, K)・距離 d＝n·rel + K（rel＝その描画の原点からの相対位置・K＝n·originPt − c を CPU f64 で＝clip.js packClip）。全部の面で d ≥ 0 の所だけ残す（交わり＝箱）。
// 距離は VS で頂点ごと・**面ごとに**出して補間（1 枚の距離は三角形の中で線形＝FS で厳密）・最小は FS で取る（頂点で最小を取って補間すると、
// 両端が箱の外にある大きな三角形は中身ごと消える＝基図の屋根 2 枚で踏んだ）。使わない面は 1e30。discard は FS の微分より後（一様制御フロー）。
// 段 2：CL に蓋と縁の帯（capT＝地形の蓋の色・capB＝建物の疑似の蓋の色（w＝点ける）・edgeC＝帯の色・p.y＝帯の幅 CSS px）。
// 置き場は「空いている group の binding b0 から」＝影と重ねる時は影の束縛の後ろ（b0＝3・模型は 4）。
const CLIP_WGSL = (g: number, b0 = 0): string => /* wgsl */`
struct ClipP { pl: array<vec4f, 6>, p: vec4f, capT: vec4f, capB: vec4f, edgeC: vec4f, pe: vec4f, pn: vec4f, pv: array<vec4f, 64> };   // p.x＝面の枚数（clip.js CLIP_MAX と対）・p.y＝縁の帯の幅（CSS px・0＝無し）・p.z＝多角形の辺の数（CLIP_POLY_MAX と対）・p.w＝1 で内側だけ残す
@group(${g}) @binding(${b0}) var<uniform> CL: ClipP;
// 多角形（P0 #4）：pe・pn＝重心の接平面の東・北（w＝K）・pv[i]＝辺 (a.xy, b.xy)。2D の点は原点相対の位置から線形＝頂点で出して補間してよい
fn polyXY(rel: vec3f) -> vec2f { return vec2f(dot(CL.pe.xyz, rel) + CL.pe.w, dot(CL.pn.xyz, rel) + CL.pn.w); }
fn polyD(q: vec2f) -> f32 {   // 符号付きの距離（残る側が正）＝辺までの最短・内外は偶奇
	let n = u32(CL.p.z);
	if (n == 0u) { return 1e30; }
	var d2 = 1e30;
	var inside = false;
	for (var i = 0u; i < n; i++) {
		let a = CL.pv[i].xy; let b = CL.pv[i].zw;
		if ((a.y > q.y) != (b.y > q.y) && q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x) { inside = !inside; }
		let v = b - a; let t = clamp(dot(q - a, v) / max(dot(v, v), 1e-30), 0.0, 1.0); let w = q - a - t * v;
		d2 = min(d2, dot(w, w));
	}
	var d = sqrt(d2);
	if (inside != (CL.p.w > 0.5)) { d = -d; }
	return d;
}
fn clipDist(rel: vec3f) -> f32 {   // 画素で位置が分かる時（球の床・蓋）＝全部の面と多角形の最小
	var d = 1e30;
	let n = u32(CL.p.x);
	for (var i = 0u; i < n; i++) { d = min(d, dot(CL.pl[i].xyz, rel) + CL.pl[i].w); }
	return min(d, polyD(polyXY(rel)));
}
fn clipD(rel: vec3f, i: u32) -> f32 { if (i < u32(CL.p.x)) { return dot(CL.pl[i].xyz, rel) + CL.pl[i].w; } return 1e30; }
fn clipA(rel: vec3f) -> vec4f { return vec4f(clipD(rel, 0u), clipD(rel, 1u), clipD(rel, 2u), clipD(rel, 3u)); }   // 面 0〜3 の距離（頂点）
fn clipB(rel: vec3f) -> vec4f { return vec4f(clipD(rel, 4u), clipD(rel, 5u), polyXY(rel)); }                    // 面 4〜5＋多角形の 2D の点
fn clipMin(a: vec4f, b: vec4f) -> f32 { return min(min(min(min(a.x, a.y), min(a.z, a.w)), min(b.x, b.y)), polyD(b.zw)); }   // 画素で最小（負＝どれかの面の外か多角形で消す側）
fn clipOut(a: vec4f, b: vec4f) -> bool { return clipMin(a, b) < 0.0; }
`;
// 切る派生を本体から作る（影の派生 *_SH_WGSL からも同じ差分で作れる＝影と重ねる版）。kind ごとの差分の表：
// ・struct には cdA/cdB を足す（場所は影の sc と重ならない番号）・VS で面ごとの距離・FS の頭で discard（＋縁の帯・建物の疑似の蓋）
// 同じ段で錨が 2 通りある所（建物メッシュの VS＝本体と影の派生で書き方が違う）は、先に見つかった方を使う
/** 段ごとの錨の候補（先に見つかった方を使う）。 */
type WgslAlts = readonly WgslPair[];
const deriveAlt = (src: string, steps: readonly WgslAlts[], label: string): string => steps.reduce((s, alts) => {
	for (const [a, b] of alts) { const k = s.split(a).length; if (k === 2) return s.replace(a, b); if (k > 2) throw new Error(`wgsl derive(${label}): anchor ambiguous: ${a.slice(0, 50)}`); }
	throw new Error(`wgsl derive(${label}): anchor missing: ${alts[0][0].slice(0, 50)}`);
}, src);
const CD = (at: string, loc: number): WgslAlts => [[at, `${at}\t@location(${loc}) cdA: vec4f,\n\t@location(${loc + 1}) cdB: vec4f,\n`]];
const CD_SET = (rel: string): string => `o.cdA = clipA(${rel}); o.cdB = clipB(${rel});`;
// 縁の帯（地形・建物・模型）＝画素で最小の距離がその画面微分の p.y 倍（CSS px×dpr）より小さい所を帯の色に。微分は discard より前
const EDGE_HEAD = "\tlet cm = clipMin(in.cdA, in.cdB); let cw = fwidth(cm);\n\tif (cm < 0.0) { discard; }\n\tif (CL.p.y > 0.0 && cm < CL.p.y * F.params.w * cw) { return vec4f(CL.edgeC.rgb, 1.0); }\n";
const EDGE_FLAG = "\tlet cm = clipMin(in.cdA, in.cdB); let cw = fwidth(cm);\n\tif (cm < 0.0) { discard; }\n\tlet edgeOn = CL.p.y > 0.0 && cm < CL.p.y * F.params.w * cw;\n";   // 帯を最後に塗る版（地形）
const DISCARD = "\tif (clipOut(in.cdA, in.cdB)) { discard; }\n";
const MESH_VS: WgslAlts = [
	["\tvar p = B.clipMesh + F.mvp * vec4f(ap + h * liftDir(vec2f(lon, lat), dir), 0.0);   // 楕円体＝測地法線\n", `\tlet lp = ap + h * liftDir(vec2f(lon, lat), dir);\n\t${CD_SET("B.clipO.xyz + lp")}\n\tvar p = B.clipMesh + F.mvp * vec4f(lp, 0.0);\n`],
	["\tvar p = B.clipMesh + F.mvp * vec4f(lp, 0.0);\n", `\t${CD_SET("B.clipO.xyz + lp")}\n\tvar p = B.clipMesh + F.mvp * vec4f(lp, 0.0);\n`],   // 影の派生（lp は既にある）
];
const PB_CLIPO: WgslAlts = [["sh: array<vec4f, 9>, pad: vec4f,", "sh: array<vec4f, 9>, clipO: vec4f,"]];   // 建物メッシュ・模型のバッチ原点 − main 原点（PB の空き 16B・CPU f64 の差）
// 建物の疑似の蓋（閉じた建物＝裏面を捨てる物だけ）：切っている間は裏面を蓋の色で塗る＝切り口から中を覗くと断面に見える（両面のデータ＝上屋・橋は今のまま）
const MESH_CAP: WgslAlts = [["\tif (B.meshOrigin.w > 0.5 && fe < -0.02) { discard; }\n", "\tif (B.meshOrigin.w > 0.5 && fe < -0.02) { if (CL.capB.w > 0.5) { return vec4f(CL.capB.rgb, 1.0); } discard; }\n"]];
type ClipKind = "terr" | "mesh" | "meshTex" | "fill" | "line" | "bld" | "globe" | "terrCast" | "meshCast" | "meshTexCast" | "bldCast";
const CLIP_STEPS: Record<ClipKind, readonly WgslAlts[]> = {
	terr: [CD("\t@location(8) guv3: vec2f,\n", 10),
		[["\tlet relW = rel + (h * F.elevP.x) * liftDir(a_ll, dir);   // 楕円体＝測地法線\n", `\tlet relW = rel + (h * F.elevP.x) * liftDir(a_ll, dir);   // 楕円体＝測地法線\n\t${CD_SET("relW")}\n`]],
		[["\tlet mpp = terrMpp(in.ll);   // 画素の地上寸法(m)＝下の低地フェード帯の上端。微分は discard より前（一様制御フロー）\n", "\tlet mpp = terrMpp(in.ll);   // 画素の地上寸法(m)＝下の低地フェード帯の上端。微分は discard より前（一様制御フロー）\n" + EDGE_FLAG]],
		// 地形は帯の早期 return を最後へ（この後に地面アトラスの textureSample＝暗黙の微分がある＝一様制御フローの外で呼べない）
		[["\treturn vec4f(col * t * P.p2.w, t * P.p2.w);", "\tif (edgeOn) { return vec4f(CL.edgeC.rgb, 1.0); }\n\treturn vec4f(col * t * P.p2.w, t * P.p2.w);"]]],
	mesh: [PB_CLIPO, CD("\t@location(3) fog: f32,\n", 5), MESH_VS,
		[["\tlet gnRaw = cross(dpdx(in.toEye), dpdy(in.toEye));\n", "\tlet gnRaw = cross(dpdx(in.toEye), dpdy(in.toEye));\n" + EDGE_HEAD]], MESH_CAP],
	meshTex: [PB_CLIPO, CD("\t@location(5) col: vec4f,\n", 7), MESH_VS,
		[["\tlet dpx = dpdx(in.toEye); let dpy = dpdy(in.toEye); let dux = dpdx(in.uv); let duy = dpdy(in.uv);   // 法線マップの接線（微分＝ここで確定）\n", "\tlet dpx = dpdx(in.toEye); let dpy = dpdy(in.toEye); let dux = dpdx(in.uv); let duy = dpdy(in.uv);   // 法線マップの接線（微分＝ここで確定）\n" + EDGE_HEAD]], MESH_CAP],
	fill: [CD("\t@location(9) guv3: vec2f,\n", 11),
		[["\to.color = a_color;", `\t${CD_SET("rel")}\n\to.color = a_color;`]],
		[["@fragment fn fs(in: FillOut) -> @location(0) vec4f {\n", "@fragment fn fs(in: FillOut) -> @location(0) vec4f {\n" + DISCARD]]],
	line: [CD("\t@location(6) fog: f32,\n", 8),
		[["\to.fog = fogOf((wa + wb) * 0.5);\n", `\to.fog = fogOf((wa + wb) * 0.5);\n\tlet cpos = select(relWb, relWa, corner.x < 0.5);   // 端点ごと＝線分に沿って線形（幅の張り出しは同じ値）\n\t${CD_SET("cpos")}\n`]],
		[["@fragment fn fs(in: LineOut) -> @location(0) vec4f {\n", "@fragment fn fs(in: LineOut) -> @location(0) vec4f {\n" + DISCARD]]],
	bld: [CD("\t@location(3) ll: vec2f,   // 絶対 lon/lat＝被覆マスクの uv 参照\n", 5),
		[["\tlet relW = rel + h * liftDir(F.origin + a_pos.xy, dir);   // 楕円体＝測地法線\n", `\tlet relW = rel + h * liftDir(F.origin + a_pos.xy, dir);   // 楕円体＝測地法線\n\t${CD_SET("relW")}\n`]],
		[["@fragment fn fs(in: BldOut) -> @location(0) vec4f {\n", "@fragment fn fs(in: BldOut) -> @location(0) vec4f {\n" + EDGE_HEAD]]],   // 基図の押し出し建物は面の向きが揃っていない（リングの向き・earcut 任せ）＝疑似の蓋は付けず帯だけ
	// 球の床（海抜 0・海面を含む）：交点の原点相対 δ＝eyeO＋t·d（#65・f32 で mm 級）で測る＝空と大気のリムは切らない
	globe: [[["\tlet Pt = A + t * d;                                                       // 絶対（霞・大気・低ズームの粗い用途）\n", "\tlet Pt = A + t * d;                                                       // 絶対（霞・大気・低ズームの粗い用途）\n\tif (clipDist(G.eyeO.xyz + t * d) < 0.0) { discard; }\n"]]],
	// 影の深度パス（落とす側）＝切った形で落とす。頂点だけのパイプラインには FS（fsClip）を足す
	terrCast: [CD("\t@location(8) guv3: vec2f,\n", 10),
		[["\tlet relW = rel + (h * F.elevP.x) * liftDir(a_ll, dir);   // 楕円体＝測地法線\n", `\tlet relW = rel + (h * F.elevP.x) * liftDir(a_ll, dir);   // 楕円体＝測地法線\n\t${CD_SET("relW")}\n`]]],
	meshCast: [PB_CLIPO, CD("\t@location(3) fog: f32,\n", 5), MESH_VS],
	meshTexCast: [PB_CLIPO, CD("\t@location(5) col: vec4f,\n", 7), MESH_VS, [["@fragment fn fsCast(in: PlOut) {\n", "@fragment fn fsCast(in: PlOut) {\n" + DISCARD]]],
	bldCast: [CD("\t@location(3) ll: vec2f,   // 絶対 lon/lat＝被覆マスクの uv 参照\n", 5),
		[["\tlet relW = rel + h * liftDir(F.origin + a_pos.xy, dir);   // 楕円体＝測地法線\n", `\tlet relW = rel + h * liftDir(F.origin + a_pos.xy, dir);   // 楕円体＝測地法線\n\t${CD_SET("relW")}\n`]],
		[["@fragment fn fs(in: BldOut) {", "@fragment fn fs(in: BldOut) {\n" + DISCARD]]],
};
const clipDerive = (src: string, kind: ClipKind, label: string, g: number, b0 = 0, tail = ""): string => deriveAlt(src, CLIP_STEPS[kind], label) + CLIP_WGSL(g, b0) + tail;
// 切るだけ（段 0〜1）
export const TERRAIN_CLIP_WGSL = clipDerive(TERRAIN_WGSL, "terr", "TERRAIN_CLIP_WGSL", 3);
export const MESH_CLIP_WGSL = clipDerive(MESH_WGSL, "mesh", "MESH_CLIP_WGSL", 3);
export const MESH_TEX_CLIP_WGSL = clipDerive(MESH_TEX_WGSL, "meshTex", "MESH_TEX_CLIP_WGSL", 2, 1);   // group 4 枚を使い切る＝group(2) の binding 1（PB と同居）
export const FILL_CLIP_WGSL = clipDerive(FILL_WGSL, "fill", "FILL_CLIP_WGSL", 2);
export const LINE_CLIP_WGSL = clipDerive(LINE_WGSL, "line", "LINE_CLIP_WGSL", 2);
export const BUILDING_CLIP_WGSL = clipDerive(BUILDING_WGSL, "bld", "BUILDING_CLIP_WGSL", 3);
export const GLOBE_CLIP_WGSL = clipDerive(GLOBE_WGSL, "globe", "GLOBE_CLIP_WGSL", 1);
// 影と重ねる（段 2）＝影の受け手の派生にさらに面を足す（面の束縛は影の後ろ＝binding 3・模型は 4）
export const TERRAIN_SH_CLIP_WGSL = clipDerive(TERRAIN_SH_WGSL, "terr", "TERRAIN_SH_CLIP_WGSL", 3, 3);
export const MESH_SH_CLIP_WGSL = clipDerive(MESH_SH_WGSL, "mesh", "MESH_SH_CLIP_WGSL", 3, 3);
export const MESH_TEX_SH_CLIP_WGSL = clipDerive(MESH_TEX_SH_WGSL, "meshTex", "MESH_TEX_SH_CLIP_WGSL", 2, 4);
export const FILL_SH_CLIP_WGSL = clipDerive(FILL_SH_WGSL, "fill", "FILL_SH_CLIP_WGSL", 2, 3);
export const LINE_SH_CLIP_WGSL = clipDerive(LINE_SH_WGSL, "line", "LINE_SH_CLIP_WGSL", 2, 3);
export const BUILDING_SH_CLIP_WGSL = clipDerive(BUILDING_SH_WGSL, "bld", "BUILDING_SH_CLIP_WGSL", 3, 3);
export const GLOBE_SH_CLIP_WGSL = clipDerive(GLOBE_SH_WGSL, "globe", "GLOBE_SH_CLIP_WGSL", 1, 3);
// 影の深度パスも切った形で（段 2）：地形は group(1)・基図の建物と建物メッシュは group(3)・模型は group(2) の binding 1
export const TERRAIN_CAST_CLIP_WGSL = clipDerive(TERRAIN_CAST_WGSL, "terrCast", "TERRAIN_CAST_CLIP_WGSL", 1, 0, `
@fragment fn fsClip(in: TerrOut) { if (clipOut(in.cdA, in.cdB)) { discard; } }
`);
export const MESH_CAST_CLIP_WGSL = clipDerive(MESH_CAST_WGSL, "meshCast", "MESH_CAST_CLIP_WGSL", 3, 0, `
@fragment fn fsClip(in: PlOut) { if (clipOut(in.cdA, in.cdB)) { discard; } }
`);
export const MESH_TEX_CAST_CLIP_WGSL = clipDerive(MESH_TEX_CAST_WGSL, "meshTexCast", "MESH_TEX_CAST_CLIP_WGSL", 2, 1);
export const BUILDING_CAST_CLIP_WGSL = clipDerive(BUILDING_CAST_WGSL, "bldCast", "BUILDING_CAST_CLIP_WGSL", 3);

// オーバーレイ（外部ベクタの塗り・周辺マスク・段 3）＝覆うパスで画素ごとに切る（扇の画素は地表の点でない＝扇では切れない）。
// 画素の視線を海抜 0 の球に当て、その地点の地表の高さ（塗りと同じ elevQ＋リフト）の球へ 2 回詰める＝ドレープした塗りの点。
// 面は group(2)（オーバーレイの原点ごとの K＝dynamic offset）。線は LINE_CLIP_WGSL をそのまま使う
export const OVERLAY_CLIP_WGSL = deriveAlt(OVERLAY_WGSL, [
	[["@fragment fn fsCover(in: CoOut) -> @location(0) vec4f {\n", "@fragment fn fsCover(in: CoOut) -> @location(0) vec4f {\n\tif (ovClipped(in.pos.xy)) { discard; }\n"]],
], "OVERLAY_CLIP_WGSL") + CLIP_WGSL(2) + /* wgsl */`
fn ovClipped(px: vec2f) -> bool {
	let ndc = vec2f(px.x / F.viewport.x * 2.0 - 1.0, 1.0 - px.y / F.viewport.y * 2.0);
	let d = F.rayF.xyz + ndc.x * F.rayX.xyz + ndc.y * F.rayY.xyz;
	let aa = dot(d, d); let bb = 2.0 * dot(F.eyeC.xyz, d);
	let O = F.originPt; let rho = length(O.xz);
	var hW = 0.0;   // 球の半径の上乗せ（単位球）＝地表の高さ
	var rel = vec3f(0.0);
	for (var k = 0; k < 3; k++) {
		let cc = F.eyeC.w - (2.0 * hW + hW * hW);   // |E|² − (1+h)²（|E|²−1 は CPU f64）
		let disc = bb * bb - 4.0 * aa * cc;
		if (disc < 0.0 || (bb >= 0.0 && cc >= 0.0)) { return true; }
		let q = -bb + sqrt(disc);
		if (q <= 0.0) { return true; }
		rel = F.eyeO.xyz + (2.0 * cc / q) * d;
		let dll = deltaLL(rel, O, rho, F.eyeO.w, F.ellP.x);
		hW = (elevQ(F.origin + dll) + P.p0.y) * F.elevP.x;
	}
	return clipDist(rel) < 0.0;
}
`;

// 地形の蓋（段 2・本人裁定＝鉛直面は縦の幕・水平面は板）：面ごとに、その面の上の大きな四角を 1 枚（instance＝面の番号）。
// FS で画素の点 X（原点相対）の「足」（測地法線に沿って地表へ下ろした点の経緯度）と高さ z を出し、床（海抜 0）≤ z ≤ 地表 の所だけ塗る＝地面の中の断面。
// 地表の高さは地形メッシュと同じ折れ線面（格子頂点で elev×距離フェード・同じ対角 a-c-b / b-c-d）＝地形の切り口と画素で合う。
// 格子の位置は原点相対（CP.g＝(原点の格子座標, 格子/度) を CPU f64 で）＝絶対経緯度（f32 で 1.4 m 刻み）を経ない。
// 四角は大きい（窓の対角ほど・隅は目の後ろにも回る）＝深度は画素ごとに書く（frag_depth＝対数深度は頂点だけで書くと大きな三角形が撓む・#62）。
// 他の面の外は捨てる（箱の角）。近窓（terrain スロット）と遠窓（terrainFar・近窓の内側は捨てる）の 2 回＝地形と同じ分担。
export const CLIP_CAP_WGSL = /* wgsl */`
${FRAME}
${CLIP_WGSL(1, 0)}
struct CapP { g: vec4f, h: vec4f, q: array<vec4f, 18> };   // g＝(原点の格子座標 xy, 格子/度 xy)・h＝(G−1, 遠窓の回, 0, 0)・q[i*3..]＝面 i の四角（中心の原点相対 xyz, 軸 A, 軸 B）
@group(1) @binding(1) var<uniform> CP: CapP;
struct CapOut { @builtin(position) pos: vec4f, @location(0) x: vec3f, @location(1) @interpolate(flat) pi: u32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> CapOut {
	var o: CapOut;
	var cs = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
	let c = cs[vi];
	let X = CP.q[ii * 3u].xyz + c.x * CP.q[ii * 3u + 1u].xyz + c.y * CP.q[ii * 3u + 2u].xyz;
	var p = F.clipT + F.mvp * vec4f(X, 0.0);
	p.z = 0.5 * p.w;   // 深度は FS で画素ごとに書く＝頂点の z はクリップ（0≤z≤w＝目の面 w=0 で正しく切る）のためだけ。対数深度を頂点に書くと、目の後ろへ回った隅（w<0）で z が壊れ、見えている部分まで切り落とされた
	o.pos = p; o.x = X; o.pi = ii;
	return o;
}
fn capDf(dll: vec2f) -> f32 {   // 地形の頂点と同じ距離フェード（遠景の平ら化）
	let dir = F.originPt + deltaToRel(dll);
	return 1.0 - smoothstep(F.params.y * 0.8, F.params.y * 2.0, distance(F.eye, dir));
}
fn capVert(gi: vec2f) -> f32 {   // 格子頂点 gi の高さ（地形の VS と同じ：絶対経緯度＝窓の原点＋窓の幅×uv）
	let N = CP.h.x;
	let ll = F.mesh.xy + F.mesh.zw * (gi / N);
	return elev(ll) * capDf(ll - F.origin);
}
struct CapFrag { @location(0) c: vec4f, @builtin(frag_depth) d: f32 };
@fragment fn fs(in: CapOut) -> CapFrag {
	let X = in.x;
	// 他の面の外（箱の角）
	let n = u32(CL.p.x);
	for (var i = 0u; i < n; i++) { if (i != in.pi && dot(CL.pl[i].xyz, X) + CL.pl[i].w < 0.0) { discard; } }
	if (polyD(polyXY(X)) < 0.0) { discard; }   // 多角形で消す側（P0 #4）
	// 足と高さ：動径の足から始めて、測地法線に沿って 2 回詰める（楕円体の法線は動径から最大 0.19° 開く）
	let O = F.originPt; let rho = length(O.xz);
	var dll = deltaLL(X, O, rho, F.eyeO.w, F.ellP.x);
	var z = 0.0;
	for (var k = 0; k < 2; k++) {
		let u = deltaToRel(dll);
		let L = liftDir(F.origin + dll, O + u);
		z = dot(X - u, L) / dot(L, L);
		dll = deltaLL(X - z * L, O, rho, F.eyeO.w, F.ellP.x);
	}
	let zm = z / max(F.elevP.x, 1e-30);
	if (zm < 0.0) { discard; }   // 床（海抜 0）より下＝地面の外
	if (dot(O + deltaToRel(dll), F.eye) - 1.0 < -0.0015) { discard; }   // 地平線の向こう（地形と同じ）
	// 窓の分担：近窓の回＝窓の外を捨てる／遠窓の回＝近窓（標高アトラス）の内側を捨てる
	let N = CP.h.x;
	let gc = CP.g.xy + dll * CP.g.zw;
	if (CP.h.y > 0.5) {
		let uvN = (F.origin + dll - F.elevBounds.xy) / F.elevBounds.zw;
		if (uvN.x >= 0.0 && uvN.x <= 1.0 && uvN.y >= 0.0 && uvN.y <= 1.0) { discard; }
	}
	if (gc.x < 0.0 || gc.y < 0.0 || gc.x > N || gc.y > N) { discard; }
	// 地表の高さ＝地形メッシュと同じ三角形
	let g = min(gc, vec2f(N - 1e-4));
	let gi = floor(g); let gf = g - gi;
	var ht: f32;
	if (gf.x + gf.y < 1.0) { let h00 = capVert(gi); ht = h00 + gf.x * (capVert(gi + vec2f(1.0, 0.0)) - h00) + gf.y * (capVert(gi + vec2f(0.0, 1.0)) - h00); }
	else { let h11 = capVert(gi + vec2f(1.0)); ht = h11 + (1.0 - gf.x) * (capVert(gi + vec2f(0.0, 1.0)) - h11) + (1.0 - gf.y) * (capVert(gi + vec2f(1.0, 0.0)) - h11); }
	if (zm > ht) { discard; }   // 地表より上＝空
	var out: CapFrag;
	out.c = vec4f(mix(CL.capT.rgb, F.fogColor, fogOf(O + X)), 1.0);
	let pc = F.clipT + F.mvp * vec4f(X, 0.0);
	out.d = fragDepthOf(pc.w);   // 級数の log1p（#62・0.76m の階段を作らない）
	return out;
}
`;

// 標高セルの GPU 再標本化（perf plan P1 step 1・2026-09-27）＝elevation.js downsampleFlipped／cropResample・elevation/worldatlas.js worldAtlasCell と同式。
// 生タイル（Int16＝u32 に 2 texel・Float32＝bitcast）は storage buffer（writeTexture の 256B 行整列を避ける＝再パック無し・1 タイル 1 回の上げで何セルでも切り出せる）。
// 出力＝アトラス（r16float）のセル矩形へ fullscreen 三角形 1 発（viewport/scissor＝セル）。行は南上げ（row0=南）＝CPU 経路と同じ配置。
// mode 0＝downsampleFlipped・2＝cropResample：標本位置 gx = (Ax + Bx·(2i+1)) / Dx を u32 の整数で厳密に（商＝x0・余り/Dx＝fx）＝JS の f64 と同じ位置
//（f32 で gx を作ると 3600 texel で 1e-4 texel ずれ＝急斜面や異常値の隣で cm 級の差が出た）。mode 0 は [M, w−1−M] に clamp（縁 2px の fill を読まない）・mode 2 は x0∈[0, w−2]・fx∈[0,1]。
// mode 3＝浮動小数の一般形（切り出しの幾何が整数で書けない時の退避）。mode 1＝箱平均（全球アトラスの切り出し＝k×k の和 / k²・異常値の篩なし）。
// 異常値（<−420／>9000／NaN）→0 は補間モードだけ（CPU と同じ）。出力は負値→0。
export const ELEV_RESAMPLE_WGSL = /* wgsl */`
struct RP {
	dim: vec4u,   // w, h, kind(0=Int16 1=Float32), mode(0=down 1=box 2=crop 3=float)
	a: vec4f,     // mode 3: ax, bx, ay, by（gx = ax + bx·(i+0.5)）
	lo: vec4f,    // mode 3: gx∈[x,y]・gy∈[z,w]
	o: vec4u,     // ox, oy（セル原点 texel）, N, k
	box: vec4u,   // mode 1: AW, rowN0, col0, 0／mode 0: M（読まない最外周の画素数）
	ix: vec4u,    // mode 0/2: Ax, Bx, Dx, shift（gx = (Ax + Bx·(2i+1))/Dx − shift＝画素中心の −½ を符号なしで書くための下駄・2026-10-02）
	iy: vec4u,    // mode 0/2: Ay, By, Dy, shift
};
@group(0) @binding(0) var<uniform> R: RP;
@group(0) @binding(1) var<storage, read> raw: array<u32>;
fn rdRaw(idx: u32) -> f32 {
	if (R.dim.z == 0u) { return f32(extractBits(bitcast<i32>(raw[idx >> 1u]), (idx & 1u) * 16u, 16u)); }
	return bitcast<f32>(raw[idx]);
}
fn rd(idx: u32) -> f32 {
	let v = rdRaw(idx);
	if (!(v >= select(-420.0, -11500.0, R.box.w == 1u) && v <= 9000.0)) { return 0.0; }   // 異常値（int16 巨大値／-9999／NaN）は 0（box.w＝1：海底＝GEBCO の負値を通す）
	return v;
}
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
	return vec4f(f32(i32(vi & 1u) * 4 - 1), f32(i32(vi >> 1u) * 4 - 1), 0.0, 1.0);   // (-1,-1) (3,-1) (-1,3)
}
@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
	let i = u32(pos.x) - R.o.x; let j = u32(pos.y) - R.o.y;   // セル内 (列, 南からの行)
	let w = R.dim.x; let h = R.dim.y; let mode = R.dim.w;
	var v: f32;
	if (mode == 1u) {
		let k = R.o.w; let C = R.o.z * k;
		let srcRow = R.box.y + (C - 1u - j * k);
		var sum = 0.0;
		for (var jj = 0u; jj < k; jj++) { let s = (srcRow - jj) * R.box.x + R.box.z + i * k; for (var ii = 0u; ii < k; ii++) { sum += rdRaw(s + ii); } }
		v = sum / f32(k * k);
	} else {
		var x0: u32; var fx: f32; var y0: u32; var fy: f32;
		if (mode == 3u) {
			let gx = clamp(R.a.x + R.a.y * (f32(i) + 0.5), R.lo.x, R.lo.y);
			let gy = clamp(R.a.z + R.a.w * (f32(j) + 0.5), R.lo.z, R.lo.w);
			x0 = u32(clamp(floor(gx), 0.0, f32(w - 2u))); fx = clamp(gx - f32(x0), 0.0, 1.0);
			y0 = u32(clamp(floor(gy), 0.0, f32(h - 2u))); fy = clamp(gy - f32(y0), 0.0, 1.0);
		} else {
			let nx = R.ix.x + R.ix.y * (2u * i + 1u); var qx = nx / R.ix.z; let rx = nx - qx * R.ix.z;
			let ny = R.iy.x + R.iy.y * (2u * j + 1u); var qy = ny / R.iy.z; let ry = ny - qy * R.iy.z;
			let negx = qx < R.ix.w; let negy = qy < R.iy.w;   // gx < 0（タイル西端・南端の半画素）＝画素 0 でクランプ（CPU の x0=0・fx=0 と同じ）
			qx = select(qx - R.ix.w, 0u, negx); qy = select(qy - R.iy.w, 0u, negy);
			x0 = qx; fx = select(f32(rx) / f32(R.ix.z), 0.0, negx); y0 = qy; fy = select(f32(ry) / f32(R.iy.z), 0.0, negy);
			if (mode == 0u) {   // downsampleFlipped：gx を [M, w−1−M] に clamp
				let M = R.box.x;
				if (qx < M) { x0 = M; fx = 0.0; } else if (qx > w - 1u - M || (qx == w - 1u - M && rx > 0u)) { x0 = w - 1u - M; fx = 0.0; }
				if (qy < M) { y0 = M; fy = 0.0; } else if (qy > h - 1u - M || (qy == h - 1u - M && ry > 0u)) { y0 = h - 1u - M; fy = 0.0; }
			} else {            // cropResample：x0 = clamp(floor, 0, w−2)・fx = clamp(gx − x0, 0, 1)
				if (qx > w - 2u) { x0 = w - 2u; fx = 1.0; }
				if (qy > h - 2u) { y0 = h - 2u; fy = 1.0; }
			}
		}
		let r0 = (h - 1u - y0) * w; let r1 = r0 - w;   // データ行（北上げ）：y0 の行と 1 行北
		let a = rd(r0 + x0); let b = rd(r0 + x0 + 1u); let c = rd(r1 + x0); let d = rd(r1 + x0 + 1u);
		let t = a + (b - a) * fx;
		v = t + ((c + (d - c) * fx) - t) * fy;
	}
	return vec4f(select(max(v, 0.0), v, R.box.w == 1u), 0.0, 0.0, 1.0);
}
`;

// ── 深度を画素で書く（#62・2026-09-29）＝対数深度を頂点だけで書くと大きな三角形の内側が撓む（z_ndc＝log(w)/w が画面上で直線補間される・
// 真は 1/w が直線）。超近景（z19 級）の地形の格子（数十 m）で撓みの傾きが AO の接平面の下駄に届き、斜めの薄い陰の帯になった。
// 深度を書く本パス（地形・押し出し建物・メッシュ・模型＝main と影の受け手と断面の派生）全部で、clip w を varying に運び FS で
// logDepthZ(w)/w を frag_depth に書く＝三角形の内側でも正確（地形の蓋 CLIP_CAP と同じ式）。**全パス揃える**のが条件＝地形だけ正確にすると
// 他パス（頂点補間のまま）との釣り合いが崩れ、手前に別の帯が出た（実験 2026-09-29）。影を落とす側（CAST＝正射影・頂点だけ）は対象外。
// 派生（deriveWgsl）の錨は触らない＝この変換は mkMod の直前に最後に掛ける（元の fs を fsColor に改名して包む＝return を書き換えない）。
// 費用＝early-Z が効かない分（東京駅 z16.5・55° で gpuMap +0.4ms・山地は差なし）。逃げ道＝?fd=0（renderer の rOpts.fragDepth=false）
export function fragDepthWgsl(src: string, label = ""): string {
	const m = /@fragment fn fs\(in: (\w+)\) -> @location\(0\) vec4f \{/.exec(src);
	if (!m) throw new Error(`fragDepth(${label}): fs not found`);
	const out = m[1], st = src.indexOf(`struct ${out} {`);
	if (st < 0) throw new Error(`fragDepth(${label}): struct ${out} not found`);
	const close = src.indexOf("\n};", st);
	if (close < 0) throw new Error(`fragDepth(${label}): struct ${out} not closed`);
	let s = src.slice(0, close) + "\n\t@location(15) cw: f32,   // clip w（frag_depth 用・#62）" + src.slice(close);
	const vsA = "\tp.z = logDepthZ(p.w);\n\to.pos = p;";
	if (s.split(vsA).length !== 2) throw new Error(`fragDepth(${label}): vs anchor missing/ambiguous`);
	s = s.replace(vsA, "\tp.z = logDepthZ(p.w);\n\to.pos = p; o.cw = p.w;");
	s = s.replace(m[0], `fn fsColor(in: ${out}) -> vec4f {`);
	return s + `
struct ${out}Frag { @location(0) c: vec4f, @builtin(frag_depth) d: f32 };
@fragment fn fs(in: ${out}) -> ${out}Frag {   // 色は元の fs（fsColor）・深度は画素ごとに対数深度（#62）
	var o: ${out}Frag;
	o.c = fsColor(in);
	o.d = fragDepthOf(in.cw);
	return o;
}
`;
}

// ── タイル GPU 常駐プール（vt perf plan §4 step A・2026-10-22）＝gl/glsl.ts の mdize と対。
// 頂点はタイル原点相対のまま常駐し、タイル原点−シーン原点（origins）を instance step の頂点属性 a_tile で受けて**先に**足す
// （小さい値同士を先に・大きい F.origin は本体の式で 1 回＝classic と丸め回数が同じ＝GL の u_tileOff[gl_DrawID] と同順）。
// 発行＝タイルごとに draw(count, 1, first, firstInstance=j)＝a_tile は origins[j]（WEBGL_multi_draw の代わり・render bundle は step B）。
// 本体（素／影／面／影＋面）の文字列に後から掛ける＝派生の掛け順は影・面の後。anchor は vs の署名行だけ＝影・面の派生が触らない行。
export const mdFillWgsl = (src: string, out: "FillOut" | "AFOut", label: string): string => deriveWgsl(src, [
	[`@vertex fn vs(@location(0) a_delta: vec2f, @location(1) a_color: vec4f) -> ${out} {\n\tvar o: ${out};\n`,
	 `@vertex fn vs(@location(0) a_delta0: vec2f, @location(1) a_color: vec4f, @location(2) a_tile: vec2f) -> ${out} {\n\tvar o: ${out};\n\tlet a_delta = a_tile + a_delta0;   // タイル原点差（小）を先に足す＝原点相対 delta を確定\n`],
], label);
// 線は頂点属性を持たない（インスタンス属性の常駐プール化はタイルごとの firstInstance と両立しない）＝線分レコード（8×u32＝scene worker の
// ensureUploaded・[bits(p1.xy), bits(p2.xy)] [RGBA8, bits(half), bits(off), snorm16×2(tS/2,tE/2)]）を storage で持ち @builtin(vertex_index)/6 から引く
// （GL の LINE_MD_VS の u_segTex と同じ読み方・float は bit のまま＝bitcast）。6 頂点/線分の角は renderer の CORNERS と同順。group(3) は fill/line の派生で空いている
export const LINEX_ANCHOR = "\tvar q0 = p1; var q3 = p2; var jf0 = 0u; var dist0 = 0.0;   // LINEX：端と継ぎの相手の点と旗・破線の距離（classic の X 派生と md の派生が差し替える）\n";
export const mdLineWgsl = (src: string, label: string): string => deriveWgsl(src, [
	["@vertex fn vs(\n\t@location(0) corner: vec2f,\n\t@location(1) p1: vec2f, @location(2) p2: vec2f,\n\t@location(3) col: vec4f, @location(4) halfPx: f32, @location(5) offT: vec3f,\n) -> LineOut {\n\tvar o: LineOut;\n",
	 "@group(3) @binding(0) var<storage, read> SEG: array<vec4u>;   // 線分プール（2 語組/線分）\n@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a_tile: vec2f) -> LineOut {\n\tvar o: LineOut;\n\tlet seg = vi / 6u; let k = vi - seg * 6u;\n\tlet corner = vec2f(select(0.0, 1.0, k == 2u || k == 3u || k == 5u), select(-1.0, 1.0, k == 1u || k == 4u || k == 5u));   // CORNERS＝(0,-1)(0,1)(1,-1)(1,-1)(0,1)(1,1)\n\tlet A = SEG[seg * 2u]; let B = SEG[seg * 2u + 1u];\n\tlet p1 = bitcast<vec2f>(A.xy) + a_tile; let p2 = bitcast<vec2f>(A.zw) + a_tile;   // タイル原点差はここ（小さい値同士）で足す\n\tlet col = unpack4x8unorm(B.x); let halfPx = bitcast<f32>(B.y & ~15u);   // 下位 4 bit＝端と継ぎの旗（S-P1-1・GL2 の LINE_MD_VS と同じ読み方）\n\tlet offT = vec3f(bitcast<f32>(B.z), unpack2x16snorm(B.w) * 2.0);\n"],
	[LINEX_ANCHOR,
	 "\tvar q0 = p1; var q3 = p2; var jf0 = 0u; var dist0 = 0.0;\n\tif (P.dashP.y > 0.5 || P.patP.x > 1.5) { dist0 = bitcast<f32>(B.z); off0.x = P.tr.w; }   // 破線の列（S-P1-3）・線の模様（G-4）＝語 6 は始点までの線に沿う距離・ずらしは層で 1 つの値（P.tr.w・語 7＝角の継ぎ）\n\tif (P.lx.z > 0.5) {   // 端と継ぎ（S-P1-1）：旗は半幅の下位 4 bit・継ぐ相手は同じ塊のすぐ前後の線分（旗が立つ時だけ読む）＝p1/p2 と同じ足し算でビット同値\n\t\tjf0 = B.y & 15u;\n\t\tif ((jf0 & 1u) != 0u) { let Pv = SEG[seg * 2u - 2u]; q0 = bitcast<vec2f>(Pv.xy) + a_tile; }\n\t\tif ((jf0 & 2u) != 0u) { let Nv = SEG[seg * 2u + 2u]; q3 = bitcast<vec2f>(Nv.zw) + a_tile; }\n\t}\n"],
], label);
// 基図の classic の線＝前後の点（@location 6/7＝renderer が P1／P2 のバッファを 1 線分ずらして同じバッファを 2 つの slot で読ませる）と旗・破線の距離（@location 8＝[jf, dist]）を属性で
export const lineXWgsl = (src: string, label: string): string => deriveWgsl(src, [
	["\t@location(3) col: vec4f, @location(4) halfPx: f32, @location(5) offT: vec3f,\n) -> LineOut {\n\tvar o: LineOut;\n",
	 "\t@location(3) col: vec4f, @location(4) halfPx: f32, @location(5) offT: vec3f,\n\t@location(6) p0: vec2f, @location(7) p3: vec2f, @location(8) jd: vec2f,\n) -> LineOut {\n\tvar o: LineOut;\n"],
	[LINEX_ANCHOR, "\tvar q0 = p0; var q3 = p3; var jf0 = u32(jd.x); var dist0 = jd.y;   // 端と継ぎ（S-P1-1）・破線（S-P1-3）＝属性から\n"],
], label);
export const mdBldWgsl = (src: string, label: string): string => deriveWgsl(src, [
	["@vertex fn vs(@location(0) a_pos: vec3f, @location(1) a_shade: f32, @location(2) a_anchor: vec2f) -> BldOut {\n\tvar o: BldOut;\n",
	 "@vertex fn vs(@location(0) a_pos0: vec3f, @location(1) a_shade: f32, @location(2) a_anchor0: vec2f, @location(3) a_tile: vec2f) -> BldOut {\n\tvar o: BldOut;\n\tlet a_pos = vec3f(a_tile + a_pos0.xy, a_pos0.z); let a_anchor = a_tile + a_anchor0;   // タイル原点差（小）を先に足す\n"],
], label);
