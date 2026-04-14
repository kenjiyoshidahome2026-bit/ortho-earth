const r2d = Math.PI / 180;

export const centroid = (self, i) => {
    const geom = self.getGeometry(i); let x = 0, y = 0, count = 0;
    const add = c => { if (typeof c[0] === 'number') { x += c[0]; y += c[1]; count++; } else c.forEach(add); };
    if (geom.type === "GeometryCollection") geom.geometries.forEach(g => add(g.coordinates || []));
    else add(geom.coordinates || []);
    return count ? [Math.round((x / count) * self.e) / self.e, Math.round((y / count) * self.e) / self.e] : [0, 0];
};

export const area = (self, i) => {
    const geom = self.getGeometry(i), R = 6378137;
    const ringArea = coords => {
        let area = 0, n = coords.length;
        if (n > 2) { for (let j = 0; j < n; j++) { let p1 = coords[j === 0 ? n - 1 : j - 1], p2 = coords[j], p3 = coords[j === n - 1 ? 0 : j + 1]; area += (p3[0] - p1[0]) * r2d * Math.sin(p2[1] * r2d); } }
        return Math.abs(area * R * R / 2);
    };
    let total = 0;
    const calc = (g) => {
        if (g.type === "Polygon") { total += ringArea(g.coordinates[0]); for (let j = 1; j < g.coordinates.length; j++) total -= ringArea(g.coordinates[j]); }
        else if (g.type === "MultiPolygon") { g.coordinates.forEach(poly => { total += ringArea(poly[0]); for (let j = 1; j < poly.length; j++) total -= ringArea(poly[j]); }); }
        else if (g.type === "GeometryCollection") g.geometries.forEach(calc);
    };
    calc(geom); return Math.round(total);
};