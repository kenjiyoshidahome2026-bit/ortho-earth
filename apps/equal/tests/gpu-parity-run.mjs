// gpu-parity.html を headless Chromium で回す（WebGPU＝SwiftShader の Vulkan）＝`npm run verify:gpu`（apps/equal）。
//   node tests/gpu-parity-run.mjs [url] [png の出力先]　CHROME_PATH＝Chromium の実行ファイル（省略時は playwright 既定）
// 器は自分で起こす（2026-10-03・関門の最適化 段 3）：url を渡さなければ VEQ_PORT（既定 5199＝dev の 5198 と別口）に vite を立てて終わったら止める
//   ＝旧「先に npm run dev を起こしておく」の手順が要らない（他の verify-* と同じ作法＝走らせ台は globe の ui-runner）。url を渡せば従来どおりそこを叩く。
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startVite } from "@ortho-earth/globe/scripts/lib/ui-runner.mjs";
const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = +process.env.VEQ_PORT || 5199;
const own = !process.argv[2];
const stop = own ? await startVite({ cwd: APP, port: PORT, portEnv: "VEQ_PORT", readyUrl: `http://localhost:${PORT}/tests/gpu-parity.html` }) : () => {};
const url = process.argv[2] || `http://localhost:${PORT}/tests/gpu-parity.html`, dir = process.argv[3];
const exe = process.env.CHROME_PATH;
const icd = exe && path.join(path.dirname(exe), "vk_swiftshader_icd.json");
const b = await chromium.launch({
	executablePath: exe, env: { ...process.env, ...(icd && fs.existsSync(icd) ? { VK_ICD_FILENAMES: icd } : {}) },
	args: ["--no-sandbox", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-vulkan=swiftshader", "--use-webgpu-adapter=swiftshader", "--ignore-gpu-blocklist", "--use-angle=vulkan"],
});
const p = await b.newPage();
p.on("pageerror", e => console.log("pageerror:", e.message));
await p.goto(url);
await p.waitForFunction(() => window.__parity, null, { timeout: 120000 });
const r = await p.evaluate(() => window.__parity);
if (dir && r.shots) { fs.mkdirSync(dir, { recursive: true }); r.shots.forEach((s, i) => ["gl", "gpu", "diff"].forEach(k => fs.writeFileSync(`${dir}/${i}-${k}.png`, Buffer.from(s[k].split(",")[1], "base64")))); }
for (const s of r.scenes) console.log(s.ok ? "ok  " : "NG  ", JSON.stringify({ ...s, ok: undefined }));
if (r.error) console.log(r.error);
await b.close();
stop();
process.exit(r.ok ? 0 : 1);
