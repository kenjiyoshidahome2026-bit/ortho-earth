// gint の GL2 の部品：cam 由来の uniform・遠方の要・標高の uniform を詰める・テクスチャを上げる。共通の部品（辺の表・遠方の要の計算…）は ../../gint/utility.js（2026-10-15 に分けた）。
import { betaOf, ellipsoidOn } from '../../camera.ts';
import { farPivotParams, farPivotGlobal, layerBboxOf, FAR_K, FAR_BIG, FAR_PIVOT } from '../../gint/utility.ts';
import type { Uniforms } from './programs.ts';
import type { GintGLState, GLDrawData } from './state.ts';
export * from '../../gint/utility.ts';   // gl の中の読み手（embed・passes・idfill・identify…）は今のまま ./utility.js から読む


// ── site 2：cam 由来の mvp/eye/origin を uniform へ（v1 の rotate/scale/rsincos/jac を建て替え）──
// mvp/eye/origin は worker が cam から一度だけ生成し data に載せる（site 3）。ここは受けて set するだけ。
// width/height は CSS px（fetchProject/toNDC が同単位で round-trip、dpr は線幅側で別処理）。
export function bindSharedUniforms(gl: WebGL2RenderingContext, u: Uniforms, data: GLDrawData, arcTex: WebGLTexture | null, metaTex: WebGLTexture | null, arcW: number, metaW: number, width: number, height: number): void {
	gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, arcTex);
	gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, metaTex);
	gl.uniform1i(u.u_arc_tex,  0);
	gl.uniform1i(u.u_meta_tex, 1);
	gl.uniform1i(u.u_arc_w,    arcW);
	gl.uniform1i(u.u_meta_w,   metaW);
	gl.uniformMatrix4fv(u.u_mvp, false, data.mvp);
	gl.uniform3f(u.u_eye,    data.eye[0], data.eye[1], data.eye[2]);
	// 経度は正規化（Morton 中心 ix_center と u_origin.x を同値に保つ）。dlonE7 が antimeridian を畳む。
	const lon = ((data.origin[0] % 360) + 540) % 360 - 180;
	gl.uniform2f(u.u_origin,   lon, data.origin[1]);
	gl.uniform2f(u.u_viewport, width, height);
	gl.uniform1ui(u.u_ix_center, (Math.round((lon             + 180) * 1e7)) >>> 0);
	gl.uniform1ui(u.u_iy_center, (Math.round((data.origin[1] +  90) * 1e7)) >>> 0);
	// RTE の錨＝原点の三角比を CPU(double) で算出（shader の float32 で origin+delta を組まない）。
	// 楕円体＝緯度側は β（更成緯度）の三角＋dβ 錨 u_ell_trig（球＝β=φ・錨は全0＝補正が厳密0）。
	const lr = lon * Math.PI / 180, br = betaOf(data.origin[1]) * Math.PI / 180;
	gl.uniform4f(u.u_origin_trig, Math.cos(lr), Math.sin(lr), Math.cos(br), Math.sin(br));
	const ell = ellipsoidOn(), pr = data.origin[1] * Math.PI / 180;
	if (u.u_ell_trig) gl.uniform4f(u.u_ell_trig, ...(ell ? [Math.cos(2 * pr), Math.sin(2 * pr), Math.cos(4 * pr), Math.sin(4 * pr)] : [0, 0, 0, 0]) as [number, number, number, number]);
	if (u.u_ell) gl.uniform1f(u.u_ell, ell ? 1 : 0);
	// MVP相殺回避の錨（worker が float64 で算出）。欠落時は 0 でなく等価挙動へ退避不能なので必ず渡す。
	if (data.clipT) gl.uniform4f(u.u_clipT, data.clipT[0], data.clipT[1], data.clipT[2], data.clipT[3]);
	gl.uniform1f(u.u_origin_zr, data.originZr ?? 0.0);
	gl.uniform1f(u.u_lod_rank, data.lodRank ?? 0.0);   // GPU Dynamic LOD 閾値（未設定=0=全描画）
	// 窓座標モード（地面アトラスへの焼き込み）：data.atlas={ off:[dlon,dlat], inv:[1/sLon,1/sLat] }。無ければ 0＝従来
	if (u.u_atlasOn) gl.uniform1f(u.u_atlasOn, data.atlas ? 1 : 0);
	if (u.u_atlas) gl.uniform4f(u.u_atlas, data.atlas ? data.atlas.off![0] : 0, data.atlas ? data.atlas.off![1] : 0, data.atlas ? data.atlas.inv[0] : 1, data.atlas ? data.atlas.inv[1] : 1);
}

