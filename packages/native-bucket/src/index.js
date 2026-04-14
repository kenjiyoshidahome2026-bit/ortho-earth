import { Bucket as _Bucket } from "./Bucket.js";
import { Fetch as _Fetch } from "./Fetch.js";
import { Cache } from "./Cache.js";

function nativeBucket(apiUrl = null) {
    const API_BASE = apiUrl || `https://api.ortho-earth.com`;
	const proxyOption = opts => ({ proxy: `${API_BASE}/proxy/`, ...opts });
	const bucketyOption = opts => ({ baseUrl: `${API_BASE}/bucket/`, ...opts });
    return {
        Fetch: (url, opt = {}) => _Fetch(url, proxyOption(opt)),
        Bucket: async function(dir, opts) { const instance = new _Bucket(dir, bucketyOption(opts)); 
            if (instance.offline()) return instance;
      		try { await instance.list(1); return instance;
			} catch (e) {
                console.warn(`[native-bucket] Failed to connect to Bucket "${dir}" at ${BUCKET_URL}.`);
                return null;
            }
		},
        Cache
    };
}

const target = (typeof window === 'undefined') ? (typeof self === 'undefined') ? null : self : window;
if (target) target.nativeBucket = nativeBucket;

export default nativeBucket;