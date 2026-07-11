// GPU picking バッファを読み、activeId を更新して drawOverlay。
// ポリゴンは GPU hit が無い時 JS fallback（findPolygon）で包含判定。
// v1(ortho-map) の gintIdentify を移植。【site 4】JS レイキャストの逆写像を d3 lastProj.invert →
// japan の unproject(cam) へ建て替え。他（readPixels・findPolygon・throttle）は node-free。
// 単位：mouse は CSS px で受け、GPU/unproject へは ×dpr で device px に。s.width/height は device px。

import { s, MOVE_THROTTLE_MS } from './state.js';
import { findPolygon } from 'geopbf/src/extension/identify.js';
import { drawOverlay } from './passes.js';
import { unproject } from '../../camera.js';

export function doIdentify(data) {
	if (data.x === s.lastMX && data.y === s.lastMY) return;
	s.lastMX = data.x; s.lastMY = data.y;
	if (!s.pickFBO) return;

	const px = new Uint8Array(4);
	const pickX = Math.max(0, Math.min(s.width  - 1, Math.round(data.x * s.dpr)));
	const pickY = Math.max(0, Math.min(s.height - 1, Math.round(s.height - data.y * s.dpr)));
	s.gl.bindFramebuffer(s.gl.READ_FRAMEBUFFER, s.pickFBO);
	s.gl.readPixels(pickX, pickY, 1, 1, s.gl.RGBA, s.gl.UNSIGNED_BYTE, px);
	s.gl.bindFramebuffer(s.gl.READ_FRAMEBUFFER, null);

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
	drawOverlay();
}

export function handleMove(data) {
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
	if (s.baseFBO && s.lastDrawData) {
		const w = s.width, h = s.height;   // v2：device px
		s.gl.bindFramebuffer(s.gl.READ_FRAMEBUFFER, s.baseFBO);
		s.gl.bindFramebuffer(s.gl.DRAW_FRAMEBUFFER, null);
		s.gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, s.gl.COLOR_BUFFER_BIT, s.gl.NEAREST);
		s.gl.bindFramebuffer(s.gl.FRAMEBUFFER, null);
	}
}
