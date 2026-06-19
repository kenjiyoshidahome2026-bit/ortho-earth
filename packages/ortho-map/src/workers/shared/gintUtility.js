// ── GL utility ────────────────────────────────────────────────────────────────

export function bindSharedUniforms(gl, u, data, arcTex, metaTex, arcW, metaW, width, height) {
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, arcTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, metaTex);
    gl.uniform1i(u.u_arc_tex,  0);
    gl.uniform1i(u.u_meta_tex, 1);
    gl.uniform1i(u.u_arc_w,    arcW);
    gl.uniform1i(u.u_meta_w,   metaW);
    gl.uniform3f(u.u_rotate,   data.rotate[0], data.rotate[1], data.rotate[2] ?? 0);
    gl.uniform1f(u.u_scale,    data.scale);
    gl.uniform2f(u.u_viewport, width, height);
    const r1 = data.rotate[1] * Math.PI / 180, r2 = (data.rotate[2] ?? 0) * Math.PI / 180;
    gl.uniform4f(u.u_rsincos,  Math.cos(r1), Math.sin(r1), Math.cos(r2), Math.sin(r2));
}



export function uploadTex2D(gl, u32, w, h, internalFmt, fmt) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFmt, w, h, 0, fmt, gl.UNSIGNED_INT, u32);
    return tex;
}

// ── Geometry ──────────────────────────────────────────────────────────────────

// Build flat Uint32Array of edge meta from polygon/polyline gint structures.
// One entry per arc edge: [vert_A, vert_B, style_id, feat_id].
// Reversed arcs (arcIdx < 0) swap A/B to preserve correct stencil winding.
//
// Returns polyEdgeRanges: Int32Array[i*2]=edgeStart, [i*2+1]=edgeCount for polygon[i].
// Returns polyEdgeCount: total polygon edge count (polyline edges start here in meta tex).
export function buildEdgeMeta(arcMeta, polygon, polyline) {
    let total = 0;
    const countArcs = arcs => {
        for (const arcIdx of arcs) total += arcMeta[(arcIdx < 0 ? ~arcIdx : arcIdx) * 8 + 1] - 1;
    };
    if (polygon)  for (const [, comps] of polygon)
        for (const rings of comps) for (const ring of rings) countArcs(ring);
    if (polyline) for (const [, sets]  of polyline)
        for (const arcs of sets) countArcs(arcs);

    const buf = new Uint32Array(total * 4);
    let j = 0;
    const addArcs = (arcs, styleId, featId) => {
        const fid = featId >>> 0;
        for (const arcIdx of arcs) {
            const aid = arcIdx < 0 ? ~arcIdx : arcIdx;
            const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
            for (let i = 0; i < len - 1; i++) {
                buf[j++] = arcIdx >= 0 ? off + i         : off + len - 1 - i;
                buf[j++] = arcIdx >= 0 ? off + i + 1     : off + len - 2 - i;
                buf[j++] = styleId;
                buf[j++] = fid;
            }
        }
    };

    let polyEdgeRanges = null;
    if (polygon) {
        polyEdgeRanges = new Int32Array(polygon.length * 2);
        for (let i = 0; i < polygon.length; i++) {
            const [fid, comps] = polygon[i];
            const eStart = j >> 2;
            for (const rings of comps) for (const ring of rings) addArcs(ring, 0, fid);
            polyEdgeRanges[i * 2]     = eStart;
            polyEdgeRanges[i * 2 + 1] = (j >> 2) - eStart;
        }
    }
    const polyEdgeCount = j >> 2;

    if (polyline) for (const [fid, sets] of polyline)
        for (const arcs of sets) addArcs(arcs, 1, fid);

    return { metaU32: buf, edgeCount: total, polyEdgeRanges, polyEdgeCount };
}

// ── Zoom range check ──────────────────────────────────────────────────────────
// arcMeta の bbox から全体の地理的広がりを算出し、minZoom/maxZoom の妥当性を検査。
// maxZoom は precision の解像度限界を超えていれば強制クランプ（warning あり）。
// minZoom は未設定かつ推奨値 > 0 なら suggestion を出すのみ（強制しない）。
// 戻り値: { minZoom, maxZoom }（minZoom は null のまま返す場合あり）
export function checkZoomRange({ arcMeta, minZoom, maxZoom, precision = 6 }) {
    // maxZoom: precision から上限を強制
    const precisionMax = Math.floor(0.491 + precision * 3.322);
    const requestedMax = maxZoom ?? precisionMax;
    if (requestedMax > precisionMax) {
        console.warn(`[gint] maxZoom(${requestedMax}) exceeds precision(${precision}) limit → clamped to ${precisionMax}`);
    }
    const effectiveMax = Math.min(requestedMax, precisionMax);

    // minZoom: bbox から推奨値を算出して suggestion のみ
    let effectiveMin = minZoom ?? null;
    if (effectiveMin === null && arcMeta?.length) {
        let bxMin = 0xFFFFFFFF, byMin = 0xFFFFFFFF, bxMax = 0, byMax = 0;
        for (let i = 0, n = (arcMeta.length / 8) | 0; i < n; i++) {
            const b = i * 8;
            if (arcMeta[b+4] < bxMin) bxMin = arcMeta[b+4];
            if (arcMeta[b+5] < byMin) byMin = arcMeta[b+5];
            if (arcMeta[b+6] > bxMax) bxMax = arcMeta[b+6];
            if (arcMeta[b+7] > byMax) byMax = arcMeta[b+7];
        }
        const maxDim = Math.max(bxMax - bxMin, byMax - byMin) * 1e-7;
        if (maxDim > 0) {
            const suggested = Math.max(0, Math.floor(Math.log2(360 / maxDim)) - 1);
            if (suggested > 0) {
                console.warn(`[gint] minZoom not set. Suggested: ${suggested} (data spans ~${maxDim.toFixed(1)}°)`);
            }
        }
    }

    return { minZoom: effectiveMin, maxZoom: effectiveMax };
}
