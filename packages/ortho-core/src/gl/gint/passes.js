// renderCleanScene:    ハイライト無しの全景（canvas か baseFBO へ）
// drawOverlay:         baseFBO を blit → アクティブ地物のハイライト＋mask
// renderPickingBuffer: feature ID を RGB24 で pick FBO へ
// v1(ortho-map) の gintRenderPasses を移植。site 2 の点bind を mvp/eye/origin へ。
// 単位は device px 一本（u_dpr=1、線幅/半径は worker が ×dpr 済み、blit は width 直）。

import { s, DEF_STYLE, DEF_DASH, DEF_FILL, DEF_MASK } from './state.js';
import { bindSharedUniforms, bindPivot, bindDepthUniforms } from './utility.js';
import { betaOf, ellipsoidOn } from '../../camera.js';
import { canUseIdFill, renderIdFill } from './idfill.js';

// 低ズームでアウトライン→ベタ塗りへ切替えるズーム閾値の既定（データ粒度から導出した s.outlineZoom を優先）。
const OUTLINE_ZOOM = 13;   // 既定の切替z（256px世界。deriveOutlineZoom targetPx=8 と同じ「旧v2視覚と同点」の調律）

// 段階別 LOD メタの選択（ortho-map から移植）：
//   名目＝「rank 適格（minW ≤ rank）で最も軽い tier」。kept 集合（weight≥minW ⊇ weight≥rank）は動的LODの
//   描画結果と同一＝見た目不変。適格 tier が無ければ基準メタ（正確・全密度）＋可視チャンクカリング。
//   安全弁＝名目の可視辺数が「最細 tier の 1.5倍」を超えるなら最細 tier で代用。これ一本で
//   ①梯子の遅延構築中 ②rank < 最細tier の帯 ③チルトで地平線が入り viewBbox=null＝カリング不能、
//   の全てを受ける（名目よりわずかに粗い絵になるだけ。旧・個別ゲートは海岸線41万辺のフル密度描画が
//   地図フレームを塞ぎ GPU 数百ms/フレーム＝実機で激重＋GPUプロセス膨張を起こした）。
// 対象は線・ピッキングのみ（stencil 塗りは全密度＝自己交差斑点の根治を維持、overlay は
// polyEdgeByFid の辺レンジが基準メタ前提のため基準メタ固定）。runs＝可視チャンクだけを描く。
function pickLineTier(rank, baseTex, baseCount) {
	let nominal = null, finest = null;
	for (const t of s.lodTiers ?? []) {
		if (t.minW <= rank && (!nominal || t.edgeCount < nominal.edgeCount)) nominal = t;
		if (!finest || t.minW < finest.minW) finest = t;
	}
	const sel = nominal
		? { tex: nominal.tex, count: nominal.edgeCount, runs: visibleRuns(nominal.edgeCount, nominal.chunks), minW: nominal.minW }
		: { tex: baseTex, count: baseCount, runs: visibleRuns(baseCount, s.metaChunks), minW: 0 };
	s._pfRuns = sel.runs.length; s._pfChunks = (nominal ? nominal.chunks : s.metaChunks)?.length ?? 0;   // perf 計測用
	if (!nominal && finest) {   // 安全弁（適格 tier 無し＝基準メタに落ちた時だけ）
		let visible = 0;
		for (const r of sel.runs) visible += r[1];
		if (visible > finest.edgeCount * 1.5)
			return { tex: finest.tex, count: finest.edgeCount, runs: visibleRuns(finest.edgeCount, finest.chunks), minW: finest.minW };
	}
	if (!nominal && !finest) {
		// ハードキャップ＝梯子が1段も無い窓（初回ロード直後の遅延構築中など）の最後の柵。
		// nps_all 実測でこの窓は基準メタ451万辺/フレーム（定常の42倍＝GPU秒級）＝「固まる」の実体だった。
		// 可視 run を辺予算で打ち切る（Morton順＝空間的に偏るが一過性。梯子完成時に scheduleTierBuild が
		// requestDraw で完全な絵に描き直す）。
		const CAP = 600_000;
		let acc = 0;
		for (let i = 0; i < sel.runs.length; i++) {
			if (acc + sel.runs[i][1] > CAP) {
				sel.runs = sel.runs.slice(0, i + 1);
				sel.runs[i] = [sel.runs[i][0], Math.max(0, CAP - acc)];
				sel.minW = -3;   // perf 行で「キャップ発動」と分かる印
				break;
			}
			acc += sel.runs[i][1];
		}
	}
	return sel;
}

