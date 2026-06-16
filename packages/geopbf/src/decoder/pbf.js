import Pbf from "pbf";
import { GeoPBF } from "../pbf-base.js";

onmessage = async ({ data: { buf } }) => {
    const g = new GeoPBF();
    g.pbf = new Pbf(buf);
    await g.getPosition();
    // props は送らない — structured clone によるメインスレッドの凍結を避けるため。
    // メインスレッド側でバッファから遅延デコードする。
    postMessage(
        { buf, fmap: g.fmap, keys: g.keys, bufs: g.bufs,
          _name: g._name, _description: g._description, _license: g._license, _attribution: g._attribution,
          _precision: g._precision, _bodyPos: g._bodyPos, end: g.end },
        [buf, ...g.bufs]
    );
};
