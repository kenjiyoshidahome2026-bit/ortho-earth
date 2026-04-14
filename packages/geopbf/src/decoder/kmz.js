import { GeoPBF } from "../pbf-base.js";
import { decodeZIP } from "../../../native-bucket/src/decodeZIP.js";

const parseCoords = (s) => s.trim().split(/\s+/).map(t => t.split(",").map(Number).slice(0, 2));

const kmlToFeatures = (text, nameToRes) => {
    const features = [];
    const placemarks = text.match(/<Placemark[\s\S]*?<\/Placemark>/g) || [];
    placemarks.forEach(pm => {
        const props = {};
        const nm = pm.match(/<name>(.*?)<\/name>/);
        if (nm) props.name = nm[1].trim();
        const ds = pm.match(/<description>(.*?)<\/description>/);
        if (ds) props.description = ds[1].trim();
        const sd = pm.match(/<SimpleData name="(.*?)">(.*?)<\/SimpleData>/g);
        if (sd) sd.forEach(t => {
            const m = t.match(/<SimpleData name="(.*?)">(.*?)<\/SimpleData>/);
            if (m) props[m[1]] = m[2];
        });
        const hr = pm.match(/<href>(.*?)<\/href>/);
        if (hr) {
            const path = hr[1].trim();
            if (nameToRes[path]) props.icon = nameToRes[path];
        }
        let geometry = null;
        if (pm.includes("<Point>")) {
            const c = pm.match(/<coordinates>(.*?)<\/coordinates>/);
            if (c) geometry = { type: "Point", coordinates: parseCoords(c[1])[0] };
        } else if (pm.includes("<LineString>")) {
            const c = pm.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
            if (c) geometry = { type: "LineString", coordinates: parseCoords(c[1]) };
        } else if (pm.includes("<Polygon>")) {
            const c = pm.match(/<coordinates>([\s\S]*?)<\/coordinates>/);
            if (c) geometry = { type: "Polygon", coordinates: [parseCoords(c[1])] };
        }
        if (geometry) features.push({ type: "Feature", geometry, properties: props });
    });
    return features;
};

self.onmessage = async (e) => {
    const { file, precision } = e.data;
    const entries = await decodeZIP(file);
    if (!entries) return;
    const nameToRes = {};
    entries.forEach(f => {
        if (!f.name.endsWith(".kml")) nameToRes[f.name] = f;
    });
    const kmlEntries = entries.filter(t => t.name.endsWith(".kml"));
    const allFeatures = [];
    for (const entry of kmlEntries) {
        const text = await entry.text();
        allFeatures.push(...kmlToFeatures(text, nameToRes));
    }
    const [keys, bufs] = await GeoPBF.makeKeys(allFeatures.map(f => f.properties));
    const pbf = new GeoPBF({ name: file.name.replace(/\.kmz$/, ""), precision });
    pbf.setHead(keys, bufs);
    pbf.setBody(() => {
        allFeatures.forEach(f => pbf.setFeature(f));
    });
    pbf.close();
    const res = pbf.arrayBuffer;
    self.postMessage({ type: "kmzdec", data: res }, [res]);
};