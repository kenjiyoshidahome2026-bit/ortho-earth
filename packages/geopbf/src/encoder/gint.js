import { GeoPBF } from "../pbf-base.js";
import { pbf2gint } from "../extension/pbf2gint.js";

onmessage = async (e) => {
    try {
        const pbf = await new GeoPBF().set(e.data.buf);
        const gintBuffer = pbf2gint(pbf);
        postMessage(gintBuffer, [gintBuffer]);
    } catch (err) {
        console.error("gint encode Worker Error:", err);
        postMessage(null);
    }
};