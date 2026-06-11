import { GeoPBF } from "../pbf.js";
import { gint } from "../extension/gint.js";
import { comma } from "common"; 
onmessage = async (e) => {
    try {
		const { buf, gintbuf, opts } = e.data;
		const self = (await new GeoPBF().set(buf)).setGintBUF(gintbuf);
		let { polygonCount, polylineCount, pointCount, nodeCount, arcCount, bbox, polygon, polyline, point } = self.unPackGint;
		const struct = {};
		[point, polyline, polygon].forEach((layer, type) => (layer || []).forEach(([id, arcs]) => {
			struct[id] = struct[id] || [0, 0, 0];
			struct[id][type] = arcs.length;
		}));
		const ids = Object.keys(struct).map(t => Number(t));
		const counts = Object.values(struct);
		const countArr = [0, 0, 0, 0, 0, 0, 0, 0];
		counts.forEach(t => {
			if (t[0] && !t[1] && !t[2]) countArr[t[0] > 1 ? 1 : 0]++;
			else if (!t[0] && t[1] && !t[2]) countArr[t[1] > 1? 3: 2]++;
			else if (!t[0] && !t[1] && t[2]) countArr[t[2] > 1 ? 5 : 4]++;
			else countArr[6]++;
		});
		const br = "-".repeat(50);
		let str = [];
		const types = countArr.map((n, i) => n ? `#${GeoPBF.geometryTypes[i]}: ${comma(n)}` : ``).filter(t => t);
		str.push(br);
		self._name && str.push(` NAME: ${self._name}`);
		self._description && str.push(` DESCRIPTION: ${self._description}`);
		self._attribution && str.push(` ATTRIBUTION: ${self._attribution}`);
		self._license && str.push(` LICENSE: ${self._license}`);
		str.push(` FILE SIZE: ${comma(await self.fileSize())} [bytes]`);
		str.push(` FEATURES: ${comma(ids.length)} ( ${types.join(" , ")} )`);
		str.push(` PRECISION: ${self._precision} [${1 / self.e}]`);
		str.push(` BBOX: ${JSON.stringify(bbox)}`);
		str.push(br, ` GEOMETRY SECTION`, br);
		str.push(` # POINT: ${comma(pointCount)} # LINE: ${comma(polylineCount)} # POLYGON: ${comma(polygonCount)}`)
		str.push(` # TOTAL ARCS: ${comma(arcCount)}`);
		str.push(` # TOTAL COORDINATES: ${comma(nodeCount)}`);
		str.push(br, ` PROPERTIES SECTION (${self.keys.length} properties)`, br);
		const typesort = a => {
			const q = {}; a.forEach(t => q[t] = (q[t] || 0) + 1);
			const c = Object.entries(q).sort((p, q) => q[1] - p[1]);
			return (c.length == 2 && GeoPBF.dataTypeNames[c[0][0]] == "FLOAT" && GeoPBF.dataTypeNames[c[1][0]] == "INTEGER") ? [[c[0][0], (c[0][1] + c[1][1])]] : c;
		};
		var a = Array.from({ length: self.keys.length }, () => []);
		ids.forEach(id => self.props[id].forEach((t, j) => t === undefined || a[j].push(t)));
		a.forEach((values, i) => {
			var typeStr = typesort(values.map(t => GeoPBF.dataType(t))).map(t => `${GeoPBF.dataTypeNames[t[0]]}:${t[1]}`).join("|");
			str.push(` ${self.keys[i]}: ${typeStr}`);
		});
		str.push(br);
		postMessage(str.join("\n") + "\n");
	} catch (err) { postMessage(null); }
};