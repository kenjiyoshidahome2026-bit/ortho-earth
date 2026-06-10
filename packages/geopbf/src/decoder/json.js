import { GeoPBF } from "../pbf-base.js";
import { dissolve } from "../extension/dissolve.js";
import { geojsonReader, isObject } from "common";
const threshold = 50 * 1024 * 1024;
onmessage = async (e) => {
    const file = e.data.file;
    const pbf = new GeoPBF(e.data);
    if (file.size < threshold) {
        await pbf.set(JSON.parse(await file.text()));
    } else {
        const keySet = new Set();
        const getPropertyKeys = f => { if (!isObject(f.properties)) return;
            for (const k in f.properties) { keySet.add(k);
                const v = f.properties[k]; if (!isObject(v)) continue;
                for (const sk in v) keySet.add(`${k}.${sk}`);
            }
        };
        await geojsonReader(file, getPropertyKeys, false);
        pbf.setHead(Array.from(keySet).sort());
        pbf.setBody(() => geojsonReader(file, f => pbf.setFeature(f), true));
    }
    pbf.close();
    await dissolve(pbf);
    const res = pbf.arrayBuffer;
    postMessage({ type: "jsondec", data: res }, [res]);
};