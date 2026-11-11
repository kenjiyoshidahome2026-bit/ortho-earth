#!/usr/bin/env node
// Ortho Earth の MCP サーバー（stdio）。`npx -y @ortho-earth/mcp` で起動＝1 行 1 通の JSON-RPC を stdin で受け、stdout へ返す。ログは stderr だけ。
// ORTHO_EARTH_BASE＝資料の取り先（既定 https://www.ortho-earth.com）。手元の道（apps/www/dist など）を渡すとファイルから読む（試験と開発用）。
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, httpLoader, cachedLoader, parseError } from "../src/server.js";

const base = process.env.ORTHO_EARTH_BASE || "https://www.ortho-earth.com";
const load = /^https?:\/\//.test(base) ? httpLoader(base) : cachedLoader(p => readFile(join(base, p), "utf8"));
const { handle } = createServer({ load });

const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let pending = 0, closed = false;
const done = () => { if (closed && !pending) process.exit(0); };
createInterface({ input: process.stdin, crlfDelay: Infinity })
	.on("line", async (line) => {
		if (!line.trim()) return;
		let msg;
		try { msg = JSON.parse(line); } catch { send(parseError()); return; }
		pending++;
		try { const r = await handle(msg); if (r) send(r); }
		catch (e) { process.stderr.write(`ortho-earth-mcp: ${e?.stack ?? e}\n`); }
		finally { pending--; done(); }
	})
	.on("close", () => { closed = true; done(); });
