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
const FRAME = /* wgsl */`
struct Frame {
	mvp: mat4x4f,
	invMvp: mat4x4f,   // 等高線（フルスクリーン・レイキャスト）用に同居
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
	farP: vec4f,       // hasFar(0/1), farEdgeFade(deg), farPass(1=遠景メッシュパス・terrainFar slot のみ), 0
	ellTrig: vec4f,    // 楕円体 dβ 錨 (cos2φ0, sin2φ0, cos4φ0, sin4φ0)（CPU double・原点の測地緯度）。球=vec4(0)＝補正が厳密0
	ellP: vec4f,       // x=1:楕円体（変位方向・β→φ復元のゲート）0:球, yzw=0
};
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var elevTex: texture_2d<f32>;
@group(0) @binding(2) var elevSamp: sampler;
@group(0) @binding(3) var farElevTex: texture_2d<f32>;
// 描画役割毎の小物（renderer.js が役割別スロットに詰める）：
//   fill/line … p0 = (seaGate, lift(m), exactDepth, 0)
//   terrain  … p0 = (land.rgb, 0)  p1 = (hypso.rgb, hypso量)  p2 = (1/hypso最大標高, 0, 0, 0)
//   building … p0 = (bldColor.rgb, 0)
//   contour  … p0 = (cColor.rgb, 主曲線間隔m)  p1 = (計曲線間隔m, 濃さ, 0, 0)
struct DrawP { p0: vec4f, p1: vec4f, p2: vec4f };
@group(1) @binding(0) var<uniform> P: DrawP;
const D2R: f32 = 0.017453292519943295;
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
	return log2(max(1.0 + w, 1e-6)) * F.params.z * 0.5 * w;
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
fn elev(ll: vec2f) -> f32 {
	if (F.elevP.y < 0.5) { return 0.0; }
	let uv = (ll - F.elevBounds.xy) / F.elevBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return elevFar(ll); }
	return mix(elevFar(ll), textureSampleLevel(elevTex, elevSamp, uv, 0.0).r, elevFadeAt(uv));
}
`;

