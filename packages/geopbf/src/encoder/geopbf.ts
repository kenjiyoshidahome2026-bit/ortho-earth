import type { EncodeRequest } from "../worker-msg.ts";

onmessage = async (e: MessageEvent<EncodeRequest>) => {
	const { buf, name } = e.data;
	try {
		let blob = new Blob([buf]);
		blob = await (new Response(blob.stream().pipeThrough(new CompressionStream("gzip")))).blob();
		postMessage(new File([blob], `${name}.geopbf`, { type: "application/x-geopbf" }));
	} catch (err) { postMessage(null); }
};
