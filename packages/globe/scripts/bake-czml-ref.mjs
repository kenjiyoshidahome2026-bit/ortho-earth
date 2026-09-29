#!/usr/bin/env node
// CZML の正解表を焼く（#113 段 0）＝tests/t-czml-ref.html?bake=1 を CesiumJS（jsDelivr）で走らせ、答えを tests/fixtures/czml/ref.json に書く。
// 外部（jsDelivr）に依る＝手で回す。試料か Cesium の版を変えた時だけ焼き直す（焼いた表は repo に置く＝関門は手元だけで回る）。
// 使い方: packages/globe で node scripts/bake-czml-ref.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite } from "./lib/ui-runner.mjs";
import { launchChrome, newTab, connect } from "./lib/cdp.mjs";

const PKG = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VGB_PORT || 5251;
const OUT = path.join(PKG, "tests/fixtures/czml/ref.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));

const stop = await startVite({ cwd: PKG, port: PORT, portEnv: "VGB_PORT", readyUrl: `http://localhost:${PORT}/tests/` });
const ch = await launchChrome({ profilePrefix: "og-czmlref" });
try {
	const cdp = await connect((await newTab(ch.port)).webSocketDebuggerUrl);
	await cdp.call("Page.enable"); await cdp.call("Runtime.enable");
	await cdp.call("Page.navigate", { url: `http://localhost:${PORT}/tests/t-czml-ref.html?bake=1` });
	let title = "";
	for (const t0 = Date.now(); Date.now() - t0 < 120e3 && !/^(PASS|FAIL)/.test(title); await sleep(500)) title = (await cdp.send("Runtime.evaluate", { expression: "document.title", returnByValue: true }))?.result?.value || "";
	console.log(title || "no title");
	if (!title.startsWith("PASS")) process.exitCode = 1;
	else {
		const ref = (await cdp.call("Runtime.evaluate", { expression: "JSON.stringify(window.__ref)", returnByValue: true }, { timeoutMs: 30000 })).result.value;
		const j = JSON.parse(ref);
		// 1 標本 1 行（差分が読める）
		const body = JSON.stringify(j, null, "\t").replace(/\[\n\t+([^\[\]]*?)\n\t+\]/g, (m, inner) => "[" + inner.replace(/\n\t+/g, " ") + "]");
		fs.writeFileSync(OUT, body + "\n");
		console.log(`wrote ${path.relative(process.cwd(), OUT)}（${(body.length / 1024).toFixed(0)} KB・Cesium ${j.cesium}）`);
	}
	cdp.close();
} finally { await ch.close(); stop(); }
