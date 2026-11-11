// Ortho Earth の MCP サーバー（リモート版・Cloudflare Worker・2026-11-11）。https://www.ortho-earth.com/mcp
// MCP の Streamable HTTP を状態なしで：POST に JSON-RPC が来たら JSON で答える（SSE の流れも session も持たない）。
// 答えの材料は同じ www.ortho-earth.com の /facts.json などを取る（この Worker の route は /mcp だけ＝それ以外の道は Pages へ素通り）。
// 配り方：deploy.yml の target「mcp」（cd packages/mcp && npx wrangler deploy）
import { createServer, httpLoader, parseError, SITE } from "./src/server.js";

const server = createServer({ load: httpLoader(SITE, { cf: { cacheTtl: 600 } }) });
const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, GET, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
	"Access-Control-Expose-Headers": "Mcp-Session-Id",
};
const reply = (body, status = 200, headers = {}) => new Response(body == null ? null : JSON.stringify(body), {
	status, headers: { ...CORS, ...(body == null ? {} : { "Content-Type": "application/json" }), ...headers },
});

const ABOUT = {
	name: "Ortho Earth MCP server",
	how: "This is a Model Context Protocol endpoint (Streamable HTTP). Add https://www.ortho-earth.com/mcp as a remote MCP server in your AI client, or run `npx -y @ortho-earth/mcp` locally.",
	docs: "https://www.npmjs.com/package/@ortho-earth/mcp",
	site: SITE,
};

export default {
	async fetch(req) {
		const url = new URL(req.url);
		if (url.pathname !== "/mcp" && url.pathname !== "/mcp/") return reply({ error: "not found" }, 404);
		if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
		if (req.method === "GET") return reply(ABOUT, 405, { Allow: "POST, OPTIONS" });   // SSE の流れは出さない＝仕様どおり 405（人が開いた時の案内つき）
		if (req.method !== "POST") return reply(ABOUT, 405, { Allow: "POST, OPTIONS" });
		const text = await req.text();
		if (text.length > 64 * 1024) return reply({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413);
		let msg;
		try { msg = JSON.parse(text); } catch { return reply(parseError(), 400); }
		const out = await server.handle(msg);
		return out == null ? reply(null, 202) : reply(out);
	},
};
