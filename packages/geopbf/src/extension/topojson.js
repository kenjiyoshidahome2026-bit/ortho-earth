import { gint } from "./gint.js";

export function toTopoJSON(self) {
    const { e, bbox, structures } = self;
    if (!structures) self.analyzeTopology();

    const arcs = [];
    const processLayer = (layer) => {
        const { buffer, meta, mlen, count } = layer;
        for (let i = 0; i < count; i++) {
            const off = meta[i * mlen], len = meta[i * mlen + 1], arc = [];
            let px = 0, py = 0;
            for (let j = 0; j < len; j++) {
                const [cx, cy] = gint.unpack(buffer[off + j]);
                const rx = Math.round(cx * e), ry = Math.round(cy * e);
                arc.push([rx - px, ry - py]);
                px = rx; py = ry;
            }
            arcs.push(arc);
        }
    };

    if (self.polygon) processLayer(self.polygon);
    if (self.polyline) processLayer(self.polyline);

    const n_poly_arcs = self.polygon ? self.polygon.count : 0;
    const shift = i => (i < 0 ? ~((~i) + n_poly_arcs) : i + n_poly_arcs);

    const geometries = self.each((id, map, props) => {
        const topo = self.structures.map(layer => layer.filter(t => t.id === id));
        const res = { type: "GeometryCollection", geometries: [], properties: props };

        if (topo[0].length) {
            const p = topo[0].map(t => t.coords);
            res.geometries.push({ type: "MultiPoint", coordinates: p.map(c => gint.unpack(c[0])) });
        }
        if (topo[1].length) {
            const a = topo[1].map(t => t.arcs.map(shift));
            res.geometries.push({ type: "MultiLineString", arcs: a });
        }
        if (topo[2].length) {
            const a = topo[2].map(t => t.arcs.map(r => r.map(shift)));
            res.geometries.push({ type: "MultiPolygon", arcs: a });
        }
        return res;
    });

    return {
        type: "Topology",
        bbox: [...bbox],
        arcs,
        transform: { scale: [1 / e, 1 / e], translate: [0, 0] },
        objects: { collection: { type: "GeometryCollection", geometries } }
    };
}