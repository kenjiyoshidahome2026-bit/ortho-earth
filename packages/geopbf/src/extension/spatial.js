import { isNumber, isBbox } from "common";
const {PI, round, sin, cos, atan2, sqrt, abs} = Math, r2d = PI / 180, R = 6378137;

export const centroid = (self, i) => {
	if (i === undefined) return self._centroid = self._centroid || self.each(i=>centroid(self, i));
	if (self._centroid && self._centroid[i]) return self._centroid[i];
	const e = self.e;
	const geom = self.getGeometry(i); let x = 0, y = 0, count = 0;
	const add = c => { if (isNumber(c[0])) { x += c[0]; y += c[1]; count++; } else c.forEach(add); };
	if (geom.type === "GeometryCollection") geom.geometries.forEach(g => add(g.coordinates || []));
	else add(geom.coordinates || []);
	return count ? [round((x / count) * e) / e, round((y / count) * e) / e] : [0, 0];
};

export const lineLength = (self, i) => {
	 if (i === undefined) return self._lineLength = self._lineLength || self.each(i=>lineLength(self, i));
	if (self._lineLength && self._lineLength[i]) return self._lineLength[i];
   let total = 0;
	const dist = (p1, p2) => {
		const lat1 = p1[1] * r2d, lat2 = p2[1] * r2d;
		const a = sin((lat2 - lat1) / 2) ** 2 + cos(lat1) * cos(lat2) * sin(((p2[0] - p1[0]) * r2d) / 2) ** 2;
		return R * 2 * atan2(sqrt(a), sqrt(1 - a));
	};
	const lineLen = c => { let l = 0; for (let j = 0; j < c.length - 1; j++) l += dist(c[j], c[j + 1]); return l; };
	const calc = (g) => {
		if (g.type === "LineString") total += lineLen(g.coordinates);
		else if (g.type === "MultiLineString" || g.type === "Polygon") g.coordinates.forEach(c => total += lineLen(c));
		else if (g.type === "MultiPolygon") g.coordinates.forEach(p => p.forEach(c => total += lineLen(c)));
		else if (g.type === "GeometryCollection") g.geometries.forEach(calc);
	};
	calc(self.getGeometry(i)); return round(total);
};

export const area = (self, i) => {
	 if (i === undefined) return self._area = self._area || self.each(i=>area(self, i));
	if (self._area && self._area[i]) return self._area[i];
	let total = 0;
	const ringArea = coords => {
		let area = 0, n = coords.length;
		if (n > 2) { for (let j = 0; j < n; j++) { let p1 = coords[j === 0 ? n - 1 : j - 1], p2 = coords[j], p3 = coords[j === n - 1 ? 0 : j + 1]; area += (p3[0] - p1[0]) * r2d * Math.sin(p2[1] * r2d); } }
		return abs(area * R * R / 2);
	};
	const calc = (g) => {
		if (g.type === "Polygon") { total += ringArea(g.coordinates[0]); for (let j = 1; j < g.coordinates.length; j++) total -= ringArea(g.coordinates[j]); }
		else if (g.type === "MultiPolygon") { g.coordinates.forEach(poly => { total += ringArea(poly[0]); for (let j = 1; j < poly.length; j++) total -= ringArea(poly[j]); }); }
		else if (g.type === "GeometryCollection") g.geometries.forEach(calc);
	};
	calc(self.getGeometry(i)); return round(total);
};

// pbf バッファから delta-varint を直接読み min/max のみ累積する（座標配列を確保しない高速版）。
// 返す値は整数（= round(coord * e)）単位。pbf-base の writeGeometry/readGeometry のエンコードに厳密準拠。
function geomBbox(self, gpos, type, box) {
	const pbf = self.pbf;
	pbf.pos = gpos;
	let lens = [];
	const acc = (x, y) => {
		if (x < box[0]) box[0] = x; if (x > box[2]) box[2] = x;
		if (y < box[1]) box[1] = y; if (y > box[3]) box[3] = y;
	};
	pbf.readMessage(tag => {
		if (tag === 9) pbf.readPackedVarint(lens);                       // TAGS.LENGTH
		else if (tag === 10) {                                           // TAGS.COORDS
			const end = pbf.readVarint() + pbf.pos;
			if (type === 0) {                                            // Point
				acc(pbf.readSVarint(), pbf.readSVarint());
			} else if (type <= 2) {                                      // MultiPoint / LineString: 単一チェーン
				let px = 0, py = 0;
				while (pbf.pos < end) { px += pbf.readSVarint(); py += pbf.readSVarint(); acc(px, py); }
			} else if (type <= 4) {                                      // MultiLineString / Polygon: セグメント毎にリセット
				for (let s = 0; s < lens.length; s++) {
					let px = 0, py = 0, n = lens[s];
					while (n-- > 0) { px += pbf.readSVarint(); py += pbf.readSVarint(); acc(px, py); }
				}
			} else {                                                     // MultiPolygon: 入れ子 lens [npoly, nring, ...ptCounts]
				let k = 0; const npoly = lens[k++];
				for (let i = 0; i < npoly; i++) {
					const nring = lens[k++];
					for (let j = 0; j < nring; j++) {
						let px = 0, py = 0, n = lens[k++];
						while (n-- > 0) { px += pbf.readSVarint(); py += pbf.readSVarint(); acc(px, py); }
					}
				}
			}
		}
	});
}

export function getBbox(self, i) {
	if (i !== undefined) {
		if (self._bboxes && self._bboxes[i]) return self._bboxes[i];
		const e = self.e, map = self.fmap[i], box = [Infinity, Infinity, -Infinity, -Infinity];
		if (map[2] === 6) map[3].forEach((pos, k) => geomBbox(self, pos, map[4][k], box));
		else geomBbox(self, map[1], map[2], box);
		const res = box.map(v => round(v) / e);
		if (self._bboxes) self._bboxes[i] = res;
		return res;
	}
	if (self._bboxes) return self._bboxes;
	let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
	self._bboxes = self.each(idx => {
		const b = self.getBbox(idx);
		if (isBbox(b)) {
			if (b[0] < xmin) xmin = b[0]; if (b[1] < ymin) ymin = b[1];
			if (b[2] > xmax) xmax = b[2]; if (b[3] > ymax) ymax = b[3];
		}
		return b;
	});
	self._bbox = [xmin, ymin, xmax, ymax];
	return self._bboxes;
}

export function bboxes(self) { return self._bboxes || (self.getBbox(), self._bboxes); }
export function bbox(self) { return self._bbox || (self.getBbox(), self._bbox); }
