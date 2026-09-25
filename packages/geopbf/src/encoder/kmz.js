import { GeoPBF } from "../pbf-base.js";
import { encodeZIP } from "../modules/encodeZIP.js";

import { escXML } from "../modules/xml.js";

// Convert a web color (#RRGGBB) or [r,g,b] array to KML format (aabbggrr).
const toKMLColor = (c, opacity = 1) => {
	const a = Math.round(opacity * 255).toString(16).padStart(2, '0');
	if (Array.isArray(c)) {
		return a + c[2].toString(16).padStart(2, '0') + c[1].toString(16).padStart(2, '0') + c[0].toString(16).padStart(2, '0');
	}
	const hex = c.replace('#', '');
	const r = hex.substring(0, 2), g = hex.substring(2, 4), b = hex.substring(4, 6);
	return a + b + g + r;
};

onmessage = async (e) => {
	const { buf, name, opts } = e.data, kmz = opts && opts.kmz !== undefined ? opts.kmz : true;
	try {
		const pbf = await new GeoPBF().name(name).set(buf);
		const embeddedFiles = [];
		// 逐次書き出し（gpx/geojson と同じ TransformStream 流儀）＝全文を 1 本の JS 文字列（UTF-16・2 倍）で抱えない
		const enc = new TextEncoder();
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const bPromise = new Response(readable).blob();
		(async () => {
			let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n`;

			// Shared style definition (batching styles saves memory).
			kml += `  <Style id="defaultStyle">\n    <LineStyle><color>ff0000ff</color><width>2</width></LineStyle>\n    <PolyStyle><color>400000ff</color></PolyStyle>\n  </Style>\n`;
			await writer.write(enc.encode(kml));

			// Coordinates in KML are longitude,latitude,altitude.
			const pos = pt => `${pt[0]},${pt[1]},0`;
			const posList = r => r.map(pos).join(" ");
			// 幾何（2026-09-25・B9）：Multi 系と GeometryCollection は KML の MultiGeometry で（旧＝幾何なしの Placemark になった）
			const polyKML = (c, ind) => `${ind}<Polygon>\n` + c.map((r, j) => {
				const t = j === 0 ? "outerBoundaryIs" : "innerBoundaryIs";
				return `${ind}  <${t}><LinearRing><coordinates>${posList(r)}</coordinates></LinearRing></${t}>\n`;
			}).join("") + `${ind}</Polygon>\n`;
			const geomKML = (g, ind) => {
				if (!g) return "";
				const { type, coordinates: c } = g;
				if (type === "Point") return `${ind}<Point><coordinates>${pos(c)}</coordinates></Point>\n`;
				if (type === "LineString") return `${ind}<LineString><coordinates>${posList(c)}</coordinates></LineString>\n`;
				if (type === "Polygon") return polyKML(c, ind);
				const parts = type === "MultiPoint" ? c.map(p => ({ type: "Point", coordinates: p }))
					: type === "MultiLineString" ? c.map(l => ({ type: "LineString", coordinates: l }))
					: type === "MultiPolygon" ? c.map(pg => ({ type: "Polygon", coordinates: pg }))
					: type === "GeometryCollection" ? g.geometries : null;
				return parts ? `${ind}<MultiGeometry>\n${parts.map(m => geomKML(m, ind + "  ")).join("")}${ind}</MultiGeometry>\n` : "";
			};
			for (let i = 0, len = pbf.length; i < len; i++) {
				const f = pbf.getFeature(i);
				const { color, fillOpacity, iconData, iconName } = f.properties;

				kml = `  <Placemark>\n    <name>${escXML(f.id ?? i)}</name>\n`;

				if (color) {
					const kmlColor = toKMLColor(color, fillOpacity || 1);
					kml += `    <Style><LineStyle><color>${kmlColor}</color></LineStyle><PolyStyle><color>${kmlColor}</color></PolyStyle></Style>\n`;
				} else {
					kml += `    <styleUrl>#defaultStyle</styleUrl>\n`;
				}

				if (iconData && iconName) {
					const iconPath = `files/${iconName}`;
					kml += `    <Style><IconStyle><Icon><href>${escXML(iconPath)}</href></Icon></IconStyle></Style>\n`;
					// Retain Blob/ArrayBuffer icon data so it can be bundled into the ZIP later.
					embeddedFiles.push(new File([iconData], iconPath));
				}

				kml += `    <ExtendedData>\n`;
				for (const [k, v] of Object.entries(f.properties)) {
					if (['iconData', 'iconName'].includes(k)) continue;
					// Date は ISO 8601・入れ子（object/配列）は JSON 文字列（旧＝落ちた・2026-09-25・B9）。バイナリは書かない
					const text = v == null || (typeof Blob !== "undefined" && v instanceof Blob) || ArrayBuffer.isView(v) ? null
						: v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
					if (text !== null) kml += `      <Data name="${escXML(k)}"><value>${escXML(text)}</value></Data>\n`;
				}
				kml += `    </ExtendedData>\n`;

				kml += geomKML(f.geometry, "    ");
				kml += `  </Placemark>\n`;
				await writer.write(enc.encode(kml));
			}
			await writer.write(enc.encode(`</Document>\n</kml>`));
			await writer.close();
		})().catch(err => writer.abort(err));

		const kmlFile = new File([await bPromise], `doc.kml`, { type: "application/vnd.google-earth.kml+xml" });

		if (kmz) {
			// Package as KMZ: bundle doc.kml together with any files/ entries.
			const zip = await encodeZIP([kmlFile, ...embeddedFiles], `${name}.kmz`);
			postMessage(zip);
		} else {
			postMessage(kmlFile);
		}
	} catch (err) { postMessage(null); }
};
