import { GeoPBF } from "../pbf-base.js";
import { dissolve } from "../extension/dissolve.js";
import { decodeZIP } from "../modules/decodeZIP.js";

const unescXML = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

function* getTags(src, tag) {
	const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
	let match;
	while ((match = regex.exec(src)) !== null) yield match[1];
}

// Determine axis order from the srsName attribute.
// CRS84 family → longitude-first (no flip needed).
// EPSG:4326 family → latitude-first (flip required).
function needsAxisFlip(srsName) {
	if (!srsName) return true; // unspecified: assume EPSG:4326 convention (flip)
	const s = srsName.trim();
	if (s.match(/CRS:?84/i) || s.match(/OGC.*CRS84/i)) return false; // CRS84/OGC84 is lng,lat — no flip
	if (s.match(/EPSG/i) && s.match(/4326/)) return true; // EPSG:4326 and URN-form 4326 are lat,lng — flip
	return false; // other CRS (e.g. projected) — no flip
}

// Convert a gml:posList / gml:pos text to an array of [lng, lat] coordinates.
function parsePosList(text, flip) {
	const nums = text.trim().split(/[\s\n\r]+/).map(Number);
	const pts = [];
	for (let i = 0; i < nums.length - 1; i += 2) {
		pts.push(flip ? [nums[i + 1], nums[i]] : [nums[i], nums[i + 1]]);
	}
	return pts;
}

// Collect all coordinate rings from a geometry block (handles MultiSurface / MultiCurve patches).
function extractAllPosLists(gmlBlock, flip) {
	const results = [];
	const posListRegex = /<gml:posList[^>]*>([\s\S]+?)<\/gml:posList>/gi;
	let m;
	while ((m = posListRegex.exec(gmlBlock)) !== null) {
		const pts = parsePosList(m[1], flip);
		if (pts.length > 0) results.push(pts);
	}
	return results;
}

// Parse inline geometry inside gml:geometryProperty (round-trip symmetric with the encoder output).
function parseInlineGeometry(pm, flip) {
	const geoPropMatch = /<gml:geometryProperty>([\s\S]+?)<\/gml:geometryProperty>/i.exec(pm);
	if (!geoPropMatch) return null;
	const block = geoPropMatch[1];
	// Point
	const posMatch = /<gml:pos[^>]*>([\s\S]+?)<\/gml:pos>/i.exec(block);
	if (posMatch) {
		const nums = posMatch[1].trim().split(/[\s\n\r]+/).map(Number);
		return { type: "Point", coordinates: flip ? [nums[1], nums[0]] : [nums[0], nums[1]] };
	}
	// LineString
	const lsMatch = /<gml:LineString[^>]*>[\s\S]*?<gml:posList[^>]*>([\s\S]+?)<\/gml:posList>/i.exec(block);
	if (lsMatch) return { type: "LineString", coordinates: parsePosList(lsMatch[1], flip) };
	// Polygon (exterior + zero or more interiors)
	const polyMatch = /<gml:Polygon[^>]*>([\s\S]+?)<\/gml:Polygon>/i.exec(block);
	if (polyMatch) {
		const rings = [];
		const extMatch = /<gml:exterior>[\s\S]*?<gml:posList[^>]*>([\s\S]+?)<\/gml:posList>/i.exec(polyMatch[1]);
		if (extMatch) rings.push(parsePosList(extMatch[1], flip));
		const intRegex = /<gml:interior>[\s\S]*?<gml:posList[^>]*>([\s\S]+?)<\/gml:posList>/gi;
		let im;
		while ((im = intRegex.exec(polyMatch[1])) !== null) rings.push(parsePosList(im[1], flip));
		if (rings.length) return { type: "Polygon", coordinates: rings };
	}
	return null;
}

