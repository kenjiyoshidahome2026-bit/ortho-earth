export const contain = (self, [px, py], getOneFlag) => {
    const out = b => (px < b[0] || px > b[2] || py < b[1] || py > b[3]);
    if (out(self.bbox)) return getOneFlag ? -1 : [];
    const rayCast = ring => {
        let inside = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
            if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) inside = !inside;
        }
        return inside;
    };
    const checkPoly = coords => { if (!rayCast(coords[0])) return false; for (let i = 1; i < coords.length; i++) if (rayCast(coords[i])) return false; return true; };
    const isContain = n => {
        const fmap = self.fmap[n], type = fmap[2]; if (type < 4 || out(self.getBbox(n))) return false;
        const geom = self.getGeometry(n);
        if (type === 4) return checkPoly(geom.coordinates);
        if (type === 5) return geom.coordinates.some(checkPoly);
        return type === 6 && geom.geometries.some(g => (g.type === "Polygon" ? checkPoly(g.coordinates) : (g.type === "MultiPolygon" ? g.coordinates.some(checkPoly) : false)));
    };
    const a = []; for (let i = 0; i < self.length; i++) if (isContain(i)) { if (getOneFlag) return i; a.push(i); }
    return getOneFlag ? -1 : a;
};