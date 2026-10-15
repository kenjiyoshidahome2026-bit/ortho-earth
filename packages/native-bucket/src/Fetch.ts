import { fname2mime } from "geopbf/fname2mime";
// ⚠zip の読み書きは静的 import のまま（2026-09-23 差し戻し）：動的 import にすると world の出荷物で `import("geopbf/decodeZIP")` が
// 解決されないまま止まり（失敗なら捨てられるが「止まる」＝gets の Promise が永久に未解決）、起動が「Loading the world…」で固まった。
import { decodeZIP } from "geopbf/decodeZIP";

/** 返す形（既定 "file"）。text／json／xml／html／csv は encoding で復号 */
export type FetchType = "file" | "blob" | "arraybuffer" | "text" | "json" | "xml" | "html" | "csv" | string;
export interface FetchOptions {
	type?: FetchType;
	/** proxy の URL（nativeBucket() が付ける）＝必須 */
	proxy?: string;
	/** proxy の第二の門（proxy 宛にだけ付ける） */
	apiKey?: string;
	/** 文字コード（既定 utf8・shift_jis → sjis） */
	encoding?: string;
	silent?: boolean;
	eventTarget?: EventTarget | null;
	/** 表示名（既定＝URL の末尾） */
	name?: string;
	/** zip の時：取り出す 1 本の名前・false＝目録 */
	target?: string | false | null;
	/** proxy を通すか（既定＝proxy の check の判断） */
	cors?: boolean;
}
/** proxy の mode=check の返り */
interface CheckInfo { exists?: boolean; url?: string; mustUseProxy?: boolean; supportsRange?: boolean; contentLength?: string; error?: string }
type CsvCell = string | number | boolean | null;

export async function Fetch(url: string, opts: string | FetchOptions = {}): Promise<unknown> {
	const o: FetchOptions = (typeof opts == "string") ? {} : opts;   // 文字列＝type だけ（他の項は無い）
	const type = ((typeof opts == "string")? opts: o.type || "file").toLowerCase();
	const PROXY_URL = o.proxy;
	if (!PROXY_URL) throw new Error("native-bucket: opts.proxy is required");
	const proxy = (s: string): string => `${PROXY_URL}?url=${encodeURIComponent(s)}`;
	// proxy の第二の門（X-API-Key）用。キーは proxy 宛のリクエストにだけ付け、転送先ホストへは絶対に送らない。
	// これが無いと allowlist 外ホスト（sekai-hub 等）が「キー持ちの uploader」からも 403 になる（2026-08-31 実測）。
	const keyHeaders = o.apiKey ? { 'X-API-Key': o.apiKey } : undefined;
	const encoding = (o.encoding||"utf8").toLowerCase().replace(/[\-\_]/g,"").replace(/shiftjis/,"sjis");
	const silent = !!o.silent || console === undefined;

	let eventTarget: EventTarget | null = o.eventTarget || (typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : null));
	// TODO(ts): window も self も無い環境（Node）で CustomEvent がある時は旧来どおり null.dispatchEvent で TypeError になる（振る舞いは変えていない）
	if (typeof CustomEvent === 'undefined' || !eventTarget!.dispatchEvent) eventTarget = null;
	const event = (type: string, detail: unknown): boolean | null => eventTarget && eventTarget.dispatchEvent(new CustomEvent(type, { detail }));

	let name = o.name || url.split("/").pop()!.split("?")[0] || "unknown";
	let suffix = name.split(".").reverse()[0].toLowerCase();
	const target = (suffix == "zip" && o.target !== undefined) ? o.target : null;
	if (target) { name = target };

	try {
		let cors: boolean | undefined = false, range: boolean | undefined = true, knownSize = 0, targetURL = "";
		const checkRes = await fetch(`${proxy(url)}&mode=check`, { headers: keyHeaders }).catch(() => null);
		// check が JSON を返さない（CF 障害ページ等）／403 の {error}（許可ホスト外＝第三者サイトからの外部 URL）／ネットワーク不通＝
		// 「proxy が使えない」であって「無い」ではない → ブラウザの CORS に任せて**直 fetch へフォールバック**（2026-09-10・SDK ドッグフードで
		// raw.githubusercontent が 403→null→0 件 pbf を黙って返した根治）。本当に無い（proxy が転送先に届いて exists:false）時だけ null。
		const info: CheckInfo | null = checkRes ? await checkRes.json().catch(() => null) : null;
		if (info && (info.exists || info.url)) {
			cors = o.cors !== undefined ? !!o.cors : info.mustUseProxy;
			targetURL = cors ? proxy(url) : url;
			range = info.supportsRange;
			knownSize = info.contentLength ? parseInt(info.contentLength, 10) : 0;
		} else if (info && info.exists === false && !info.error) {
			silent || console.warn(`file is not exist: ${url}`); return null;
		} else {
			silent || console.info(`[native-bucket] proxy unavailable (${checkRes ? checkRes.status : "no response"}${info?.error ? ": " + info.error : ""}) → direct fetch (browser CORS applies): ${url}`);
			cors = false; targetURL = url; range = false; knownSize = 0;
		}
		if (range && target != null) {
			const file = await decodeZIP(targetURL, { target, encoding, eventTarget, totalLength: knownSize });
			if (target === false) return file;
			if (!file) {
				console.warn(`file is not exist: ${target} in ${url}`);
				console.log("zip file includes:", await decodeZIP(targetURL, false));
			}
			return await convert(file as File | null, type, encoding);
		}

		// 2. Fetch the full resource.
		const finalURL = `${targetURL}${targetURL.includes('?') ? '&' : '?'}_t=${Date.now()}`;
		// キーは proxy 経由（cors=true）のときだけ。直接取得（cors=false）で転送先へ漏らさない
		const res = await fetch(finalURL, { cache: 'no-store', headers: cors ? keyHeaders : undefined });

		if (!res.ok) throw new Error(String(res.status));

		const reader = res.body!.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
		const total = parseInt(res.headers.get('Content-Length') || "0", 10) || 0;
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

		let file: File | null = new File([rawBlob], name, {type: fname2mime(name)});
		if (target) file = await decodeZIP(file, target);
		return await convert(file, type, encoding);

	} catch (error) {
		event("FetchError", {name, error});
		throw error;
	}

	async function convert(file: File | null, type: string, encoding: string): Promise<unknown> {
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

		function str2csv(str: string): CsvCell[][] {
			let a: CsvCell[][] = [[""]], i = 0, j = 0;
			str.replace(/^\xEF\xBB\xBF/,"")
			.replace(/\r?\n$/, '').replace(/\,|\r?\n|[^\,\"\r\n][^\,\r\n]*|\"(?:[^\"]|\"\")*\"/g, function(s: string): string {
				if (s === "\n" || s === "\r\n") a[++i] = [""], j = 0; else if (s === ",") a[i][++j] = "";
				else if (s.charAt(0) === '"') a[i][j] = s.slice(1, -1).replace(/""/g, '"');
				else {
					s = s.replace(/^\s+|\s+$/g, "");
					a[i][j] = s === "true"? true: s === "false"? false: s === "null"? null:
					(isNaN(+s)||s==="")? s: isFinite(+s)? s.match(/e[+-]?\d/i)? s:+s:s;   // isNaN(s)／isFinite(s) と同じ強制（Number(s)）
				}
				return "";   // 置換の結果は使わない（走査だけ）
			});
			return a;
		}
	}
}
