import { load, setApiUrl } from "./altpbf.js";
onmessage = async e => {
	const { name, apiUrl } = e.data;
	if (apiUrl) setApiUrl(apiUrl);
	try { const obj = await load(name);
		obj ? postMessage(obj, [obj.data.buffer]) : postMessage(null);
	} catch (e) { postMessage(null); }
};