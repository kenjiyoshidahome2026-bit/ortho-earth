// 公式例の門の切り分け道具：こちら側の例の頁（/ortho/test/examples/<例>.html＝網は録り置きの再生）を開き、待ってから式を評価して返す。
// 使い方: node tests/mlexamples/probe.mjs <例の名前> '<式>' [待ち秒=6]   式の中で m＝通訳の Map・eng＝エンジンの地図・window.__placed()/__placedDebug()/__idleWhy()/__labelsMain() が使える
// 例: node tests/mlexamples/probe.mjs locate-the-user '(async () => ({ idle: window.__idleWhy(), placed: (await window.__placed()).length }))()' 7
// 写しは <repo>/.cache/mlexamples/probe.png（一つ）。console の error/EXC/label を含む行も出す
import path from "node:path";
import { fileURLToPath } from "node:url";
const G = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");   // packages/globe
const { startVite } = await import(G + "/scripts/lib/ui-runner.mjs");
const { launchChrome, connect, REALGPU } = await import(G + "/scripts/lib/cdp.mjs");
const { createNetStore, UA } = await import(G + "/tests/mlexamples/netstore.mjs");
const { CACHE } = await import(G + "/tests/mlexamples/corpus.mjs");
const [name, expr, waitS = "6"] = process.argv.slice(2);
const PORT = 5255;
const stop = await startVite({ cwd: G, port: PORT, args: ["--config", "tests/mlexamples/vite.config.mjs"], readyUrl: `http://localhost:${PORT}/ref/dist/maplibre-gl.css` });
const ch = await launchChrome({ flags: REALGPU, profilePrefix: "oe-probe", extraArgs: [`--user-agent=${UA}`] });
const cdp = await connect(ch.browserWs);
const store = createNetStore({ dir: path.join(CACHE, "..", "net"), assetsDir: path.join(CACHE, "assets"), mode: "replay" });
const { targetId } = await cdp.call("Target.createTarget", { url: "about:blank" });
const { sessionId: page } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
const logs = [];
cdp.on(m => { if (m.method === "Fetch.requestPaused" && m.sessionId === page) store.handle(cdp, page, m.params); if (m.method === "Runtime.consoleAPICalled") logs.push(m.params.type + ": " + m.params.args.map(a => a.value ?? a.description).join(" ").slice(0, 200)); if (m.method === "Runtime.exceptionThrown") logs.push("EXC: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200)); });
const on = (mm, p = {}) => cdp.call(mm, p, { session: page });
await on("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
await on("Page.enable"); await on("Runtime.enable");
await on("Fetch.enable", { patterns: [{ urlPattern: "https://*" }] });
await on("Page.navigate", { url: `http://localhost:${PORT}/ortho/test/examples/${name}.html` });
await new Promise(r => setTimeout(r, +waitS * 1000));
const r = await on("Runtime.evaluate", { expression: `(async () => { const X = window.__mlx, m = X.maps[0], eng = X.engines[0]; return JSON.stringify(await (${expr})); })()`, awaitPromise: true, returnByValue: true });
const shot = await on("Page.captureScreenshot", { format: "png" }); (await import("node:fs")).writeFileSync(path.join(CACHE, "..", "probe.png"), Buffer.from(shot.data, "base64"));
console.log(r.result?.value ?? JSON.stringify(r.exceptionDetails?.exception?.description));
console.log(logs.filter(l => /error|EXC|label|warn/i.test(l) || !/\[boot\]|\[terrain\]|\[render\]|\[vite\]/.test(l)).slice(0, 30).join("\n"));
cdp.close(); await ch.close(); stop(); process.exit(0);
