# @ortho-earth/mcp

An [MCP](https://modelcontextprotocol.io/) server for [Ortho Earth](https://www.ortho-earth.com/), the open-source 3D globe map engine for the browser.
It lets an AI agent check facts about Ortho Earth instead of guessing them: the current version, whether a MapLibre GL JS or CesiumJS feature works, the exact API signature, and the tested setup recipe.

- Read-only. No API key, no account.
- Answers come from the machine-readable files that www.ortho-earth.com rebuilds on every deploy, so they stay current without updating this package.
- Two ways to use it, with the same tools: a remote server at `https://www.ortho-earth.com/mcp`, or a local one with `npx`.

## Tools

| Tool | What it answers |
|---|---|
| `get_facts` | Latest version and release date, packages, licenses, how many official MapLibre GL JS and CesiumJS examples run unchanged |
| `get_started` | The step-by-step recipe with exact file contents (`route: "vite"` or `"html"`). Every step is run by an automated test against the published packages |
| `check_compat` | How the official MapLibre GL JS and CesiumJS examples matching a word run on Ortho Earth (same picture / same answers / runs partly / does not run), with links to side-by-side comparisons, and how MapLibre style properties are read |
| `lookup_api` | The TypeScript declaration of an API, with its doc comment (`createGlobe`, `flyTo`, `GlobeOptions`…) |
| `search_docs` | Full-text search over the documentation: recipe, changelog, migration guides, engine overview, formats |
| `view_link` | A link that opens the globe at a place, and the matching `createGlobe({ view })` string |
| `list_apps` | The apps and demos built with Ortho Earth |

## Use it

### Remote (no install)

Add `https://www.ortho-earth.com/mcp` as a remote MCP server (Streamable HTTP) in your client.

Claude Code:

```bash
claude mcp add --transport http ortho-earth https://www.ortho-earth.com/mcp
```

### Local (npx)

Requires Node.js 18 or later.

Claude Code:

```bash
claude mcp add ortho-earth -- npx -y @ortho-earth/mcp
```

Claude Desktop, Cursor and other clients that take a JSON config:

```json
{
  "mcpServers": {
    "ortho-earth": { "command": "npx", "args": ["-y", "@ortho-earth/mcp"] }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "ortho-earth": { "type": "stdio", "command": "npx", "args": ["-y", "@ortho-earth/mcp"] }
  }
}
```

`ORTHO_EARTH_BASE` changes where the files are read from (default `https://www.ortho-earth.com`; a local directory such as a built `apps/www/dist` also works).

## How it works

The server reads `/facts.json`, `/llms.txt`, `/llms-full.txt`, `/start.md`, `/compat.json` and `/ref/*.ts` from www.ortho-earth.com and keeps them for ten minutes.
It has no dependencies. The same code runs as the npm command (stdio) and as the Cloudflare Worker behind `https://www.ortho-earth.com/mcp` (`worker.js`, stateless Streamable HTTP).

## License

GPL-3.0-or-later, like the engine.