// 可視チャンク run（[startEdge, edgeCount] の列）。チャンク台帳や view bbox が無ければ全量1本。
// マージン: 線幅ぶん bbox を少し広げる（SE=1e7 単位・約 0.001°）。
function visibleRuns(totalCount, chunks) {
	const vb = s.lastViewBbox;
	if (!chunks?.length || !vb) return [[0, totalCount]];
	const mg = 10000;
	const vx0 = vb[0] - mg, vy0 = vb[1] - mg, vx1 = vb[2] + mg, vy1 = vb[3] + mg;
	const runs = [];
	let curStart = -1, curEnd = 0;
	for (const c of chunks) {
		const b = c.bbox;
		const vis = !(b[2] < vx0 || b[0] > vx1 || b[3] < vy0 || b[1] > vy1);
		if (vis) { if (curStart < 0) curStart = c.start; curEnd = c.end; }
		else if (curStart >= 0) { runs.push([curStart, curEnd - curStart]); curStart = -1; }
	}
	if (curStart >= 0) runs.push([curStart, curEnd - curStart]);
	return runs;
}

// bindDepthUniforms は utility.js へ移設（2026-08-14＝面ドレープ化で uStencil/uId=idfill.js とも共用）。

// 境界メタ描画用：扇要=クリップ原点（単一要）＋fid bbox カリング無効。
// 境界メタのループは「多数 fid の arc の寄せ集め」＝per-fid 扇要（pivotClip）では1つの閉ループが
// 別々の要から扇られて閉じず、巻き数の閉じ残しが巨大な楔として漏れる（札幌 大字圏で実測）。
// 同様に fid bbox カリングは視界外 fid 帰属の arc を落とし、視界内ループを破る＝両方無効化が正解。
// v1 は常に単一要・カリング無し＝この流儀そのもの。境界メタは辺数が桁減済みなので TBDR も安全。
function bindPivotBoundary(gl, u) {
	gl.uniform1i(u.u_has_pivot, 0);   // pivotClip → クリップ原点 vec4(0,0,0,1)
	gl.uniform1i(u.u_use_vbb, 0);     // bboxVisible → 常に true
}

// per-fid スタイル表（paint 時のみ・unit5）：visibility（filter）/line色/width を VS が引く。
// u_width_add＝パス都合の幅増分（clean=0 / highlight=+2。表はスタイル正味のみ＝spec §7.1）。
function bindFidStyle(gl, u, widthAdd = 0) {
	gl.uniform1i(u.u_has_fidstyle, s.fidStyleTex ? 1 : 0);
	if (u.u_width_add) gl.uniform1f(u.u_width_add, widthAdd);
	if (!s.fidStyleTex) return;
	gl.uniform1i(u.u_fid_style, 5);
	gl.uniform1i(u.u_fidstyle_w, s.fidStyleW || 1);
	gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, s.fidStyleTex); gl.activeTexture(gl.TEXTURE0);
}

