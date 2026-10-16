// 取得の前の手入れ（#37・2026-09-23・MapLibre と同名）。
//   transformRequest(url, resourceType) → { url?, headers?, credentials? } | undefined   … opts.transformRequest / map.setTransformRequest
//   addProtocol(scheme, loader) / removeProtocol(scheme)                               … "myscheme://…" の取得を呼び手の関数に任せる
//     loader({ url, type: "arrayBuffer"|"json"|"image"|"string", headers }, abortController) → Promise<{ data }>（MapLibre v4 以降の形）
//     type は MapLibre と同じく資源で選ぶ：style・TileJSON・sprite の JSON＝"json"・画像タイル＝"image"・ベクタタイルほか＝"arrayBuffer"
// resourceType は MapLibre と同じ語彙：Style / Source（TileJSON・tileset.json）/ Tile / SpriteJSON / SpriteImage / Image / Unknown。
// 関数は worker へ渡せない＝URL を main で組む取得（基図タイル・3D Tiles・style・sprite）はここで判定して、結果（ヘッダか取得済みの本体）を渡す。
// 画像タイルは URL を worker が組む＝ヘッダは「ソースの型紙」で一度だけ決め、独自スキームは port プロバイダで main から画像を渡す（globe.js の map.raster）。
import type { queryTiles } from "@ortho-earth/core";
import type { ProtocolLoader, ResourceType, TransformRequestFunction } from "../globe.d.ts";

/** url を手入れした結果（load＝独自スキームの読み口） */
export interface ResolvedRequest { url: string; headers: Record<string, string> | undefined; credentials: RequestCredentials | undefined; load?(want?: "arrayBuffer" | "json" | "image" | "string", ac?: AbortController): Promise<unknown> }
/** requester.fetch の答え＝fetch の Response か、独自スキームの読み口の Response 風（ok／status／json／text／arrayBuffer／blob） */
export interface ResponseLike { ok: boolean; status: number; url?: string; headers?: Headers; json(): Promise<unknown>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; blob(): Promise<Blob> }
export interface Requester {
	setTransform(fn: TransformRequestFunction | null | undefined): void;
	readonly transform: TransformRequestFunction | null;
	resolve(url: string, type?: ResourceType): ResolvedRequest;
	fetch(url: string, type?: ResourceType, init?: RequestInit): Promise<Response | ResponseLike>;
	/** タイルの手入れ（core の queryTiles／pipeline の request の形＝種類の名前は core が渡す・手入れが何も無い間は null を返す） */
	forTiles(): NonNullable<Parameters<typeof queryTiles>[0]["request"]>;
}
const protocols = new Map<string, ProtocolLoader>();   // scheme → loader（地図をまたいで共有＝MapLibre の addProtocol と同じ大域）
export function addProtocol(scheme: string, loader: ProtocolLoader): void { protocols.set(String(scheme).replace(/:\/*$/, ""), loader); }
export function removeProtocol(scheme: string): void { protocols.delete(String(scheme).replace(/:\/*$/, "")); }
const protocolOf = (url: string): ProtocolLoader | null | undefined => { const m = /^([a-z][\w+.-]*):\/\//i.exec(url || ""); return m && protocols.has(m[1]) ? protocols.get(m[1]) : null; };

// 読み口の戻り（data）を欲しい形へ
async function asBuffer(data: unknown): Promise<ArrayBuffer> {
	if (data == null) return new ArrayBuffer(0);
	if (data instanceof ArrayBuffer) return data;
	if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	if (data instanceof Blob) return data.arrayBuffer();
	if (typeof data === "string") return new TextEncoder().encode(data).buffer;
	return new TextEncoder().encode(JSON.stringify(data)).buffer;
}

export function createRequester(): Requester {
	let transform: TransformRequestFunction | null = null;
	const self: Requester = {
		setTransform(fn) { transform = typeof fn === "function" ? fn : null; },
		get transform() { return transform; },
		// url → { url, headers, credentials, load? }（load＝独自スキームの読み口＝本体を ArrayBuffer で返す）
		resolve(url, type = "Unknown") {
			let out: ResolvedRequest = { url, headers: undefined, credentials: undefined };
			if (transform) { try { const r = transform(url, type); if (r) out = { url: r.url ?? url, headers: r.headers, credentials: r.credentials }; } catch (err) { console.error("[transformRequest]", err); } }
			const loader = protocolOf(out.url);
			if (loader) { const u = out.url, h = out.headers; out.load = async (want = "arrayBuffer", ac = new AbortController()) => { const r = await loader({ url: u, type: want, headers: h }, ac); return want === "arrayBuffer" ? asBuffer(r?.data) : r?.data; }; }
			return out;
		},
		// fetch の代わり（Response 風：ok / status / json() / text() / arrayBuffer() / blob()）
		async fetch(url, type = "Unknown", init = {}) {
			const r = self.resolve(url, type);
			if (r.load) {
				// 頼む型は MapLibre と同じく資源で選ぶ：style・TileJSON・sprite の JSON＝"json"（maplibre-cog-protocol などは型で答え方を変える・"arrayBuffer" は断る）
				if (/^(Style|Source|SpriteJSON)$/.test(type)) {
					const d = await r.load("json");
					const obj = typeof d === "string" ? JSON.parse(d) : d instanceof ArrayBuffer || ArrayBuffer.isView(d) ? JSON.parse(new TextDecoder().decode(d as ArrayBuffer)) : d;
					const txt = JSON.stringify(obj);
					return { ok: true, status: 200, url: r.url, json: async () => obj, text: async () => txt, arrayBuffer: async () => new TextEncoder().encode(txt).buffer, blob: async () => new Blob([txt]) };
				}
				const ab = await r.load("arrayBuffer") as ArrayBuffer;
				return { ok: true, status: 200, url: r.url, arrayBuffer: async () => ab, text: async () => new TextDecoder().decode(ab), json: async () => JSON.parse(new TextDecoder().decode(ab)), blob: async () => new Blob([ab]) };
			}
			const headers = r.headers ? { ...(init.headers || {}), ...r.headers } : init.headers;
			return fetch(r.url, { ...init, ...(headers ? { headers } : {}), credentials: r.credentials ?? init.credentials ?? "omit" });
		},
		// pipeline / queryTiles へ渡す形（Tile は同期で判定＝load は後で呼ぶ）
		forTiles() { return (url, type) => (transform || protocols.size) ? self.resolve(url, type as ResourceType) as ReturnType<ReturnType<Requester["forTiles"]>> : null; },   // 何も無い間は素通し（後から addProtocol しても効く）
	};
	return self;
}
