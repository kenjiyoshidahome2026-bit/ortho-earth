// Reads Cesium's dynamic environment maps on the reference pages: for every tileset or model with an environmentMapManager, its position,
// the irradiance SH coefficients and the mean of each radiance cube face (RGBA8, so out-of-range or NaN radiance shows up here).
// Needs the example server (see run.mjs). Usage: node packages/globe/tests/csexamples/envprobe.mjs [--gpu] [--wait 30000] <example> [<example> ...]
import { createRequire } from "node:module";
import path from "node:path";
const REPO = path.resolve(import.meta.dirname, "../../../..");
const { chromium } = createRequire(path.join(REPO, "package.json"))("playwright");
const argv = process.argv.slice(2), gpu = argv.includes("--gpu"), wi = argv.indexOf("--wait"), WAIT = wi >= 0 ? +argv[wi + 1] : 30000;
const names = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--wait");
const browser = await chromium.launch({ ...(process.env.CHROME && { executablePath: process.env.CHROME }), args: ["--no-sandbox", "--disable-dev-shm-usage", ...(gpu ? ["--ignore-gpu-blocklist"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])] });
for (const name of names) {
	const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
	await page.goto(`http://localhost:5460/cs/ref/gallery/${name}/`, { timeout: 60000 });
	await page.waitForTimeout(WAIT);
	const out = await page.evaluate(() => {
		const v = window.__csx.viewers[0], gl = v.scene.context._gl, res = { renderer: gl.getParameter(gl.RENDERER), managers: [] };
		const visit = (p, depth) => {
			if (!p || depth > 4) return;
			const m = p.environmentMapManager;
			if (m && !res.managers.some(r => r.m === m)) {
				const r = { m, kind: p.constructor?.name, pos: m._position && [m._position.x, m._position.y, m._position.z].map(Math.round), sh: m.sphericalHarmonicCoefficients?.map(q => [q.x, q.y, q.z].map(x => +x.toFixed(4))), faces: [] };
				const cm = m.radianceCubeMap;
				if (cm) {
					const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
					for (let f = 0; f < 6; f++) {
						gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, cm._texture, 0);
						const w = cm.width, px = new Uint8Array(w * w * 4); gl.readPixels(0, 0, w, w, gl.RGBA, gl.UNSIGNED_BYTE, px);
						const s = [0, 0, 0, 0]; for (let k = 0; k < px.length; k++) s[k % 4] += px[k] / (w * w);
						r.faces.push(s.map(x => Math.round(x)));
					}
					gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb);
				}
				res.managers.push(r);
			}
			if (typeof p.length === "number" && typeof p.get === "function") for (let i = 0; i < p.length; i++) visit(p.get(i), depth + 1);
		};
		visit(v.scene.primitives, 0);
		const c = v.camera; res.camera = { pos: [c.positionWC.x, c.positionWC.y, c.positionWC.z].map(Math.round), dir: [c.directionWC.x, c.directionWC.y, c.directionWC.z].map(x => +x.toFixed(4)), up: [c.upWC.x, c.upWC.y, c.upWC.z].map(x => +x.toFixed(4)) };
		res.managers.forEach(r => delete r.m);
		return res;
	}).catch(e => ({ error: String(e) }));
	console.log(JSON.stringify({ name, ...out }));
	await page.close();
}
await browser.close();
