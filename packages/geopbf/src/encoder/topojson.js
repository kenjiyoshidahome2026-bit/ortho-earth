import { GeoPBF } from "../pbf.js";

onmessage = async (e) => {
    const { buf, name, opts, gint } = e.data, gz = opts && opts.gz;
    try { debugger
        const pbf = (await new GeoPBF().set(buf)).setGintBUF(gint);
        const topo = await pbf.topojson();
        let str = JSON.stringify(topo);
        if (gz) {
            const out = new Response(new Blob([str]).stream().pipeThrough(new CompressionStream("gzip")));
            str = await out.blob();
        }
        postMessage(new File([str], `${name}.topojson${gz ? ".gz" : ""}`, {type: gz ? "application/gzip" : "application/json"}));
    } catch (err) {
        console.error("Topojson encode Worker Error:", err);
        postMessage(null);
    }
};