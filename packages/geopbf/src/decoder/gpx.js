import { GeoPBF } from "../pbf-base.js"; //

onmessage = async (e) => {
	const { file, precision } = e.data;
	const text = await file.text();
	const pbf = new GeoPBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision: precision || 6 });

	// 1. ヘッダー情報の定義（name, time などの属性を想定）
	pbf.setHead(["name", "time", "ele"]);

	pbf.setBody(() => {
		// 2. trkpt (トラックポイント) の抽出
		const ptRegex = /<trkpt lat="([^"]+)" lon="([^"]+)">([\s\S]*?)<\/trkpt>/gi;
		let match, coords = [];
		while ((match = ptRegex.exec(text)) !== null) {
			coords.push([+match[2], +match[1]]); // [lon, lat]
		}
		if (coords.length > 0) {
			pbf.setFeature({
				type: "Feature",
				geometry: { type: "LineString", coordinates: coords },
				properties: { name: file.name }
			});
		}
	});

	pbf.close();
	const res = pbf.arrayBuffer;
	postMessage({ type: "gpxdec", data: res }, [res]); //
};