import { Bucket as _Bucket } from "./Bucket.js";
import { Fetch as _Fetch } from "./Fetch.js";
import { Cache } from "./Cache.js";

export function nativeBucket(apiUrl, options = {}) {
    if (!apiUrl) throw new Error("native-bucket: apiUrl is required");
    const API_BASE = apiUrl;
    const { apiKey = "" } = typeof options === "string" ? { apiKey: options } : options;
    const proxyOption = opts => typeof opts === "string"
        ? { type: opts, proxy: `${API_BASE}/proxy/` }
        : { proxy: `${API_BASE}/proxy/`, ...opts };
    const bucketOption = opts => ({ baseUrl: `${API_BASE}/bucket/`, apiKey, ...opts });
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