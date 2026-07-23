// GPU picking バッファを読み、activeId を更新して drawOverlay。
// ポリゴンは GPU hit が無い時 JS fallback（findPolygon）で包含判定。
// v1(ortho-map) の gintIdentify を移植。【site 4】JS レイキャストの逆写像を d3 lastProj.invert →
// japan の unproject(cam) へ建て替え。他（readPixels・findPolygon・throttle）は node-free。
// 単位：mouse は CSS px で受け、GPU/unproject へは ×dpr で device px に。s.width/height は device px。

import { s, MOVE_THROTTLE_MS } from './state.js';
import { findPolygon } from 'geopbf/identify';
import { drawOverlay } from './passes.js';
import { unproject } from '../../camera.js';

export function doIdentify(data) {
	if (data.x === s.lastMX && data.y === s.lastMY) return;
	s.lastMX = data.x; s.lastMY = data.y;
	if (!s.pickFBO) return;

	const pickX = Math.max(0, Math.min(s.width  - 1, Math.round(data.x * s.dpr)));
	const pickY = Math.max(0, Math.min(s.height - 1, Math.round(s.height - data.y * s.dpr)));
	// embedded＝render worker 同居：同期 readPixels は GPU パイプラインを止め、hover のたびに地図フレームを
	// 塞ぐ（旧・別worker時代は並列で無害だった＝統合で生まれた唯一の新規ストール）。PBO+fence で非同期化
	//（識別は 1-2 フレーム遅れるが hover tip には無関係の遅さ）。worker モードは従来の同期読みのまま。
	if (s.embedded) { readPickAsync(pickX, pickY, data); return; }
	const px = new Uint8Array(4);
	s.gl.bindFramebuffer(s.gl.READ_FRAMEBUFFER, s.pickFBO);
	s.gl.readPixels(pickX, pickY, 1, 1, s.gl.RGBA, s.gl.UNSIGNED_BYTE, px);
	s.gl.bindFramebuffer(s.gl.READ_FRAMEBUFFER, null);
	finishIdentify(px, data);
}

// 非同期 pick 読み（embedded 専用）：readPixels を PIXEL_PACK_BUFFER へ発行 → fence を置き、
// clientWaitSync(0) のポーリングで GPU 完了後にだけ getBufferSubData（＝ブロックしない）。
// 進行中に新しい move が来たら座標だけ差し替え（発行は1本＝解決後に最新座標で読み直す）。
let _pr = null;   // { fence, data } 進行中の読み
export function readPickAsync(pickX, pickY, data) {
	const gl = s.gl;
	if (_pr) { _pr.next = { pickX, pickY, data }; return; }   // 解決後に最新で再発行
	if (!s._pickPBO) s._pickPBO = gl.createBuffer();
	gl.bindFramebuffer(gl.READ_FRAMEBUFFER, s.pickFBO);
	gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s._pickPBO);
	gl.bufferData(gl.PIXEL_PACK_BUFFER, 4, gl.STREAM_READ);
	gl.readPixels(pickX, pickY, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, 0);
	gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);   // 束縛を残すと以後の readPixels（snapshot等）が PBO に化ける
	gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
	const fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
	gl.flush();   // fence をドライバへ押し出す（これが無いと idle 中に永久 TIMEOUT）
	_pr = { fence, data };
	pollPick();
}
function pollPick() {
	const gl = s.gl, pr = _pr;
	if (!pr || !gl) return;
	if (gl.clientWaitSync(pr.fence, 0, 0) === gl.TIMEOUT_EXPIRED) { setTimeout(pollPick, 16); return; }
	gl.deleteSync(pr.fence);
	const px = new Uint8Array(4);
	gl.bindBuffer(gl.PIXEL_PACK_BUFFER, s._pickPBO);
	gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px);
	gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
	const next = pr.next;
	_pr = null;
	finishIdentify(px, pr.data);
	if (next) { s.lastMX = NaN; doIdentify(next.data); }   // 進行中に届いた最新座標で読み直し（dedupe/クランプは doIdentify が再適用）
}

function finishIdentify(px, data) {
	const fid1 = px[0] | (px[1] << 8) | (px[2] << 16);
	let featureId = fid1 === 0 ? null : fid1 - 1;

	// GPU hit 無し → JS ポリゴン包含判定へ fallback（viewBbox=null でも動く＝早期棄却を飛ばすだけ）。
	// 【site 4】lastProj.invert → unproject(cam)（device px）。
	if (fid1 === 0 && s.gintData?.polyStream && s.cam) {
		const geo = unproject(s.cam, data.x * s.dpr, data.y * s.dpr);
		if (geo) {
			const SE = 1e7;
			featureId = findPolygon(
				s.gintData.arcBuffer, s.gintData.arcMeta, s.gintData.polyStream,
				Math.round((geo[0] + 180) * SE),
				Math.round((geo[1] +  90) * SE),
				s.polyBboxByFid, s.lastViewBbox
			);
		}
	}

	const newId = featureId ?? -1;
	if (newId === s.activeId) return;
	s.activeId = newId;
	postMessage({ action: "identify", featureId: featureId ?? null, x: data.x, y: data.y });
	// embedded＝ハイライトは毎フレームの gint パスが inline で描く＝地図ごと1枚描き直させる。
	if (s.embedded) s.requestDraw?.();
	else drawOverlay();
}

export function handleMove(data) {
	// ズーム範囲外＝地物が描画されていない → 識別しない（見えない地物に tip を出さない）。
	// 直前まで in-range で activeId が残っていれば handleLeave が tip を消す。
	if (!s._inRange) { handleLeave(); return; }
	if (!s.cam || !s.gintData || s._isDrawing) {
		if (s._isDrawing) s._pendingMove = data;
		return;
	}
	if (s._moveTimer !== null) { s._pendingMove = data; return; }
	doIdentify(data);
	s._moveTimer = setTimeout(() => {
		s._moveTimer = null;
		if (s._pendingMove) { doIdentify(s._pendingMove); s._pendingMove = null; }
	}, MOVE_THROTTLE_MS);
}

export function handleLeave() {
	clearTimeout(s._moveTimer); s._moveTimer = null;
	s._pendingMove = null;
	if (s.activeId === -1) return;
	s.activeId = -1;
	postMessage({ action: "identify", featureId: null });
	if (s.embedded) { s.requestDraw?.(); return; }   // embedded＝blit で消さず地図ごと描き直し
	if (s.baseFBO && s.lastDrawData) {
		const w = s.width, h = s.height;   // v2：device px
		s.gl.bindFramebuffer(s.gl.READ_FRAMEBUFFER, s.baseFBO);
		s.gl.bindFramebuffer(s.gl.DRAW_FRAMEBUFFER, null);
		s.gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, s.gl.COLOR_BUFFER_BIT, s.gl.NEAREST);
		s.gl.bindFramebuffer(s.gl.FRAMEBUFFER, null);
	}
}
