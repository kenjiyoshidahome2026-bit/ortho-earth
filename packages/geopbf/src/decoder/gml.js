import { GeoPBF } from "../pbf-base.js";
import { decodeZIP } from "../modules/decodeZIP.js";

import { unescXML } from "../modules/xml.js";

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
// Multi 系（MultiPoint/MultiCurve/MultiSurface）と MultiGeometry も読む（2026-09-25・B9＝encoder と対称）
const polyRings = (inner, flip) => {
	const rings = [];
	const extMatch = /<gml:exterior>[\s\S]*?<gml:posList[^>]*>([\s\S]+?)<\/gml:posList>/i.exec(inner);
	if (extMatch) rings.push(parsePosList(extMatch[1], flip));
	const intRegex = /<gml:interior>[\s\S]*?<gml:posList[^>]*>([\s\S]+?)<\/gml:posList>/gi;
	let im;
	while ((im = intRegex.exec(inner)) !== null) rings.push(parsePosList(im[1], flip));
	return rings;
};
const posOf = (text, flip) => { const nums = text.trim().split(/[\s\n\r]+/).map(Number); return flip ? [nums[1], nums[0]] : [nums[0], nums[1]]; };
function parseGeomBlock(block, flip) {
	const head = /<gml:(Point|LineString|Polygon|MultiPoint|MultiCurve|MultiLineString|MultiSurface|MultiPolygon|MultiGeometry)\b/i.exec(block);
	if (!head) return null;
	const kind = head[1].toLowerCase();
	if (kind === "multigeometry") {
		const geometries = [];
		const re = /<gml:geometryMembers?>([\s\S]+?)<\/gml:geometryMembers?>/gi; let m;
		while ((m = re.exec(block)) !== null) { const g = parseGeomBlock(m[1], flip); if (g) geometries.push(g); }
		return geometries.length ? { type: "GeometryCollection", geometries } : null;
	}
	if (kind === "multipoint") {
		const pts = [...block.matchAll(/<gml:pos[^>]*>([\s\S]+?)<\/gml:pos>/gi)].map(m => posOf(m[1], flip));
		return pts.length ? { type: "MultiPoint", coordinates: pts } : null;
	}
	if (kind === "multicurve" || kind === "multilinestring") {
		const ls = [...block.matchAll(/<gml:posList[^>]*>([\s\S]+?)<\/gml:posList>/gi)].map(m => parsePosList(m[1], flip));
		return ls.length ? { type: "MultiLineString", coordinates: ls } : null;
	}
	if (kind === "multisurface" || kind === "multipolygon") {
		const polys = [...block.matchAll(/<gml:Polygon[^>]*>([\s\S]+?)<\/gml:Polygon>/gi)].map(m => polyRings(m[1], flip)).filter(r => r.length);
		return polys.length ? { type: "MultiPolygon", coordinates: polys } : null;
	}
	if (kind === "point") {
		const posMatch = /<gml:pos[^>]*>([\s\S]+?)<\/gml:pos>/i.exec(block);
		return posMatch ? { type: "Point", coordinates: posOf(posMatch[1], flip) } : null;
	}
	if (kind === "linestring") {
		const lsMatch = /<gml:posList[^>]*>([\s\S]+?)<\/gml:posList>/i.exec(block);
		return lsMatch ? { type: "LineString", coordinates: parsePosList(lsMatch[1], flip) } : null;
	}
	const polyMatch = /<gml:Polygon[^>]*>([\s\S]+?)<\/gml:Polygon>/i.exec(block);
	const rings = polyMatch ? polyRings(polyMatch[1], flip) : [];
	return rings.length ? { type: "Polygon", coordinates: rings } : null;
}
function parseInlineGeometry(pm, flip) {
	const geoPropMatch = /<gml:geometryProperty>([\s\S]+?)<\/gml:geometryProperty>/i.exec(pm);
	return geoPropMatch ? parseGeomBlock(geoPropMatch[1], flip) : null;
}

onmessage = async (e) => {
	const { file, precision } = e.data;
	let gmlStr = "";
	if (file.name.match(/\.zip$/i)) {
		const entries = await decodeZIP(file);
		const gmlFile = entries.find(f => f.name.match(/\.gml$/i));
		if (!gmlFile) { console.error("[gml] no .gml in the zip"); postMessage(null); return; }   // 旧＝何も返さず呼び手が永久に待った（B9b）
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
	// 要素名は Unicode の文字も（encoder が日本語のキーをそのまま書く・2026-09-25）
	const attrRegex = () => /<([\p{L}_][\p{L}\p{N}_.\-]*(?::[\p{L}_][\p{L}\p{N}_.\-]*)?)>([^<]+)<\/\1>/giu;
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
	const res = pbf.arrayBuffer;
	postMessage({ type: "gmldec", data: res }, [res]);
};
