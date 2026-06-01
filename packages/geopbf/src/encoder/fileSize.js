import { gzip } from "native-bucket";
onmessage = async (e) => {
	try { postMessage((await gzip(new Blob([e.data]))).size);
	} catch (err) { postMessage(0); }
};