import { GeoPBF } from "../pbf.ts";
import { preview } from "../extension/preview.ts";
import type { PreviewRequest } from "../worker-msg.ts";

onmessage = async ({ data: { buf, canvas, name, props } }: MessageEvent<PreviewRequest>) => {
	try {
		const pbf = await new GeoPBF().set(buf);
		const result = preview(pbf, canvas, props);
		result instanceof ImageBitmap
			? postMessage(result, [result])
			: postMessage(null);
	} catch (e) {
		postMessage(null);
	}
};
