import { GeoPBF } from "../pbf.js";
onmessage = async (e) => {
    const { buf, name, gz:opts } = e.data;
    try {
		const pbf = await new GeoPBF().name(name).set(buf);
		postMessage(pbf.lint(opts));
	} catch (err) { postMessage(null); }
};