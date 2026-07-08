import Pbf from "pbf";
import { GeoPBF } from "../pbf-base.js";

onmessage = async ({ data: { buf } }) => {
	const g = new GeoPBF();
	g.pbf = new Pbf(buf);
	await g.getPosition();
	// props are not sent — structured clone of large property arrays would freeze the main thread.
	// The main thread decodes them lazily from the buffer instead.
	postMessage(
		{ buf, fmap: g.fmap, keys: g.keys, bufs: g.bufs,
		  _name: g._name, _description: g._description, _license: g._license, _attribution: g._attribution,
		  _minZoom: g._minZoom, _maxZoom: g._maxZoom,
		  _precision: g._precision, _bodyPos: g._bodyPos, end: g.end },
		[buf, ...g.bufs]
	);
};
