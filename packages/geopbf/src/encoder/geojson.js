import { GeoPBF } from "../pbf-base.js";
const enc = new TextEncoder();

onmessage = async (e) => {
    const { buf, name, gz } = e.data;
    try {
        const pbf = await new GeoPBF().name(name).set(buf);
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const out = gz ? readable.pipeThrough(new CompressionStream("gzip")) : readable;
        const bPromise = new Response(out).blob();

        (async () => {
            await writer.write(enc.encode('{"type":"FeatureCollection","features":[\n'));
            for (let i = 0, len = pbf.length; i < len; i++) {
                const f = pbf.getFeature(i);
                let s = JSON.stringify({ type: "Feature", geometry: f.geometry, properties: f.properties });
                if (i < len - 1) s += ",\n";
                await writer.write(enc.encode(s));
            }
            await writer.write(enc.encode('\n]}'));
            await writer.close();
        })();

        const b = await bPromise;
        postMessage(new File([b], `${name}.geojson${gz ? ".gz" : ""}`, { type: gz ? "application/gzip" : "application/geo+json" }));
    } catch (err) { postMessage(null); }
};