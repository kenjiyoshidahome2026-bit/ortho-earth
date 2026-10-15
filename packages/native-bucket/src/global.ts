// CDN / 非 ESM 向けの入口（dist/native-bucket.iife.js）＝README「Option B」の window.nativeBucket。
// 既定輸出の関数 nativeBucket に名前付き輸出（Fetch/Bucket/Cache/encodeZIP…）をぶら下げ、
// <script type="module"> で読まれても届くよう globalThis へ明示的に付ける（module では top-level var が global にならない）。
import nativeBucket, * as api from "./index.ts";
const bag = nativeBucket as typeof nativeBucket & Record<string, unknown>, named = api as Record<string, unknown>;
for (const k of Object.keys(api)) if (k !== "default" && !(k in nativeBucket)) bag[k] = named[k];
(globalThis as Record<string, unknown>).nativeBucket = nativeBucket;
export default nativeBucket;
