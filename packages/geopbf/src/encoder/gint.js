import { GeoPBF } from "../pbf-base.js";
import { topology } from "../extension/topology.js";

onmessage = async (e) => {
    try {
        const pbf = await new GeoPBF().set(e.data.buf);
        const gintBuffer = topology(pbf);
        postMessage(gintBuffer, [gintBuffer]);
    } catch (err) {
        console.error("gint encode Worker Error:", err);
        postMessage(null);
    }
};