// 塗り（earcut 三角形・premultiplied）。FILL_VS/FILL_FS の移植：
// 標高ドレープ（距離フェード df 込み）・水面リフト(P.p0.y)・図郭外フォールバック水域（seaGate＝FS標高ゲート）。
// fs=通常（frag_depth 触れない＝early-Z 温存）／fsExact=水域の厳密対数深度（琵琶湖の偽島対策＝GL と同じ棲み分け）。
export const FILL_WGSL = /* wgsl */`
${FRAME}
struct FillOut {
	@builtin(position) pos: vec4f,
	@location(0) color: vec4f,
	@location(1) front: f32,
	@location(2) fog: f32,
	@location(3) ll: vec2f,
	@location(4) w: f32,   // clip w（perspective-correct 補間＝水域の厳密深度用）
};
@vertex fn vs(@location(0) a_delta: vec2f, @location(1) a_color: vec4f) -> FillOut {
	var o: FillOut;
	let ll = F.origin + a_delta;              // elev 参照用の絶対（粗くて可）
	let rel = deltaToRel(a_delta);            // 頂点3D − 原点3D（小・正確）
	let dir = F.originPt + rel;               // 絶対単位球点（front/fog/df 用＝粗くて可）
	// 標高変位は地形と同じ距離フェード＝遠景で地形が平ら化された時に塗りだけ浮かない（glsl.js と同式）
	let df = 1.0 - smoothstep(F.params.y * 0.8, F.params.y * 2.0, distance(F.eye, dir));
	// seaGate=1（図郭外フォールバック水域）は海抜0の球面に置く（隅が山に乗ると水面ごと傾く）
	let h = select((elev(ll) + P.p0.y) * F.elevP.x * df, 0.0, P.p0.x > 0.5);
	let relW = rel + h * liftDir(ll, dir);   // 楕円体＝測地法線で変位（球＝従来の dir）
	var p = F.clipT + F.mvp * vec4f(relW, 0.0);   // RTE：mvp*[w,1] を相殺なしで
	p.z = logDepthZ(p.w);
	o.pos = p;
	o.color = a_color;
	o.front = dot(dir, F.eye) - 1.0;
	o.fog = fogOf(F.originPt + relW);
	o.ll = ll;
	o.w = p.w;
	return o;
}
fn fillColor(in: FillOut) -> vec4f {
	// 霧はフェードアウト（透明化）＝地平線の先の塗りが空に浮かない（glsl.js FILL_FS と同式）
	// ×P.p0.w＝グローバルα（シーン差し替えクロスフェード用。通常は1）
	let af = in.color.a * clamp(1.0 - 1.2 * in.fog, 0.0, 1.0) * P.p0.w;
	if (af <= 0.003) { discard; }
	return vec4f(mix(in.color.rgb, F.fogColor, in.fog) * af, af);
}
@fragment fn fs(in: FillOut) -> @location(0) vec4f {
	if (in.front < -0.0015) { discard; }
	if (P.p0.x > 0.5 && elev(in.ll) > 0.0) { discard; }   // 図郭外＝陸は塗り残す（紙色+等高線に委ねる）
	return fillColor(in);
}
// 水域の厳密深度：頂点線形補間の対数深度は湖全体を跨ぐ巨大三角形で真の曲線から外れ「湖中の偽島」になる
// ＝perspective-correct な w から真の対数深度を書き直す（GL 版 u_exactDepth と同じ・水域 draw だけこの変種）。
struct FillDepthOut { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 };
@fragment fn fsExact(in: FillOut) -> FillDepthOut {
	if (in.front < -0.0015) { discard; }
	if (P.p0.x > 0.5 && elev(in.ll) > 0.0) { discard; }
	var o: FillDepthOut;
	o.color = fillColor(in);
	o.depth = select(in.pos.z, clamp(log2(max(1.0 + in.w, 1e-6)) * F.params.z * 0.5, 0.0, 1.0), P.p0.z > 0.5);
	return o;
}
`;

