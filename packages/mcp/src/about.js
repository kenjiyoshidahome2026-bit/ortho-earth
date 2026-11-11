// /mcp を GET で開いた人と AI への案内（2026-11-12）。ChatGPT などの取得器は 405 の本文を捨てる＝「本文が取れない」と言われたので、
// SSE を求めない GET には 200 で Markdown（既定）か HTML（Accept に text/html）を返す。道具の表は TOOLS から作る＝増えても書き直し不要
import { TOOLS } from "./tools.js";
import { VERSION } from "./version.js";
import { SITE } from "./server.js";

const ENDPOINT = `${SITE}/mcp`;
const firstSentence = (s) => (/^.*?(?<!e\.g)\.(?=\s|$)/.exec(s) || [s])[0];

/** 案内の本文（Markdown）。見出し・段落・箇条・コードだけ＝そのまま HTML にもできる形 */
export function aboutMarkdown() {
	const tools = TOOLS.map(t => `- \`${t.name}\`: ${firstSentence(t.description)}`).join("\n");
	return `# Ortho Earth MCP server

This URL is a Model Context Protocol (MCP) endpoint. An AI client talks to it with JSON-RPC over HTTP POST; opening it in a browser shows this guide.

- Endpoint: ${ENDPOINT}
- Transport: Streamable HTTP, stateless (POST JSON-RPC, JSON responses; no SSE stream, no session)
- Local alternative: \`npx -y @ortho-earth/mcp\` (stdio, Node.js 18 or later, same tools)
- Authentication: none. No API key, no account
- Version: ${VERSION}. MCP Registry name: io.github.kenjiyoshidahome2026-bit/ortho-earth

## What it is for

Ortho Earth is an open-source 3D globe map engine for the browser. This server helps an AI agent write code with it correctly: it looks up the current facts (version, packages, licenses), the tested setup recipe, exact API declarations, whether a given MapLibre GL JS or CesiumJS example runs on Ortho Earth, and the documentation.

It is a reference server. It does not open or operate a map, render images, move a camera, or edit layers, and it does not search PLATEAU building attributes or run spatial analysis. To show a place, it returns a link that opens the globe there (\`view_link\`). All tools are read-only.

## Tools

${tools}

## Connect

Claude Code:

\`\`\`bash
claude mcp add --transport http ortho-earth ${ENDPOINT}
\`\`\`

Claude Desktop: Settings → Connectors → Add custom connector, URL \`${ENDPOINT}\`. Or run it locally, in claude_desktop_config.json:

\`\`\`json
{ "mcpServers": { "ortho-earth": { "command": "npx", "args": ["-y", "@ortho-earth/mcp"] } } }
\`\`\`

Cursor (~/.cursor/mcp.json or .cursor/mcp.json):

\`\`\`json
{ "mcpServers": { "ortho-earth": { "url": "${ENDPOINT}" } } }
\`\`\`

VS Code (.vscode/mcp.json):

\`\`\`json
{ "servers": { "ortho-earth": { "type": "http", "url": "${ENDPOINT}" } } }
\`\`\`

## Try it without a client

\`\`\`bash
curl -s ${ENDPOINT} -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

## Where the answers come from

The files that ${SITE.replace("https://", "")} rebuilds on every deploy: /facts.json, /llms.txt, /llms-full.txt, /start.md, /compat.json and /ref/*.ts. Nothing else is read or stored.

## Links

- Package and full README: https://www.npmjs.com/package/@ortho-earth/mcp
- Source: https://github.com/kenjiyoshidahome2026-bit/ortho-earth/tree/main/packages/mcp
- Site: ${SITE}/ · For AI agents: ${SITE}/llms.txt
`;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/(https:\/\/[^\s<]+[^\s<.,)])/g, '<a href="$1">$1</a>');

/** 同じ本文の HTML（JS なし・外の資源なし） */
export function aboutHtml() {
	const out = [];
	let list = false, code = null;
	for (const line of aboutMarkdown().split("\n")) {
		if (code) { if (line.startsWith("```")) { out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`); code = null; } else code.push(line); continue; }
		if (line.startsWith("```")) { code = []; continue; }
		if (list && !line.startsWith("- ")) { out.push("</ul>"); list = false; }
		if (line.startsWith("# ")) out.push(`<h1>${inline(line.slice(2))}</h1>`);
		else if (line.startsWith("## ")) out.push(`<h2>${inline(line.slice(3))}</h2>`);
		else if (line.startsWith("- ")) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(line.slice(2))}</li>`); }
		else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
	}
	if (list) out.push("</ul>");
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ortho Earth MCP server</title>
<meta name="description" content="Remote MCP endpoint for Ortho Earth: read-only tools to look up facts, the setup recipe, API declarations and MapLibre/CesiumJS compatibility. Streamable HTTP, no key.">
<link rel="alternate" type="text/markdown" href="${ENDPOINT}?format=md">
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#222;background:#fff}pre{background:#f4f4f4;padding:.8rem;overflow-x:auto}code{font-size:.92em}@media (prefers-color-scheme:dark){body{color:#ddd;background:#111}pre{background:#222}a{color:#8ab4f8}}</style>
</head><body>
${out.join("\n")}
</body></html>
`;
}
