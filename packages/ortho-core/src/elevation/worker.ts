import { load, setApiUrl } from "./loader.ts";
import type { HeightRequest } from "../worker-msg.ts";
onmessage = async e => {
	const { name, apiUrl }: HeightRequest = e.data;
	if (apiUrl) setApiUrl(apiUrl);
	try { const obj = await load(name);
		obj ? postMessage(obj, [obj.data.buffer as ArrayBuffer]) : postMessage(null);
	} catch (e) { postMessage(null); }
};