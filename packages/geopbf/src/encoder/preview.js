import { GeoPBF } from "../pbf.js";
import { preview } from "../extension/preview.js";

onmessage = async ({ data: { buf, canvas, name, props } }) => {
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
