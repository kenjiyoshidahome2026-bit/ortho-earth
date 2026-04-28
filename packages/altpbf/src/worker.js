import { load } from "./altpbf.js";
onmessage = async e => {
     try { const obj = await load(e.data);
        obj? postMessage(obj, [obj.data.buffer]):postMessage(null);
    } catch (e) { postMessage(null); } 
};