import { GeoPBF } from "../pbf-base.js";
import { geojsonReader } from "common";
const threshold = 50 * 1024 * 1024;
onmessage = async (e) => {
    const file = e.data.file;
    if (file.size < threshold) {
        const json = JSON.parse(await file.text());
        const pbf = new GeoPBF(e.data);
        await pbf.set(json);
        const res = pbf.arrayBuffer;
        postMessage({ type: "jsondec", data: res }, [res]);
    } else {
        const keySet = new Set();
        const getPropertyKeys = f => { if (!f.properties) return;
            for (const k in f.properties) { keySet.add(k);
                const v = f.properties[k];
                if (v && typeof v === 'object' && !Array.isArray(v)) {
                    for (const sk in v) keySet.add(`${k}.${sk}`);
                }
            }
        };
        await geojsonReader(file, getPropertyKeys, false);
        const pbf = new GeoPBF(e.data);
        pbf.setHead(Array.from(keySet).sort());
        pbf.setBody(() => geojsonReader(file, f => pbf.setFeature(f), true));
        pbf.close();
        const res = pbf.arrayBuffer;
        postMessage({ type: "jsondec", data: res }, [res]);
    }
};