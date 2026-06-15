class PriorityQueue {
	constructor(compare) { this.d = []; this.c = compare; }
	get length() { return this.d.length; }
	peek() { return this.d[0]; }
	push(v) {
		let d = this.d, i = d.push(v) - 1, p;
		while (i > 0 && this.c(v, d[p = (i - 1) >> 1]) < 0) d[i] = d[p], i = p;
		d[i] = v;
	}
	pop() {
		let d = this.d, t = d[0], b = d.pop(), i = 0, j, r;
		if (!d.length) return t;
		while ((j = (i << 1) + 1) < d.length) {
			if ((r = j + 1) < d.length && this.c(d[r], d[j]) < 0) j = r;
			if (this.c(d[j], b) >= 0) break;
			d[i] = d[j]; i = j;
		}
		d[i] = b;
		return t;
	}
}

const rad = Math.PI / 180;
const hSin = t => Math.sin(t / 2) ** 2;
const hDistP = (hDLng, cLat, lat1, lat2) => cLat * Math.cos(lat2 * rad) * hDLng + hSin((lat1 - lat2) * rad);
const hDist = (l1, lat1, l2, lat2, cLat) => hDistP(hSin((l1 - l2) * rad), cLat, lat1, lat2);

const vLat = (lat, hDLng) => {
	const c = 1 - 2 * hDLng;
	return c <= 0 ? (lat > 0 ? 90 : -90) : Math.atan(Math.tan(lat * rad) / c) / rad;
};

const bDist = (lng, lat, cLat, { minLng: x0, maxLng: x1, minLat: y0, maxLat: y1 }) => {
	if (lng >= x0 && lng <= x1) return lat < y0 ? hSin((lat - y0) * rad) : lat > y1 ? hSin((lat - y1) * rad) : 0;
	const hDLng = Math.min(hSin((lng - x0) * rad), hSin((lng - x1) * rad)), eLat = vLat(lat, hDLng);
	return (eLat > y0 && eLat < y1) ? hDistP(hDLng, cLat, lat, eLat) : Math.min(hDistP(hDLng, cLat, lat, y0), hDistP(hDLng, cLat, lat, y1));
};

export async function nearPoint(self, pt, maxResults = Infinity, maxDistance = Infinity) {
	if (!self.kdbush) {
		let KDBushClass = globalThis.KDBush;
		if (!KDBushClass) {
			const module = await import('https://unpkg.com/kdbush@3.0.0/kdbush.js');
			KDBushClass = module.default || module;
		}
		const length = self.count[0], kdbush = self.kdbush = new KDBushClass(length), index = self.kdIndex = [];
		const add = (n, coords) => { kdbush.add(coords[0], coords[1]); index.push(n); };
		self.each(n => {
			const fmap = self.fmap[n], type = fmap[2];
			if (type === 0) add(n, self.getGeometry(n).coordinates);
			else if (type === 1) self.getGeometry(n).coordinates.forEach(t => add(n, t));
			else if (type === 6) self.getGeometry(n).geometries.forEach(g => (g.type === "Point" ? add(n, g.coordinates) : (g.type === "MultiPoint" ? g.coordinates.forEach(t => add(n, t)) : null)));
		});
		kdbush.finish();
	}

	const [lng, lat] = pt;
	const index = self.kdbush;
	const maxHDist = maxDistance < Infinity ? hSin(maxDistance / 6371) : 1;
	const res = [], q = new PriorityQueue((a, b) => a.dist - b.dist);
	let node = { l: 0, r: index.ids.length - 1, ax: 0, dist: 0, minLng: -180, minLat: -90, maxLng: 180, maxLat: 90 };
	const cLat = Math.cos(lat * rad);

	while (node) {
		const { l, r, ax, minLng, minLat, maxLng, maxLat } = node;
		if (r - l <= index.nodeSize) {
			for (let i = l; i <= r; i++) q.push({ id: index.ids[i], dist: hDist(lng, lat, index.coords[2 * i], index.coords[2 * i + 1], cLat) });
		} else {
			const m = (l + r) >> 1, mLng = index.coords[2 * m], mLat = index.coords[2 * m + 1];
			q.push({ id: index.ids[m], dist: hDist(lng, lat, mLng, mLat, cLat) });
			const nx = 1 - ax;
			const lN = { l, r: m - 1, ax: nx, minLng, minLat, maxLng: ax ? maxLng : mLng, maxLat: ax ? mLat : maxLat, dist: 0 };
			const rN = { l: m + 1, r, ax: nx, minLng: ax ? minLng : mLng, minLat: ax ? mLat : minLat, maxLng, maxLat, dist: 0 };
			lN.dist = bDist(lng, lat, cLat, lN);
			rN.dist = bDist(lng, lat, cLat, rN);
			q.push(lN); q.push(rN);
		}
		while (q.length && q.peek().id != null) {
			const c = q.pop();
			if (c.dist > maxHDist) return res.map(t => self.kdIndex[t]);
			if (res.push(c.id) === maxResults) return res.map(t => self.kdIndex[t]);
		}
		node = q.pop();
	}
	return res.map(t => self.kdIndex[t]);
}