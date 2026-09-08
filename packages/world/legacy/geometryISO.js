{
	function antimeridianFeature(feature) {
		const { antimeridianCut } = Resources;
		if (feature.type == "FeatureCollection") { feature.features.map(t => antimeridianFeature(t)); return feature; }
		const p = feature.properties = feature.properties || {};
		const { type, coordinates } = feature.geometry;
		type.match(/Point/) || (p.bbox = p.bbox || turf.bbox(feature).map(t => turf.round(t, 6)));//// <=== bboxを入れておく
		var c = type.match(/Multi/) ? coordinates : [coordinates];
		if (type.match(/LineString/)) {
			c = c.map(t => antimeridianCut(t, true)).flat();
			feature.geometry = c.length == 1 ?
				{ type: "LineString", coordinates: c[0] } :
				{ type: "MultiLineString", coordinates: c };
		} else if (type.match(/Polygon/)) {
			c = c.map(antimeridianPolygon).flat();
			feature.geometry = c.length == 1 ?
				{ type: "Polygon", coordinates: c[0] } :
				{ type: "MultiPolygon", coordinates: c };
		}
		return toClockwise(feature);
		function antimeridianPolygon(c) {
			var a = antimeridianCut(c[0]); if (a.length == 1) return [c];
			if (c.length == 1) return a;
			var hole = c.slice(1).map(antimeridianCut).flat();
			return a.map(t => subFeature(turf.polygon([t]), turf.multiPolygon(hole)));
		}
	}
	////=======================================================================================
	function dividePoints(p, tub) {
		const { type, coordinates } = p.geometry;
		var c = type.match(/Multi/) ? coordinates : [coordinates];
		return c.map(a => a.map(divide));//<<<<<<<<<<<<<<<<<<<<<<<<<<<<
		function divide(p) {
			var q = [p[0]];
			for (var i = 1; i < p.length; i++) {
				var npoints = Math.floor(Math.abs(p[i - 1][0] - p[i][0]));
				if (npoints > 2) {
					var a = turf.greatCircle(p[i - 1], p[i], { npoints }).geometry.coordinates;
					a = a.slice(1, a.length - 1);
					a.forEach(t => { tub[t.join(",")] = true; })
					q = q.concat(a);
				}
				q = q.concat([p[i]]);
			}
			return q;
		}
	}
	function clean(p) {
		const prop = p.properties; p = toClockwise(turf.cleanCoords(p));
		return p.geometry.coordinates.length == 0 ? null :
			p.geometry.coordinates.length == 1 ? turf.polygon(p.geometry.coordinates[0], prop) :
				turf.multiPolygon(p.geometry.coordinates, prop);
	}
	function unionFeature(p, q) {
		const prop = p.properties;
		return clean(turf.multiPolygon(polygonClipping.union(dividePoints(p), dividePoints(q)), prop));
	}
	function intersectionFeature(p, q) {
		const prop = p.properties;
		return clean(turf.multiPolygon(polygonClipping.intersection(dividePoints(p), dividePoints(q)), prop));
	}
	function subFeature(p, q) {
		const prop = p.properties;
		const { antimeridianCut } = Resources;
		const tub = {};
		var pbox = p.properties.bbox || turf.bbox(p), qbox = q.properties.bbox || turf.bbox(q);
		if (pbox[2] < qbox[0] || pbox[0] > qbox[2] || pbox[3] < qbox[1] || pbox[1] > qbox[3]) return p;
		p = dividePoints(p, tub), q = dividePoints(q, tub).map(t => t[0] = antimeridianCut(t[0])).flat();
		p = p.map(t => polygonClipping.xor([t], polygonClipping.intersection([t], q))).flat();
		p = p.map(v => v.map((t, i) => t.filter(u => !tub[u.join(",")])));
		return clean(turf.multiPolygon(p, prop));
	}
	////=======================================================================================
	const mergeFeatures = (f, reso = 1e6) => {
		var g = f.map(t => turf.getType(t) == "MultiPolygon" ? turf.getCoords(t) : turf.getType(t) == "Polygon" ? [turf.getCoords(t)] : []).flat();
		var merged = turf.featureCollection([turf.multiPolygon(g)]);
		let topo = topojson.topology({ "foo": merged }, reso);
		return topojson.merge(topo, topo.objects.foo.geometries);
	};
	const reductFeatures = (f, reso = 1e6) => {
		let topo = topojson.topology({ "foo": turf.featureCollection(f) }, reso);
		return topojson.feature(topo, topo.objects.foo).features;
	};
	const meshFeature = f => { // Make a feature with MultiLineString
		const topo = topojson.topology({ "foo": turf.featureCollection(f) });
		return topojson.mesh(topo, topo.objects.foo, function (a, b) { return a !== b; });
	};
	const clipFeature = (f, g) => { //fをgでクリップ
		const conv = t => toClockwise(t.length == 1 ? turf.polygon(t[0]) : turf.multiPolygon(t));
		const toCoods = f => {
			f = f.type == "Feature" ? f.geometry : f;
			return (f.type, match(/Polygon/)) ? f.coordinates : Array.isArray(f) ? f : [];
		};
		const clip = (f, g) => polygonClipping.intersection(toCoods(f), toCoods(g));
		if (f.type == "FeatureCollection") return conv(f.features.map(t => clip(t, g)).flat());
		return conv(clip(f, g));
	};
	function clipLineString(polyline, polygon) {
		const intersectPoints = (p1, p2) => {
			if (!p1 || !p2) return;
			const p = turf.lineIntersect(turf.lineString([p1, p2]), polygon);
			return (p && p.features && p.features.length) ? p.features[0].geometry.coordinates : null;
		}
		let c = polyline.type == "Feature" ? polyline.geometry : polyline;
		c = c.type == "MultiLineString" ? c.coordinates : c.type == "LineString" ? [c.coordinates] : [];
		const a = [];
		c.forEach(line => {
			const x = line.map(p => geoContains(polygon, p)), len = line.length;
			if (x.filter(t => t).length) {
				let s = [];
				for (let i = 0; i < len; i++) {
					if (i > 0 && !x[i - 1] && x[i]) {
						s.push(intersectPoints(line[i - 1], line[i]));
					}
					if (x[i]) s.push(line[i])
					if (i < len - 1 && x[i] && !x[i + 1]) {
						s.push(intersectPoints(line[i], line[i + 1]));
						s = s.filter(t => t); if (s.length > 1) a.push(s);
						s = [];
					}
				}
				s = s.filter(t => t); if (s.length > 1) a.push(s);
			}
		});
		return a.length == 1 ? turf.lineString(a[0], polyline.properties) : turf.multiLineString(a, polyline.properties);
	}
	const bboxFeatures = f => {
		f.forEach(t => t.properties.bbox = t.properties.bbox || turf.bbox(t.geometry));
		return f;
	};
	const centerFeatures = f => {
		f.forEach(t => t.properties.center = t.properties.center || turf.pointOnFeature(t.geometry).geometry.coordinates);
		return f;
	};
	const toClockwise = json => {
		const is_clockwise = a => {
			let sum = 0
			for (let i = 0; i < a.length - 1; i++) {
				const p = a[i], q = a[i + 1];
				sum += (q[0] - p[0]) * (q[1] + p[1]);
			}
			return sum > 0
		};
		const fix = c => {
			c.forEach((t, i) => {
				const clockwise = is_clockwise(t);
				(i && clockwise || !i && !clockwise) && (c[i] = t.reverse());
			});
			return c;
		};
		function rewind(t) {
			(t.type === "Polygon") && fix(t.coordinates);
			(t.type === "MultiPolygon") && t.coordinates.map(fix);
		}
		function feature(t) { t.type === "Feature" && rewind(t.geometry); }

		(json.type === "FeatureCollection") ? json.features.forEach(feature) :
			(json.type === "GeometryCollection") ? json.geometries.forEach(rewind) :
				(json.type === "Feature") ? feature(json) :
					Array.isArray(json) ? json.forEach(feature) : rewind(json);
		return json;
	};
	const geoContains = (feature, [x, y]) => {
		const g = feature.geometry ? feature.geometry : feature, b = feature.properties.bbox || (feature.properties.bbox = turf.bbox(feature));
		if (b && (x > b[2] || y > b[3] || x < b[0] || y < b[1])) return false;
		const sum = a => { let n = 0; a.forEach(t => n += t); return n; }
		const a = g.type == "Polygon" ? [g.coordinates] : g.coordinates;
		return !!(sum(a.map(t => sum(t.map(cross)))) % 2);
		function cross(a) {
			var count = 0, n = a.length;
			for (let i = 0; i < n; i++) {
				var q = a[i], r = a[i + 1] || a[0];
				if ((((x - q[0]) * (x - r[0])) < 0) && (((x - q[0]) * (((x - q[0]) * (r[1] - q[1])) - ((y - q[1]) * (r[0] - q[0])))) < 0)) count++;
			}
			return count;
		}
	};
	function nearestFeature(e, features) {
		const err_point = 8 * 8, err_line = 5 * 5;
		const c = [e.x, e.y], proj = e.proj;
		const tester = map.projectTester;
		let a, q;
		q = features.filter(t => t.geometry.type.match(/Point/))
			.map(t => [t, points2feature(t)]).filter(t => t[1] < err_point)
			.sort((p, q) => p[1] > q[1] ? 1 : -1).map(t => t[0])[0];
		if (q) return q;
		q = features.filter(t => t.geometry.type.match(/LineString/))
			.map(t => [t, points2feature(t)]).filter(t => t[1] < err_line)
			.sort((p, q) => p[1] > q[1] ? 1 : -1).map(t => t[0])[0];
		if (q) return q;
		a = features.filter(t => t.geometry.type.match(/Polygon/))
		q = a.filter(t => geoContains(t, [e.lng, e.lat]))[0];
		if (q) return q;
		a.map(t => [t, points2feature(t)]).filter(t => t[1] < err_line)
			.sort((p, q) => p[1] > q[1] ? 1 : -1).map(t => t[0])[0];
		return q;
		function markerCenter([x, y], f) {
			return [x, y + (f.properties && f.properties.markerType == "marker" ? { S: -6, M: -12, L: -18, LL: -30 }[f.properties.markerSize] || 0 : 0)];
		}
		function points2feature(f) {
			const sqr = (a, b) => a * a + b * b;
			const dist = ([x0, y0], [x1, y1]) => sqr(x1 - x0, y1 - y0);
			const dist2 = ([x, y], [[x0, y0], [x1, y1]]) => {
				var r = dist([x1, y1], [x0, y0]);
				var t = -((x1 - x0) * (x0 - x) + (y1 - y0) * (y0 - y));
				if (t <= 0) return dist([x, y], [x0, y0]);
				if (t >= r) return dist([x, y], [x1, y1]);
				var f = (x1 - x0) * (y0 - y) - (y1 - y0) * (x0 - x);
				return f * f / r;
			};
			const dist_point = p => dist(c, p)
			const dist_line = a => {
				var d = []; if (a.length < 2) return Infinity;
				for (let i = 0; i < a.length - 1; i++) d[i] = dist2(c, [a[i], a[i + 1]]);
				return d3.min(d);
			};
			var p = f.geometry.coordinates;
			switch (f.geometry.type) {
				case "Point": return tester(p) ? dist_point(markerCenter(proj(p), f)) : Infinity;
				case "MultiPoint": return d3.min(p.map(t => tester(t) ? dist_point(markerCenter(proj(t), f)) : Infinity));
				case "LineString": return dist_line(p.filter(tester).map(proj));
				case "MultiLineString": return d3.min(p.map(t => dist_line(t.filter(tester).map(proj))));
				case "Polygon": return dist_line(p[0].filter(tester).map(proj));
				case "MultiPolygon": return d3.min(p.map(t => dist_line(t[0].filter(tester).map(proj))));
			}
		}
	}
	const cleanCoordsFeature = f => {
		if (f.type == "FeatureCollection") { f.features = f.features.map(cleanCoordsFeature); return f; }
		return turf.cleanCoords(f);
	}
	const truncateFeature = f => cleanCoordsFeature(turf.truncate(f, { precision: 3, coordinates: 2 }));
	const setup = async () => {
		if (this.setupComplete) return;
		await scripts("JEGXNgCp");
		await scripts("soovwRVV");
		await scripts("z6KkGJP9");
		await scripts("6UXlwcnK");
		const rawScript = id => new Promise(resolve => Synquery.getRawScript(id, resolve));
		const url = async id => URL.createObjectURL(new Blob([await rawScript(id)], { type: "text/javascript" }));
		let worker = await url("QsJRdYgo"), codec = await url("GQq9mUtF");
		let deflate = await url("cPIiQ0DU"), inflate = await url("2wR2FSLX");
		zip.workerScripts = { deflater: [worker, deflate, codec], inflater: [worker, inflate, codec] };
		this.setupComplete = true;
	}
	//	const cleanFeature = async(json) => {
	//		await setup();
	//		let ifile = "a.geojson", ofile = "b.geojson";
	//		let inp = {}; inp[ifile] = json;
	//		let clean = `-i ${ifile} -clean -o ${ofile}`;
	//		let output = await mapshaper.applyCommands(clean, inp);
	//		return JSON.parse(await bucket.reader("readAsText",new Blob([output[ofile]]), "UTF-8")).features[0];
	//	};
	const cleanCollection = async fc => {
		await setup();
		let ifile = "a.geojson", ofile = "b.geojson";
		let inp = {}; inp[ifile] = truncateFeature(fc);
		let clean = `-i ${ifile} -clean -o ${ofile}`;
		let output = await mapshaper.applyCommands(clean, inp);
		return JSON.parse(await bucket.reader("readAsText", new Blob([output[ofile]]), "UTF-8"));
	};
	function coordsCount(g) {//頂点(coordinates)の数をカウント
		if (g.type == "FeatureCollection") return d3.sum(g.features.map(coordsCount));
		if (Array.isArray(g)) return d3.sum(g.map(coordsCount));
		g = g.geometry || g;
		const p = g.coordinates;
		switch (g.type) {
			case "Point": return 1;
			case "LineString": case "MultiPoint": return p.length;
			case "Polygon": case "MultiLineString": return d3.sum(p.map(t => t.length));
			case "MultiPolygon": return d3.sum(p.map(t => d3.sum(t.map(u => u.length))));
		}
	}
	function geometryCount(g) {//Featureの数をカウント
		var counts = [0, 0, 0];
		if ((g.type || "").match(/Collection/)) g = g.features || g.geometries;
		if (!Array.isArray(g)) return counts;
		g.forEach(g => {
			const { type, coordinates } = g.geometry || g;
			const num = type.match(/Polygon/) ? 2 : type.match(/LineString/) ? 1 : 0;
			counts[num] += type.match(/Multi/) ? coordinates.length : 1
		});
		return counts;
	}
	function bboxSelect(feature, bbox) {
		if (bbox[2] - bbox[0] > 180 && Math.abs(bbox[0] + bbox[2]) < 180) {
			return areaSelect(feature, [bbox[2], bbox[1], 180, bbox[3]]) || areaSelect(feature, [-180, bbox[1], bbox[0], bbox[3]]);
		}
		const edge = p => (p[0] < bbox[0] || p[0] > bbox[2] || p[1] < bbox[1] || p[1] > bbox[3]);
		const geom = feature.geometry || feature, c = geom.type.match(/Multi/) ? geom.coordinates : [geom.coordinates];
		if (geom.type.match(/Point/)) {
			for (let i = 0; i < c.length; i++) if (!edge(c[i])) return true;
		}
		if (geom.type.match(/LineString/)) {
			for (let i = 0; i < c.length; i++) if (checkLineString(c[i])) return true;
		}
		if (geom.type.match(/Polygon/)) {
			for (let i = 0; i < c.length; i++) if (checkPolygon(c[i][0])) return true;
		}
		return false;
		function intersect(a, b) {
			var x;
			x = a[0] + (b[0] - a[0]) * (bbox[3] - a[1]) / (b[1] - a[1]); if (x > bbox[0] && x < bbox[2]) return true;
			x = a[0] + (b[0] - a[0]) * (bbox[1] - a[1]) / (b[1] - a[1]); if (x > bbox[0] && x < bbox[2]) return true;
			return false;
		}
		function checkLineString(c) {
			for (let i = 0; i < c.length; i++) if (!edge(c[i])) return true;
			for (let i = 1; i < c.length; i++) if (intersect(c[i - 1], c[i])) return true;
			return false;
		}
		function checkPolygon(c) {
			if (c.length < 4) return false;
			for (let i = 0; i < c.length - 1; i++) if (!edge(c[i])) return true;
			return geoContains(turf.polygon([c], {}), [bbox[0], bbox[1]]) ? true : false;
		}
	}
	function greatCircleLineIntersect([p0, p1], [q0, q1]) {
		const bbox = [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])];
		if (bbox[0] > Math.max(q[0][0], q1[0]) || bbox[2] < Math.min(q[0][0], q1[0])) return null;
		if (bbox[1] > Math.max(q[0][1], q1[1]) || bbox[3] < Math.min(q[0][1], q1[1])) return null;
		const sin = v => Math.sin(v / 180 * Math.PI);
		const cos = v => Math.cos(v / 180 * Math.PI);
		const atan2 = (x, y) => Math.atan2(x, y) / Math.PI * 180;
		const p = line(p0, p1), q = line(q0, q1);
		const [x, y, z] = [p.y * q.z - q.y * p.z, p.z * q.x - q.z * p.x, p.x * q.y - p.y * q.x];
		let [lng, lat] = [atan2(-y, x), atan2(z, Math.sqrt(x * x + y * y))];
		if (bbox[0] <= lng && lng <= bbox[2] && bbox[1] <= lat && lat <= bbox[3]) return [lng, lat];
		[lng, lat] = [lng + (lng < 0 ? 1 : -1) * 180, -lat];
		if (bbox[0] <= lng && lng <= bbox[2] && bbox[1] <= lat && lat <= bbox[3]) return [lng, lat];
		return null;
		function line([x0, y0], [x1, y1]) {
			const xp = x0 + x1, xn = x0 - x1;
			const yp = y0 + y1, yn = y0 - y1;
			const x = sin(yn) * sin(xp / 2) * cos(xn / 2) - sin(yp) * cos(xp / 2) * sin(xn / 2);
			const y = sin(yn) * cos(xp / 2) * cos(xn / 2) + sin(yp) * sin(xp / 2) * sin(xn / 2);
			const z = cos(y0) * cos(y1) * sin(xn);
			const r = Math.sqrt(x * x + y * y + z * z);
			return { x: x / r, y: y / r, z: z / r };
		}
	}
	Object.assign(window, {
		antimeridianFeature,
		unionFeature, intersectionFeature, subFeature,
		mergeFeatures, reductFeatures, meshFeature, clipFeature, toClockwise,
		geoContains, nearestFeature, truncateFeature, cleanCollection,
		coordsCount, geometryCount, bboxSelect
	});
}
const LANGS = "EN|DE|ES|FR|PT|RU|ZH|AR|BN|EL|HI|HU|ID|IT|JA|KO|NL|PL|SV|TR|VI|FA|HE|UK|UR|ZHT".split("|");
const langs = LANGS.map(t => t.toLowerCase());
const cache = name => d3.cache("nvkelso/" + name);
const naturalEarth = name => bucket.getJSON(`https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/${name}.geojson`);
const naturalEarthX = name => {
	const scale = name.match(/_([0-9]+m)_/)[1];
	const url = `https://www.naturalearthdata.com/http//www.naturalearthdata.com/download/${scale}/cultural/${name}.zip`;
	return bucket.shape2geo(url);
};
const loadObject = name => bucket.loadObject("nvkelso/" + name, { project: "b1qEpPlw" });
const saveObject = async (name, v) => { await bucket.saveObject("nvkelso/" + name, v, { project: "b1qEpPlw" }); console.log(await loadObject(name)); };
async function setupMapGeometories(flag) {
	const rev = "1.25", date = "2025/03/13";
	const nvkelso = {}, dbs = "nation|state|city|road|rail|urbun".split("|");
	await d3.thenEach(dbs, async t => nvkelso[t] = await d3.cache("nvkelso/" + t));
	const version = await nvkelso.nation("version");
	if (!flag && version && version.rev == rev) return nvkelso;
	console.log("updating geo databases...");
	{
		const v = await loadObject("ne_10m_admin_1_states_provinces");
		const tub = {};
		v.forEach(t => { var iso = t.properties.iso; (tub[iso] = tub[iso] || []).push(t); });
		await d3.thenEach(Object.entries(tub), ([k, v]) => nvkelso.state(k, v));
		const a = Object.entries(tub).sort((p, q) => p[0] > q[0] ? 1 : -1).map(([k, v]) => {
			const geo = mergeFeatures(v);
			return turf.feature(geo, { id: k, bbox: turf.bbox(geo), area: turf.area(geo) / 1e6 });
		});
		await nvkelso.nation("iso", a);
	} {
		const v = await loadObject("ne_10m_admin_0_disputed_areas");
		await nvkelso.nation("disputed", v);
	} {
		const v = await loadObject("ne_10m_geography_marine_polys");
		await nvkelso.nation("ocean", v);
	} {
		const v = await loadObject("ne_10m_lakes");
		await nvkelso.nation("lake", v);
	} {
		const v = await loadObject("ne_10m_rivers_lake_centerlines_scale_rank");
		await nvkelso.nation("river", v);
	} {
		const v = await loadObject("List_of_mountain_peaks_by_prominence");
		await nvkelso.nation("mountain", v);
	} {
		const v = await loadObject("ne_50m_admin_0_boundary_lines_maritime_indicator_chn");
		await nvkelso.nation("china", v);
	} {
		const v = await loadObject("ne_10m_antarctic_ice_shelves_polys");
		await nvkelso.nation("antarctic", v);
	} {
		const v = await loadObject("ne_10m_populated_places");
		const tub = {}; v.forEach(t => (tub[t.iso] = tub[t.iso] || []).push(t));
		await d3.thenEach(Object.entries(tub), ([k, v]) => nvkelso.city(k, v));
	} {
		const v = await loadObject("ne_10m_roads");
		await d3.thenEach(v, t => nvkelso.road(t.properties.id, t));
	} {
		const v = await loadObject("ne_10m_railroads");
		await d3.thenEach(v, t => nvkelso.rail(t.properties.id, t));
	} {
		const v = await loadObject("ne_50m_urban_areas");
		await d3.thenEach(v, t => nvkelso.urbun(t.properties.id, t));
	}
	await nvkelso.nation("version", { rev, date });
	console.log("complete!!!");
	return nvkelso;
}

