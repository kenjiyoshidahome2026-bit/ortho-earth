onmessage = async (e) => {
    const { buf, name, gz } = e.data;
    try {
        let res = buf;
        if (gz) {
            const out = new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream("gzip")));
            res = await out.blob();
        }
        postMessage(new File([res], `${name}.pbf${gz ? ".gz" : ""}`, { type: gz ? "application/gzip" : "application/x-protobuf" }));
    } catch (err) { postMessage(null); }
};