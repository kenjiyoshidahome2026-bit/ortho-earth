function douglasPeuckerOrtho(a, err = 1e-6) {
	const hybot = (p, q) => p * p + q * q;
	if (a.type && (a.type == "Feature")) return a.geometry.type.match(/Point/) ? a : { type: a.type, geometry: douglasPeuckerOrtho(a.geometry, err), properties: a.properties };
	else if (a.type && (a.type == "LineString")) return { type: a.type, coordinates: DP(a.coordinates) };
	else if (a.type && (a.type == "MultiLineString" || a.type == "Polygon")) return { type: a.type, coordinates: a.coordinates.map(DP) };
	else if (a.type && (a.type == "MultiPolygon")) return { type: a.type, coordinates: a.coordinates.map(t => t.map(DP)) };
	else if (a.type && (a.type == "FeatureCollection")) return turf.featureCollection(a.features.map(t => douglasPeuckerOrtho(t, err)));
	else if (Array.isArray(a)) return [].concat(a.filter(t => t.type == "Feature").map(t => douglasPeuckerOrtho(t, err)));
	return null;
	function filter(a) {
		let pp = a[0], len = a.length, b = [pp], p;
		for (let i = 1; i < len; i++) {
			p = a[i];
			(hybot(p[0] - pp[0], p[1] - pp[1]) > err) && b.push(pp = p);
		}
		(pp === p) || b.push(p);
		return b;
	}
	function DP(a) {
		a = filter(a);
		const last = a.length - 1;// if (last < 3) console.log(a)
		let b = [a[0]]; loop(0, last); b.push(a[last]);
		return b;
		function loop(first, last) {
			const dist = (p, p1, p2) => {
				let [x, y] = [p1[0], p1[1]], [dx, dy] = [p2[0] - x, p2[1] - y];
				if (dx !== 0 || dy !== 0) {
					let t = ((p[0] - x) * dx + (p[1] - y) * dy) / hybot(dx, dy);
					if (t > 1) [x, y] = p2; else if (t > 0) x += dx * t, y += dy * t;
				}
				[dx, dy] = [p[0] - x, p[1] - y];
				return hybot(dx, dy);
			};
			let max = err, index;
			for (let i = first + 1; i < last; i++) {
				let sqDist = dist(a[i], a[first], a[last]);
				if (sqDist > max) { index = i; max = sqDist; }
			}
			if (max > err) {
				(index - first > 1) && loop(first, index);
				b.push(a[index]);
				(last - index > 1) && loop(index, last);
			} else if (Math.abs(a[first][0] - a[last][0]) > 1) {//経度が離れている場合は、分割(アメリカーカナダ国境)
				index = ~~((first + last) / 2);
				(index - first > 1) && loop(first, index);
				b.push(a[index]);
				(last - index > 1) && loop(index, last);
			}
		}
	}
}
