// 取得の前の手入れ（#37・2026-09-23・MapLibre と同名）。
//   transformRequest(url, resourceType) → { url?, headers?, credentials? } | undefined   … opts.transformRequest / map.setTransformRequest
//   addProtocol(scheme, loader) / removeProtocol(scheme)                               … "myscheme://…" の取得を呼び手の関数に任せる
//     loader({ url, type: "arrayBuffer"|"json"|"image"|"string", headers }, abortController) → Promise<{ data }>（MapLibre v4 以降の形）
// resourceType は MapLibre と同じ語彙：Style / Source（TileJSON・tileset.json）/ Tile / SpriteJSON / SpriteImage / Image / Unknown。
// 関数は worker へ渡せない＝URL を main で組む取得（基図タイル・3D Tiles・style・sprite）はここで判定して、結果（ヘッダか取得済みの本体）を渡す。
// 画像タイルは URL を worker が組む＝ヘッダは「ソースの型紙」で一度だけ決め、独自スキームは port プロバイダで main から画像を渡す（globe.js の map.raster）。
const protocols = new Map();   // scheme → loader（地図をまたいで共有＝MapLibre の addProtocol と同じ大域）
export function addProtocol(scheme, loader) { protocols.set(String(scheme).replace(/:\/*$/, ""), loader); }
export function removeProtocol(scheme) { protocols.delete(String(scheme).replace(/:\/*$/, "")); }
export const protocolOf = url => { const m = /^([a-z][\w+.-]*):\/\//i.exec(url || ""); return m && protocols.has(m[1]) ? protocols.get(m[1]) : null; };

// 読み口の戻り（data）を欲しい形へ
async function asBuffer(data) {
	if (data == null) return new ArrayBuffer(0);
	if (data instanceof ArrayBuffer) return data;
	if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
	if (data instanceof Blob) return data.arrayBuffer();
	if (typeof data === "string") return new TextEncoder().encode(data).buffer;
	return new TextEncoder().encode(JSON.stringify(data)).buffer;
}

export function createRequester() {
	let transform = null;
	const self = {
		setTransform(fn) { transform = typeof fn === "function" ? fn : null; },
		get transform() { return transform; },
		// url → { url, headers, credentials, load? }（load＝独自スキームの読み口＝本体を ArrayBuffer で返す）
		resolve(url, type = "Unknown") {
			let out = { url, headers: undefined, credentials: undefined };
			if (transform) { try { const r = transform(url, type); if (r) out = { url: r.url ?? url, headers: r.headers, credentials: r.credentials }; } catch (err) { console.error("[transformRequest]", err); } }
			const loader = protocolOf(out.url);
			if (loader) { const u = out.url, h = out.headers; out.load = async (want = "arrayBuffer", ac = new AbortController()) => { const r = await loader({ url: u, type: want, headers: h }, ac); return want === "arrayBuffer" ? asBuffer(r?.data) : r?.data; }; }
			return out;
		},
		// fetch の代わり（Response 風：ok / status / json() / text() / arrayBuffer() / blob()）
		async fetch(url, type = "Unknown", init = {}) {
			const r = self.resolve(url, type);
			if (r.load) {
				const ab = await r.load("arrayBuffer");
				return { ok: true, status: 200, url: r.url, arrayBuffer: async () => ab, text: async () => new TextDecoder().decode(ab), json: async () => JSON.parse(new TextDecoder().decode(ab)), blob: async () => new Blob([ab]) };
			}
			const headers = r.headers ? { ...(init.headers || {}), ...r.headers } : init.headers;
			return fetch(r.url, { ...init, ...(headers ? { headers } : {}), credentials: r.credentials ?? init.credentials ?? "omit" });
		},
		// pipeline / queryTiles へ渡す形（Tile は同期で判定＝load は後で呼ぶ）
		forTiles() { return (url, type) => (transform || protocols.size) ? self.resolve(url, type) : null; },   // 何も無い間は素通し（後から addProtocol しても効く）
	};
	return self;
}