async function upload_admin() {
	const name = "ne_10m_admin_1_states_provinces";
	var a = await naturalEarth(name);
	var ヤンマイエン島 = toClockwise(JSON.parse(__HTML__));//ヤンマイエン島はノルーウェーに含まれる
	a = a.features.concat([ヤンマイエン島]);
	a.map(t => {
		var p = t.properties, name = p.name_ja, iso = p.iso_a2, iso2 = p.iso_3166_2;
		if (name == "デケリア") iso = "CY";
		if (name == "アクロティリ") iso = "CY";
		if (name == "北キプロス") iso = "CY";
		if (name == "ソマリランド") iso = "SO";
		if (name == "グアンタナモ湾収容キャンプ") iso = "CU";
		if (name == "バイコヌール") iso = "KZ";
		if (name == "コーラル・シー諸島") iso = "AU";
		if (name == "ココス諸島") iso = "CC";
		if (name == "クリスマス島") iso = "CX";
		if (name == "カシミール") iso = "B45";
		if (name == "南沙諸島") iso = "B46";
		if (name == "クリッパートン島") iso = "FR-CP";
		if (name == "ブーベ島") iso = "BV";
		if (name == "スヴァールバル諸島") iso = "SJ";
		if (iso == "FR") {
			if (iso2 == "FR-RE") iso = "RE";
			if (iso2 == "FR-YT") iso = "YT";
			if (iso2 == "FR-GF") iso = "GF";
			if (iso2 == "FR-MQ") iso = "MQ";
			if (iso2 == "FR-GP") iso = "GP";
		}
		if (iso == "NL") {
			if (iso2 == "NL-BQ1") iso = "BQ";
			if (iso2 == "NL-BQ2") iso = "BQ";
			if (iso2 == "NL-BQ3") iso = "BQ";
		}
		if (iso == "-1") console.warn(t);
		if (name == "ハワイ州") {//北西ハワイ諸島・ミッドウェー(UM)が含まれている
			var UM = t.geometry.coordinates.filter(t => t[0][0][0] < -160);
			console.log(UM);
			t.geometry.coordinates = t.geometry.coordinates.filter(t => t[0][0][0] > -160);
		}
		if (!t.properties.name) console.log("no name: ", t.properties.note);
		if (!iso.match(/^[A-Z]{2}$/)) console.log("iso: ", iso, name);
		var prop = { id: p.iso_3166_2, iso, name: {} };
		langs.forEach(t => prop.name[t] = p["name_" + t] || "");
		prop.bbox = turf.bbox(t);
		prop.area = turf.area(t) / 1e6;
		p.wikidataid && (prop.qid = p.wikidataid);
		t.properties = prop;
		delete t.bbox;
		//	if (prop.id.match("~")) console.log(prop.name.ja, prop);
		return t;
	});
	a = a.sort((p, q) => p.properties.iso > q.properties.iso ? 1 : -1);
	await d3.thenEach(a, async t => {
		var p = t.properties;
		if (!p.name.en || p.qid) return;
		p.qid = await d3.wiki.id2qid(await d3.wiki.title2id(p.name.en, "en"), "en");
		if (!p.qid) p.qid = await d3.wiki.id2qid(await d3.wiki.title2id(p.name.fr, "fr"), "fr");
		if (!p.qid) console.warn(p.iso, p.id, p.name);
	})
	//	await saveObject(name, a);
}
async function upload_conflict() {
	const name = "ne_10m_admin_0_disputed_areas";
	const tub = {};
	[["B00", "IN", ["CN"]],//アルナーチャル・プラデーシュ州
	["B01", "IN", ["CN"]],//ティルパニ渓谷
	["B02", "IN", ["CN"]],//バラホティ渓谷
	["B03", "IN", ["CN"]],//デムチョク
	["B04", "IN", ["CN"]],//サムドゥ渓谷
	["B05", "IN", ["PK"]],//カシミール
	["B06", "CN", ["IN"]],//カラコルム回廊
	["B07", "CN", ["IN"]],//アクサイチン
	["B08", "PK", ["IN"]],//ギルギット・バルティスタン州
	["B09", "PK", ["IN"]],//アザド・カシミール
	["B10", "KR", []],//南軍事境界線
	["B11", "KP", []],//北軍事境界線
	["B12", "GB", ["AR"], "FK"],//フォークランド諸島
	["B13", "SD", ["SS"]],//アビエイ
	["B14", "FR", ["SR"], "GF"],//ラワ源流
	["B15", "GY", ["SR"]],//チグリ地域
	["B16", "IL", ["SY"]],//ゴラン高原
	["B17", "KE", ["SS"]],//イレミ・トライアングル
	["B18", "JP", ["CN", "TW"]],//尖閣諸島
	["B19", "MA", ["EH"]],//西サハラ
	["B20", "B20", ["CY"]],//北キプロス・トルコ共和国
	["B21", "DK", ["CA"], "GL"],//ハンス島
	["B22", "FR", ["KM"], "YT"],//マヨット
	["B23", "FR", ["MG"], "TF"],//フアン・デ・ノヴァ島
	["B24", "FR", ["MG"], "TF"],//グロリオソ諸島
	["B25", "FR", ["MU", "SC"], "TF"],//トロメリン島
	["B26", "FR", ["MG"], "TF"],//ユローパ島
	["B27", "FR", ["MG"], "TF"],//バサス・ダ・インディア
	["B28", "EH", ["MA"]],//サハラ・アラブ民主共和国
	["B29", "RU", ["JP"]],//北方領土
	["B30", "B30", ["SO"]],//ソマリランド
	["B31", "GB", ["IE", "DK", "IS"]],//ロッコール島
	["B32", "GB", ["AR"], "GS"],//南ジョージア島
	["B33", "GB", ["AR"], "GS"],//南サンドイッチ島
	["B34", "US", ["HT"], "UM"],//ナヴァッサ島
	["B35", "B35", ["GE"]],//アブハジア
	["B36", "B36", ["MD"]],//沿ドニエストル共和国
	["B37", "B37", ["GE"]],//南オセチア
	["B38", "B38", ["AZ"]],//アルツァフ共和国
	["B39", "KR", ["JP"]],//竹島
	["B40", "RU", ["KZ"]],//バイコヌール
	["B41", "US", ["CO", "JM", "NI"], "UM"],//バホヌエボ
	["B42", "US", ["CO", "HN", "NI"], "UM"],//セラニャ・バンク
	["B43", "CY", []],//グリーンライン(キプロス)
	["B44", "GB", ["MU", "SC"], "IO"],//ディエゴガルシア海軍支援施設
	["B45", "", ["PK", "IN"]],//シアチェン氷河
	["B46", "", ["CN", "TW", "MY", "PH", "BN", "VN"]],//南沙(スプラトリー)諸島
	["B47", "CN", ["VN", "TW"]],//西沙諸島
	["B48", "VE", ["DM"]],//アベス島
	["B49", "SY", []],//国際連合兵力引き離し監視軍
	["B50", "US", ["CU"]],//グァンタナモ米軍基地
	["B51", "BZ", []],//ベリーズ
	["B52", "GA", ["GQ"]],//ムベイン島
	["B53", "PS", ["IL"]],//ガザ地区
	["B54", "PS", ["IL"]],//ヨルダン川西岸地区
	["B55", "GB", ["ES"], "GI"],//ジブラルタル
	["B56", "GY", ["VE"]],//グアヤナエセキバ
	["B57", "XK", ["RS"]],//コソボ共和国
	["B58", "IL", ["LB"]],//シェバー・ファームズ
	["B59", "US", ["MH"], "UM"],//ウェーク島
	["B60", "ES", []],//セウタ
	["B61", "ES", []],//メリリャ
	["B62", "ES", ["MA"]],//ペレヒル島
	["B63", "ES", ["MA"]],//ペニョン・デ・ベレス・デ・ラ・ゴメラ
	["B64", "ES", ["MA"]],//ペニョン・デ・アルセマス
	["B65", "ES", ["MA"]],//チャファリナス諸島
	["B66", "FR", ["VU"], "NC"],//マシュー島・ハンター島
	["B67", "ES", ["PT"]],//オリベンサ
	["B68", "EG", ["SA"]],//チラン・サナフィール島
	["B69", "GB", ["MU", "SC"], "IO"],//イギリス領インド洋地域
	["B70", "CN", ["PH", "TW"]],//スカボロー礁
	["B71", "US", ["TK"], "AS"],//スウェインズ島
	["B73", "IR", ["AE"]],//アブー・ムーサー島
	["B74", "SS", ["KE"]],//イレミ・トライアングル
	["B75", "BT", ["CN"]],//北西渓谷(ブータン)
	["B76", "BT", ["CN"]],//チュンビ谷(ブータン)
	["B77", "TW", ["CN"]],//中華民国
	["B78", "IL", ["PS"]],//中間地帯（フォート・ラトゥルン）
	["B79", "IL", ["PS"]],//中間地帯（エルサレム）
	["B80", "BZ", ["HN", "GT"]],//サポディーラケイズ
	["B82", "HR", ["SI"]],//ドラゴニャ川
	["B84", "KR", ["KP"]],//北方限界線
	["B85", "", ["BR", "UY"]],//ブラジレイラ島
	["B87", "ER", ["DJ"]],//ドゥメーラ島
	["B88", "IN", ["NP"]],//オム・プラバット
	["B89", "RU", ["UA"]],//クリミア半島
	["B91", "IL", []],//イスラエル
	["B92", "BR", ["UY"]],//アルティガスのコーナー
	["B93", "EG", ["SD"]],//ハラーイブ・トライアングル
	["B94", "", ["EG", "SD"]],//ビル・タウィール
	["B95", "RS", ["HR"]],//シャレングラード島
	["B96", "RS", ["HR"]],//ヴコヴァル島
	["B97", "", ["CL", "AR"]],//南パタゴニア氷原
	["B98", "IL", ["PS"]],//東エルサレム
	["B99", "IL", ["PS"]],//スコープス山
	["C01", "IN", ["PK"]],//ジュナーガド
	["C02", "C02", ["UA"]],//ドネツク人民共和国
	["C03", "C03", ["UA"]],//ルガンスク人民共和国
	["C04", "MY", []],//北ボルネオ
	].forEach(t => tub[t[0]] = [t[1], t[2], t[3]]);
	var disputed = await naturalEarth(name);
	const MAP = {}; disputed.features.forEach(t => MAP[t.properties.BRK_A3] = t);
	await d3.thenEach(Object.entries(MAP), async ([id, t]) => {
		const p = t.properties;
		const prop = { id, name: {} };
		langs.forEach(t => prop.name[t] = p["NAME_" + t.toUpperCase()] || "");
		prop.sovereignt = tub[id][0];
		prop.claim = tub[id][1];
		tub[id][2] && (prop.iso = tub[id][2]);
		prop.bbox = turf.bbox(t);
		prop.area = turf.area(t) / 1e6;
		p.WIKIDATAID && (prop.qid = p.WIKIDATAID);
		t.properties = prop;
		if (id == "B46") prop.name = await d3.wiki.qid2titles(prop.qid = "Q215664");//データ修正(南沙諸島)
		id == "B29" && (prop.name.ja = "北方領土");
		id == "B38" && (prop.name.ja = "アルツァフ共和国");
		//		id == "B46" && (prop.name.ja = "南沙(スプラトリー)諸島");
		//		id == "B47" && (prop.name.ja = "西沙(パラセル)諸島");
		delete t.bbox;
	});
	const nations = await loadNationDB();
	const nation = await cache("nation"), isos = await nation("iso");
	{	/// アフガニスタン紛争作成
		var q = MAP["AFX"] = { type: "Feature", geometry: isos.filter(t => t.properties.id == "AF")[0].geometry };
		var qid = await d3.wiki.id2qid(nations.filter(t => t.name.ja == "アフガニスタン・イスラム共和国")[0].wiki.ja);
		var prop = q.properties = { id: "AFX", sovereignt: "AF", claim: ["AFX"], bbox: turf.bbox(q), area: turf.area(q) / 1e6 };
		prop.name = await d3.wiki.qid2titles(prop.qid = qid);
	}
	{	// 西サハラ作成
		var q = MAP["EHX"] = { type: "Feature", geometry: mergeFeatures([MAP["B19"], MAP["B28"]]) };
		var qid = await d3.wiki.id2qid(nations.filter(t => t.name.ja == "西サハラ")[0].wiki.ja);
		var prop = q.properties = { id: "EHX", sovereignt: "EHX", claim: [], bbox: turf.bbox(q), area: turf.area(q) / 1e6 };
		prop.name = await d3.wiki.qid2titles(prop.qid = qid);
	}
	var a = Object.values(MAP).sort((p, q) => p.properties.id > q.properties.id ? 1 : -1);
	await saveObject(name, a);
}
async function upload_china() {
	const name = "ne_50m_admin_0_boundary_lines_maritime_indicator_chn";
	var v = await naturalEarth(name);
	v = turf.multiLineString(v.features.map(t => t.geometry.coordinates));
	await saveObject(name, v);
}
async function upload_antarctic() {
	const name = "ne_10m_antarctic_ice_shelves_polys";
	var v = await naturalEarth(name);
	v = turf.multiPolygon(v.features.map(t => t.geometry.type == "MultiPolygon" ? t.geometry.coordinates : t.geometry.type == "Polygon" ? [t.geometry.coordinates] : []).flat());
	await saveObject(name, v);
}

