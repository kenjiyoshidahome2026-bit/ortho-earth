import { GeoPBF } from "../pbf-base.js";

const { geometryTypes, geometryMap } = GeoPBF;

export async function dissolve(self, key) {
    if (typeof key === "string") {
        key = self.keys.indexOf(key);
        if (key < 0) key = false;
    }

    const propTub = new Map();
    self.each(i => {
        const pkey = typeof key === "number" ? self.props[i][key] : key === true ? "" : self.props[i].join("|");
        if (!propTub.has(pkey)) propTub.set(pkey, [i, [[], [], []]]);
        
        const [id, a] = propTub.get(pkey);
        const geom = self.getGeometry(i);
        if (!geom) return;

        geom.type === geometryTypes[6] ? geom.geometries.forEach(elem) : elem(geom);
        function elem(geom) { 
            const { type, coordinates } = geom;
            const n = geometryMap[type], multi = (n % 2), fig = n < 2 ? 0 : n < 4 ? 1 : 2;
            multi ? a[fig].push(...coordinates) : a[fig].push(coordinates);
        }
    });

    const pbf = self.pbf;
    pbf.pos = self._bodyPos;

    self.setBody(() => {
        for (const [id, a] of propTub.values()) {
            const properties = key === false ? self.getProperties(id) : {};
            if (typeof key === "number") properties[self.keys[key]] = self.props[id][key];

            const active = [];
            [0, 1, 2].forEach(n => a[n].length && active.push(n));

            if (active.length === 1) {
                write(active[0]);
            } else if (active.length > 1) {
                const geometries = active.map(n => geom(n));
                self.setFeature({ geometry: { type: geometryTypes[6], geometries }, properties }, false);
            }

            function geom(n) { 
                const isM = a[n].length > 1, type = geometryTypes[n * 2 + (isM ? 1 : 0)], coordinates = isM ? a[n] : a[n][0];
                return { type, coordinates };
            }   
            function write(n) { self.setFeature({ geometry: geom(n), properties }, false); }
        }
    });

    self.close();
    await self.getPosition();
    return self;
}