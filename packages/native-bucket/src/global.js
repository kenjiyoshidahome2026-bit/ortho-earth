// CDN / 非 ESM 向けの入口（dist/native-bucket.iife.js）＝README「Option B」の window.nativeBucket。
// 既定輸出の関数 nativeBucket に名前付き輸出（Fetch/Bucket/Cache/encodeZIP…）をぶら下げ、
// <script type="module"> で読まれても届くよう globalThis へ明示的に付ける（module では top-level var が global にならない）。
import nativeBucket, * as api from "./index.js";
for (const k of Object.keys(api)) if (k !== "default" && !(k in nativeBucket)) nativeBucket[k] = api[k];
globalThis.nativeBucket = nativeBucket;
export default nativeBucket;