// 線（capsule SDF・インスタンス6頂点）。LINE_VS/LINE_FS の移植：標高ドレープ（端点毎 df）＋接地リフト(P.p0.y)。
// corner=(end 0/1, side ±1) は頂点ステップ、p1/p2/color/half はインスタンスステップ。
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
	@location(6) fog: f32,
};
fn toScreen(c: vec4f) -> vec2f {
	let ndc = c.xy / c.w;
	return vec2f((ndc.x * 0.5 + 0.5) * F.viewport.x, (1.0 - (ndc.y * 0.5 + 0.5)) * F.viewport.y);
}
@vertex fn vs(
	@location(0) corner: vec2f,
	@location(1) p1: vec2f, @location(2) p2: vec2f,
	@location(3) col: vec4f, @location(4) halfPx: f32,
) -> LineOut {
	var o: LineOut;
	let la1 = F.origin + p1; let la2 = F.origin + p2;   // elev 参照用の絶対（粗くて可）
	let rela = deltaToRel(p1); let relb = deltaToRel(p2);
	let da = F.originPt + rela; let db = F.originPt + relb;
	// 標高変位は地形と同じ距離フェード＝遠景の平ら化に追随（無いと地平線に「漂う点線の鎖」）
	let dfa = 1.0 - smoothstep(F.params.y * 0.8, F.params.y * 2.0, distance(F.eye, da));
	let dfb = 1.0 - smoothstep(F.params.y * 0.8, F.params.y * 2.0, distance(F.eye, db));
	let ha = (elev(la1) + P.p0.y) * F.elevP.x * dfa;
	let hb = (elev(la2) + P.p0.y) * F.elevP.x * dfb;
	let relWa = rela + ha * liftDir(la1, da); let relWb = relb + hb * liftDir(la2, db);   // 楕円体＝測地法線
	let wa = F.originPt + relWa; let wb = F.originPt + relWb;
	let ca = F.clipT + F.mvp * vec4f(relWa, 0.0);
	let cb = F.clipT + F.mvp * vec4f(relWb, 0.0);
	let fa = dot(da, F.eye) - 1.0; let fb = dot(db, F.eye) - 1.0;
	if (ca.w <= 0.0 || cb.w <= 0.0) {        // カメラ背後（var o はゼロ初期化済）
		o.front = -1.0; o.pos = vec4f(2.0, 2.0, 2.0, 1.0); return o;
	}
	let sa = toScreen(ca); let sb = toScreen(cb);
	let d = sb - sa; let len = length(d);
	var dirS = vec2f(1.0, 0.0);
	if (len > 1e-6) { dirS = d / len; }
	let perp = vec2f(-dirS.y, dirS.x);
	let hw = halfPx * F.params.w + 1.0;      // +1px の AA/丸端余白
	var base = sb; var capSign = 1.0;
	if (corner.x < 0.5) { base = sa; capSign = -1.0; }
	let posS = base + perp * (hw * corner.y) + dirS * (capSign * hw);
	o.a = sa; o.b = sb; o.halfw = halfPx * F.params.w; o.sp = posS;
	o.color = col; o.front = min(fa, fb);
	o.fog = fogOf((wa + wb) * 0.5);
	// 端点の深度は対数系＝地形・建物と同じ深度空間（山岳ビューで尾根の向こうを遮蔽）
	let wz = select(cb.w, ca.w, corner.x < 0.5);
	let ndc = vec2f(posS.x / F.viewport.x * 2.0 - 1.0, 1.0 - posS.y / F.viewport.y * 2.0);
	o.pos = vec4f(ndc, log2(max(1.0 + wz, 1e-6)) * F.params.z * 0.5, 1.0);
	return o;
}
@fragment fn fs(in: LineOut) -> @location(0) vec4f {
	if (in.front < -0.0015) { discard; }
	let pa = in.sp - in.a; let ba = in.b - in.a;
	let t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
	let dist = length(pa - ba * t);
	// 細線のシャープ化（glsl.js LINE_FS と同式）：幾何幅±0.5px保証＋細さはカバレッジ・フェザー半減
	let hw = max(in.halfw, 0.5);
	let alpha = clamp((hw - dist) * 2.0 + 0.5, 0.0, 1.0) * min(in.halfw * 2.0, 1.0);
	if (alpha <= 0.0) { discard; }
	let a = in.color.a * alpha * clamp(1.0 - 1.2 * in.fog, 0.0, 1.0);
	if (a <= 0.003) { discard; }
	let ga = a * P.p0.w;   // ×グローバルα（クロスフェード用・通常1）
	return vec4f(mix(in.color.rgb, F.fogColor, in.fog) * ga, ga);
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
fn climUV(ll: vec2f) -> vec2f { return vec2f(ll.x / 360.0 + 0.5, 0.5 - ll.y / 180.0); }
`;

export const TERRAIN_WGSL = /* wgsl */`
${FRAME}
${WORLD_HYPSO_WGSL}
// 気候場（全球ハイプソの cross-blend）＝terrain 専用 group(2)。未着は dummy（hasClim=P.p2.z=0 で不使用）
@group(2) @binding(0) var climTex: texture_2d<f32>;
@group(2) @binding(1) var climSamp: sampler;
@group(2) @binding(2) var<uniform> WP: WorldPal;   // 世界パレット＝globe 側 binding(4) と同一バッファ（同色契約）
struct TerrOut {
	@builtin(position) pos: vec4f,
	@location(0) ll: vec2f,
	@location(1) front: f32,
	@location(2) fog: f32,
	@location(3) h: f32,
};
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
	let relW = rel + (h * F.elevP.x) * liftDir(a_ll, dir);   // 楕円体＝測地法線
	o.front = dot(dir, F.eye) - 1.0;
	o.fog = fogOf(F.originPt + relW);
	var p = F.clipT + F.mvp * vec4f(relW, 0.0);
	p.z = logDepthZ(p.w);
	o.pos = p;
	return o;
}
@fragment fn fs(in: TerrOut) -> @location(0) vec4f {
	if (in.front < -0.0015) { discard; }   // 接線より少し先まで許容＝地平線に頭を出す高山。遮蔽は深度とフォグ
	if (F.farP.z > 0.5) {   // 遠景メッシュパス：近窓の内側は近メッシュの担当＝discard（縁の連続は elev() が保証）
		let uvN = (in.ll - F.elevBounds.xy) / F.elevBounds.zw;
		if (uvN.x >= 0.0 && uvN.x <= 1.0 && uvN.y >= 0.0 && uvN.y <= 1.0) { discard; }
	}
	// 海〜低地は地形を透明化し海岸線は精細なベクタに委ねる（粗いメッシュの海岸の崖・平野ノイズを消す）
	let t = smoothstep(1.0, 100.0, in.h);
	if (t <= 0.0) { discard; }
	// 北西光の hillshade（前方差分）。歩幅＝アトラス1texel（下限0.004°≈R10 texel＝遠層域の歩幅としても妥当）
	let tsz = vec2f(textureDimensions(elevTex, 0));
	let d = max(0.004, F.elevBounds.w / tsz.y);
	let h0 = elev(in.ll);
	let hx = elev(in.ll + vec2f(d, 0.0)) - h0;
	let hy = elev(in.ll + vec2f(0.0, d)) - h0;
	let shade = clamp(0.82 + (-hx + hy) * 0.0007, 0.45, 1.15);
	// 標高ティント：land を高所ほど hypso 色へ寄せる（テーマのノブ・未指定は量0で恒等）。陰影の前
	var landC = mix(P.p0.rgb, P.p1.rgb, clamp(h0 * P.p2.x, 0.0, 1.0) * P.p1.w);
	// 全球ハイプソ（低ズーム帯・p2.y=出現度/p2.z=hasClim）＝globe パスと同色でピッチ不変（gl 側と同式）
	if (P.p2.y > 0.001) {
		let clim = textureSampleLevel(climTex, climSamp, climUV(in.ll), 0.0).rg;
		landC = mix(landC, worldHypsoColor(h0, in.ll, clim, P.p2.z), P.p2.y);
	}
	let col = mix(landC * shade, F.fogColor, in.fog);
	return vec4f(col * t, t);   // premultiplied（globe基色→地形へ滑らかに）
}
`;

// 建物（BUILDING_VS/FS の移植）：フットプリント押し出し・基準点(anchor)の単一標高で足元を揃える（屋根水平・
// 壁垂直）。PLATEAU 被覆マスクは Phase 2 未搭載（u_plateauCount=0 相当）＝PLATEAU 移植時に追加。
export const BUILDING_WGSL = /* wgsl */`
${FRAME}
// PLATEAU 被覆マスク（group(2)）：実フットプリントが立つ区（最大4）を uv 正規化で参照し、基図の押し出し
// 建物を伏せる＝同一体積の全面 z-fight を断ちつつ範囲外は残す（GL BUILDING_FS の u_plateauMaskN 移植）。
// mparams.count=0（PLATEAU 無し）なら discard は起きない＝素通し。
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
	let base = elev(F.origin + a_anchor) * F.elevP.x;   // 基準点の標高で足元を揃える
	let h = base + a_pos.z;                              // 地形標高 + 建物高さ
	let relW = rel + h * liftDir(F.origin + a_pos.xy, dir);   // 楕円体＝測地法線
	o.shade = a_shade;
	o.front = dot(dir, F.eye) - 1.0;
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

