import { decode } from "./altpbf.js";
import { Bucket, Cache } from "native-bucket";
import { ALOS } from "./altitude.js"
const bucket = await Bucket("GIS/alt"), cache = await Cache("GIS/alt");
const alos = new ALOS();

onmessage = async function (e) {
    try { const {lng, lat, range} = e.data;
        if (range == 1) return alos.get(lng,lat);
        const name = altpbfName(lng, lat, range);
        let v = await cache(name); if (v) return success(await decode(v));
        v = await bucket.get(name); if (!v) return postMessage({ error: `not found: ${name}` });
        success(await decode(v));
        await cache(new File([v], name, {type:"application/x-altpbf"}));
        function success(v) { postMessage(v,[v.data]); }
    } catch (e) {
        postMessage({ error: e.message });
    }
};