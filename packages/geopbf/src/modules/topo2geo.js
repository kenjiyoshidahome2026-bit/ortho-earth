import { GeoPBF } from "../pbf-base.js";
export function topo2geo(topo) {
    const { arcs, transform, objects } = topo;
    const { scale = [1, 1], translate = [0, 0] } = transform || {};
    const tran = c => [ c[0] * scale[0] + translate[0], c[1]* scale[1] + translate[1] ];
    const decodePoints = coords => { let t = [0,0]; return transform? coords.map(c => [t[0] += c[0], t[1] += c[1]]).map(tran): coords; };
    const decodedArcs = (arcs||[]).map(decodePoints);
    const getCoords = arcs => { let coords = [];
        arcs.forEach((idx, i) => {
            let arc = decodedArcs[idx < 0 ? ~idx : idx];
            if (idx < 0) arc = [...arc].reverse();
            if (i > 0) arc = arc.slice(1);
            coords = coords.concat(arc);
        });
        return coords;
    };
    const geom = g => { const {type} = g;
        switch (GeoPBF.geometryMap[type]) {
            case 0: return { type, coordinates: tran(g.coordinates)};
            case 1: return { type, coordinates: decodePoints(g.coordinates)};
            case 2: return { type, coordinates: getCoords(g.arcs)};
            case 3: return { type, coordinates: g.arcs.map(getCoords)};
            case 4: return { type, coordinates: g.arcs.map(getCoords)};
            case 5: return { type, coordinates: g.arcs.map(t => t.map(getCoords))};
            case 6: return { type, geometries: g.geometries.map(geom)};
        }
    }
    const toFeature = g => {
        const f = { type: "Feature", geometry: geom(g), properties: g.properties || {} };
        (g.id === undefined) || (f.id = g.id);
        return f;
    };
    const features = [];
    for (const key in objects) {
        const obj = objects[key];
        if (obj.type === "GeometryCollection") {
            obj.geometries.forEach(t=> features.push(toFeature(t)));
        } else {
            features.push(toFeature(obj));
        }
    }
    return { type: "FeatureCollection", features };
}