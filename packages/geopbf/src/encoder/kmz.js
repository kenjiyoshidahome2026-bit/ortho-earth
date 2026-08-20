import { GeoPBF } from "../pbf-base.js";
import { encodeZIP } from "../modules/encodeZIP.js";

const escXML = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

		let kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n`;

		// Shared style definition (batching styles saves memory).
		kml += `  <Style id="defaultStyle">\n    <LineStyle><color>ff0000ff</color><width>2</width></LineStyle>\n    <PolyStyle><color>400000ff</color></PolyStyle>\n  </Style>\n`;

		for (let i = 0, len = pbf.length; i < len; i++) {
			const f = pbf.getFeature(i);
			const { type, coordinates: c } = f.geometry;
			const { color, fillOpacity, iconData, iconName } = f.properties;

			kml += `  <Placemark>\n    <name>${escXML(f.id ?? i)}</name>\n`;

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
				if (v !== null && typeof v !== 'object' && !['iconData', 'iconName'].includes(k)) {
					kml += `      <Data name="${escXML(k)}"><value>${escXML(v)}</value></Data>\n`;
				}
			}
			kml += `    </ExtendedData>\n`;

			// Coordinates in KML are longitude,latitude,altitude.
			const pos = pt => `${pt[0]},${pt[1]},0`;
			const posList = r => r.map(pos).join(" ");
			if (type === "Point") kml += `    <Point><coordinates>${pos(c)}</coordinates></Point>\n`;
			else if (type === "LineString") kml += `    <LineString><coordinates>${posList(c)}</coordinates></LineString>\n`;
			else if (type === "Polygon") {
				kml += `    <Polygon>\n`;
				c.forEach((r, j) => {
					const t = j === 0 ? "outerBoundaryIs" : "innerBoundaryIs";
					kml += `      <${t}><LinearRing><coordinates>${posList(r)}</coordinates></LinearRing></${t}>\n`;
				});
				kml += `    </Polygon>\n`;
			}
			kml += `  </Placemark>\n`;
		}
		kml += `</Document>\n</kml>`;

		const kmlFile = new File([kml], `doc.kml`, { type: "application/vnd.google-earth.kml+xml" });

		if (kmz) {
			// Package as KMZ: bundle doc.kml together with any files/ entries.
			const zip = await encodeZIP([kmlFile, ...embeddedFiles], `${name}.kmz`);
			postMessage(zip);
		} else {
			postMessage(kmlFile);
		}
	} catch (err) { postMessage(null); }
};
