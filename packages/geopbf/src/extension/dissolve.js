import { GeoPBF } from "../pbf-base.js";
import { isString, isNumber } from "common";
const {geometryTypes, geometryMap} = GeoPBF;
export async function dissolve(self, dissolveKey = false) {
    if (isString(dissolveKey)) {
        dissolveKey = self.keys.indexOf(dissolveKey); if (dissolveKey < 0) dissolveKey = false;
    }
    const pbf = self.pbf;
    const propTub = new Map();
    self.each(i => {
        const pkey = isNumber(dissolveKey)? self.props[i][dissolveKey]: dissolveKey === true? "" : self.props[i].join("|");
        if (!propTub.has(pkey)) propTub.set(pkey, [i, [[], [], []]]);
        const [id, a] = propTub.get(pkey);
        const geom = self.getGeometry(i);
        geom.type === geometryTypes[6] ? geom.geometries.forEach(elem) : elem(geom);
        function elem(geom) { const {type, coordinates} = geom;
            const n = geometryMap[type], multi = (n % 2), fig = n < 2 ? 0: n < 4? 1: 2;
            multi? a[fig].push(...coordinates): a[fig].push(coordinates);
        }
        propTub.set(pkey, [id, a]);
    });
    console.log(propTub);
    pbf.pos = self._bodyPos;
    self.setBody(() => Object.values(propTub).forEach(([id, a]) => {
        const properties = dissolveKey === false? self.getProperties[id]: {};
        if (isNumber(dissolveKey)) properties[self.keys.indexOf(dissolveKey)] = self.props[id][dissolveKey];
        if (a[0].length && !a[1].length && !a[2].length) return write(0);
        if (!a[0].length && a[1].length && !a[2].length) return write(1);
        if (!a[0].length && !a[1].length && a[2].length) return write(2);
        const type = geometryTypes[6], geometries = [];
        [0,1,2].forEach(n => a[n].length && geometries.push(geom(n)));
        self.setFeature({geometry: { type, geometries }, properties}, false);
        a[0] = a[1] = a[2] = [];
        function geom(n) { const isM = a[n].length > 1, type = geometryTypes[n * 2 + (isM? 1 : 0)], coordinates = isM? a[n] : a[n][0];
            return { type, coordinates };
        }   
        function write(n) { self.setFeature({geometry: geom(n), properties}, false); a[n] = []; }
    }));
    self.close();
    await self.getPosition();
    return self;
}