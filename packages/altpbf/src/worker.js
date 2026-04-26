import { Bucket, Cache } from "native-bucket";
import { ALOS } from "./alos.js";
import { decode, altpbfName } from "./altpbf.js";

let bucket, cache, alos;
onmessage = async e => { 
    bucket = bucket || await Bucket("GIS/alt");
    cache = cache || await Cache("GIS/alt");
    alos = alos || await (new ALOS()).init();
    const { lng, lat, range } = e.data;
    try { 
        if (range == 1) return success(await alos.get(lng, lat));
        const name = altpbfName(lng, lat, range);
        let v = await cache(name); if (v) return success(await decode(v));
        v = await bucket.get(name); 
        if (!v) return postMessage({ error: `not found: ${name}`, req_lng: lng, req_lat: lat, req_range: range });
        success(await decode(v));
        await cache(new File([v], name, {type:"application/x-altpbf"}));
        function success(v) { 
            if (!v) return postMessage({ error: "No data", req_lng: lng, req_lat: lat, req_range: range });
            const transfer = (v.data && v.data.buffer) ? [v.data.buffer] : [];
            postMessage({ ...v, req_lng: lng, req_lat: lat, req_range: range }, transfer); 
        }
    } catch (err) { postMessage({ error: err.message, req_lng: lng, req_lat: lat, req_range: range }); }
};