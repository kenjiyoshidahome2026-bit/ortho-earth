import { GeoPBF } from "../pbf-base.js";
const enc = new TextEncoder();

onmessage = async (e) => {
	const { buf, name, opts } = e.data, gz = opts && opts.gz;
	try {
		const pbf = await new GeoPBF().name(name).set(buf);
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		const out = gz ? readable.pipeThrough(new CompressionStream("gzip")) : readable;
		const promise = new Response(out).blob();

		(async () => {
			await writer.write(enc.encode('{"type":"FeatureCollection","features":[\n'));
			let first = true;
			for (let i = 0, len = pbf.length; i < len; i++) {
				let f;
				try {
					f = pbf.getFeature(i);
				} catch (err) {
					console.warn(`GeoPBF: Feature[${i}] could not be converted and was skipped.`, err);
					continue;
				}
				const g = f.geometry;
				if (g != null && g.type !== "GeometryCollection" && !Array.isArray(g.coordinates)) {
					console.warn(`GeoPBF: Feature[${i}] has invalid geometry (coordinates missing) and was skipped.`);
					continue;
				}
				const s = (first ? "" : ",\n") + JSON.stringify({ type: "Feature", geometry: g ?? null, properties: f.properties });
				first = false;
				await writer.write(enc.encode(s));
			}
			await writer.write(enc.encode('\n]}'));
			await writer.close();
		})();

		const b = await promise;
		postMessage(new File([b], `${name}.geojson${gz ? ".gz" : ""}`, { type: gz ? "application/gzip" : "application/geo+json" }));
	} catch (err) { postMessage(null); }
};