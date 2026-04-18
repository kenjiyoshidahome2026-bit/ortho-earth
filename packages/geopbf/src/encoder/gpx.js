import { GeoPBF } from "../pbf-base.js"; //
const enc = new TextEncoder();

self.onmessage = async (e) => {
	const { buf, name, gz } = e.data;
	try {
		const pbf = await new GeoPBF().name(name).set(buf);
		const { readable, writable } = new TransformStream(); //
		const writer = writable.getWriter();
		const out = gz ? readable.pipeThrough(new CompressionStream("gzip")) : readable;
		const bPromise = new Response(out).blob();

		(async () => {
			await writer.write(enc.encode('<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="WhiteEarth">\n<trk><trkseg>\n'));

			for (let i = 0, len = pbf.length; i < len; i++) {
				const f = pbf.getFeature(i);
				if (f.geometry.type === "LineString") {
					for (const [lon, lat] of f.geometry.coordinates) {
						await writer.write(enc.encode(`<trkpt lat="${lat}" lon="${lon}" />\n`));
					}
				}
			}

			await writer.write(enc.encode('</trkseg></trk>\n</gpx>'));
			await writer.close();
		})();

		const b = await bPromise;
		self.postMessage(new File([b], `${name}.gpx${gz ? ".gz" : ""}`, { type: "application/gpx+xml" })); //
	} catch (err) { self.postMessage(null); }
};