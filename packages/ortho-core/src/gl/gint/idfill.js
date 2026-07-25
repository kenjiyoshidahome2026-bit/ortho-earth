// gint v2 コロプレス塗り＝winding 和 ID バッファ（gint draw spec.md §7.2）。
//
// stencil 塗りと同一の fan 辺集合（pivotClip 扇要・クリップ空間・全密度）を、stencil の代わりに
// FS で gl_FrontFacing ? +(fid+1) : -(fid+1) として float バッファへ加算ブレンドする。
// 非重複被覆なら画素値 = 含有 feature の fid+1（winding の線形和＝stencil NOTEQUAL 0 と数学的に等価）。
// 解決パスが fid→スタイル表→色 に引く＝パス数は色数に非依存（コロプレス 1919 色でも 2 パス）。
//
// 能力梯子（§7.2）:
//   EXT_color_buffer_float + EXT_float_blend → R32F（fid 上限 2^24＝実質無制限）
//   EXT_color_buffer_float のみ             → R16F（float16 仮数 11bit＝fid+1 ≤ 2048 まで厳密）
//   EXT_color_buffer_half_float のみ        → RGBA16F（同上）
//   いずれも無し or fid 超過 or 重複被覆    → 呼び出し側（passes.js）が従来 stencil 単色へフォールバック
//
// 既知の制約（仕様どおり）:
//   - 単被覆前提。重複被覆（|winding|>1）は fid 和が壊れる＝union 経路（クラス別 nonzero OR・未実装）の担当。
//   - 向き未正規化データ（外環 CW）は合計が負になる＝解決パスの abs() で拾う（feature 内の向き一貫が前提）。
//   - 塗りのみ per-fid。線/点の per-fid スタイルは次段（fid 表自体は line 色/width も既に持つ）。

import { s } from './state.js';
import { GLSL_VS_HEADER, VS_FILL, SHARED_UNIFORM_NAMES, linkProgram, getUniforms } from './programs.js';
import { bindSharedUniforms, bindPivot } from './utility.js';

// VS_STENCIL と同一の fan 幾何＋fid を flat varying で FS へ（facing は rasterizer が判定）。
const VS_ID = `${GLSL_VS_HEADER}
flat out float v_fid1;
void main() {
	int edge_id = gl_VertexID / 3;
	int sub     = gl_VertexID % 3;
	uvec4 meta = fetchEdgeMeta(edge_id);
	v_fid1 = float(meta.a + 1u);
	if (!bboxVisible(meta.a)) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
	uint lodA = meta.r, lodB = meta.g;
	if (!lodSnap(lodA, lodB, edge_id)) { gl_Position = vec4(2.0, 0.0, 0.0, 1.0); return; }
	if (sub == 0) { gl_Position = pivotClip(meta.a); return; }
	gl_Position = fetchClip(sub == 1 ? lodA : lodB);
}`;

// R = Σ±(fid+1)（fid 重み付き winding 和）、G = Σ±1（winding カウント＝被覆多重度）。
// 同一 feature の多重登記（MOJ 名物＝同一リング2回登記で winding ±2）は R=k(fid+1), G=k と
// なり R/G で fid が正確に復元される＝stencil NOTEQUAL 0 の多重度耐性を ID 塗りでも保つ。
const FS_ID = `#version 300 es
precision highp float;
flat in float v_fid1;
out vec4 fragColor;
void main() {
	float sgn = gl_FrontFacing ? 1.0 : -1.0;
	fragColor = vec4(sgn * v_fid1, sgn, 0.0, 0.0);
}`;

