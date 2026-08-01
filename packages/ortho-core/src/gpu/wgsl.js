// WebGPU(WGSL) シェーダ＝gl/glsl.js の忠実移植（Phase 1: globe / fill / line の基図コア）。
// 数学は GLSL 版と1:1（sinP テイラー・deltaToRel の桁落ち回避 RTE・capsule SDF・対数深度）。
// GL との差分は座標系だけ：
//  ・クリップ z が GL の [-1,1] でなく [0,1] ＝対数深度は z01 = 0.5·log2(1+w)·coef を直接書く
//    （GL の window 深度 0.5·(z_ndc+1) と同値＝深度の互換維持。glsl.js applyLogDepth 参照）。
//  ・invMvp レイキャスト（globe）は GL 流儀の ndc±1 平面をそのまま逆変換＝行列が自己完結なので無変更。
// Phase 1 は標高（elev）非搭載＝h=0 固定で式ごと畳んである（u_elevScale=0 と等価＝真俯瞰の平面地図と同じ絵）。
// ⚠移植の轍：smoothstep の引数逆転（GLSL は黙認・WGSL は未定義動作の明記）は 1-smoothstep(正順) に書き換える。

// 共通フレーム uniform（1スロット=176B・256B 境界で base/main の2領域を1バッファに同居）。
// params = (fogNear, fogFar, logCoef, dpr)。JS 側の詰め順は renderer.js packFrame と厳密に対応。
const FRAME = /* wgsl */`
struct Frame {
	mvp: mat4x4f,
	clipT: vec4f,      // mvp*[originPt,1]（CPU double）＝RTE の錨
	trig: vec4f,       // (cosLon, sinLon, cosLat, sinLat) of origin
	originPt: vec3f,   // lonlatTo3D(origin)
	eye: vec3f,        // カメラ位置（単位球ワールド）
	origin: vec2f,     // シーン原点 lon/lat (deg)
	viewport: vec2f,   // canvas 幅高 (device px)
	fogColor: vec3f,   // 霞む先の色（=land基色）
	params: vec4f,     // fogNear, fogFar, logCoef, dpr
};
@group(0) @binding(0) var<uniform> F: Frame;
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
`;

// 塗り（earcut 三角形・premultiplied）。FILL_VS/FILL_FS の Phase 1 サブセット
// （u_lift/u_seaGate/u_exactDepth は標高・地形深度の従属＝Phase 1 では恒等）。
export const FILL_WGSL = /* wgsl */`
${FRAME}
struct FillOut {
	@builtin(position) pos: vec4f,
	@location(0) color: vec4f,
	@location(1) front: f32,
	@location(2) fog: f32,
};
@vertex fn vs(@location(0) a_delta: vec2f, @location(1) a_color: vec4f) -> FillOut {
	var o: FillOut;
	let rel = deltaToRel(a_delta);           // 頂点3D − 原点3D（小・正確）
	let dir = F.originPt + rel;              // 絶対単位球点（front/fog 用＝粗くて可）
	var p = F.clipT + F.mvp * vec4f(rel, 0.0);   // RTE：mvp*[w,1] を相殺なしで
	p.z = logDepthZ(p.w);
	o.pos = p;
	o.color = a_color;
	o.front = dot(dir, F.eye) - 1.0;         // >0 で手前半球
	o.fog = fogOf(dir);
	return o;
}
@fragment fn fs(in: FillOut) -> @location(0) vec4f {
	if (in.front < -0.0015) { discard; }     // 裏半球は描かない（接線に標高許容）
	// 霧はフェードアウト（透明化）＝地平線の先の塗りが空に浮かない（glsl.js FILL_FS と同式）
	let af = in.color.a * clamp(1.0 - 1.2 * in.fog, 0.0, 1.0);
	if (af <= 0.003) { discard; }
	return vec4f(mix(in.color.rgb, F.fogColor, in.fog) * af, af);   // premultiplied
}
`;

// 線（capsule SDF・インスタンス6頂点）。LINE_VS/LINE_FS の Phase 1 サブセット。
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
	let rela = deltaToRel(p1); let relb = deltaToRel(p2);
	let da = F.originPt + rela; let db = F.originPt + relb;
	let ca = F.clipT + F.mvp * vec4f(rela, 0.0);
	let cb = F.clipT + F.mvp * vec4f(relb, 0.0);
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
	o.fog = fogOf((da + db) * 0.5);
	// 端点の深度は対数系＝地形・建物と同じ深度空間（Phase 1 は深度バッファ無し＝クリップのみに効く）
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

// 球体本体（フルスクリーン・レイキャスト）。GLOBE_VS/GLOBE_FS の忠実移植。
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
	let P = A + t * d;
	let viewDir = normalize(A - P);
	let ndv = clamp(dot(P, viewDir), 0.0, 1.0);
	let haze = pow(1.0 - ndv, 3.0);
	let col = mix(G.land.rgb, G.atmo.rgb, haze * G.atmo.a * 0.9);
	return vec4f(col, 1.0);
}
`;
