import { keyMatches, sameKey } from './proxy.ts';
import type { CfCacheStorage, Env, ExecutionContext, R2Bucket, R2Object, R2ObjectBody, R2UploadedPart } from './types.ts';

// 中身のハッシュ（8 桁以上の 16 進）を名前に持つ共有データ（GIS/shared/…・uploader の「共有データ」ボタンが上げる）は
// 中身が変わればキーが変わる＝ブラウザに 1 年持たせてよい（2026-09-30・縮小計画 項目6b。他のキーは従来どおり max-age=60）
const IMMUTABLE = /^GIS\/shared\/.+\.[0-9a-f]{8,}\.[a-z0-9]+$/;
// 範囲付きの鍵（API_KEY_POI）が書けるのはここの下だけ＝poiedit（packages/globe/src/gadgets/poiedit.ts）の手差分。
// 全権の鍵（API_KEY）をブラウザに置かないため（2026-10-24 の監査＝www の localStorage に全権の鍵が居た）
const POI_PREFIX = "GIS/pbf/";
// 一覧（prefix/）は R2 の list を全頁なぞる＝誰でも叩けるので頁数に上限を置き、エッジに 60 秒持たせる（2026-10-24）
const MAX_LIST_PAGES = 10;
const LIST_CACHE = "public, max-age=0, s-maxage=60";

// 書き込みの門：全権の鍵＝どこでも、範囲付きの鍵＝POI_PREFIX の下だけ（鍵が未設定なら誰も書けない）
export const canWrite = (req: Request, env: Partial<Env>, path: string) =>
	keyMatches(req, env) || (path.startsWith(POI_PREFIX) && sameKey(env.API_KEY_POI, req.headers.get("X-API-Key") || ""));

