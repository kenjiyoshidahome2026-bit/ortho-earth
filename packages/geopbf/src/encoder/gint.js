import { GeoPBF } from "../pbf-base.js";
import { topology, unPackGintBuffer, repackGintBuffer } from "../extension/topology.js";
import { cleanTopology } from "../extension/clean.js";
import { gint } from "../extension/gint.js";

let wasmInitPromise = null;

onmessage = async (e) => {
    try {
        if (!wasmInitPromise) wasmInitPromise = gint.initialize();
        await wasmInitPromise;
        const pbf = await new GeoPBF().set(e.data.buf);
        let gintBuffer = topology(pbf);
        if (e.data.opts?.clean) {
            const gintData = unPackGintBuffer(gintBuffer);
            cleanTopology(gintData, e.data.opts?.clean !== true ? e.data.opts?.clean : {});
            gintBuffer = repackGintBuffer(gintData);
        }
        postMessage(gintBuffer, [gintBuffer]);
    } catch (err) {
        console.error("gint encode Worker Error:", err);
        postMessage(null);
    }
};