onmessage = async (e) => {
	const { file, precision } = e.data;
	let gmlStr = "";
	if (file.name.match(/\.zip$/i)) {
		const entries = await decodeZIP(file);
		const gmlFile = entries.find(f => f.name.match(/\.gml$/i));
		if (!gmlFile) return;
		gmlStr = await gmlFile.text();
	} else {
		gmlStr = await file.text();
	}

	const srsMatch = /srsName=["']([^"']+)["']/.exec(gmlStr);
	const flip = needsAxisFlip(srsMatch ? srsMatch[1] : null);

	const geometryCache = new Map();
	const keySet = new Set();

	const featureTagMatch = /<([^:>\s]+:[^:>\s]+)\s+gml:id="/.exec(gmlStr);
	const featureTag = featureTagMatch ? featureTagMatch[1] : null;

	const geoRegex = /<(gml:(?:Surface|Curve|Point|MultiCurve|MultiSurface))\s+gml:id="([^"]+)"([\s\S]+?)<\/\1>/gi;
	let gMatch;
	while ((gMatch = geoRegex.exec(gmlStr)) !== null) {
		const id = gMatch[2];
		const block = gMatch[3];
		const posMatch = /<gml:pos[^>]*>([\s\S]+?)<\/gml:pos>/i.exec(block);
		if (posMatch) {
			const nums = posMatch[1].trim().split(/[\s\n\r]+/).map(Number);
			geometryCache.set(id, {
				type: "Point",
				coordinates: flip ? [nums[1], nums[0]] : [nums[0], nums[1]]
			});
			continue;
		}
		const posLists = extractAllPosLists(block, flip);
		if (posLists.length === 1) {
			const isClosed = gMatch[1].match(/Surface/i);
			geometryCache.set(id, {
				type: isClosed ? "Polygon" : "LineString",
				coordinates: isClosed ? [posLists[0]] : posLists[0]
			});
		} else if (posLists.length > 1) {
			const isClosed = gMatch[1].match(/Surface/i);
			geometryCache.set(id, {
				type: isClosed ? "MultiPolygon" : "MultiLineString",
				coordinates: isClosed ? posLists.map(r => [r]) : posLists
			});
		}
	}

	// Exclude gml:/xsi:/xlink: namespace tags; also match unnamespaced tags (encoder output).
	const attrRegex = () => /<([a-zA-Z_][a-zA-Z0-9_.]*(?::[a-zA-Z_][a-zA-Z0-9_.]*)?)>([^<]+)<\/\1>/gi;
	const isPropTag = name => !name.match(/^(?:gml|xsi|xlink):|(?:pos|geometry|location|bound)/i);

	if (featureTag) {
		for (const pm of getTags(gmlStr, featureTag)) {
			let aMatch;
			const re = attrRegex();
			while ((aMatch = re.exec(pm)) !== null) {
				if (isPropTag(aMatch[1])) keySet.add(aMatch[1].replace(/:/g, '_'));
			}
		}
	}

	const pbf = new GeoPBF({
		name: file.name.replace(/\.[^\.]+$/, ""),
		precision: precision || 7
	});
	pbf.setHead(Array.from(keySet).sort());

	pbf.setBody(() => {
		if (!featureTag) return;
		for (const pm of getTags(gmlStr, featureTag)) {
			const props = {};
			let aMatch;
			const re = attrRegex();
			while ((aMatch = re.exec(pm)) !== null) {
				const key = aMatch[1].replace(/:/g, '_');
				if (keySet.has(key)) props[key] = unescXML(aMatch[2].trim());
			}
			const ref = /xlink:href=["']#([^"']+)["']/.exec(pm);
			if (ref) {
				const geom = geometryCache.get(ref[1]);
				if (geom) pbf.setFeature({ type: "Feature", geometry: geom, properties: props });
			} else {
				const geom = parseInlineGeometry(pm, flip);
				if (geom) pbf.setFeature({ type: "Feature", geometry: geom, properties: props });
			}
		}
	});

	pbf.close();
	await dissolve(pbf);
	const res = pbf.arrayBuffer;
	postMessage({ type: "gmldec", data: res }, [res]);
};