// site 2（点）：cam 由来の mvp/eye/origin を点プログラムへ。v1 の rotate/scale/rsincos/jac を建て替え。
function bindPointUniforms(u, data) {
	const { gl, ptTex, ptMetaTex, TEX_ARC_W, width, height } = s;
	gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ptTex);
	gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, ptMetaTex);
	gl.uniform1i(u.u_pt_tex,      0);
	gl.uniform1i(u.u_pt_meta_tex, 1);
	gl.uniform1i(u.u_pt_w,        TEX_ARC_W);
	gl.uniformMatrix4fv(u.u_mvp, false, data.mvp);
	gl.uniform3f(u.u_eye,    data.eye[0], data.eye[1], data.eye[2]);
	const lon = ((data.origin[0] % 360) + 540) % 360 - 180;
	gl.uniform2f(u.u_origin,   lon, data.origin[1]);
	gl.uniform2f(u.u_viewport, width, height);
	gl.uniform1f(u.u_pt_radius, data.ptRadius ?? 1.5);
	gl.uniform1ui(u.u_ix_center, (Math.round((lon            + 180) * 1e7)) >>> 0);
	gl.uniform1ui(u.u_iy_center, (Math.round((data.origin[1] +  90) * 1e7)) >>> 0);
	// RTE の錨＝原点の三角比＋MVP相殺回避の錨（arc 側 bindSharedUniforms と同一）。楕円体＝β三角＋dβ錨。
	const lr = lon * Math.PI / 180, br = betaOf(data.origin[1]) * Math.PI / 180;
	gl.uniform4f(u.u_origin_trig, Math.cos(lr), Math.sin(lr), Math.cos(br), Math.sin(br));
	const pr = data.origin[1] * Math.PI / 180, pell = ellipsoidOn();
	if (u.u_ell_trig) gl.uniform4f(u.u_ell_trig, ...(pell ? [Math.cos(2 * pr), Math.sin(2 * pr), Math.cos(4 * pr), Math.sin(4 * pr)] : [0, 0, 0, 0]));
	if (u.u_ell) gl.uniform1f(u.u_ell, pell ? 1 : 0);
	if (data.clipT) gl.uniform4f(u.u_clipT, data.clipT[0], data.clipT[1], data.clipT[2], data.clipT[3]);
	gl.uniform1f(u.u_origin_zr, data.originZr ?? 0.0);
}

