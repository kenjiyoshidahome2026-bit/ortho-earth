import { GeoPBF } from "../pbf-base.js";

const { geometryTypes, geometryMap } = GeoPBF;

export async function dissolve(pbfInstance, key = false) {
    if (typeof key === "string") {
        key = pbfInstance.keys.indexOf(key);
        if (key < 0) key = false;
    }
    const propTub = new Map();
    pbfInstance.forEach(i => {
        const pkey = typeof key === "number" ? pbfInstance.props[i][key] : key === true ? "" : pbfInstance.props[i].join("|");
        if (!propTub.has(pkey)) propTub.set(pkey, [i, [[], [], []], new Set()]);
        const [id, a, ptSet] = propTub.get(pkey);
        const geom = pbfInstance.getGeometry(i);
        if (!geom) return;
        geom.type === geometryTypes[6] ? geom.geometries.forEach(elem) : elem(geom);
        function elem(geom) {
            const { type, coordinates } = geom;
            const n = geometryMap[type], multi = (n % 2), fig = n < 2 ? 0 : n < 4 ? 1 : 2;
            if (fig === 0) {
                (multi ? coordinates : [coordinates]).forEach(pt => {
                    const k = pt.join(",");
                    if (!ptSet.has(k)) { ptSet.add(k); a[0].push(pt); }
                });
            } else {
                multi ? a[fig].push(...coordinates) : a[fig].push(coordinates);
            }
        }
    });
    pbfInstance.pbf.pos = pbfInstance._bodyPos;
    pbfInstance.setBody(() => {
        for (const [id, a] of propTub.values()) {
            const properties = key === false ? pbfInstance.getProperties(id) : {};
            if (typeof key === "number") properties[pbfInstance.keys[key]] = pbfInstance.props[id][key];
            const active = [];
            [0, 1, 2].forEach(n => a[n].length && active.push(n));
            if (active.length === 1) {
                write(active[0]);
            } else if (active.length > 1) {
                const geometries = active.map(n => geom(n));
                pbfInstance.setFeature({ geometry: { type: geometryTypes[6], geometries }, properties });
            }
            function geom(n) { 
                const isM = a[n].length > 1, type = geometryTypes[n * 2 + (isM ? 1 : 0)], coordinates = isM ? a[n] : a[n][0];
                return { type, coordinates };
            }   
            function write(n) { pbfInstance.setFeature({ geometry: geom(n), properties }); }
        }
    });
    pbfInstance.close();
    await pbfInstance.getPosition();
    return pbfInstance;
}