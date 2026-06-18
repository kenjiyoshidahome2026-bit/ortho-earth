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
    if (polygon)  for (const [fid, comps] of polygon)
        for (const rings of comps) for (const ring of rings) addArcs(ring, 0, fid);
    if (polyline) for (const [fid, sets]  of polyline)
        for (const arcs of sets) addArcs(arcs, 1, fid);

    return { metaU32: buf, edgeCount: total };
}
