import { GeoPBF } from "../pbf.js";

onmessage = async (e) => {
    const { buf, name, gz } = e.data;
    try {
        const pbf = await new GeoPBF({ name }).set(buf);
        const topo = pbf.topojson;
        const resStr = JSON.stringify(topo);
        let res = resStr;
        if (gz) {
            const out = new Response(new Blob([resStr]).stream().pipeThrough(new CompressionStream("gzip")));
            res = await out.blob();
        }
        postMessage(new File([res], `${name}.topojson${gz ? ".gz" : ""}`, {
            type: gz ? "application/gzip" : "application/json"
        }));
    } catch (err) {
        console.error("Topojson encode Worker Error:", err);
        postMessage(null);
    }
};