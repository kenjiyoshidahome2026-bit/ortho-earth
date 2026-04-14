import { GeoPBF } from "../pbf-base.js";

export async function dissolve(self, pname) {
    const keyIdx = self.keys.indexOf(pname);
    if (keyIdx < 0) return self;

    const tub = {};
    self.props.forEach((propArr, i) => {
        const val = propArr[keyIdx];
        if (val !== undefined) {
            tub[val] = tub[val] || [];
            tub[val].push(i);
        }
    });

    const groups = Object.entries(tub).sort((p, q) => p[0] > q[0] ? 1 : -1).map(t => t[1]);
    const props = groups.map(indices => {
        const groupProps = indices.map(idx => self.props[idx]), base = [...groupProps[0]], propObj = {};
        for (let i = 1; i < groupProps.length; i++) {
            base.forEach((v, j) => { if (base[j] !== groupProps[i][j]) base[j] = undefined; });
        }
        base.forEach((v, i) => {
            if (v === undefined) return;
            const keys = self.keys[i].split(".");
            if (keys.length === 1) propObj[keys[0]] = v;
            else {
                propObj[keys[0]] = propObj[keys[0]] || {};
                propObj[keys[0]][keys.slice(1).join(".")] = v;
            }
        });
        return propObj;
    });

    const pbf = new GeoPBF({ name: self._name, precision: Math.log10(self.e) }).copyHead(self);
    pbf.setBody(() => {
        groups.forEach((indices, idx) => {
            let mergedCoords = [];
            const addGeom = g => {
                if (g.type === "Polygon") mergedCoords.push(g.coordinates);
                else if (g.type === "MultiPolygon") mergedCoords.push(...g.coordinates);
            };
            indices.map(i => self.getGeometry(i)).forEach(g => {
                if (g.type === "GeometryCollection") g.geometries.forEach(addGeom);
                else addGeom(g);
            });
            if (!mergedCoords.length) return;
            const isMulti = mergedCoords.length > 1;
            pbf.setFeature({
                type: "Feature",
                geometry: { type: isMulti ? "MultiPolygon" : "Polygon", coordinates: isMulti ? mergedCoords : mergedCoords[0] },
                properties: props[idx]
            });
        });
    }).close();

    return await pbf.getPosition();
}