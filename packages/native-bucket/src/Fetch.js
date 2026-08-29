import { fname2mime } from "geopbf/fname2mime";
import { decodeZIP } from "geopbf/decodeZIP";

export async function Fetch(url, opts = {}) {
	const type = ((typeof opts == "string")? opts: opts.type || "file").toLowerCase();
	const PROXY_URL = opts.proxy;
	if (!PROXY_URL) throw new Error("native-bucket: opts.proxy is required");
	const proxy = s => `${PROXY_URL}?url=${encodeURIComponent(s)}`;
	const encoding = (opts.encoding||"utf8").toLowerCase().replace(/[\-\_]/g,"").replace(/shiftjis/,"sjis");
	const silent = !!opts.silent || console === undefined;

	let eventTarget = opts.eventTarget || (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
	if (typeof CustomEvent === 'undefined' || !eventTarget.dispatchEvent) eventTarget = null;
	const event = (type, detail) => eventTarget && eventTarget.dispatchEvent(new CustomEvent(type, { detail }));

	let name = opts.name || url.split("/").pop().split("?")[0] || "unknown";
	let suffix = name.split(".").reverse()[0].toLowerCase();
	const target = (suffix == "zip" && opts.target !== undefined) ? opts.target : null;
	if (target) { name = target }; 

	try {
		let cors = false, range = true, knownSize = 0, targetURL = "";
		const checkRes = await fetch(`${proxy(url)}&mode=check`);
		// check が JSON を返さない（proxy 検問 403 の素通し・CF 障害ページ等）＝存在不明でなく「取れない」扱い
		const info = await checkRes.json().catch(() => null);
		if (!info) { console.warn(`proxy check failed (${checkRes.status}): ${url}`); return null; }
		if (!info.exists && !info.url) {
			 console.warn(`file is not exist: ${url}`); return null; 
		} else {
			cors = opts.cors !== undefined ? !!opts.cors : info.mustUseProxy;
			targetURL = cors ? proxy(url) : url;
			range = info.supportsRange;
			knownSize = info.contentLength ? parseInt(info.contentLength, 10) : 0;
		}
		if (range && target != null) {
			const file = await decodeZIP(targetURL, { target, encoding, eventTarget, totalLength: knownSize });
			if (target === false) return file; 
			if (!file) { 
				console.warn(`file is not exist: ${target} in ${url}`);
				console.log("zip file includes:", await decodeZIP(targetURL, false));
			}
			return await convert(file, type, encoding);
		}

		// 2. Fetch the full resource.
		const finalURL = `${targetURL}${targetURL.includes('?') ? '&' : '?'}_t=${Date.now()}`;
		const res = await fetch(finalURL, { cache: 'no-store' }); 
		
		if (!res.ok) throw new Error(res.status);

		const reader = res.body.getReader(), chunks = [];
		const total = parseInt(res.headers.get('Content-Length') || 0, 10) || 0;
		const totalLength = total ? total.toLocaleString() : "(unknown)";
		
		let loaded = 0, n = 0;
		event("FetchStart", {name});
		while (true) {
			const { done, value } = await reader.read(); if (done) break;
			chunks.push(value);
			loaded += value.length;
			if (++n % 256 === 0) { 
				event("FetchProgress", { name, loaded, total }); 
			}
		}
		let rawBlob = new Blob(chunks);
		event("FetchEnd", {name, size:rawBlob.size});

		const head = new Uint8Array(await rawBlob.slice(0, 2).arrayBuffer());
		if (head[0] === 0x1f && head[1] === 0x8b) { 
			const ds = new DecompressionStream("gzip");
			rawBlob = await new Response(rawBlob.stream().pipeThrough(ds)).blob();
			name = name.replace(/\.gz(ip)?$/i, "");
		}

		let file = new File([rawBlob], name, {type: fname2mime(name)});
		if (target) file = await decodeZIP(file, target);
		return await convert(file, type, encoding);

	} catch (error) { 
		event("FetchError", {name, error}); 
		throw error; 
	}

	async function convert(file, type, encoding) {
		if (!file) return null;
		if (type === "file") return file;
		if (type === "blob") return new Blob([file], { type: file.type });
		if (type === "arraybuffer") return await file.arrayBuffer();
		if (["text","json","xml","html","csv"].includes(type)) {
			const text = new TextDecoder(encoding).decode(await file.arrayBuffer());
			return (type === "json") ? JSON.parse(text) :
				   (type === "xml") ? new DOMParser().parseFromString(text, 'text/xml') :
				   (type === "html") ? new DOMParser().parseFromString(text, 'text/html') :
				   (type === "csv") ? str2csv(text) : text;
		}
		return file;

		function str2csv(str) {
			let a = [[""]], i = 0, j = 0;
			str.replace(/^\xEF\xBB\xBF/,"")
			.replace(/\r?\n$/, '').replace(/\,|\r?\n|[^\,\"\r\n][^\,\r\n]*|\"(?:[^\"]|\"\")*\"/g, function(s) {
				if (s === "\n" || s === "\r\n") a[++i] = [""], j = 0; else if (s === ",") a[i][++j] = "";
				else if (s.charAt(0) === '"') a[i][j] = s.slice(1, -1).replace(/""/g, '"');
				else { 
					s = s.replace(/^\s+|\s+$/g, "");
					a[i][j] = s === "true"? true: s === "false"? false: s === "null"? null:
					(isNaN(s)||s==="")? s: isFinite(s)? s.match(/e[+-]?\d/i)? s:+s:s;
				}
			});
			return a;
		}
	}
}