// PLATEAU LOD2 建物メッシュ（PLATEAU_VS/FS の移植）。頂点は重心(u_meshOrigin)相対 delta（RTE-lite＝
// 小さい値＝float32 仮数フル活用）、法線は int8 量子化（FS で normalize＝精度 1/127 で十分）。
// 投影は基図(fill/line/terrain)と別＝重心相対（scene 原点相対でない）：絶対位置 = meshOrigin + a_pos、
// clip 錨は u_clipMesh（CPU double・相殺回避）。接地リフトは DTM 保証域(P.p0=liftBounds)内だけ。
// フレーム共通 uniform は建物 bld スロットの Frame を流用（mvp/eye/fog/elev が同一）＝group(0)=bld。
// group(1)=DrawP（p0=liftBounds・p1=bldColor）、group(2)=per-batch（meshOrigin+cullBack・clipMesh）。
export const PLATEAU_WGSL = /* wgsl */`
${FRAME}
struct PB { meshOrigin: vec4f, clipMesh: vec4f };   // xyz+cullBack, clip錨
@group(2) @binding(0) var<uniform> B: PB;
struct PlOut {
	@builtin(position) pos: vec4f,
	@location(0) n: vec3f,       // 実法線（巻き順非依存で表向きへ）
	@location(1) toEye: vec3f,
	@location(2) front: f32,
	@location(3) fog: f32,
};
@vertex fn vs(@location(0) a_pos: vec3f, @location(1) a_normal: vec4f) -> PlOut {
	var o: PlOut;
	let wp = B.meshOrigin.xyz + a_pos;                 // 絶対位置（陰影/フォグ/半球判定＝粗くて可）
	let dir = normalize(wp);
	o.n = a_normal.xyz;
	o.toEye = F.eye - wp;
	o.front = dot(dir, F.eye) - 1.0;
	o.fog = fogOf(wp);
	// 接地リフト（DTM 保証域 P.p0=liftBounds 内だけ・境界 0.05° smoothstep）。域外/bounds無しは h=0（r=1 接地）
	let lat = geoLat(degrees(asin(clamp(dir.y, -1.0, 1.0))));   // β球点→測地緯度（elev/リフト域は測地の台帳。球=恒等）
	let lon = degrees(atan2(dir.z, dir.x));
	let lb = P.p0;   // [lng0, lat0, spanLng, spanLat]
	let inX = smoothstep(0.0, 0.05, min(lon - lb.x, lb.x + lb.z - lon));
	let inY = smoothstep(0.0, 0.05, min(lat - lb.y, lb.y + lb.w - lat));
	let h = elev(vec2f(lon, lat)) * F.elevP.x * inX * inY;
	var p = B.clipMesh + F.mvp * vec4f(a_pos + h * liftDir(vec2f(lon, lat), dir), 0.0);   // 楕円体＝測地法線
	p.z = logDepthZ(p.w);
	o.pos = p;
	return o;
}
@fragment fn fs(in: PlOut) -> @location(0) vec4f {
	// 面の幾何法線＝スクリーン微分（FS冒頭＝uniform control flow・discard より前＝fwidth の轍と同じ掟）。
	// toEye = eye − pos で eye は定数＝微分は −dPos、cross で符号相殺＝位置微分の面法線と等価（varying追加不要）。
	let gnRaw = cross(dpdx(in.toEye), dpdy(in.toEye));
	if (in.front < 0.0) { discard; }
	var n = normalize(in.n);
	// 裏面カリングは幾何法線＝面内で一定＝画素毎の揺れゼロ。旧・補間int8法線のdot閾値は「すれすれ帯≈1px」
	// 前提が深ズーム(z20)で崩れ点描ゴーストになった（glsl.js PLATEAU_FS と同文・2026-08-02）。
	// 向きは属性法線で採決＝巻き順非依存。退化面（微分ゼロ）だけ旧判定へフォールバック。
	let g2 = dot(gnRaw, gnRaw);
	let fe = select(dot(n, normalize(in.toEye)), dot(normalize(gnRaw * sign(dot(gnRaw, n))), normalize(in.toEye)), g2 > 1e-18);
	// 裏面カリング。cullBack=B.meshOrigin.w
	if (B.meshOrigin.w > 0.5 && fe < -0.02) { discard; }
	if (fe < 0.0) { n = -n; }   // 両面時は法線を視線側へ＝裏から見ても陰影が成立
	let L = normalize(vec3f(-0.35, 0.85, 0.30));   // 斜め上の光＝屋根が立つ
	let d = clamp(dot(n, L) * 0.28 + 0.76, 0.72, 1.0);   // 基図建物の屋根1.0/壁0.76に合わせる
	let c = mix(P.p1.rgb * d, F.fogColor, in.fog);
	return vec4f(c, 1.0);
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
	invMvp: mat4x4f,   // 夜面レイキャスト
	gmst: vec2f,       // (cos, sin) 恒星時
	fadeSky: vec2f,    // (fade=出現α, sky=天球倍率)
	viewport: vec2f,   // device px（星の四角形展開）
	pad: vec2f,
	sun: vec3f,        // 夜面の太陽方向（地球固定・単位）
	alpha: f32,        // 夜面の濃さ
};
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
	let np = SK.invMvp * vec4f(in.ndc, -1.0, 1.0);
	let fp = SK.invMvp * vec4f(in.ndc, 1.0, 1.0);
	let A = np.xyz / np.w; let B = fp.xyz / fp.w; let d = B - A;
	let aa = dot(d, d); let bb = 2.0 * dot(A, d); let cc = dot(A, A) - 1.0;
	let disc = bb * bb - 4.0 * aa * cc;
	if (disc < 0.0) { discard; }
	let t = (-bb - sqrt(disc)) / (2.0 * aa);
	if (t < 0.0) { discard; }
	let Pt = A + t * d;
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
	let h = (elev(ll) + P.p0.y) * F.elevP.x * df;
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
fn elevAt(ll: vec2f) -> f32 {   // 等高線は edgeFade 無し（GL CONTOUR_FS と同じ・uv 範囲外=0）
	let uv = (ll - F.elevBounds.xy) / F.elevBounds.zw;
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
	let np = F.invMvp * vec4f(in.ndc, -1.0, 1.0);
	let fp = F.invMvp * vec4f(in.ndc, 1.0, 1.0);
	let A = np.xyz / np.w; let B = fp.xyz / fp.w; let d = B - A;
	let aa = dot(d, d); let bb = 2.0 * dot(A, d); let cc = dot(A, A) - 1.0;
	let disc = bb * bb - 4.0 * aa * cc;
	if (disc < 0.0) { discard; }
	let t = (-bb - sqrt(disc)) / (2.0 * aa);
	if (t < 0.0) { discard; }
	let Pt = A + t * d;
	let ll = vec2f(atan2(Pt.z, Pt.x) * R2D, geoLat(asin(clamp(Pt.y, -1.0, 1.0)) * R2D));   // β→測地（球=恒等）
	let e = elevAt(ll);
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
	invMvp: mat4x4f,
	land: vec4f,
	atmo: vec4f,   // 大気色 rgb + 強さ(a)
	elevBounds: vec4f,   // 全球ハイプソ用（R90 全球窓の被覆）
	whP: vec4f,          // (出現度whK, hasElev, ell, hasClim)
	seaC: vec4f,         // 海の平色（NE流の淡青）
};
@group(0) @binding(0) var<uniform> G: Globe;
// 全球ハイプソ：標高（R90全球窓）＋気候場。未着/K=0 は dummy（whP が使用をゲート）
@group(0) @binding(1) var gElevTex: texture_2d<f32>;
@group(0) @binding(2) var gSamp: sampler;
@group(0) @binding(3) var gClimTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> WP: WorldPal;   // 世界パレット＝terrain 側 binding(2) と同一バッファ（同色契約）
${WORLD_HYPSO_WGSL}
const R2Dg: f32 = 57.29577951308232;
fn gElevAt(ll: vec2f) -> f32 {
	let uv = (ll - G.elevBounds.xy) / G.elevBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 0.0; }
	return textureSampleLevel(gElevTex, gSamp, uv, 0.0).r;
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
	let np = G.invMvp * vec4f(in.ndc, -1.0, 1.0);
	let fp = G.invMvp * vec4f(in.ndc, 1.0, 1.0);
	let A = np.xyz / np.w; let B = fp.xyz / fp.w; let d = B - A;
	let aa = dot(d, d); let bb = 2.0 * dot(A, d); let cc = dot(A, A) - 1.0;
	let disc = bb * bb - 4.0 * aa * cc;
	let aDotd = bb * 0.5; let tstar = -aDotd / aa;
	var t = -1.0;
	if (disc >= 0.0) { t = (-bb - sqrt(disc)) / (2.0 * aa); }
	if (t < 0.0) {                             // 前方に球ヒット無し＝空：地平の霞から宇宙へ連続減衰
		let lenA = length(A);
		var m = lenA;
		if (tstar > 0.0) { m = sqrt(max((cc + 1.0) - aDotd * aDotd / aa, 0.0)); }
		var g = 1.0 - smoothstep(1.0, 1.09, m);
		g = g * (1.0 - smoothstep(0.0, 0.55, dot(normalize(d), A / lenA)));
		if (g <= 0.0) { discard; }
		let limbCol = mix(G.land.rgb, G.atmo.rgb, G.atmo.a * 0.9);
		let a = g * g * mix(G.atmo.a, 1.0, g);
		return vec4f(mix(G.atmo.rgb, limbCol, g) * a, a);   // premultiplied
	}
	let Pt = A + t * d;
	var base = G.land.rgb;
	if (G.whP.x > 0.001 && G.whP.y > 0.5) {   // 全球ハイプソ：標高×気候→配色＋陰影（gl/glsl.js GLOBE_FS と同式）
		let bl = asin(clamp(Pt.y, -1.0, 1.0));   // β(rad)
		let latD = bl * R2Dg + G.whP.z * (0.0016792203863837047 * sin(2.0 * bl) + 0.0000014098905530233192 * sin(4.0 * bl)) * R2Dg;   // β→測地
		let ll = vec2f(atan2(Pt.z, Pt.x) * R2Dg, latD);
		let e = gElevAt(ll);
		let tsz = vec2f(textureDimensions(gElevTex, 0));
		let dstep = G.elevBounds.w / tsz.y;
		let hx = gElevAt(ll + vec2f(dstep, 0.0)) - e;
		let hy = gElevAt(ll + vec2f(0.0, dstep)) - e;
		let shade = clamp(0.86 + (-hx + hy) * 0.00013, 0.62, 1.08);
		let landK = smoothstep(0.2, 4.0, e);   // 海(=0クランプ)↔陸の境（低平地を海に沈めない・干拓地級のみ海側）
		let clim = textureSampleLevel(gClimTex, gSamp, climUV(ll), 0.0).rg;
		let hyp = mix(G.seaC.rgb, worldHypsoColor(e, ll, clim, G.whP.w) * shade, landK);
		base = mix(base, hyp, G.whP.x);
	}
	let viewDir = normalize(A - Pt);
	let ndv = clamp(dot(Pt, viewDir), 0.0, 1.0);
	let haze = pow(1.0 - ndv, 3.0);
	let col = mix(base, G.atmo.rgb, haze * G.atmo.a * 0.9);
	return vec4f(col, 1.0);
}
// 海面下の陸地（wdepr）カバー：stencil-then-cover の cover 側を「landK=1 強制のハイプソ本体」で塗る＝
// 海→海面下→陸の描画順（2026-09-01 本人設計・gl/glsl.js WDEPR_FS と対）。同モジュール＝globe と同一バインド
//（G/gElevTex/gSamp/gClimTex）を共有し、色は globe パスの陸側と画素単位で厳密一致＝ポリゴン境界が
// e≳4m（landK≈1）の土地に落ちれば継ぎ目が消える。α＝whP.x（whK フェード）。
@fragment fn fsWdepr(in: GOut) -> @location(0) vec4f {
	let np = G.invMvp * vec4f(in.ndc, -1.0, 1.0);
	let fp = G.invMvp * vec4f(in.ndc, 1.0, 1.0);
	let A = np.xyz / np.w; let d = fp.xyz / fp.w - A;
	let aa = dot(d, d); let bb = 2.0 * dot(A, d); let cc = dot(A, A) - 1.0;
	let disc = bb * bb - 4.0 * aa * cc;
	if (disc < 0.0) { discard; }
	let t = (-bb - sqrt(disc)) / (2.0 * aa);
	if (t < 0.0) { discard; }
	let Pt = A + t * d;
	let bl = asin(clamp(Pt.y, -1.0, 1.0));
	let latD = bl * R2Dg + G.whP.z * (0.0016792203863837047 * sin(2.0 * bl) + 0.0000014098905530233192 * sin(4.0 * bl)) * R2Dg;
	let ll = vec2f(atan2(Pt.z, Pt.x) * R2Dg, latD);
	let e = gElevAt(ll);
	let tsz = vec2f(textureDimensions(gElevTex, 0));
	let dstep = G.elevBounds.w / tsz.y;
	let hx = gElevAt(ll + vec2f(dstep, 0.0)) - e;
	let hy = gElevAt(ll + vec2f(0.0, dstep)) - e;
	let shade = clamp(0.86 + (-hx + hy) * 0.00013, 0.62, 1.08);
	let clim = textureSampleLevel(gClimTex, gSamp, climUV(ll), 0.0).rg;
	// 以降は fs（globe）の末尾と厳密同式（landK=1 だけが違い）：紙とのwhK混合も大気ヘイズも同じに通し、
	// α=1 の不透明で置く＝ポリゴン境界の e≳4m では画素値が globe と bit 一致し縁が完全に消える。
	var hyp = worldHypsoColor(e, ll, clim, G.whP.w) * shade;   // landK=1 強制＝「陸」の上塗り
	// 海面下の締め（NE流「最深帯」）：0→-60m で僅かに暗く・緑側へ＝乾燥帯でも読める（gl WDEPR_FS と同式）
	hyp = mix(hyp, hyp * WP.belowSea.rgb, clamp(-e / 60.0, 0.0, 1.0));
	let base = mix(G.land.rgb, hyp, G.whP.x);
	let viewDir = normalize(A - Pt);
	let ndv = clamp(dot(Pt, viewDir), 0.0, 1.0);
	let haze = pow(1.0 - ndv, 3.0);
	return vec4f(mix(base, G.atmo.rgb, haze * G.atmo.a * 0.9), 1.0);
}
// 10度レチクル（v1 ortho-map geoGraticule10/Canvas2D の移植・gl GRAT_FS と対）：レイ→球→測地経緯度→
// 10°格子への画素距離を fwidth で解析AA（≈0.7px 白細線）。度距離の上限ゲート＝極（経線収束）と atan 継ぎ目で
// fwidth が爆発して線が面に化けるのを防ぐ。d3.geoGraticule10 と同じ約束＝±80°打切り・90°毎の経線だけ極まで。
// 出現度＝G.seaC.w（レンダラが z帯フェード×基礎αを書く）。
@fragment fn fsGrat(in: GOut) -> @location(0) vec4f {
	let np = G.invMvp * vec4f(in.ndc, -1.0, 1.0);
	let fp = G.invMvp * vec4f(in.ndc, 1.0, 1.0);
	let A = np.xyz / np.w; let d = fp.xyz / fp.w - A;
	let aa = dot(d, d); let bb = 2.0 * dot(A, d); let cc = dot(A, A) - 1.0;
	let disc = bb * bb - 4.0 * aa * cc;
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