export async function bucket(request: Request, bucket: R2Bucket, ctx: ExecutionContext, env: Partial<Env> = {}) {
	const url = new URL(request.url);
	const path = decodeURIComponent(url.pathname.split('/bucket/').pop()!);
	const cache = (caches as CfCacheStorage).default;
	// 書いた・消した後はこの道の GET キャッシュを捨てる（B18・旧＝s-maxage=3600 の間、古い本体を返し続けた）。
	// ⚠ 本番の実測（2026-09-25・SJC）＝同じ拠点でも効かない回がある（3 回中 1 回だけ効いた・delete は "deleted" を返しても次の GET が HIT）＝best effort。
	//   確実にするには s-maxage を縮めるか、GET で R2 の ETag を照合する（未決）。結果は tail で見える（[bucket] purge …）
	// ⚠ Cache API はデータセンター単位＝消えるのは書き込みを受けた拠点の分だけ。他拠点は s-maxage（1 時間）で自然に切れる
	//   （全拠点を即時に消すにはゾーンの purge API＝API トークンが要る）。?v= 等の query 付きの版も別の鍵＝消えない
	// 親の一覧（…/prefix/）も一緒に捨てる＝一覧をエッジに持たせた分（LIST_CACHE）が書いた直後に古く見えないように
	const purgeOne = (pathname: string) => cache.delete(new Request(url.origin + pathname, { method: "GET" }))
		.then(ok => console.log(`[bucket] purge ${pathname} ${ok ? "deleted" : "not-cached"}`), (e?: Error) => console.warn(`[bucket] purge ${pathname} failed`, e?.message));
	const purge = () => ctx?.waitUntil?.(Promise.all([purgeOne(url.pathname), purgeOne(url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1))]));
	if (request.method === "GET") {
		const res = await cache.match(request); if (res) return res;
	}
	try {
		if (request.method === "GET") {
			 if (path.endsWith('/') || path === "") {
				let allObjects: R2Object[] = [];
				let cursor: string | undefined = undefined;
				let truncated = true, pages = 0;
				while (truncated && pages < MAX_LIST_PAGES) {
					const list = await bucket.list({ prefix: path || undefined, cursor: cursor, delimiter: '/' });
					allObjects.push(...(list.objects || []));
					truncated = list.truncated;
					cursor = list.cursor;
					pages++;
				}
				const response = new Response(JSON.stringify({
					data: {
						Contents: allObjects.map(o => ({
							Key: o.key,
							Size: o.size,
							LastModified: o.uploaded,
							ETag: (o.httpEtag || "").replace(/"/g, "")
						})),
						IsTruncated: truncated,   // 頁数の上限（MAX_LIST_PAGES）で打ち切った時だけ true
						NextContinuationToken: null
					}
				}), { headers: { "Content-Type": "application/json", "Cache-Control": LIST_CACHE } });
				ctx.waitUntil(cache.put(request, response.clone()));
				return response;
			}
			const isMeta = url.searchParams.has("meta");
			const obj = await (isMeta ? bucket.head(path) : bucket.get(path));
			if (!obj) return new Response(JSON.stringify({ data: null }), { status: 404 });
			if (isMeta) {
				const meta = { Key: obj.key, Size: obj.size, LastModified: obj.uploaded,
					ETag: (obj.httpEtag || "").replace(/"/g, ""),
					ContentEncoding: obj.httpMetadata?.contentEncoding || ""
				};
				return new Response(JSON.stringify({ data: meta }), { headers: { "Content-Type": "application/json" } });
			}
			const response = new Response((obj as R2ObjectBody).body, {
				headers: {
					"Content-Type": obj.httpMetadata?.contentType || "application/octet-stream",
					"Content-Encoding": obj.httpMetadata?.contentEncoding || "",
					"Content-Length": obj.size as unknown as string, "ETag": obj.httpEtag,
					"Cache-Control": IMMUTABLE.test(path) ? "public, max-age=31536000, immutable" : "public, s-maxage=3600, max-age=60"
				}
			});
			(response.status === 200) && ctx.waitUntil(cache.put(request, response.clone()));
			return response;
		}
		 if (request.method === "POST") {
			if (!canWrite(request, env, path)) {   // 全権の鍵か、範囲内なら範囲付きの鍵（定数時間で比べる・鍵が未設定なら誰も書けない）
				return new Response(JSON.stringify({ error: "Unauthorized" }), { 
					status: 401, headers: { "Content-Type": "application/json" }
				});
			}
			const action = request.headers.get("X-Action");
			if (action === "put") { // 通常のアップロード
				const contentType = request.headers.get("X-Metadata-Type") || "application/octet-stream";
				const contentEncoding = request.headers.get("X-Content-Encoding");
				await bucket.put(path, request.body, { httpMetadata: { contentType, contentEncoding } });
				purge();
				return new Response(JSON.stringify({ data: "ok" }));
			}
			if (action === "mp-create") { // マルチパートアップロード: 開始
				const contentType = request.headers.get("X-Metadata-Type") || "application/octet-stream";
				const contentEncoding = request.headers.get("X-Content-Encoding");
				const upload = await bucket.createMultipartUpload(path, { httpMetadata: { contentType, contentEncoding } });
				return new Response(JSON.stringify({ uploadId: upload.uploadId }));
			}
			if (action === "mp-upload") { // マルチパートアップロード: パーツ送信
				const uploadId = request.headers.get("X-Upload-ID");
				const partNumber = parseInt(request.headers.get("X-Part-Number")!);
				if (!uploadId || isNaN(partNumber)) return new Response(JSON.stringify({ error: "Missing X-Upload-ID or X-Part-Number" }), { status: 400, headers: { "Content-Type": "application/json" } });
				const upload = bucket.resumeMultipartUpload(path, uploadId);
				const part = await upload.uploadPart(partNumber, request.body);
				return new Response(JSON.stringify({ etag: part.etag }));
			}
			if (action === "mp-complete") { // マルチパートアップロード: 完了
				const { uploadId, parts } = await request.json() as { uploadId: string; parts: R2UploadedPart[] };
				const upload = bucket.resumeMultipartUpload(path, uploadId);
				await upload.complete(parts.sort((a, b) => a.partNumber - b.partNumber));
				purge();
				return new Response(JSON.stringify({ data: "ok" }));
			}
			if (action === "del") { // 削除処理
				await bucket.delete(path);
				purge();
				return new Response(JSON.stringify({ data: "ok" }));
			}
		}
	} catch (e) {
		return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { "Content-Type": "application/json" } });
	}
	return new Response("Method Not Allowed", { status: 405 });
}