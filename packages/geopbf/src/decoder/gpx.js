import { GeoPBF } from "../pbf-base.js";
import { dissolve } from "../extension/dissolve.js";

const tagContent = (src, tag) => {
	const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(src);
	return m ? m[1].trim() : null;
};

onmessage = async (e) => {
	const { file, precision } = e.data;
	try {
		const text = await file.text();
		const pbf = new GeoPBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision: precision || 6 });

		const keys = ["name", "desc", "ele", "time", "type"].sort();
		pbf.setHead(keys);

		pbf.setBody(() => {
			const wptRegex = /<wpt\s+lat="([^"]+)"\s+lon="([^"]+)">([\s\S]*?)<\/wpt>/gi;
			let match;
			while ((match = wptRegex.exec(text)) !== null) {
				const [_, lat, lon, inner] = match;
				const ele = tagContent(inner, "ele");
				const time = tagContent(inner, "time");
				const name = tagContent(inner, "name") || "Waypoint";
				const desc = tagContent(inner, "desc");
				const type = tagContent(inner, "type");

				pbf.setFeature({
					type: "Feature",
					geometry: { type: "Point", coordinates: [+lon, +lat] },
					properties: { name, desc, ele: ele ? +ele : null, time, type }
				});
			}

			const trkRegex = /<trk>([\s\S]*?)<\/trk>/gi;
			while ((match = trkRegex.exec(text)) !== null) {
				const trkInner = match[1];
				const trkName = tagContent(trkInner, "name") || file.name;
				const trkDesc = tagContent(trkInner, "desc");
				const trkType = tagContent(trkInner, "type");

				const segs = [];
				const segRegex = /<trkseg>([\s\S]*?)<\/trkseg>/gi;
				let segMatch;

				while ((segMatch = segRegex.exec(trkInner)) !== null) {
					const coords = [];
					const ptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"/gi;
					let ptMatch;
					while ((ptMatch = ptRegex.exec(segMatch[1])) !== null) {
						coords.push([+ptMatch[2], +ptMatch[1]]); // [lon, lat]
					}
					if (coords.length > 0) segs.push(coords);
				}

				// A single segment becomes LineString; multiple discontiguous segments become MultiLineString.
				if (segs.length === 1) {
					pbf.setFeature({
						type: "Feature",
						geometry: { type: "LineString", coordinates: segs[0] },
						properties: { name: trkName, desc: trkDesc, type: trkType }
					});
				} else if (segs.length > 1) {
					pbf.setFeature({
						type: "Feature",
						geometry: { type: "MultiLineString", coordinates: segs },
						properties: { name: trkName, desc: trkDesc, type: trkType }
					});
				}
			}
		});

		pbf.close();
		await dissolve(pbf);
		const res = pbf.arrayBuffer;
		postMessage({ type: "gpxdec", data: res }, [res]);
	} catch (err) {
		console.error("GPX decode Worker Error:", err);
		postMessage(null);
	}
};
