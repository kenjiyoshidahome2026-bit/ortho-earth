import { Bucket as _Bucket } from "./Bucket.js";
import { Fetch as _Fetch } from "./Fetch.js";
import { Cache } from "./Cache.js";

export function nativeBucket(apiUrl = null) {
    const API_BASE = apiUrl || `https://api.ortho-earth.com`;
    const proxyOption = opts => ({ proxy: `${API_BASE}/proxy/`, ...opts });
    const bucketOption = opts => ({ baseUrl: `${API_BASE}/bucket/`, ...opts });
    return {
        Fetch: (url, opt = {}) => _Fetch(url, proxyOption(opt)),
        Bucket: (dir, opts = {}) => _Bucket(dir, bucketOption(opts)),
        Cache
    };
}

export default nativeBucket; // 👈 コメントアウトを解除

export * from "./Fetch.js"
export * from "./Cache.js"
export * from "./Bucket.js"
export * from "./encodeZIP.js"
export * from "./decodeZIP.js"
export * from "./gzip.js"