// 解決パス：ID バッファの画素値 → fid → スタイル表 → 色（straight alpha で現ターゲットへ blend）。
const FS_RESOLVE = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform sampler2D  u_id_tex;
uniform usampler2D u_fid_style;
uniform int u_fid_w;
uniform int u_fid_count;
uniform int u_overlap;   // 1＝重複可視化モード（データ品質監査）：通常塗りせず異常画素だけ色分け
out vec4 fragColor;
void main() {
	vec2 t = texelFetch(u_id_tex, ivec2(gl_FragCoord.xy), 0).rg;
	if (u_overlap == 1) {
		// 監査プローブ（STENCIL_DEBUG と同思想）：winding 和の異常だけを色分けして残す。
		float ar = abs(t.r), ag = abs(t.g);
		if (ag < 0.5) {
			if (ar > 0.5) { fragColor = vec4(0.0, 0.9, 1.0, 0.85); return; }   // シアン＝向き矛盾の重なり（巻き数正味0なのに fid 和が残る）
			discard;                                                            // 被覆なし＝正常
		}
		float qo = t.r / t.g;
		if (abs(qo - round(qo)) > 0.25) { fragColor = vec4(1.0, 0.0, 0.8, 0.85); return; }   // マゼンタ＝別筆同士の重なり（fid 不定）
		if (ag > 1.5)                   { fragColor = vec4(1.0, 0.55, 0.0, 0.85); return; }   // 橙＝同一筆の多重登記（k重・fid は約分で整数）
		discard;                                                                              // 単被覆＝正常
	}
	if (abs(t.g) < 0.5) discard;        // 被覆なし（穴・外）。G の符号は外環 CW（向き未正規化）も吸収
	float q = t.r / t.g;                // 多重登記は約分で消える（R=k(fid+1), G=k → q=fid+1）
	if (abs(q - round(q)) > 0.25) discard;   // 別 feature 同士の真の重複＝fid が定まらない＝塗らない（デタラメ色を出さない。union 経路の担当）
	int fid = int(round(q)) - 1;
	if (fid < 0 || fid >= u_fid_count) discard;
	uvec4 rec = texelFetch(u_fid_style, ivec2(fid % u_fid_w, fid / u_fid_w), 0);
	if ((rec.b & 1u) == 0u) discard;    // flags bit0 = visible（filter の実体）
	uint c = rec.r;                     // R = fill 色 RGBA8
	vec4 col = vec4(float(c >> 24u), float((c >> 16u) & 255u), float((c >> 8u) & 255u), float(c & 255u)) / 255.0;
	if (col.a <= 0.0) discard;
	fragColor = col;
}`;

// ── 能力検出（コンテキストごとに一度）──
function idCaps(gl) {
	if (s._idCaps !== undefined) return s._idCaps;
	const cbf = gl.getExtension('EXT_color_buffer_float');
	const fb  = gl.getExtension('EXT_float_blend');
	let caps = null;
	if (cbf && fb)  caps = { internal: gl.RG32F,   fmt: gl.RG,   type: gl.FLOAT,      maxFid: 1 << 24, name: 'RG32F' };
	else if (cbf)   caps = { internal: gl.RG16F,   fmt: gl.RG,   type: gl.HALF_FLOAT, maxFid: 2047,    name: 'RG16F' };
	else if (gl.getExtension('EXT_color_buffer_half_float'))
	                caps = { internal: gl.RGBA16F, fmt: gl.RGBA, type: gl.HALF_FLOAT, maxFid: 2047,    name: 'RGBA16F' };
	s._idCaps = caps;
	console.info('[gint] idFill caps: %s (float_blend=%s)', caps?.name ?? 'なし（stencil単色へ）', !!fb);
	return caps;
}

// ── fid スタイル表（RGBA32UI・1 texel/fid）── style.js の buildFidStyle 出力を受ける。
// 同寸なら texSubImage2D（restyle の契約＝テクスチャ更新1回のみ・§7.1）。CPU 側データは
// context restore 用に保持（s._fidStyleData）。
export function uploadFidStyle(table, count) {
	const gl = s.gl;
	const u32 = table instanceof Uint32Array ? table : new Uint32Array(table);
	if (!gl || !count || u32.length < count * 4) { clearFidStyle(); return; }
	s._fidStyleData = { u32, count };
	const W = Math.min(4096, s.TEX_ARC_W), H = Math.ceil(count / W);
	if (s.fidStyleTex && s.fidStyleW === W && s._fidStyleH === H) {
		const pad = new Uint32Array(W * H * 4);
		pad.set(u32.subarray(0, count * 4));
		gl.bindTexture(gl.TEXTURE_2D, s.fidStyleTex);
		gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RGBA_INTEGER, gl.UNSIGNED_INT, pad);
	} else {
		if (s.fidStyleTex) gl.deleteTexture(s.fidStyleTex);
		const pad = new Uint32Array(W * H * 4);
		pad.set(u32.subarray(0, count * 4));
		const tex = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, tex);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, W, H, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, pad);
		s.fidStyleTex = tex; s.fidStyleW = W; s._fidStyleH = H;
	}
	s.fidStyleCount = count;
}

export function clearFidStyle() {
	if (s.fidStyleTex && s.gl) s.gl.deleteTexture(s.fidStyleTex);
	s.fidStyleTex = null; s.fidStyleW = 0; s._fidStyleH = 0; s.fidStyleCount = 0;
	s._fidStyleData = null;
}

// context restore 時の再構築（worker.js / embed.js の restore ハンドラから呼ぶ）。
export function restoreFidStyle() {
	const d = s._fidStyleData;
	s.fidStyleTex = null; s.fidStyleW = 0; s._fidStyleH = 0;   // 旧テクスチャはコンテキストごと消滅済み
	if (d) uploadFidStyle(d.u32, d.count);
}

// ID 塗りが使えるか（passes.js の分岐条件）。paint 明示＝全ズーム尊重（低ズーム既定塗りと独立）。
// fillOff（巨大ポリゴン）は stencil と同じ理由（fan 全密度が毎フレーム）で尊重する。
export function canUseIdFill() {
	const gl = s.gl;
	if (!gl || !s.fidStyleTex || s.polyEdges <= 0 || s.fillOff) return false;
	const caps = idCaps(gl);
	return !!caps && s.fidStyleCount <= caps.maxFid;
}

function ensurePrograms(gl) {
	if (s._idPrograms) return s._idPrograms;
	const idProgram      = linkProgram(gl, VS_ID,   FS_ID);
	const resolveProgram = linkProgram(gl, VS_FILL, FS_RESOLVE);
	s._idPrograms = {
		idProgram, resolveProgram,
		uId:      getUniforms(gl, idProgram, [...SHARED_UNIFORM_NAMES,
					'u_pivot_tex', 'u_pivot_w', 'u_has_pivot', 'u_view_bbox', 'u_use_vbb']),
		uResolve: getUniforms(gl, resolveProgram, ['u_id_tex', 'u_fid_style', 'u_fid_w', 'u_fid_count', 'u_overlap']),
	};
	return s._idPrograms;
}

// ID バッファ FBO（canvas と同寸）。embedded の動的解像度ではフレーム毎に寸法が変わり得る＝
// 不一致時のみ作り直し（解像度段の変化は稀＝churn は実用上無視できる）。
function ensureIdFBO(gl, caps) {
	if (s._idFBO && s._idW === s.width && s._idH === s.height) return true;
	if (s._idFBO) { gl.deleteFramebuffer(s._idFBO); gl.deleteTexture(s._idTex); }
	const tex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texImage2D(gl.TEXTURE_2D, 0, caps.internal, s.width, s.height, 0, caps.fmt, caps.type, null);
	const fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
	const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	if (!ok) {   // 実機で float 添付が不完全＝能力なし扱いに降格（以後 stencil 単色）
		gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
		s._idCaps = null;
		console.warn('[gint] idFill FBO incomplete → stencil 単色へ降格');
		return false;
	}
	s._idFBO = fbo; s._idTex = tex; s._idW = s.width; s._idH = s.height;
	return true;
}

// ── 本体：ID 蓄積パス → 解決パス（renderCleanScene の stencil+fill 位置から呼ばれる）──
// 呼び出し時の前提：emptyVAO bind 済み・viewport=canvas 寸・blend 有効（straight alpha）。
// 終了時：targetFBO を bind し blend を straight alpha に復元して返す。
export function renderIdFill(data, targetFBO) {
	const gl = s.gl;
	const caps = idCaps(gl);
	if (!caps || !ensurePrograms(gl) || !ensureIdFBO(gl, caps)) {
		gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO ?? null);   // 失敗時も呼び出し元のターゲットへ戻す（stencil 分岐が続行できる状態）
		return false;
	}
	const { idProgram, resolveProgram, uId, uResolve } = s._idPrograms;
	const { arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height } = s;

	// ① winding 和の蓄積（自前 FBO へ加算）。stencil と同じく全密度（u_lod_rank=0）＝
	//    LOD 簡略化の自己交差で winding が壊れる斑点を出さない（stencil 塗りと同じ設計判断）。
	gl.bindFramebuffer(gl.FRAMEBUFFER, s._idFBO);
	gl.disable(gl.STENCIL_TEST);
	gl.clearColor(0, 0, 0, 0);
	gl.clear(gl.COLOR_BUFFER_BIT);
	gl.blendFunc(gl.ONE, gl.ONE);   // 加算（equation は既定 FUNC_ADD のまま）
	gl.useProgram(idProgram);
	bindSharedUniforms(gl, uId, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
	bindPivot(gl, uId);
	gl.uniform1f(uId.u_lod_rank, 0);
	gl.drawArrays(gl.TRIANGLES, 0, s.polyEdges * 3);

	// ② 解決（fid→スタイル表→色）を本来のターゲットへ straight alpha で。
	gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
	gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
	gl.useProgram(resolveProgram);
	gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, s._idTex);
	gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, s.fidStyleTex);
	gl.activeTexture(gl.TEXTURE0);
	gl.uniform1i(uResolve.u_id_tex,    3);
	gl.uniform1i(uResolve.u_fid_style, 4);
	gl.uniform1i(uResolve.u_fid_w,     s.fidStyleW);
	gl.uniform1i(uResolve.u_fid_count, s.fidStyleCount);
	gl.uniform1i(uResolve.u_overlap,   s.idOverlapMode ? 1 : 0);
	gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	return true;
}

// context lost（テクスチャ/FBO はコンテキストごと消滅＝参照だけ捨てる。CPU 側 _fidStyleData は保持）。
export function idFillContextLost() {
	s.fidStyleTex = null; s._idFBO = null; s._idTex = null; s._idW = s._idH = 0;
	s._idPrograms = null; s._idCaps = undefined;
}

export function disposeIdFill() {
	const gl = s.gl;
	if (gl) {
		if (s._idFBO) gl.deleteFramebuffer(s._idFBO);
		if (s._idTex) gl.deleteTexture(s._idTex);
		if (s._idPrograms) { gl.deleteProgram(s._idPrograms.idProgram); gl.deleteProgram(s._idPrograms.resolveProgram); }
	}
	clearFidStyle();
	s._idFBO = null; s._idTex = null; s._idW = s._idH = 0;
	s._idPrograms = null; s._idCaps = undefined;
}
