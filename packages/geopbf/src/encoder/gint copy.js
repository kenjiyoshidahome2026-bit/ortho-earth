import { GeoPBF } from "../pbf-base.js";
import { topology } from "../extension/topology.js";
import init from 'gishub-wasm';

let wasm = null;

onmessage = async (e) => {
    try {
		if (!wasm) wasm = await init();
        const pbf = await new GeoPBF().set(e.data.buf);
        const gintBuffer = topology(pbf, wasm);
        postMessage(gintBuffer, [gintBuffer]);
    } catch (err) {
        console.error("gint encode Worker Error:", err);
        postMessage(null);
    }
};