export function renderCleanScene(data, targetFBO = null) {
	const { gl, programs, arcTex, metaTex, ptTex, ptMetaTex,
			totalEdges, totalPoints, TEX_ARC_W, TEX_META_W, width, height } = s;
	const { renderProgram, stencilProgram, fillProgram,
			pointProgram, uRender, uStencil, uFill, uPoint, emptyVAO } = programs;

	gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
	if (s.embedded && !targetFBO) {
		// embedded＝地図が既に描かれた default framebuffer の上に blend で重ねる＝色は消さない。
		// stencil だけ消す（塗りの winding 判定用。renderer 側の stencil 利用は都度 clear する規約＝衝突しない）。
		// ★bit7(0x80)＝renderer の建物マスク（面ドレープの深度統合 2026-08-14）＝消さない（0x7F＝winding 側だけ）
		gl.stencilMask(0x7F);
		gl.clear(gl.STENCIL_BUFFER_BIT);
	} else {
		gl.clearColor(0, 0, 0, 0);
		gl.stencilMask(0xFF);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
	}
	gl.bindVertexArray(emptyVAO);

	// ── Stencil + Fill（stencil-then-cover）──
	// 低ズームの既定は面＝ベタ塗り（ortho-map から移植）。style0 の色 × α0.8＝下のタイル(地形/注記)がうっすら
	// 生きる。zoom < outlineZoom（データ粒度から導出＝筆z≈15/市区町村z≈6）かつポリゴンが在る時だけ。
	// 明示 fillColor は全ズームで尊重（透明を渡せば従来のアウトラインのみ）。polyBboxByFid が空＝線/点のみ
	// （海岸線等）＝塗らない（線を winding にファンさせる誤塗り防止）。
	const st = data.styleTable ?? DEF_STYLE;
	const zoomV = data.zoom ?? 99, oz = s.outlineZoom ?? OUTLINE_ZOOM;
	const lowZoom = zoomV < oz;
	// 切替ズーム（outlineZoom）跨ぎのもたつき対策＝ヒステリシス：移動中は安い表現（境界メタ＋ベタ塗り）を
	// +1.5z 延長し、崖（境界3万辺→基準20万辺級のコスト跳ね）を操作中に跨がない。静止(settle)で必ず正表現へ
	// 戻る＝止まった絵は従来と同一（terrainGate と同じ「動いている間だけ粗く」の思想）。
	// 「移動中」は静止4フレームまで含む＝wheel の tick 間の1-2フレーム静止で表現が明滅しない
	//（MOVE_EDGE_BUDGET の _staticN<4 と同じデバウンス。embedded 以外は _staticN 無し＝_isDrawing のみ）。
	const moving = s._isDrawing || (s._staticN ?? 99) < 4;
	const lowZoomEff = lowZoom || (moving && zoomV < oz + 1.5) || !!data._forceLow;   // _forceLow＝予算超え巨大層の移動中安表現（embed.js/gpu 同型）
	// ヒステリシス帯で静止カウント中はフレームを自前で継続要求＝地図が即 idle 化しても正表現へ必ず収束
	//（予算スキップの settle 復帰と同じ「他人のフレームに相乗りしない」原則）。
	if (!s._isDrawing && moving && !lowZoom && lowZoomEff) s.requestDraw?.();
	// fillOff＝巨大ポリゴンの自動塗り停止（uploadGintTextures 判定）。lowFill＝その層だけ低ズーム帯の単色塗りを
	// 生かす（fillA のフェードが z<oz+1.2 に自然に閉じ込める＝高ズームは従来どおりアウトラインのみ）。
	// 単色 stencil は常時境界メタ＝隣接データ（ZCTA/筆級）では正味winding≠0のみで桁減＝v1が滑らかに描けていた帯。
	const hasPoly = (s.polyBboxByFid?.size ?? 0) > 0 && (!s.fillOff || s.lowFill);
	// 既定塗り＝α0.8（v1 と同値。0.5 も試したが 0.8 へ戻す＝2026-07-26 目視裁定）。
	// oz 跨ぎで即消しせず oz〜oz+1.2z で 0.8→0 へ線形フェード＝切替を「ポン」でなくグラデーションに溶かす
	//（z≤oz は clamp で常に 0.8。塗りは境界メタ stencil＝帯の延長コストは実質ゼロ）。移動中は lowZoomEff が
	// さらに帯を持ち上げるが、フェード式は zoom 連続なので明滅しない。
	const fillA = data._forceLow ? st[3] * 0.8   // 安表現中＝フェード無効（内陸ビューでも面のシルエットを残す）
		: st[3] * 0.8 * Math.max(0, Math.min(1, ((oz + 1.2) - zoomV) / 1.2));
	const fc = data.fillColor ?? (hasPoly && (lowZoomEff || fillA > 0.004) ? [st[0], st[1], st[2], fillA] : DEF_FILL);
	// paint（fid スタイル表）が預けられていれば ID バッファ塗り＝per-fid コロプレス（gint draw spec.md §7.2）。
	// 明示 paint は全ズーム尊重（明示 fillColor と同じ原則）。能力なし/fid 超過/FBO 不成立は従来 stencil へ。
	const idDone = !data._forceLow && canUseIdFill() && renderIdFill(data, targetFBO);   // 安い表現中は idfill（全密度扇）を止める
	// 単色 stencil 塗りは常時境界メタ（共有 arc は winding 寄与が正味 0＝落としても数学的に同一で桁違いに軽い）。
	// ID バッファ塗りは fid 重みのため境界メタ不可＝基準メタ固定（renderIdFill 側）。
	const hasB = !!(s.metaTexB && s.polyEdgesB > 0);
	const stTex = hasB ? s.metaTexB : metaTex, stCount = hasB ? s.polyEdgesB : s.polyEdges;
	if (!idDone && fc[3] > 0 && stCount > 0 && !(data._forceLow && stCount > (data.moveBudget ?? 250_000) * 8)) {   // 安表現中の塗り予算（embed.js sync の canFill と同じ物差し）
		// occ＝面ドレープの深度統合：チルト（elevScale>0）でのみ建物 bit7 で塗りをスキップ＝真俯瞰は全塗り維持（裁定）
		const occ = !targetFBO && !!(data.depth && (data.depth.elevScale ?? 0) > 0 && data.depth.hasElev);
		gl.enable(gl.STENCIL_TEST);
		gl.stencilMask(0x7F);   // winding はビット0-6（bit7=renderer の建物マスク＝汚さない）
		gl.clear(gl.STENCIL_BUFFER_BIT);
		gl.colorMask(false, false, false, false);
		gl.stencilFunc(gl.ALWAYS, 0, 0x7F);
		gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
		gl.stencilOpSeparate(gl.BACK,  gl.KEEP, gl.KEEP, gl.DECR_WRAP);
		gl.useProgram(stencilProgram);
		bindSharedUniforms(gl, uStencil, data, arcTex, stTex, TEX_ARC_W, TEX_META_W, width, height);
		bindDepthUniforms(gl, uStencil, data);   // 面ドレープ＝塗り扇の辺端点を地形高へ（fetchClipDrape・真俯瞰=全0=無変化）
		if (hasB) bindPivotBoundary(gl, uStencil); else bindPivot(gl, uStencil);   // 境界メタ＝単一要・カリング無効（fid混成ループ）
		gl.uniform1f(uStencil.u_lod_rank, 0);   // 塗りstencilは全密度＝LOD簡略化の自己交差による斑点(winding反転)を防ぐ
		// ポリゴン辺（メタ先頭連続）のみ winding にファン＝折れ線辺を混ぜない（ortho-map と同規約）
		gl.drawArrays(gl.TRIANGLES, 0, stCount * 3);
		gl.useProgram(fillProgram);
		if (occ) {   // 建物 bit7 の画素の winding を 0 へ（REPLACE は ref 0x80 を stencilMask 0x7F で書く＝0）→cover(≠0) が陰を跳ぶ
			gl.stencilFunc(gl.EQUAL, 0x80, 0x80);
			gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		}
		gl.colorMask(true, true, true, true);
		gl.stencilMask(0x00);
		gl.stencilFunc(gl.NOTEQUAL, 0, 0x7F);   // 比較も winding ビットのみ（bit7 で「建物の上だけ塗る」誤爆を防ぐ）
		gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
		gl.uniform4fv(uFill.u_fill_color, fc);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.disable(gl.STENCIL_TEST);
	}

	// ── Fat-line edges ──（低ズーム＝境界メタ＝アウトラインのみ / 中〜高ズーム＝tier＋可視チャンク run）
	// lowZoom(z<outlineZoom) では筆内部の線は視認不能（ベタ潰れ）＝境界メタで街区外郭だけ描く。
	// anchor支配で tier が組めない筆系（札幌37万辺=tiers0）の中ズームを桁で軽くする＝ズーム中描画の生命線。
	const lineOK = !(data._forceLow && !(s.metaTexB && s.totalEdgesB > 0 && s.totalEdgesB <= (data.moveBudget ?? 250_000)));   // 安表現中に境界が予算超＝線パスごと出さない（フル tier へ落とさない＝塗りシルエットのみ）
	if (!lineOK) { s._pfLineEdges = 0; s._pfTierW = -4; }   // perf印: -4＝安表現で線パス抑止
	if (totalEdges > 0 && lineOK) {
		// 境界メタ線パスの安全弁：離散データ（nps_all級）は netting が効かず境界メタ≈全辺（実測120万辺）に
		// 退化するが、この経路は runs=null＝カリング/tier/ハードキャップの全てをすり抜ける唯一の線パスだった。
		// 最細 tier（台帳先頭＝minW最小＝辺数最大）の1.5倍を超える境界メタは tier 経路へ（pickLineTier の
		// 安全弁と同じ物差し）。梯子不在の窓では絶対予算600kと比較＝pickLineTier 側のハードキャップに任せる。
		// tier が組めない筆系（anchor支配・境界メタが桁減する本来の受益者）は従来どおり境界メタ＝視覚不変。
		const finestT = s.lodTiers?.length ? s.lodTiers[0] : null;   // minW 昇順台帳＝先頭が最細（辺数最大）
		const lnB = data._forceLow ? !!(s.metaTexB && s.totalEdgesB > 0 && s.totalEdgesB <= (data.moveBudget ?? 250_000))   // 強制安表現＝境界一択・予算超は線なし（塗りシルエットのみ）
			: lowZoomEff && s.metaTexB && s.polyEdgesB > 0
			&& (finestT ? s.totalEdgesB <= finestT.edgeCount * 1.5 : s.totalEdgesB <= 600_000);
		const lnSel = lnB
			? { tex: s.metaTexB, count: s.totalEdgesB, runs: null, minW: -2 }   // minW=-2＝perf行で境界パスと分かる印
			: pickLineTier(data.lodRank ?? 0, metaTex, totalEdges);
		gl.useProgram(renderProgram);
		bindSharedUniforms(gl, uRender, data, arcTex, lnSel.tex, TEX_ARC_W, TEX_META_W, width, height);
		gl.uniform1f(uRender.u_line_width,   data.lineWidth ?? 1.0);   // device px（worker 済み）
		gl.uniform1f(uRender.u_dpr,          1.0);                     // device px 一本化
		gl.uniform1i(uRender.u_active_id,    -1);
		gl.uniform4fv(uRender.u_style_table, data.styleTable ?? DEF_STYLE);
		gl.uniform2fv(uRender.u_dash_table,  data.dashTable  ?? DEF_DASH);
		gl.uniform1i(uRender.u_pass, 0);
		if (lnB) bindPivotBoundary(gl, uRender);   // 境界メタ＝fidカリング無効（視界外fid帰属arcで外郭が欠けるのを防ぐ）
		else bindPivot(gl, uRender);               // feature bbox カリング（ポリゴン辺のみ VS が判定）
		bindFidStyle(gl, uRender, 0);   // per-fid 線スタイル（paint 時のみ有効）
		// 深度統合（段階B・山岳ビュー z<13 のみ dep 非null）：線を地形深度でテスト（書かない）＝
		// 尾根の向こうは実線が消え、直後の GREATER パスが「淡い固定破線」で拾う（CAD の隠線表現）。
		const dep = bindDepthUniforms(gl, uRender, data);
		if (dep) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(false); }
		let pfEdges = 0;   // perf 計測用（実際に発行した辺数＝tier/カリングの効き確認。?perf=1 の行へ）
		for (const [est, cnt] of (lnSel.runs ?? [[0, lnSel.count]])) {
			pfEdges += cnt;
			gl.drawArrays(gl.TRIANGLES, est * 6, cnt * 6);
		}
		s._pfLineEdges = pfEdges; s._pfTierW = lnSel.minW ?? -1;
		if (dep) {
			// 隠線パスは静止時のみ（移動中は省略＝tilt山岳ビューの線頂点コストを半減）。淡破線は装飾＝
			// パン/ズーム中に一瞬消えても違和感がなく、settle の再描画で必ず戻る（terrainGate と同じ思想）。
			// 可視辺数が大きい時も省略（fillOff と同じ自動品質ノブ）：anchor支配で tier が組めない筆系37万辺で
			// 2パス目がフレームを倍にする（実機 gpuGint 90ms級）＝装飾のために本業を落とさない。
			if (!s._isDrawing && pfEdges < 100_000) {
				gl.depthFunc(gl.GREATER);
				gl.uniform1f(uRender.u_hidden, 1);
				for (const [est, cnt] of (lnSel.runs ?? [[0, lnSel.count]]))
					gl.drawArrays(gl.TRIANGLES, est * 6, cnt * 6);
				gl.uniform1f(uRender.u_hidden, 0);
				gl.depthFunc(gl.LEQUAL);
			}
			gl.disable(gl.DEPTH_TEST);
			gl.depthMask(true);
		}
	}

	// ── Points ──
	if (totalPoints > 0 && ptTex && ptMetaTex) {
		gl.useProgram(pointProgram);
		bindPointUniforms(uPoint, data);
		gl.uniform1i(uPoint.u_active_id, -1);
		gl.drawArrays(gl.TRIANGLES, 0, totalPoints * 6);
	}

	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

