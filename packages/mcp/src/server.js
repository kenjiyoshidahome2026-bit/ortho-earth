// MCP（Model Context Protocol）の JSON-RPC を受ける本体（2026-11-11）。運び（stdio・HTTP）を知らない＝handle(msg) が答え（または null）を返すだけ。
// 依存なし：MCP の SDK を入れず、使う口（initialize・ping・tools/list・tools/call）だけを書く＝Worker にも npx にも同じ物が載る。
import { TOOLS } from "./tools.js";
import { VERSION } from "./version.js";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];   // 新しい順
export const SITE = "https://www.ortho-earth.com";

const INSTRUCTIONS = "Ortho Earth is an open-source 3D globe map engine for the browser (WebGPU with a WebGL2 fallback, no API key). " +
	"Use get_facts before quoting a version or a compatibility number, get_started for the tested setup recipe, check_compat to see whether a MapLibre GL JS or CesiumJS feature works, " +
	"lookup_api for exact signatures, search_docs for anything else, and view_link to show a place on the globe.";

/** 取り方（path → 本文）に 10 分の写しを被せる。落ちた取得は写さない */
export function cachedLoader(fetchText, ttlMs = 10 * 60 * 1000) {
	const memo = new Map();
	return (path) => {
		const hit = memo.get(path);
		if (hit && Date.now() - hit.at < ttlMs) return hit.p;
		const p = fetchText(path);
		memo.set(path, { at: Date.now(), p });
		p.catch(() => memo.delete(path));
		return p;
	};
}

/** fetch で www.ortho-earth.com から取る（base を変えれば手元の dist でも） */
export const httpLoader = (base = SITE, init = {}) => cachedLoader(async (path) => {
	const r = await fetch(`${base.replace(/\/$/, "")}/${path}`, init);
	if (!r.ok) throw new Error(`could not read ${path} from ${base} (HTTP ${r.status})`);
	return r.text();
});

const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });

export function createServer({ load }) {
	async function one(msg) {
		if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return err(msg?.id ?? null, -32600, "Invalid Request");
		const { id, method, params = {} } = msg;
		const isNote = !("id" in msg);
		if (typeof method !== "string") return isNote ? null : err(id ?? null, -32600, "Invalid Request");   // 答え（result／error）が来ても返さない
		if (isNote) return null;   // notifications/initialized・cancelled など
		switch (method) {
			case "initialize": {
				const want = params.protocolVersion;
				return ok(id, {
					protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0],
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: "ortho-earth", title: "Ortho Earth", version: VERSION, websiteUrl: SITE },
					instructions: INSTRUCTIONS,
				});
			}
			case "ping": return ok(id, {});
			case "tools/list": return ok(id, { tools: TOOLS.map(({ run, ...t }) => t) });
			case "tools/call": {
				const tool = TOOLS.find(t => t.name === params.name);
				if (!tool) return err(id, -32602, `Unknown tool: ${params.name}`);
				try {
					const text = await tool.run(params.arguments ?? {}, load);
					return ok(id, { content: [{ type: "text", text }] });
				} catch (e) {
					return ok(id, { content: [{ type: "text", text: `Error: ${e?.message ?? e}` }], isError: true });   // 道具の誤り＝結果として返す（AI が読んで直せる）
				}
			}
			default: return err(id, -32601, `Method not found: ${method}`);
		}
	}
	/** 1 通（または古い版の束）を受けて答えを返す。答えが要らない（通知だけ）なら null */
	async function handle(msg) {
		if (Array.isArray(msg)) {
			if (!msg.length) return err(null, -32600, "Invalid Request");
			const out = (await Promise.all(msg.map(one))).filter(Boolean);
			return out.length ? out : null;
		}
		return one(msg);
	}
	return { handle };
}

export const parseError = () => err(null, -32700, "Parse error");
