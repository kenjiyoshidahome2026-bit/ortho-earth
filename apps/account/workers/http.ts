// 共通レスポンスヘルパ（エラー形は {error, message} で統一）
export const json = (obj: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });
export const err = (status: number, error: string, message: string) => json({ error, message }, status);