// feature bbox テクスチャ（扇要＋GPU bbox カリング）を unit2 へ。無いデータ（線のみ/疎fid）は
// 従来のクリップ原点＆カリング無効。視野bbox は visibleRuns と同じ線幅マージン（e7 で 10000≈0.001°）。
// （passes.js から移設＝idfill.js の ID 塗りパスと共用）
// data（任意）＝塗り扇の遠方の要（画面カリング・farPivotParams）の向き。無し・線パス＝無効（従来の bbox 中心）
export function bindPivot(s: GintGLState, gl: WebGL2RenderingContext, u: Uniforms, data: GLDrawData | null = null): void {
	gl.uniform1i(u.u_pivot_tex, 2);
	gl.uniform1i(u.u_pivot_w, s.pivotW || 1);
	gl.uniform1i(u.u_has_pivot, s.pivotTex ? 1 : 0);
	const vb = s.lastViewBbox;
	gl.uniform1i(u.u_use_vbb, (s.pivotTex && vb) ? 1 : 0);
	if (vb) gl.uniform4ui(u.u_view_bbox,
		Math.max(0, vb[0] - 10000), Math.max(0, vb[1] - 10000),
		Math.min(0xFFFFFFFF, vb[2] + 10000), Math.min(0xFFFFFFFF, vb[3] + 10000));
	if (u.u_far_q) {
		const fp = data && s.pivotTex ? farPivotParams(data, vb) : null;
		gl.uniform4f(u.u_far_q, fp ? fp.q[0] : 0, fp ? fp.q[1] : 0, fp ? 1 : 0, FAR_K);
		if (fp) { gl.uniform4f(u.u_far_axes, fp.axes[0], fp.axes[1], fp.axes[2], fp.axes[3]); gl.uniform2ui(u.u_far_big, fp.big[0], fp.big[1]); }
	}
	// pivot 無しでも「null を」バインド＝unit2 は基図の メッシュマスク（float）と共用。残留 float を
	// usampler(u_pivot_tex) が掴むと sampler型不整合で draw 全滅（renderer unit1 の標高と対の同病）。
	gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, s.pivotTex || null); gl.activeTexture(gl.TEXTURE0);
}

// 深度統合（1canvas 段階B）uniform：data.depth（renderer の frame コンテキスト＝terrainDepth 時のみ非null）
// を program へ。無ければ全0＝従来動作（worker モード含む）。u_elevTex の unit 割当(7)だけは常に行う
//（sampler2D の既定 unit0 は u_arc_tex(usampler2D) と同 unit になり draw が INVALID_OPERATION になるため）。
//（passes.js から移設 2026-08-14＝面ドレープ化で uStencil/uId とも共用）
export function bindDepthUniforms(gl: WebGL2RenderingContext, u: Uniforms, data: GLDrawData) {
	const dep = data.depth;
	gl.uniform1i(u.u_elevTex, 7);
	gl.uniform1f(u.u_logCoef, dep?.logCoef ?? 0);
	gl.uniform1f(u.u_fogFar,  dep?.fogFar ?? 1e9);
	const op = data.originPt;
	gl.uniform3f(u.u_origin_pt, op?.[0] ?? 0, op?.[1] ?? 0, op?.[2] ?? 0);
	gl.uniform1f(u.u_elevScale, dep?.elevScale ?? 0);
	gl.uniform1f(u.u_hasElev,   dep?.hasElev ?? 0);
	gl.uniform1f(u.u_elevEdgeFade, dep?.edgeFade ?? 0);
	const b = dep?.elevBounds;
	gl.uniform4f(u.u_elevBounds, b?.[0] ?? 0, b?.[1] ?? 0, b?.[2] ?? 1, b?.[3] ?? 1);
	const mq = dep?.meshQ;   // 案A: 描画メッシュ面への量子化（無ければ G=0＝素の elevAt）
	gl.uniform4f(u.u_meshQ, mq?.[0] ?? 0, mq?.[1] ?? 0, mq?.[2] ?? 1, mq?.[3] ?? 1);
	gl.uniform1f(u.u_meshG, dep?.meshG ?? 0);
	if (u.u_near) { const nr = data.near; gl.uniform2f(u.u_near, nr?.[0] ?? 0, nr?.[1] ?? 0); }   // 地形適応細分の近傍窓（deg 半幅・0=集中なし）
	if (u.u_sub) gl.uniform1i(u.u_sub, 1);   // 1辺あたりサブ区間数の既定＝1（線パスがバケットごとに上書き）
	if (u.u_subSkipE7) gl.uniform1ui(u.u_subSkipE7, 0);   // メイン描画が飛ばす長辺の下限スパン（e7）。0＝飛ばさない
	if (u.u_hidden) gl.uniform1f(u.u_hidden, 0);
	if (dep?.elevTex) { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, dep.elevTex); gl.activeTexture(gl.TEXTURE0); }
	return dep;
}

// ── 以下 node-independent（投影に触れない純データ構造）＝v1 から逐語で携行 ──

export function uploadTex2D(gl: WebGL2RenderingContext, u32: Uint32Array, w: number, h: number, internalFmt: number, fmt: number): WebGLTexture {
	const tex = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, tex);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, fmt, gl.UNSIGNED_INT, u32);
	return tex;
}
