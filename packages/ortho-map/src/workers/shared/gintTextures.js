// ── テクスチャ管理 ─────────────────────────────────────────────────────────────
// set() と context restore 両方から呼ばれる。gintData から一括再構築。

import { s } from './gintState.js';
import { uploadTex2D, buildEdgeMeta, buildPolyBboxByFid } from './gintUtility.js';

export function uploadGintTextures() {
    const { gl, gintData } = s;
    if (!gl || !gintData) return;
    const { arcBuffer: ab, arcMeta: am, polyStream: ps, lineStream: ls, pointBuffer: pb } = gintData;

    // arcTex: RG32UI — 64bit Morton 頂点（lo32, hi32）
    if (s.arcTex) gl.deleteTexture(s.arcTex);
    s.arcTex = null;
    if (ab?.length) {
        const arcU32 = new Uint32Array(ab.buffer, ab.byteOffset, ab.byteLength / 4);
        const arcH   = Math.ceil(arcU32.length / 2 / s.TEX_ARC_W);
        const arcPad = new Uint32Array(s.TEX_ARC_W * arcH * 2);
        arcPad.set(arcU32);
        s.arcTex = uploadTex2D(gl, arcPad, s.TEX_ARC_W, arcH, gl.RG32UI, gl.RG_INTEGER);
    }

    // metaTex: RGBA32UI — エッジメタ（vert_A, vert_B, style_id, feat_id）
    if (s.metaTex) gl.deleteTexture(s.metaTex);
    s.metaTex = null;
    const { metaU32, edgeCount, polyEdgeByFid } = buildEdgeMeta(am, ps, ls);
    s.totalEdges    = edgeCount;
    s.polyEdgeByFid = polyEdgeByFid;
    s.polyBboxByFid = buildPolyBboxByFid(ps, am);
    if (s.totalEdges > 0) {
        const metaH   = Math.ceil(s.totalEdges / s.TEX_META_W);
        const metaPad = new Uint32Array(s.TEX_META_W * metaH * 4);
        metaPad.set(metaU32);
        s.metaTex = uploadTex2D(gl, metaPad, s.TEX_META_W, metaH, gl.RGBA32UI, gl.RGBA_INTEGER);
    }

    // ptTex: RG32UI — ポイント座標（arcTex 同形式）
    // ptMetaTex: R32UI — ポイントの feature ID（point[pt_id]）
    if (s.ptTex)     { gl.deleteTexture(s.ptTex);     s.ptTex     = null; }
    if (s.ptMetaTex) { gl.deleteTexture(s.ptMetaTex); s.ptMetaTex = null; }
    if (pb?.length) {
        const ptU32    = new Uint32Array(pb.buffer, pb.byteOffset, pb.byteLength / 4);
        s.totalPoints  = ptU32.length / 2;
        const ptH      = Math.ceil(s.totalPoints / s.TEX_ARC_W);
        const ptPad    = new Uint32Array(s.TEX_ARC_W * ptH * 2);
        ptPad.set(ptU32);
        s.ptTex = uploadTex2D(gl, ptPad, s.TEX_ARC_W, ptH, gl.RG32UI, gl.RG_INTEGER);
        const ptMetaH   = Math.ceil(s.totalPoints / s.TEX_ARC_W);
        const ptMetaPad = new Uint32Array(s.TEX_ARC_W * ptMetaH);
        ptMetaPad.set(gintData.point.subarray(0, s.totalPoints));
        s.ptMetaTex = uploadTex2D(gl, ptMetaPad, s.TEX_ARC_W, ptMetaH, gl.R32UI, gl.RED_INTEGER);
    } else {
        s.totalPoints = 0;
    }
}

export function deleteTextures() {
    const { gl } = s;
    if (!gl) return;
    if (s.arcTex)    gl.deleteTexture(s.arcTex);
    if (s.metaTex)   gl.deleteTexture(s.metaTex);
    if (s.ptTex)     gl.deleteTexture(s.ptTex);
    if (s.ptMetaTex) gl.deleteTexture(s.ptMetaTex);
    s.arcTex = s.metaTex = s.ptTex = s.ptMetaTex = null;
}
