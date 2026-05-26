import { GeoPBF } from "../pbf.js";
onmessage = async (e) => {
    const { buf, name, opts } = e.data;
    try {
		const pbf = await new GeoPBF().set(buf);
		postMessage(pbf.lint(opts));
	} catch (err) { postMessage(null); }
};