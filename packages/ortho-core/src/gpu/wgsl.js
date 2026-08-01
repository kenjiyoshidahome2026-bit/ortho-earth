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
};
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var elevTex: texture_2d<f32>;
@group(0) @binding(2) var elevSamp: sampler;
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
// 頂点3D − originPt を桁落ちなしで直接作る（cos(θ)-1=-2sin²(θ/2)）＝glsl.js deltaToRel と同式
fn deltaToRel(dDeg: vec2f) -> vec3f {
	let da = dDeg.x * D2R; let db = dDeg.y * D2R;
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
fn elev(ll: vec2f) -> f32 {
	if (F.elevP.y < 0.5) { return 0.0; }
	let uv = (ll - F.elevBounds.xy) / F.elevBounds.zw;
	if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 0.0; }
	return textureSampleLevel(elevTex, elevSamp, uv, 0.0).r * elevFadeAt(uv);
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
	let relW = rel + h * dir;
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
	let af = in.color.a * clamp(1.0 - 1.2 * in.fog, 0.0, 1.0);
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
	let relWa = rela + ha * da; let relWb = relb + hb * db;
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
	return vec4f(mix(in.color.rgb, F.fogColor, in.fog) * a, a);
}
`;

// 地形サーフェス（TERRAIN_VS/FS の移植）：標高変位した格子メッシュ・hillshade は FS per-pixel（前方差分・
// texel歩幅）・海〜低地は透明化・遠景は距離フェードで平ら化・標高ティント（hypso）。深度は書く（尾根の遮蔽）。
export const TERRAIN_WGSL = /* wgsl */`
${FRAME}
struct TerrOut {
	@builtin(position) pos: vec4f,
	@location(0) ll: vec2f,
	@location(1) front: f32,
	@location(2) fog: f32,
	@location(3) h: f32,
};
@vertex fn vs(@location(0) a_ll: vec2f) -> TerrOut {
	var o: TerrOut;
	let dDeg = a_ll - F.origin;               // 原点相対 (deg)。renderer は main シーン原点を渡す
	let rel = deltaToRel(dDeg);
	let dir = F.originPt + rel;
	// 遠景は変位を距離フェードで平ら化＝grazing で粗い格子が縦壁に見えるのを消す（glsl.js と同式）
	let df = 1.0 - smoothstep(F.params.y * 0.8, F.params.y * 2.0, distance(F.eye, dir));
	let h = elev(a_ll) * df;
	o.h = h;
	o.ll = a_ll;
	let relW = rel + (h * F.elevP.x) * dir;
	o.front = dot(dir, F.eye) - 1.0;
	o.fog = fogOf(F.originPt + relW);
	var p = F.clipT + F.mvp * vec4f(relW, 0.0);
	p.z = logDepthZ(p.w);
	o.pos = p;
	return o;
}
@fragment fn fs(in: TerrOut) -> @location(0) vec4f {
	if (in.front < -0.0015) { discard; }   // 接線より少し先まで許容＝地平線に頭を出す高山。遮蔽は深度とフォグ
	// 海〜低地は地形を透明化し海岸線は精細なベクタに委ねる（粗いメッシュの海岸の崖・平野ノイズを消す）
	let t = smoothstep(1.0, 100.0, in.h);
	if (t <= 0.0) { discard; }
	// 北西光の hillshade（前方差分）。歩幅＝アトラス1texel（下限0.004°）＝どのスケールでも塗りが痩せない
	let tsz = vec2f(textureDimensions(elevTex, 0));
	let d = max(0.004, F.elevBounds.w / tsz.y);
	let h0 = elev(in.ll);
	let hx = elev(in.ll + vec2f(d, 0.0)) - h0;
	let hy = elev(in.ll + vec2f(0.0, d)) - h0;
	let shade = clamp(0.82 + (-hx + hy) * 0.0007, 0.45, 1.15);
	// 標高ティント：land を高所ほど hypso 色へ寄せる（テーマのノブ・未指定は量0で恒等）。陰影の前
	let landC = mix(P.p0.rgb, P.p1.rgb, clamp(h0 * P.p2.x, 0.0, 1.0) * P.p1.w);
	let col = mix(landC * shade, F.fogColor, in.fog);
	return vec4f(col * t, t);   // premultiplied（globe基色→地形へ滑らかに）
}
`;

// 建物（BUILDING_VS/FS の移植）：フットプリント押し出し・基準点(anchor)の単一標高で足元を揃える（屋根水平・
// 壁垂直）。PLATEAU 被覆マスクは Phase 2 未搭載（u_plateauCount=0 相当）＝PLATEAU 移植時に追加。
export const BUILDING_WGSL = /* wgsl */`
${FRAME}
struct BldOut {
	@builtin(position) pos: vec4f,
	@location(0) shade: f32,
	@location(1) front: f32,
	@location(2) fog: f32,
};
@vertex fn vs(@location(0) a_pos: vec3f, @location(1) a_shade: f32, @location(2) a_anchor: vec2f) -> BldOut {
	var o: BldOut;
	let rel = deltaToRel(a_pos.xy);
	let dir = F.originPt + rel;
	let base = elev(F.origin + a_anchor) * F.elevP.x;   // 基準点の標高で足元を揃える
	let h = base + a_pos.z;                              // 地形標高 + 建物高さ
	let relW = rel + h * dir;
	o.shade = a_shade;
	o.front = dot(dir, F.eye) - 1.0;
	o.fog = fogOf(F.originPt + relW);
	var p = F.clipT + F.mvp * vec4f(relW, 0.0);
	p.z = logDepthZ(p.w);
	o.pos = p;
	return o;
}
@fragment fn fs(in: BldOut) -> @location(0) vec4f {
	if (in.front < 0.0) { discard; }
	let c = mix(P.p0.rgb * in.shade, F.fogColor, in.fog);
	return vec4f(c, 1.0);
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
	let ll = vec2f(atan2(Pt.z, Pt.x) * R2D, asin(clamp(Pt.y, -1.0, 1.0)) * R2D);
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
};
@group(0) @binding(0) var<uniform> G: Globe;
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
	let viewDir = normalize(A - Pt);
	let ndv = clamp(dot(Pt, viewDir), 0.0, 1.0);
	let haze = pow(1.0 - ndv, 3.0);
	let col = mix(G.land.rgb, G.atmo.rgb, haze * G.atmo.a * 0.9);
	return vec4f(col, 1.0);
}
`;
