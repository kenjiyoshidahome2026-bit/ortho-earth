import { GeoPBF } from "../pbf.js";
import { gint } from "../extension/gint.js";
import { comma } from "common"; 
onmessage = async (e) => {
    try { //debugger
		const { buf, gintbuf, opts } = e.data;
		const self = (await new GeoPBF().set(buf)).setGintBUF(gintbuf);
		let { polygonCount, polylineCount, pointCount, nodeCount, arcCount, bbox } = self.unPackGint;
		bbox = [...gint.intToVal([bbox[0], bbox[1]]), ...gint.intToVal([bbox[2], bbox[3]])];
		const br = "-".repeat(50);
		let str = []; const countArr = [0, 0, 0, 0, 0, 0, 0, 0];
		self.each((i, fmap) => countArr[fmap[2]]++);
		const types = countArr.map((n, i) => n ? `#${GeoPBF.geometryTypes[i]}: ${comma(n)}` : ``).filter(t => t);
		str.push(br);
		self._name && str.push(` NAME: ${self._name}`);
		self._description && str.push(` DESCRIPTION: ${self._description}`);
		self._attribution && str.push(` ATTRIBUTION: ${self._attribution}`);
		self._license && str.push(` LICENSE: ${self._license}`);
		str.push(` FILE SIZE: ${comma(self._fileSize||await self.fileSize())} [bytes]`);
		str.push(` FEATURES: ${comma(self.length)} ( ${types.join(" , ")} )`);
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
		self.props.forEach((t) => t.forEach((s, j) => { if (s !== undefined) a[j].push(s); }));
		a.forEach((values, i) => {
			var typeStr = typesort(values.map(t => GeoPBF.dataType(t))).map(t => `${GeoPBF.dataTypeNames[t[0]]}:${t[1]}`).join("|");
			str.push(` ${self.keys[i]}: ${typeStr}`);
		});
		str.push(br);
		postMessage(str.join("\n") + "\n");
	} catch (err) { postMessage(null); }
};