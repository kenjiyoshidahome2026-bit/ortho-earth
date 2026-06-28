import { GeoPBF } from "../pbf-base.js";
const enc = new TextEncoder();
const escXML = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

onmessage = async (e) => {
	const { buf, name, opts } = e.data, gz = opts && opts.gz;
	try {
		const pbf = await new GeoPBF().name(name).set(buf);
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const out = gz ? readable.pipeThrough(new CompressionStream("gzip")) : readable;
		const bPromise = new Response(out).blob();

		(async () => {
			await writer.write(enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="WhiteEarth">\n'));

			for (let i = 0, len = pbf.length; i < len; i++) {
				const f = pbf.getFeature(i);
				const { type, coordinates: c } = f.geometry;
				const p = f.properties;

				if (type === "Point") {
					let wpt = `<wpt lat="${c[1]}" lon="${c[0]}">\n`;
					if (p.name != null) wpt += `  <name>${escXML(p.name)}</name>\n`;
					if (p.desc != null) wpt += `  <desc>${escXML(p.desc)}</desc>\n`;
					if (p.ele != null) wpt += `  <ele>${p.ele}</ele>\n`;
					if (p.time != null) wpt += `  <time>${escXML(p.time)}</time>\n`;
					if (p.type != null) wpt += `  <type>${escXML(p.type)}</type>\n`;
					wpt += `</wpt>\n`;
					await writer.write(enc.encode(wpt));
				} else if (type === "LineString" || type === "MultiLineString") {
					// Each coordinate array of a MultiLineString maps to a separate trkseg.
					const segs = type === "MultiLineString" ? c : [c];
					let trk = `<trk>\n`;
					if (p.name != null) trk += `  <name>${escXML(p.name)}</name>\n`;
					if (p.desc != null) trk += `  <desc>${escXML(p.desc)}</desc>\n`;
					if (p.type != null) trk += `  <type>${escXML(p.type)}</type>\n`;
					await writer.write(enc.encode(trk));
					for (const seg of segs) {
						let segStr = `  <trkseg>\n`;
						for (const [lon, lat] of seg) segStr += `    <trkpt lat="${lat}" lon="${lon}" />\n`;
						segStr += `  </trkseg>\n`;
						await writer.write(enc.encode(segStr));
					}
					await writer.write(enc.encode(`</trk>\n`));
				}
			}

			await writer.write(enc.encode('</gpx>'));
			await writer.close();
		})();

		const b = await bPromise;
		postMessage(new File([b], `${name}.gpx${gz ? ".gz" : ""}`, { type: "application/gpx+xml" }));
	} catch (err) { postMessage(null); }
};
