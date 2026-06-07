import { GeoPBF } from "../pbf-base.js";
import { topology } from "../extension/topology.js";
import { gint } from "../extension/gint.js"; // 🌟 gint のインポートを追加

let wasmInitPromise = null;

onmessage = async (e) => {
     try {
		if (!wasmInitPromise) {
            wasmInitPromise = gint.initialize();
        }
        await wasmInitPromise;
        const pbf = await new GeoPBF().set(e.data.buf);
        const gintBuffer = topology(pbf);
        postMessage(gintBuffer, [gintBuffer]);
    } catch (err) {
        console.error("gint encode Worker Error:", err);
        postMessage(null);
    }
};