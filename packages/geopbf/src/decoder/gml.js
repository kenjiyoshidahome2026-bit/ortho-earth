import { GeoPBF } from "../pbf-base.js";
import { decodeZIP } from "../../../native-bucket/src/decodeZIP.js";

function* getTags(src, tag) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match;
    while ((match = regex.exec(src)) !== null) yield match[1];
}

self.onmessage = async (e) => {
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

    const geometryCache = new Map();
    const keySet = new Set(["bbox"]);
    const featureTagMatch = /<([^:>\s]+:[^:>\s]+)\s+gml:id="/.exec(gmlStr);
    const featureTag = featureTagMatch ? featureTagMatch[1] : null;

    const geoRegex = /<(gml:(?:Surface|Curve|Point|MultiCurve|MultiSurface))\s+gml:id="([^"]+)">([\s\S]+?)<\/\1>/gi;
    let gMatch;
    while ((gMatch = geoRegex.exec(gmlStr)) !== null) {
        const id = gMatch[2];
        const posList = /<gml:posList[^>]*>([\s\S]+?)<\/gml:posList>/i.exec(gMatch[3]);
        const pos = /<gml:pos[^>]*>([\s\S]+?)<\/gml:pos>/i.exec(gMatch[3]);
        if (posList) {
            const coords = posList[1].trim().split(/[\s\n\r]+/).map(Number);
            const pts = [];
            for (let i = 0; i < coords.length; i += 2) pts.push([coords[i + 1], coords[i]]);
            geometryCache.set(id, pts);
        } else if (pos) {
            const c = pos[1].trim().split(/[\s\n\r]+/).map(Number);
            geometryCache.set(id, [c[1], c[0]]);
        }
    }

    if (featureTag) {
        for (const pm of getTags(gmlStr, featureTag)) {
            const attrRegex = /<([^:>\s]+:[^:>\s]+)>([^<]+)<\/\1>/gi;
            let aMatch;
            while ((aMatch = attrRegex.exec(pm)) !== null) {
                if (!aMatch[1].match(/(pos|geometry|location|bound)/i)) {
                    keySet.add(aMatch[1].replace(/:/g, '_'));
                }
            }
        }
    }

    const pbf = new GeoPBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision: precision || 7 });
    pbf.setHead(Array.from(keySet).sort());

    pbf.setBody(() => {
        if (!featureTag) return;
        for (const pm of getTags(gmlStr, featureTag)) {
            const props = {};
            const attrRegex = /<([^:>\s]+:[^:>\s]+)>([^<]+)<\/\1>/gi;
            let aMatch;
            while ((aMatch = attrRegex.exec(pm)) !== null) {
                const key = aMatch[1].replace(/:/g, '_');
                if (keySet.has(key)) props[key] = aMatch[2].trim();
            }
            const ref = /xlink:href=["']#([^"']+)["']/.exec(pm);
            if (ref) {
                const coords = geometryCache.get(ref[1]);
                if (coords) {
                    const isPoint = !Array.isArray(coords[0]);
                    pbf.setFeature({
                        type: "Feature", properties: props,
                        geometry: { type: isPoint ? "Point" : "Polygon", coordinates: isPoint ? coords : [coords] }
                    });
                }
            }
        }
    });

    pbf.close();
    const res = pbf.arrayBuffer;
    self.postMessage({ type: "gmldec", data: res }, [res]);
};