async function upload_city() {
	const nations = await loadNationDB(), name = "ne_10m_populated_places";
	var a = (await naturalEarth(name)).features.map(t => {
		var p = t.properties;
		var json = { name: {} };
		LANGS.forEach(t => p["NAME_" + t] || console.warn(p));
		LANGS.forEach(t => json.name[t.toLowerCase()] = p["NAME_" + t]);
		json.level = p.SCALERANK;
		json.capital = !!(p.FEATURECLA == "Admin-0 capital");
		json.coords = t.geometry.coordinates;
		json.pop = [p.POP_MAX, p.POP_MIN];
		p.WIKIDATAID && (json.qid = p.WIKIDATAID);
		var iso = p.ISO_A2;
		if (iso == "-99") {
			(p.ADM0_A3 == "KOS") && (iso = "XK");
			(p.ADM0_A3 == "SOL") && (iso = "SO");
			(p.ADM0_A3 == "CYN") && (iso = "CY");
		}
		json.name.ja = json.name.ja.replace(/(特別市|広域市|市|都|島|州|＝ヴィル)$/, "");
		iso == "YE" && json.name.ja == "サヌア" && (json.name.ja = "サナア");
		iso == "UA" && json.name.ja == "キエフ" && (json.name.ja = "キーウ");
		iso == "KZ" && json.name.ja == "ヌル-スルタン" && (json.name.ja = "アスタナ");
		iso == "LK" && json.name.ja == "スリジャヤワルダナプラコッテ" && (json.name.ja = "スリ・ジャヤワルダナプラ・コッテ");
		iso == "PR" && json.name.ja == "サン・フアン" && (json.name.ja = "サンフアン");
		iso == "PW" && json.name.ja == "マルキョク" && (json.name.ja = "ンゲルルムッド");
		iso == "MP" && json.name.ja == "キャピトル・ヒル" && (json.name.ja = "サイパン");
		iso == "KI" && json.name.ja == "サウス・タラワ" && (json.name.ja = "タラワ");
		////-------------------------------------------------------------
		iso == "BI" && json.name.ja == "ギテガ" && (json.capital = true);
		iso == "BI" && json.name.ja == "ブジュンブラ" && (json.capital = false);
		iso == "BJ" && json.name.ja == "コトヌー" && (json.capital = false);
		iso == "BJ" && json.name.ja == "ポルトノボ" && (json.capital = true);
		iso == "BO" && json.name.ja == "ラパス" && (json.capital = false);
		iso == "CI" && json.name.ja == "アビジャン" && (json.capital = false);
		iso == "SO" && json.name.ja == "ハルゲイサ" && (json.capital = false);
		iso == "IN" && json.name.ja == "ニューデリー" && (json.capital = false);
		iso == "IN" && json.name.ja == "デリー" && (json.capital = true);
		iso == "LK" && json.name.ja == "コロンボ" && (json.capital = false);
		iso == "LK" && json.name.ja == "スリ・ジャヤワルダナプラ・コッテ" && (json.capital = true);
		iso == "MM" && json.name.ja == "ヤンゴン" && (json.capital = false);
		iso == "TZ" && json.name.ja == "ダルエスサラーム" && (json.capital = false);
		iso == "TZ" && json.name.ja == "ドドマ" && (json.capital = true);
		iso == "ZA" && json.name.ja == "ヨハネスブルグ" && (json.capital = false);
		iso == "GP" && json.name.ja == "バステール" && (json.capital = true);
		iso == "AW" && json.name.ja == "オラニエスタッド" && (json.capital = true);
		iso == "AX" && json.name.ja == "マリエハムン" && (json.capital = true);
		iso == "CW" && json.name.ja == "ウィレムスタッド" && (json.capital = true);
		iso == "GU" && json.name.ja == "ハガニア" && (json.capital = true);
		iso == "CK" && json.name.ja == "アバルア" && (json.capital = true);
		iso == "GL" && json.name.ja == "ヌーク" && (json.capital = true);
		iso == "KY" && json.name.ja == "ジョージタウン" && (json.capital = true);
		iso == "GI" && json.name.ja == "ジブラルタル" && (json.capital = true);
		iso == "SJ" && json.name.ja == "ロングイェールビーン" && (json.capital = true);
		iso == "TC" && json.name.ja == "コックバーンタウン" && (json.capital = true);
		iso == "NC" && json.name.ja == "ヌメア" && (json.capital = true);
		iso == "BM" && json.name.ja == "ハミルトン" && (json.capital = true);
		iso == "PS" && json.name.ja == "ラマッラー" && (json.capital = true);
		iso == "FO" && json.name.ja == "トースハウン" && (json.capital = true);
		iso == "FK" && json.name.ja == "スタンリー" && (json.capital = true);
		iso == "GF" && json.name.ja == "カイエンヌ" && (json.capital = true);
		iso == "PF" && json.name.ja == "パペーテ" && (json.capital = true);
		iso == "MO" && json.name.ja == "マカオ" && (json.capital = true);
		iso == "MQ" && json.name.ja == "フォール＝ド＝フランス" && (json.capital = true);
		iso == "IM" && json.name.ja == "ダグラス" && (json.capital = true);
		iso == "RE" && json.name.ja == "サン＝ドニ" && (json.capital = true);
		iso == "HK" && json.name.ja == "香港" && (json.capital = true);
		iso == "AS" && json.name.ja == "パゴパゴ" && (json.capital = true);
		iso == "PR" && json.name.ja == "サンフアン" && (json.capital = true);
		iso == "MP" && json.name.ja == "サイパン" && (json.capital = true);
		////-------------------------------------------------------------
		if (iso == "-99") console.error(p)
		json.iso = iso;
		return json;
	});
	a = a.concat([
		{ "qid": "Q5838", "name": { "ar": "كابل", "bn": "কাবুল", "de": "Kabul", "el": "Καμπούλ", "en": "Kabul", "es": "Kabul", "fa": "کابل", "fr": "Kaboul", "he": "קאבול", "hi": "काबुल", "hu": "Kabul", "id": "Kabul", "it": "Kabul", "ja": "カーブル", "ko": "카불", "nl": "Kabul", "pl": "Kabul", "pt": "Cabul", "ru": "Кабул", "sv": "Kabul", "tr": "Kâbil", "uk": "Кабул", "ur": "کابل", "vi": "Kabul", "zh": "喀布尔" }, "iso": "AFX", "capital": true, "level": 4, "coords": [69.178333, 34.525278, 1803], "pop": [4601789, 4601789, 4601789] },
		{ "qid": "Q40811", "name": { "ar": "سوخومي", "bn": "সুখুমি", "de": "Sochumi", "el": "Σουχούμι", "en": "Sukhumi", "es": "Sujumi", "fa": "سوخومی", "fr": "Soukhoumi", "he": "סוחומי", "hu": "Szuhumi", "id": "Sukhum", "it": "Sukhumi", "ja": "スフミ", "ko": "수후미", "nl": "Soechoemi", "pl": "Suchumi", "pt": "Sucumi", "ru": "Сухуми", "sv": "Suchumi", "tr": "Sohum", "uk": "Сухумі", "ur": "سخومی", "vi": "Sukhumi", "zh": "苏呼米" }, "iso": "B35", "capital": true, "level": 4, "coords": [41.016667, 43, 4], "pop": [62914, 62914, 62914] },
		{ "qid": "Q129352", "name": { "ar": "خانكندي", "de": "Xankəndi", "el": "Στεπανακέρτ", "en": "Stepanakert", "es": "Jankendi", "fa": "استپاناکرت", "fr": "Khankendi", "he": "סטפנקרט", "hu": "Xankəndi", "id": "Stepanakert", "it": "Step'anakert", "ja": "ステパナケルト", "ko": "스테파나케르트", "nl": "Stepanakert", "pl": "Chankendi", "pt": "Estepanaquerte", "ru": "Ханкенди", "sv": "Stepanakert", "tr": "Hankendi", "uk": "Ханкенді", "ur": "خان کندی", "vi": "Stepanakert", "zh": "漢肯德" }, "iso": "B38", "capital": true, "level": 4, "coords": [46.751944, 39.815278, 861], "pop": [8000, 8000, 8000] },
		{ "qid": "Q30994", "name": { "ar": "ذا فالي", "de": "The Valley", "el": "Δε Βάλεϊ", "en": "The Valley, Anguilla", "es": "The Valley", "fa": "د ولی", "fr": "The Valley", "he": "הוואלי", "hu": "The Valley", "id": "The Valley", "it": "The Valley", "ja": "バレー", "ko": "더밸리", "nl": "The Valley", "pl": "The Valley", "pt": "The Valley", "ru": "Валли", "sv": "The Valley", "tr": "The Valley", "uk": "Валлі", "ur": "دی ویلی", "vi": "The Valley, Anguilla", "zh": "瓦利" }, "iso": "AI", "capital": true, "level": 4, "coords": [-63.051667, 18.220833, 15], "pop": [1067, 1067, 1067] },
		{ "qid": "Q3940", "name": { "ar": "فيكتوريا", "bn": "ভিক্তোরিয়া, সেশেলস", "de": "Victoria", "el": "Βικτώρια", "en": "Victoria, Seychelles", "es": "Victoria", "fa": "ویکتوریا", "fr": "Victoria", "he": "ויקטוריה", "hi": "विक्टोरिया, सेशाइल्स", "hu": "Victoria", "id": "Victoria, Seychelles", "it": "Victoria", "ja": "ヴィクトリア", "ko": "빅토리아", "nl": "Victoria", "pl": "Victoria", "pt": "Vitória", "ru": "Виктория", "sv": "Victoria, Seychellerna", "tr": "Victoria", "uk": "Вікторія", "ur": "وکٹوریا", "vi": "Victoria, Seychelles", "zh": "维多利亚" }, "iso": "IO", "capital": true, "level": 4, "coords": [55.4525, -4.6231, 6], "pop": [26450, 26450, 26450] },
		{ "qid": "Q31002", "name": { "ar": "ماتا-أوتو", "de": "Mata Utu", "el": "Μάτα Ούτου", "en": "Mata Utu", "es": "Mata-Utu", "fa": "ماتا-اوتو", "fr": "Mata-Utu", "he": "מאטה אוטו", "hu": "Matāʻutu", "id": "Mata Utu", "it": "Matāʻutu", "ja": "マタウトゥ", "ko": "마타우투", "nl": "Matâ'utu", "pl": "Mata Utu", "pt": "Mata Utu", "ru": "Мата-Уту", "sv": "Matāʻutu", "tr": "Mata-Utu", "uk": "Мата-Уту", "ur": "ماتا-اتو", "vi": "Matāʻutu", "zh": "马塔乌图" }, "iso": "WF", "capital": true, "level": 4, "coords": [-176.183333, -13.283333, 24], "pop": [1075, 1075, 1075] },
		{ "qid": "Q174262", "name": { "ar": "سان بيتر بورت", "de": "Saint Peter Port", "el": "Σεντ Πίτερ Πορτ", "en": "Saint Peter Port", "es": "Saint Peter Port", "fa": "سن پتر پورت", "fr": "Saint-Pierre-Port", "he": "סנט פיטר פורט", "hi": "सेंट पीटर पोर्ट", "hu": "Saint Peter Port", "id": "Saint Peter Port", "it": "Saint Peter Port", "ja": "セント・ピーター・ポート", "ko": "세인트피터포트", "nl": "Saint Peter Port", "pl": "Saint Peter Port", "pt": "Porto de São Pedro", "ru": "Сент-Питер-Порт", "sv": "St. Peter Port", "tr": "Saint Peter Port", "uk": "Сент-Пітер-Порт", "ur": "سینٹ پیٹر پورٹ", "vi": "Saint Peter Port", "zh": "圣彼得港" }, "iso": "GG", "capital": true, "level": 4, "coords": [-2.5368, 49.4555, 18], "pop": [18798, 18798, 18798] },
		{ "qid": "Q30980", "name": { "ar": "فلاينغ فيش كوف", "bn": "ফ্লাইং ফিশ কোভ", "de": "Flying Fish Cove", "el": "Φλάινγκ Φις Κόουβ", "en": "Flying Fish Cove", "es": "Flying Fish Cove", "fa": "فلاینگ فیش کاو", "fr": "Flying Fish Cove", "he": "פלאיינג פיש קואוב", "hi": "फ्लाइंग फिश कोव", "id": "Flying Fish Cove", "it": "Flying Fish Cove", "ja": "フライング・フィッシュ・コーブ", "ko": "플라잉피시코브", "nl": "Flying Fish Cove", "pl": "Flying Fish Cove", "pt": "Flying Fish Cove", "ru": "Флайинг-Фиш-Ков", "sv": "Flying Fish Cove", "tr": "Flying Fish Cove", "uk": "Флаїнг-Фіш-Коув", "ur": "فلائینگ فش کوو", "vi": "Flying Fish Cove", "zh": "飞鱼湾" }, "iso": "CX", "capital": true, "level": 4, "coords": [105.672778, -10.426111, 21], "pop": [1347, 1347, 1347] },
		{ "qid": "Q19566", "name": { "ar": "سيمفروبول", "de": "Simferopol", "el": "Συμφερόπολη", "en": "Simferopol", "es": "Simferópol", "fa": "سیمفروپول", "fr": "Simferopol", "he": "סימפרופול", "hu": "Szimferopol", "id": "Simferopol", "it": "Sinferopoli", "ja": "シンフェロポリ", "ko": "심페로폴", "nl": "Simferopol", "pl": "Symferopol", "pt": "Simferopol", "ru": "Симферополь", "sv": "Simferopol", "tr": "Akmescit", "uk": "Сімферополь", "ur": "سمفروپول", "vi": "Simferopol", "zh": "辛菲罗波尔" }, "iso": "B89", "capital": true, "level": 4, "coords": [34.102222, 44.951944, 245], "pop": [361980, 361980, 361980] },
		{ "qid": "Q48675", "name": { "ar": "ويست آيلند", "de": "West Island", "el": "Γουέστ Άιλαντ", "en": "West Island, CocosIslands", "es": "West Island", "fa": "وست آیلند", "fr": "West Island", "he": "וסט איילנד", "hi": "पश्चिम द्वीप, कोकोस द्वीपसमूह", "hu": "West Island", "id": "Pulau Panjang, Kepulauan Cocos", "it": "West Island", "ja": "ウェスト島", "ko": "웨스트섬", "nl": "West Island", "pl": "West Island", "pt": "Ilha Ocidental", "ru": "Уэст-Айленд", "sv": "West Island", "tr": "Batı Adası", "uk": "Західний острів", "ur": "ویسٹ آئلینڈ، جزائر کوکوس", "vi": "West Island, Quần đảo Cocos", "zh": "西島" }, "iso": "CC", "capital": true, "level": 4, "coords": [96.828333, -12.186944, 10], "pop": [133, 133, 133] },
		{ "qid": "Q34112", "name": { "ar": "غوستافيا، سانت بارتيليمي", "de": "Gustavia", "el": "Γουσταβία", "en": "Gustavia, Saint Barthélemy", "es": "Gustavia", "fa": "گوستاویا", "fr": "Gustavia", "he": "גוסטביה", "id": "Gustavia", "it": "Gustavia", "ja": "グスタビア", "ko": "귀스타비아", "nl": "Gustavia", "pl": "Gustavia", "pt": "Gustávia", "ru": "Густавия", "sv": "Gustavia", "tr": "Gustavia", "uk": "Густавія", "ur": "گوسٹاویا", "vi": "Gustavia", "zh": "居斯塔维亚" }, "iso": "BL", "capital": true, "level": 4, "coords": [-62.850556, 17.897908, 0], "pop": [2670, 2670, 2670] },
		{ "qid": "Q200605", "name": { "ar": "ماريجوت", "de": "Marigot", "el": "Μαριγκό", "en": "Marigot, Saint Martin", "es": "Marigot", "fa": "ماریگو", "fr": "Marigot", "he": "מריגו", "hu": "Marigot", "id": "Marigot", "it": "Marigot", "ja": "マリゴ", "ko": "마리고", "nl": "Marigot", "pl": "Marigot", "pt": "Marigot", "ru": "Мариго", "sv": "Marigot", "tr": "Marigot, Saint Martin", "uk": "Маріго", "ur": "ماریگاٹ", "vi": "Marigot, Saint-Martin", "zh": "马里戈" }, "iso": "MF", "capital": true, "level": 4, "coords": [-63.0822, 18.0731, 5], "pop": [3672, 3672, 3672] },
		{ "qid": "Q185678", "name": { "ar": "سان بيير", "bn": "সাঁ-পিয়ের, সাঁ-পিয়ের এবং মিকলোঁ", "de": "Saint-Pierre", "el": "Σαιν-Πιερ", "en": "Saint-Pierre, Saint Pierre and Miquelon", "es": "San Pedro", "fa": "سن-پیر، سن-پیر و میکلون", "fr": "Saint-Pierre", "he": "סן-פייר", "hu": "Saint-Pierre", "id": "Saint-Pierre, Saint-Pierre dan Miquelon", "it": "Saint-Pierre", "ja": "サンピエール", "ko": "생피에르", "nl": "Saint-Pierre", "pl": "Saint-Pierre", "pt": "São Pedro", "ru": "Сен-Пьер", "sv": "Saint-Pierre", "tr": "Saint-Pierre, Saint Pierre ve Miquelon", "uk": "Сен-П'єр", "ur": "سین-پیری، سینٹ پیری و مقولون", "vi": "Saint-Pierre, Saint-Pierre và Miquelon", "zh": "圣皮埃尔" }, "iso": "PM", "capital": true, "level": 4, "coords": [-56.173611, 46.781667, 14], "pop": [5618, 5618, 5618] },
		{ "qid": "Q147738", "name": { "ar": "ساينت هيلير", "de": "Saint Helier", "el": "Σεντ Χέλιερ", "en": "St Helier", "es": "Saint Helier", "fa": "سن هلیه", "fr": "Saint-Hélier", "he": "סנט הלייר", "hu": "Saint Helier", "id": "Saint Helier, Jersey", "it": "Saint Helier", "ja": "セント・ヘリア", "ko": "세인트헬리어", "nl": "Saint Helier", "pl": "Saint Helier", "pt": "Santo Helério", "ru": "Сент-Хелиер", "sv": "Saint Helier", "tr": "Saint Helier", "uk": "Сент-Гелієр", "ur": "سینٹ ہیلیر", "vi": "Saint Helier", "zh": "圣赫利尔" }, "iso": "JE", "capital": true, "level": 4, "coords": [-2.11, 49.185833, 11], "pop": [33522, 33522, 33522] },
		{ "qid": "Q30958", "name": { "ar": "فيليبسبورغ", "de": "Philipsburg", "el": "Φίλιπσμπουργκ", "en": "Philipsburg, Sint Maarten", "es": "Philipsburg", "fa": "فیلیپسبورگ، سینت مارتن", "fr": "Philipsburg", "he": "פיליפסבורג", "id": "Philipsburg, Sint Maarten", "it": "Philipsburg", "ja": "フィリップスブルフ", "ko": "필립스뷔르흐", "nl": "Philipsburg", "pl": "Philipsburg", "pt": "Philipsburg", "ru": "Филипсбург", "sv": "Philipsburg", "tr": "Philipsburg, Sint Maarten", "uk": "Філіпсбург", "ur": "فلپسبرگ", "vi": "Philipsburg", "zh": "菲利普斯堡" }, "iso": "SX", "capital": true, "level": 4, "coords": [-63.0458, 18.0237, 7], "pop": [1327, 1327, 1327] },
		{ "qid": "Q30970", "name": { "ar": "جيمس تاون", "bn": "জেমসটাউন, সেইন্ট হেলেনা", "de": "Jamestown", "el": "Τζέιμσταουν", "en": "Jamestown, Saint Helena", "es": "Jamestown", "fa": "جیمزتاون", "fr": "Jamestown", "he": "ג'יימסטאון", "hi": "जेम्सटाउन, सेंट हेलेना", "hu": "Jamestown", "id": "Jamestown, Saint Helena", "it": "Jamestown", "ja": "ジェームズタウン", "ko": "제임스타운", "nl": "Jamestown", "pl": "Jamestown", "pt": "Jamestown", "ru": "Джеймстаун", "sv": "Jamestown, Sankta Helena", "tr": "Jamestown, Saint Helena", "uk": "Джеймстаун", "ur": "جیمز ٹاون، سینٹ ہلینا", "vi": "Jamestown, Saint Helena", "zh": "詹姆斯敦" }, "iso": "SH", "capital": true, "level": 4, "coords": [-5.718056, -15.924444, 13], "pop": [625, 625, 625] },
		{ "qid": "Q168652", "name": { "ar": "هرجيسا", "bn": "হারগেইসা", "de": "Hargeysa", "el": "Χαργκέισα", "en": "Hargeisa", "es": "Hargeisa", "fa": "هرجیسا", "fr": "Hargeisa", "he": "הרגייסה", "hu": "Hargeysa", "id": "Hargeisa", "it": "Hargheisa", "ja": "ハルゲイサ", "ko": "하르게이사", "nl": "Hargeisa", "pl": "Hargejsa", "pt": "Hargeisa", "ru": "Харгейса", "sv": "Hargeisa", "tr": "Hargeisa", "uk": "Харгейса", "ur": "ہرجيسا", "vi": "Hargeisa", "zh": "哈尔格萨" }, "iso": "B30", "capital": true, "level": 4, "coords": [44.0675, 9.563056, 1268], "pop": [1960000, 1960000, 1960000] },
		{ "qid": "Q656709", "name": { "ar": "نوكونونو", "de": "Nukunonu", "en": "Nukunonu", "es": "Nukunonu", "fa": "نوکونونو", "fr": "Nukunonu", "it": "Nukunonu", "ja": "ヌクノノ", "ko": "누쿠노누", "nl": "Nukunonu", "pl": "Nukunonu", "pt": "Nucunonu", "ru": "Нукунону", "sv": "Nukunonu", "tr": "Nukunonu", "uk": "Нукунону", "ur": "نوکونونو", "zh": "努庫諾努環礁" }, "iso": "TK", "capital": true, "level": 4, "coords": [-171.809722, -9.168333, 0], "pop": [426, 426, 426] },
		{ "qid": "Q43070", "name": { "ar": "دونيتسك", "bn": "দোনেৎস্ক", "de": "Donezk", "el": "Ντονέτσκ", "en": "Donetsk", "es": "Donetsk", "fa": "دونتسک", "fr": "Donetsk", "he": "דונצק", "hi": "डोनेट्स्क", "hu": "Doneck", "id": "Donetsk", "it": "Donec'k", "ja": "ドネツィク", "ko": "도네츠크", "nl": "Donetsk", "pl": "Donieck", "pt": "Donetsk", "ru": "Донецк", "sv": "Donetsk", "tr": "Donetsk", "uk": "Донецьк", "ur": "دونیتسک", "vi": "Donetsk", "zh": "頓涅茨克" }, "iso": "C02", "capital": true, "level": 4, "coords": [37.805278, 48.002778, 194], "pop": [975959, 975959, 975959] },
		{ "qid": "Q31026", "name": { "ar": "ضاحية يارين", "bn": "ইয়ারেন জেলা", "de": "Yaren", "el": "Γιαρέν", "en": "Yaren District", "es": "Distrito de Yaren", "fa": "یارن", "fr": "Yaren", "he": "יארן", "hi": "यारेन जिला", "hu": "Yaren", "id": "Yaren", "it": "Yaren", "ja": "ヤレン", "ko": "야렌구", "nl": "Yaren", "pl": "Yaren", "pt": "Iarém", "ru": "Ярен", "sv": "Yaren", "tr": "Yaren, Nauru", "uk": "Ярен", "ur": "یارن", "vi": "Yaren", "zh": "亞倫區" }, "iso": "NR", "capital": true, "level": 4, "coords": [166.925, -0.545556, 39], "pop": [803, 803, 803] },
		{ "qid": "Q30966", "name": { "ar": "الوفي", "de": "Alofi", "el": "Αλόφι", "en": "Alofi", "es": "Alofi", "fa": "الوفی", "fr": "Alofi", "he": "אלופי", "hu": "Alofi", "id": "Alofi", "it": "Alofi", "ja": "アロフィ", "ko": "알로피", "nl": "Alofi", "pl": "Alofi", "pt": "Alofi", "ru": "Алофи", "sv": "Alofi", "tr": "Alofi", "uk": "Алофі", "ur": "الوفی", "vi": "Alofi", "zh": "阿洛菲" }, "iso": "NU", "capital": true, "level": 4, "coords": [-169.919444, -19.054167, 25], "pop": [597, 597, 597] },
		{ "qid": "Q30963", "name": { "ar": "كينغستون", "bn": "কিংসটন, নরফোক দ্বীপ", "de": "Kingston", "el": "Κίνγκστον", "en": "Kingston, Norfolk Island", "es": "Kingston", "fa": "کینگستون", "fr": "Kingston", "he": "קינגסטון", "hi": "किंग्स्टन, नॉर्फ़ोक द्वीप", "id": "Kingston, Pulau Norfolk", "it": "Kingston", "ja": "キングストン", "ko": "킹스턴", "nl": "Kingston", "pl": "Kingston", "pt": "Kingston", "ru": "Кингстон", "tr": "Kingston, Norfolk Adası", "uk": "Кінгстон", "ur": "کنگسٹن", "vi": "Kingston, Đảo Norfolk", "zh": "金斯顿" }, "iso": "NF", "capital": true, "level": 4, "coords": [167.961944, -29.060556, 0], "pop": [880, 880, 880] },
		{ "qid": "Q48273", "name": { "ar": "آدمزتاون", "de": "Adamstown", "el": "Άνταμσταουν", "en": "Adamstown, Pitcairn Islands", "es": "Adamstown", "fa": "آدامستاون، جزایر پیت‌کرن", "fr": "Adamstown", "he": "אדמסטאון", "hu": "Adamstown", "id": "Adamstown", "it": "Adamstown", "ja": "アダムスタウン", "ko": "애덤스타운", "nl": "Adamstown", "pl": "Adamstown", "pt": "Adamstown", "ru": "Адамстаун", "sv": "Adamstown, Pitcairnöarna", "tr": "Adamstown", "uk": "Адамстаун", "ur": "ایڈمز ٹاؤن، جزائر پٹکیرن", "vi": "Adamstown, Quần đảo Pitcairn", "zh": "亚当斯敦" }, "iso": "PN", "capital": true, "level": 4, "coords": [-130.1, -25.066667, 92], "pop": [57, 57, 57] },
		{ "qid": "Q839559", "name": { "ar": "بورت أو فرانسيه", "de": "Port-aux-Français", "en": "Port-aux-Français", "es": "Port-aux-Français", "fr": "Port-aux-Français", "hu": "Port-aux-Français", "id": "Port-aux-Français", "it": "Port-aux-Français", "ja": "ポルトーフランセ", "nl": "Port-aux-Français", "pl": "Port-aux-Français", "pt": "Port-aux-Français", "ru": "Порт-о-Франсе", "sv": "Port-aux-Français", "tr": "Port-aux-Français", "uk": "Порт-о-Франсе", "zh": "法兰西港" }, "iso": "TF", "capital": true, "level": 4, "coords": [70.218889, -49.35, 7], "pop": [60, 60, 60] },
		{ "qid": "Q132676", "name": { "ar": "مامودزو", "bn": "মামুদজু", "de": "Mamoudzou", "el": "Μαμουντζού", "en": "Mamoudzou", "es": "Mamoudzou", "fa": "مامودزو", "fr": "Mamoudzou", "he": "מאמודזו", "id": "Mamoudzou", "it": "Mamoudzou", "ja": "マムズ", "ko": "마무주", "nl": "Mamoudzou", "pl": "Mamoudzou", "pt": "Mamudzu", "ru": "Мамуцу", "sv": "Mamoudzou", "tr": "Mamoudzou", "uk": "Мамудзу", "ur": "مامودزو", "vi": "Mamoudzou", "zh": "马穆楚" }, "iso": "YT", "capital": true, "level": 4, "coords": [45.2278, -12.7806, 38], "pop": [71437, 71437, 71437] },
		{ "qid": "Q30990", "name": { "ar": "بليموث", "de": "Plymouth", "el": "Πλίμουθ", "en": "Plymouth, Montserrat", "es": "Plymouth", "fa": "پلی‌موث، مونتسرات", "fr": "Plymouth", "he": "פלימות'", "id": "Plymouth, Montserrat", "it": "Plymouth", "ja": "プリマス", "ko": "플리머스", "nl": "Plymouth", "pl": "Plymouth", "pt": "Plymouth", "ru": "Плимут", "sv": "Plymouth, Montserrat", "tr": "Plymouth, Montserrat", "uk": "Плімут", "ur": "پلایماؤت، مانٹسریٹ", "vi": "Plymouth, Montserrat", "zh": "普利茅斯" }, "iso": "MS", "capital": true, "level": 4, "coords": [-62.215839, 16.706417, 40], "pop": [0, 0, 0] },
		{ "qid": "Q134279", "name": { "ar": "لوهانسك", "bn": "লুহানস্ক", "de": "Luhansk", "el": "Λουγκάνσκ", "en": "Luhansk", "es": "Lugansk", "fa": "لوهانسک", "fr": "Louhansk", "he": "לוהנסק", "hi": "लुहान्स्क", "hu": "Luhanszk", "id": "Luhansk", "it": "Luhans'k", "ja": "ルハーンシク", "ko": "루한스크", "nl": "Loehansk", "pl": "Ługańsk", "pt": "Lugansk", "ru": "Луганск", "sv": "Luhansk", "tr": "Luhansk", "uk": "Луганськ", "ur": "لوہانسک", "vi": "Luhansk", "zh": "卢甘斯克" }, "iso": "C03", "capital": true, "level": 4, "coords": [39.303056, 48.567778, 103], "pop": [445900, 445900, 445900] },
		{ "qid": "Q179431", "name": { "ar": "رود تاون", "de": "Road Town", "el": "Ρόουντ Τάουν", "en": "Road Town", "es": "Road Town", "fa": "رود تاون", "fr": "Road Town", "he": "רואוד טאון", "hu": "Road Town", "id": "Road Town", "it": "Road Town", "ja": "ロードタウン", "ko": "로드타운", "nl": "Road Town", "pl": "Road Town", "pt": "Road Town", "ru": "Род-Таун", "sv": "Road Town", "tr": "Road Town", "uk": "Род-Таун", "ur": "روڈ ٹاون", "vi": "Road Town", "zh": "罗德城" }, "iso": "VG", "capital": true, "level": 4, "coords": [-64.623056, 18.431389, 68], "pop": [12603, 12603, 12603] },
		{ "qid": "Q132572", "name": { "ar": "تيراسبول", "bn": "তিরাসপোল", "de": "Tiraspol", "el": "Τιράσπολ", "en": "Tiraspol", "es": "Tiráspol", "fa": "تیراسپل", "fr": "Tiraspol", "he": "טירספול", "hu": "Tiraszpol", "id": "Tiraspol", "it": "Tiraspol", "ja": "ティラスポリ", "ko": "티라스폴", "nl": "Tiraspol", "pl": "Tyraspol", "pt": "Tiraspol", "ru": "Тирасполь", "sv": "Tiraspol", "tr": "Tiraspol", "uk": "Тирасполь", "ur": "تیراسپول", "vi": "Tiraspol", "zh": "蒂拉斯波尔" }, "iso": "B36", "capital": true, "level": 4, "coords": [29.643333, 46.840278, 37], "pop": [127282, 127282, 127282] },
		{ "qid": "Q47837", "name": { "ar": "العيون", "bn": "লা-আয়ুন", "de": "El Aaiún", "el": "Λααγιούν", "en": "Laayoune", "es": "El Aaiún", "fa": "العیون", "fr": "Laâyoune", "he": "לעיון", "hu": "El-Ajún", "id": "El Aaiún", "it": "El Aaiún", "ja": "ラユーン", "ko": "엘아이운", "nl": "Al Ajoen", "pl": "Al-Ujun", "pt": "El Aiune", "ru": "Эль-Аюн", "sv": "El-Aaiún", "tr": "Layun", "uk": "Ель-Аюн", "ur": "العیون", "vi": "Laayoune", "zh": "阿尤恩" }, "iso": "EH", "capital": true, "level": 4, "coords": [-13.198889, 27.15, 73], "pop": [217732, 217732, 217732] },
		{ "qid": "Q47837", "name": { "ar": "العيون", "bn": "লা-আয়ুন", "de": "El Aaiún", "el": "Λααγιούν", "en": "Laayoune", "es": "El Aaiún", "fa": "العیون", "fr": "Laâyoune", "he": "לעיון", "hu": "El-Ajún", "id": "El Aaiún", "it": "El Aaiún", "ja": "ラユーン", "ko": "엘아이운", "nl": "Al Ajoen", "pl": "Al-Ujun", "pt": "El Aiune", "ru": "Эль-Аюн", "sv": "El-Aaiún", "tr": "Layun", "uk": "Ель-Аюн", "ur": "العیون", "vi": "Laayoune", "zh": "阿尤恩" }, "iso": "EHX", "capital": true, "level": 4, "coords": [-13.198889, 27.15, 73], "pop": [217732, 217732, 217732] },
		{ "qid": "Q79863", "name": { "ar": "تسخينفالي", "bn": "স্কিনভালি", "de": "Zchinwali", "el": "Τσχινβάλι", "en": "Tskhinvali", "es": "Tsjinvali", "fa": "تسخینوالی", "fr": "Tskhinvali", "he": "צחינוואלי", "hu": "Chinvali", "id": "Tskhinvali", "it": "Tskhinvali", "ja": "ツヒンヴァリ", "ko": "츠힌발리", "nl": "Tschinvali", "pl": "Cchinwali", "pt": "Tsequinváli", "ru": "Цхинвали", "sv": "Tschinvali", "tr": "Tshinvali", "uk": "Цхінвалі", "ur": "تسخینوالی", "vi": "Tskhinvali", "zh": "茨欣瓦利" }, "iso": "B37", "capital": true, "level": 4, "coords": [43.97, 42.225, 880], "pop": [30432, 30432, 30432] },
		{ "qid": "Q393878", "name": { "ar": "نقطة الملك إدوارد", "de": "King Edward Point", "el": "Κινγκ Έντουαρντ Πόιντ", "en": "King Edward Point", "es": "Punta Coronel Zelaya", "fa": "کینگ ادوارد پوینت", "fr": "King Edward Point", "he": "קינג אדוארד פוינט", "id": "King Edward Point", "it": "King Edward Point", "ja": "キング・エドワード・ポイント", "nl": "King Edward Point", "pl": "King Edward Point", "pt": "Cabo Rei Eduardo", "ru": "Кинг-Эдуард-Пойнт", "sv": "King Edward Point", "tr": "King Edward Point", "uk": "Кінг-Едвард-Пойнт", "ur": "کنگ ایڈورڈ پوائنٹ", "zh": "爱德华国王角" }, "iso": "GS", "capital": true, "level": 4, "coords": [-36.495, -54.283333, 1], "pop": [20, 20, 20] },
		{ "qid": "Q51681", "name": { "ar": "شارلوت أمالي", "de": "Charlotte Amalie", "el": "Σαρλότ Αμαλί", "en": "Charlotte Amalie, U.S. Virgin Islands", "es": "Charlotte Amalie", "fa": "شارلوت آمالی", "fr": "Charlotte-Amélie", "he": "שארלוט אמאלי", "hu": "Charlotte Amalie", "id": "Charlotte Amalie", "it": "Charlotte Amalie", "ja": "シャーロット・アマリー", "ko": "샬럿아말리에", "nl": "Charlotte Amalie", "pl": "Charlotte Amalie", "pt": "Charlotte Amalie", "ru": "Шарлотта-Амалия", "sv": "Charlotte Amalie", "tr": "Charlotte Amalie, Amerika Birleşik Devletleri Virjin Adaları", "uk": "Шарлотта-Амалія", "ur": "شارلٹ ایملی", "vi": "Charlotte Amalie, Quần đảo Virgin thuộc Mỹ", "zh": "夏洛特阿马利亚" }, "iso": "VI", "capital": true, "level": 4, "coords": [-64.95, 18.35, 235], "pop": [10354, 10354, 10354] },
		{ "qid": "Q3856", "name": { "ar": "نيقوسيا", "bn": "নিকোসিয়া", "de": "Nikosia", "el": "Λευκωσία", "en": "Nicosia", "es": "Nicosia", "fa": "نیکوزیا", "fr": "Nicosie", "he": "ניקוסיה", "hi": "निकोसिया", "hu": "Nicosia", "id": "Nikosia", "it": "Nicosia", "ja": "ニコシア", "ko": "니코시아", "nl": "Nicosia", "pl": "Nikozja", "pt": "Nicósia", "ru": "Никосия", "sv": "Nicosia", "tr": "Lefkoşa", "uk": "Нікосія", "ur": "نیکوسیا", "vi": "Nicosia", "zh": "尼科西亚" }, "iso": "B20", "capital": true, "level": 4, "coords": [33.365, 35.1725, 144], "pop": [310355, 310355, 310355] }]);
	const tub = {};
	a.forEach(json => {
		const iso = json.iso;
		tub[iso] = tub[iso] || [];
		tub[iso].push(json);
	});
	await d3.thenEach(nations, async q => {
		var iso = q.iso ? q.iso[0] : null;
		if (iso && q.capital) {
			var a = (tub[iso] || []).filter(t => t.capital).map(t => t.name.ja).join("|");
			q.capital.name.ja == a || console.log(iso, q.name.ja, q.capital.name.ja, a || "***")
		}
	});
	var no_qid = a.filter((t, i) => !t.qid);
	const qids_en = await d3.wiki.title2qid(no_qid.map(t => t.name.en), "en");
	const qids_fr = await d3.wiki.title2qid(no_qid.map(t => t.name.fr), "fr");
	const qids_es = await d3.wiki.title2qid(no_qid.map(t => t.name.es), "es");
	const qids_ja = await d3.wiki.title2qid(no_qid.map(t => t.name.ja), "ja");
	no_qid.forEach((t, i) => t.qid = qids_en[i] || qids_fr[i] || qids_es[i] || qids_ja[i]);
	console.log(a.filter((t, i) => !t.qid).map(t => [t.name.ja, t.name.en]));
	#inline("1b3MCcgb");
	const yomi_map = {}; yomi_array.forEach(t => yomi_map[t[0]] = t[1]);
	const kanji_map = {}; yomi_array.forEach(t => (kanji_map[t[1]] = kanji_map[t[1]] || [], kanji_map[t[1]].push(t[0])));
	for (let t in kanji_map) { kanji_map[t].length == 1 ? kanji_map[t] = kanji_map[t][0] : delete kanji_map[t]; }
	a.forEach(async t => {
		kanji_map[t.name.ja] && console.log(t.name.ja = kanji_map[t.name.ja] + "(" + t.name.ja + ")");
		yomi_map[t.name.ja] && console.log(t.name.ja = t.name.ja + "(" + yomi_map[t.name.ja] + ")");
		//if (!(t.yomi||t.name.ja).match(/^[ァ-ンヴー]/)) console.warn("読み", t.name.ja, t.yomi);
	});


	await saveObject(name, a);

	//	const idb = await cache("city");
	//	await d3.thenEach(Object.entries(tub), ([k,v])=>idb(k, v));
}
async function upload_road() {
	const name = "ne_10m_roads";
	var json = await naturalEarth(name);
	var lines = json.features.filter(t => t.properties.featurecla == "Road")
		.map(t => {
			var type = t.geometry.type, coords = t.geometry.coordinates;
			return type == "MultiLineString" ? coords : [coords];
		}).flat();
	const nation = await cache("nation");
	var v = await nation("iso");
	v = await d3.thenMap(v, async q => {
		const id = q.properties.id;
		const B = turf.bbox(q);
		const check = t => geoContains(q, t);
		const cut = a => {
			const b = turf.bbox(turf.lineString(a));
			if (b[0] > B[2] || b[1] > B[3] || b[2] < B[0] || b[3] < B[1]) return null;
			const start = check(a[0]), end = check(a[a.length - 1]);
			if (!start && !end) return null;
			if (!start) while (!check(a[1])) a.shift();
			if (!end) while (!check(a[a.length - 2])) a.pop();
			return a;
		};
		const line = lines.map(cut).filter(t => t);
		console.log(id, line.length);
		return turf.multiLineString(line, { id });
	}).catch(console.error);
	await saveObject(name, v);
}
async function upload_rail() {
	const name = "ne_10m_railroads";
	var json = await naturalEarth(name);
	var lines = json.features.map(t => {
		var type = t.geometry.type, coords = t.geometry.coordinates;
		return type == "MultiLineString" ? coords : [coords];
	}).flat();
	const nation = await cache("nation");
	var v = await nation("iso");
	v = await d3.thenMap(v, async q => {
		const id = q.properties.id;
		const B = turf.bbox(q);
		const check = t => geoContains(q, t);
		const cut = a => {
			const b = turf.bbox(turf.lineString(a));
			if (b[0] > B[2] || b[1] > B[3] || b[2] < B[0] || b[3] < B[1]) return null;
			const start = check(a[0]), end = check(a[a.length - 1]);
			if (!start && !end) return null;
			if (!start) while (!check(a[1])) a.shift();
			if (!end) while (!check(a[a.length - 2])) a.pop();
			return a;
		};
		const line = lines.map(cut).filter(t => t);
		console.log(id, line.length);
		return turf.multiLineString(line, { id });
	}).catch(console.error);
	await saveObject(name, v);
}
async function upload_urbun() {
	const exec = await fetch("https://raw.githubusercontent.com/mfogel/polygon-clipping/refs/heads/main/dist/polygon-clipping.umd.js");
	eval(await exec.text());
	const name = "ne_50m_urban_areas";
	var json = await naturalEarth(name);
	var polys = json.features.map(t => {
		var type = t.geometry.type, coords = t.geometry.coordinates;
		return type == "MultiPolygon" ? coords : [coords];
	}).flat();
	console.log(polys)
	const nation = await cache("nation");
	var v = await nation("iso");
	v = await d3.thenMap(v, async q => {
		const id = q.properties.id;
		const B = turf.bbox(q);
		var v = polys.filter(t => {
			const b = turf.bbox(turf.polygon(t));
			return !(b[0] > B[2] || b[1] > B[3] || b[2] < B[0] || b[3] < B[1]);
		});
		v = v.map(t => polygonClipping.intersection(t, q.geometry.coordinates)).filter(t => t.length).flat();
		console.log(id, v.length);
		return toClockwise(turf.multiPolygon(v, { id: q.properties.id }));
	}).catch(console.error);
	await saveObject(name, v);
}
async function upload_ocean() {
	const name = "ne_10m_geography_marine_polys";
	var json = await naturalEarth(name);
	json = reductFeatures(json.features, 1e4);
	json = json.map(t => {
		var p = t.properties, g = t.geometry;
		var prop = { name: {} };
		langs.forEach(t => prop.name[t] = p["name_" + t]);
		if (g.type == "Polygon") g.coordinates = [g.coordinates[0]];
		else if (g.type == "MultiPolygon") g.coordinates = g.coordinates.map(t => [t[0]]);
		else console.error(g)
		p.wikidataid && (prop.qid = p.wikidataid);
		if (!prop.name.en) console.log(prop.name, g);
		t.properties = prop;
		delete t.bbox;
		return t;
	}).filter(t => t.properties.name.en);
	bucket.download("ocean.json", turf.featureCollection(json));
	console.log(turf.featureCollection(json))
	await saveObject(name, json);
}
async function upload_lake() {
	const name = "ne_10m_lakes";
	var json = await naturalEarth(name);
	json = reductFeatures(json.features, 1e4);
	console.log(json)
	json = json.map(t => {
		var p = t.properties, g = t.geometry;
		var prop = { name: {} };
		langs.forEach(t => prop.name[t] = p["name_" + t]);
		p.wikidataid && (prop.qid = p.wikidataid);
		if (!prop.name.en) console.log(prop.name, g);
		prop.area = turf.area(t) / 1e6;
		prop.bbox = turf.bbox(t);
		t.properties = prop;
		delete t.bbox;
		return t;
	}).filter(t => t.properties.name.en && t.properties.qid && t.properties.area > 100).sort((p, q) => p.properties.area > q.properties.area ? -1 : 1);
	bucket.download("lake.json", turf.featureCollection(json));
	console.log(turf.featureCollection(json))
	await saveObject(name, json);
}
async function upload_river() {
	const name = "ne_10m_rivers_lake_centerlines_scale_rank";
	var json = await naturalEarth(name);
	const tub = {};
	json.features.filter(t => t.properties.wikidataid/*&&t.properties.featurecla=="River"*/).forEach(t => {
		var p = t.properties;
		(tub[p.wikidataid] = tub[p.wikidataid] || []).push(t);
	});
	json = Object.values(tub).map(a => {
		var c = a.map(u => {
			const g = u.geometry;
			return g.type == "MultiLineString" ? g.coordinates : g.type == "LineString" ? [g.coordinates] : [];
		}).flat();
		const p = a[0].properties, prop = { name: {} };
		c = turf.multiLineString(c, prop);
		langs.forEach(t => prop.name[t] = p["name_" + t]);
		prop.level = d3.min(a.map(t => t.properties.scalerank));
		prop.qid = p.wikidataid;
		prop.bbox = turf.bbox(c);
		prop.length = Math.round(turf.length(c));
		return c;
	})
	console.log(json);
	bucket.download("river.json", turf.featureCollection(json));
	await saveObject(name, json);
}
async function upload_mountain() {
	const name = "List_of_mountain_peaks_by_prominence";
	var v = await bucket.fetchHTML("https://en.wikipedia.org/wiki/" + name);
	v = [...d3.select(v).selectAll("tr")].map(t => [...t.querySelectorAll("td")]);
	var v10 = v.filter(t => t.length == 10).map(t => ({
		name: t[1].querySelector("a").innerText,
		title: t[1].querySelector("a").title,
		mountains: t[2].querySelector("a").innerText,
		coords: t[4].querySelector("span.geo").innerText.split(";").reverse().map(t => +t),
		prominence: +(t[5].innerText).replace(/,/g, ""),
		height: +(t[6].innerText).replace(/,/g, "")
	}));
	var v6 = v.filter(t => t.length == 6).map(t => ({
		name: t[0].querySelector("a").innerText,
		title: t[0].querySelector("a").title,
		height: +(t[2].innerText).replace(/,/g, ""),
		prominence: +(t[3].innerText).replace(/,/g, "")
	}));
	const coords = await d3.wiki.title2coords(v6.map(t => t.title), "en");
	v6.forEach((t, i) => t.coords = coords[i]);
	v = [].concat(v10, v6);
	const qids = await d3.wiki.title2qid(v.map(t => t.title), "en");
	v.forEach((t, i) => t.qid = qids[i]);
	await d3.thenEach(v, async t => t.name = await d3.wiki.qid2titles(t.qid));
	v = v.map(t => turf.point(t.coords, { type: "mountain", name: t.name, qid: t.qid, height: t.height, prominence: t.prominence }));
	//	bucket.download("List_of_mountain_peaks_by_prominence.json", v);
	await saveObject(name, v);
}
async function upload_climate() {
	var tub = {};
	var temp = await temperature();
	var prec = await precipitation();
	temp.forEach(t => tub[t.qid] = { qid: t.qid, city: t.city, nation: t.nation, temparature: t.temparature });
	prec.filter(t => tub[t.qid]).forEach(t => tub[t.qid].precipitation = t.precipitation);
	tub = Object.values(tub).filter(t => t.precipitation);
	console.log(tub)
	await saveObject("List_of_cities_by_climate", tub);

	async function temperature() {
		const name = "List_of_cities_by_average_temperature";
		var v = await bucket.fetchHTML("https://en.wikipedia.org/wiki/" + name);
		v = [...d3.select(v).selectAll("tr")].map(t => [...t.querySelectorAll("td")]).filter(t => t.length == 16);
		v = v.map(t => {
			var a = t.slice(2, 14).map(u => +u.innerText.split("(")[0]);
			return { city: t[1].querySelector("a").title, nation: t[0].querySelector("a").title, temparature: a };
		});
		var qids = await d3.wiki.title2qid(v.map(t => t.city), "en");
		v.forEach((t, i) => t.qid = qids[i]);
		return v;
	}
	async function precipitation() {
		const name = "List_of_cities_by_average_precipitation";
		var v = await bucket.fetchHTML("https://en.wikipedia.org/wiki/" + name);
		v = [...d3.select(v).selectAll("tr")].map(t => [...t.querySelectorAll("td")]).filter(t => t.length == 16);
		v = v.filter(t => t[0].querySelector("a")).map(t => {
			var a = t.slice(3, 15).map(u => +u.innerText.split("(")[0]);
			return { city: t[0].querySelector("a").title, precipitation: a };
		});
		var qids = await d3.wiki.title2qid(v.map(t => t.city), "en");
		v.forEach((t, i) => t.qid = qids[i]);
		v = v.filter(t => t.qid)
		return v;
	}
}
async function createGeometryPNG() {
	const ndb = await loadNationDB();
	const cache = await cache("nation");
	if (!(await cache("iso"))) { await admin(); }
	const geo_tub = {};
	const iso_json = await cache("nation");
	const dis_json = await cache("disputed");
	iso_json.forEach(t => geo_tub[t.properties.id] = t);
	dis_json.forEach(t => geo_tub[t.properties.BRK_A3] = t);
	////-----------------------------------------------------
	const size = 256, width = size, height = size, margin = 0.05;
	const canvas = new d3.staticOrthoMap(width, height, 2);
	const files = await d3.thenMap(ndb, async t => {
		var geo = (t.iso ? [t.iso[0]] : t.sovereignt || t.claim).map(t => geo_tub[t]);
		geo = (geo.length == 1) ? geo[0] : d3.mergeFeatures(geo);
		const coords = d3.geoCentroid(geo);
		const proj = d3.geoOrthographic().rotate([-coords[0], -coords[1], 0])
			.fitExtent([[width * margin, height * margin], [width * (1 - margin), height * (1 - margin)]], geo);
		proj.scale(Math.min(proj.scale(), 10000));
		canvas.fill("#cff");
		canvas.json(proj, iso_json, { fill: "#ffc", stroke: "#440", width: 1, noFilter: t.pole });
		canvas.json(proj, geo, { fill: "#040", noFilter: true });
		(t.sovereignt || []).forEach(id => canvas.json(proj, geo_tub[id], { fill: "#280", noFilter: true }));
		(t.claim || []).forEach(id => canvas.json(proj, geo_tub[id], { fill: "#f40", noFilter: true }));
		console.log(t.name.ja, t.iso, t.sovereignt, t.claim);
		return new File([await canvas.png()], t.name.ja + ".png", { type: "image/png" });
	});
	canvas.destroy();
	await saveGeoPNG(files);
	console.log(await loadGeoPNG());
}
