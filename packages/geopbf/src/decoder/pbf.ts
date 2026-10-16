import Pbf from "../modules/pbf.ts";
import { GeoPBF } from "../pbf-base.js";
import type { PbfDecodeRequest, PbfDecodeResponse } from "../worker-msg.ts";

onmessage = async ({ data: { buf } }: MessageEvent<PbfDecodeRequest>) => {
	const g = new GeoPBF();
	g.pbf = new Pbf(buf);
	await g.getPosition({ skipProps: true });   // props は送らない（main が遅延復号）＝ここで復号もしない
	// props are not sent — structured clone of large property arrays would freeze the main thread.
	// The main thread decodes them lazily from the buffer instead.
	const msg: PbfDecodeResponse = { buf, fmap: g.fmap, keys: g.keys, bufs: g.bufs,
		  _name: g._name, _description: g._description, _license: g._license, _attribution: g._attribution,
		  _minZoom: g._minZoom, _maxZoom: g._maxZoom,
		  _precision: g._precision, _bodyPos: g._bodyPos, end: g.end };
	postMessage(msg, [buf, ...g.bufs]);
};