export function drawOverlay() {
	const { gl, baseFBO, lastDrawData, width, height } = s;
	if (!baseFBO || !lastDrawData) return;

	// baseFBO → canvas を blit して前フレームの overlay を消す。
	gl.bindFramebuffer(gl.READ_FRAMEBUFFER, baseFBO);
	gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
	gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	gl.stencilMask(0xFF);
	gl.clear(gl.STENCIL_BUFFER_BIT);

	drawHighlight(lastDrawData);
}

// アクティブ地物のハイライト（太線＋黄・点拡大・外側マスク）。blit を含まない純描画＝
// worker モードは drawOverlay（blit 後）から、embedded モードは毎フレームの gint パス末尾から呼ぶ。
export function drawHighlight(data) {
	const { gl, programs, arcTex, metaTex, ptTex, ptMetaTex,
			totalEdges, totalPoints, TEX_ARC_W, TEX_META_W, width, height,
			activeId, polyEdgeByFid } = s;
	if (activeId === -1) return;
	if (!arcTex && !ptTex) return;

	const { renderProgram, stencilProgram, fillProgram,
			pointProgram, uRender, uStencil, uFill, uPoint, emptyVAO } = programs;
	gl.bindVertexArray(emptyVAO);

	const range    = polyEdgeByFid?.get(activeId);
	const eStart   = range?.[0] ?? null;
	const eCount   = range?.[1] ?? null;
	const hasRange = eStart != null && eCount > 0;

	// Edge highlight：太く＋黄。深度統合時もハイライトは深度免除＝選択地物は尾根の向こうでも実線で示す
	//（識別の主目的は「どれが当たっているか」＝隠さない）。ドレープだけ掛けて基図と同じ高さに乗せる。
	gl.useProgram(renderProgram);
	bindSharedUniforms(gl, uRender, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
	bindDepthUniforms(gl, uRender, data);
	bindFidStyle(gl, uRender, 2.0);   // per-fid 幅にもハイライト増分 +2px（表には混ぜない）
	gl.uniform1f(uRender.u_line_width,   (data.lineWidth ?? 1.0) + 2.0);
	gl.uniform1f(uRender.u_dpr,          1.0);
	gl.uniform1i(uRender.u_active_id,    activeId);
	gl.uniform4fv(uRender.u_style_table, data.styleTable ?? DEF_STYLE);
	gl.uniform2fv(uRender.u_dash_table,  data.dashTable  ?? DEF_DASH);
	if (uRender.u_hilite_color) gl.uniform4fv(uRender.u_hilite_color, data.hiliteColor ?? [0, 0, 0, 0]);   // ホバー線色（未指定=素の線色を不透明）
	if (uRender.u_hilite_width) gl.uniform1f(uRender.u_hilite_width, data.hiliteWidth ?? 0.0);   // ホバー全幅(device px・0=未指定＝u_line_width)
	gl.uniform1i(uRender.u_pass, 1);
	if (hasRange) {
		gl.drawArrays(gl.TRIANGLES, eStart * 6, eCount * 6);
	} else if (totalEdges > 0) {
		gl.drawArrays(gl.TRIANGLES, 0, totalEdges * 6);
	}

	// Point highlight：大きく＋黄。
	if (totalPoints > 0 && ptTex && ptMetaTex) {
		gl.useProgram(pointProgram);
		bindPointUniforms(uPoint, data);
		gl.uniform1i(uPoint.u_active_id, activeId);
		gl.drawArrays(gl.TRIANGLES, 0, totalPoints * 6);
	}

	// Polygon mask：アクティブ地物の外を暗く。
	const mc = data.maskColor ?? DEF_MASK;
	if (mc[3] > 0 && hasRange) {
		gl.enable(gl.STENCIL_TEST);
		gl.stencilMask(0xFF);
		gl.clear(gl.STENCIL_BUFFER_BIT);
		gl.colorMask(false, false, false, false);
		gl.stencilFunc(gl.ALWAYS, 0, 0xFF);
		gl.stencilOpSeparate(gl.FRONT, gl.KEEP, gl.KEEP, gl.INCR_WRAP);
		gl.stencilOpSeparate(gl.BACK,  gl.KEEP, gl.KEEP, gl.DECR_WRAP);
		gl.useProgram(stencilProgram);
		bindSharedUniforms(gl, uStencil, data, arcTex, metaTex, TEX_ARC_W, TEX_META_W, width, height);
		bindPivot(gl, uStencil);
		gl.drawArrays(gl.TRIANGLES, eStart * 3, eCount * 3);
		gl.colorMask(true, true, true, true);
		gl.stencilMask(0x00);
		gl.stencilFunc(gl.EQUAL, 0, 0xFF);
		gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
		gl.useProgram(fillProgram);
		gl.uniform4fv(uFill.u_fill_color, mc);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
		gl.disable(gl.STENCIL_TEST);
	}
}

export function renderPickingBuffer(data) {
	const { gl, programs, arcTex, metaTex, ptTex, ptMetaTex,
			totalEdges, totalPoints, TEX_ARC_W, TEX_META_W, width, height, pickFBO } = s;
	if (!pickFBO) return;
	if (!arcTex && !ptTex) return;

	const { pickLineProgram, pickPointProgram, uPickLine, uPickPoint } = programs;
	try {
		gl.bindFramebuffer(gl.FRAMEBUFFER, pickFBO);
		gl.clearColor(0, 0, 0, 0);
		gl.stencilMask(0xFF);
		gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
		gl.disable(gl.BLEND);

		// 見た目の線より太く描いて pick 感度を上げる（~12 device px マージン）。
		const pickMargin = 12 * (s.dpr ?? 1);
		if (totalEdges > 0 && metaTex) {
			const pkSel = pickLineTier(data.lodRank ?? 0, metaTex, totalEdges);
			gl.useProgram(pickLineProgram);
			bindSharedUniforms(gl, uPickLine, data, arcTex, pkSel.tex, TEX_ARC_W, TEX_META_W, width, height);
			bindFidStyle(gl, uPickLine);   // filter 非表示の feature を pick からも外す
			gl.uniform1f(uPickLine.u_line_width, (data.lineWidth ?? 1.0) + pickMargin);
			for (const [est, cnt] of (pkSel.runs ?? [[0, pkSel.count]]))
				gl.drawArrays(gl.TRIANGLES, est * 6, cnt * 6);
		}

		if (totalPoints > 0 && ptTex && ptMetaTex) {
			gl.useProgram(pickPointProgram);
			bindPointUniforms(uPickPoint, data);
			gl.uniform1f(uPickPoint.u_pt_radius, Math.max(data.ptRadius ?? 1.5, pickMargin * 0.5));
			gl.drawArrays(gl.TRIANGLES, 0, totalPoints * 6);
		}

		gl.enable(gl.BLEND);
	} finally {
		gl.bindFramebuffer(gl.FRAMEBUFFER, null);
		gl.colorMask(true, true, true, true);
		gl.stencilMask(0xFF);
		gl.disable(gl.STENCIL_TEST);
	}
}
