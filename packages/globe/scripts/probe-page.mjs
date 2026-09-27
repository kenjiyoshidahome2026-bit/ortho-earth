// 検定の頁（tests/t-mlcompat.html?g=<group>）を実 GPU の Chrome で開き、待ってから式を評価して返す＝場面の切り分け（verify-ui を全部回さずに 1 点を覗く）。
// 使い方: node scripts/probe-page.mjs <group> '<式>' [待ち秒=15]   式の中で map＝window.__map（頁が置く）・sleep(ms)・window.__placed()/__placedDebug()/__idleWhy()/__labelsMain()（debugGlobals の頁）
// 例: node scripts/probe-page.mjs vector '(async () => { map.setLayerZoomRange("poi-lbl", 0, 24); await sleep(3000); return (await window.__placed()).length; })()' 12
import path from "node:path"; import { fileURLToPath } from "node:url";
const G = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");   // packages/globe
const { startVite } = await import(G + "/scripts/lib/ui-runner.mjs");
const { launchChrome, connect, REALGPU } = await import(G + "/scripts/lib/cdp.mjs");
const [group, expr, waitS = "15"] = process.argv.slice(2);
const PORT = 5277;
const stop = await startVite({ cwd: G, port: PORT, readyUrl: `http://localhost:${PORT}/tests/` });
const ch = await launchChrome({ flags: REALGPU, profilePrefix: "oe-probe-test" });
const cdp = await connect(ch.browserWs);
const { targetId } = await cdp.call("Target.createTarget", { url: "about:blank" });
const { sessionId: page } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
const logs = [];
cdp.on(m => { if (m.method === "Runtime.consoleAPICalled" && m.sessionId === page) logs.push(m.params.type + ": " + m.params.args.map(a => a.value ?? a.description).join(" ").slice(0, 160)); if (m.method === "Runtime.exceptionThrown") logs.push("EXC: " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text).slice(0, 200)); });
const on = (mm, p = {}) => cdp.call(mm, p, { session: page });
await on("Emulation.setDeviceMetricsOverride", { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false });
await on("Page.enable"); await on("Runtime.enable");
await on("Page.navigate", { url: `http://localhost:${PORT}/tests/t-mlcompat.html?g=${group}&gl2=1` });
await new Promise(r => setTimeout(r, +waitS * 1000));
const r = await on("Runtime.evaluate", { expression: `(async () => { const map = window.__map; const sleep = ms => new Promise(r => setTimeout(r, ms)); return JSON.stringify(await (${expr})); })()`, awaitPromise: true, returnByValue: true });
console.log(r.result?.value ?? JSON.stringify(r.exceptionDetails?.exception?.description));
console.log(logs.filter(l => /label|symbol|poi|EXC|error/i.test(l)).slice(0, 20).join("\n"));
cdp.close(); await ch.close(); stop(); process.exit(0);
