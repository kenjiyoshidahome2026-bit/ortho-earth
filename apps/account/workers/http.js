// 共通レスポンスヘルパ（エラー形は {error, message} で統一）
export const json = (obj, status = 200, headers = {}) =>
	new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });
export const err = (status, error, message) => json({ error, message }, status);
