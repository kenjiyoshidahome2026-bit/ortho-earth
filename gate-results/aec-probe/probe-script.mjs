import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(process.cwd() + "/package.json");
const { chromium } = require("playwright");
const [OUT, PHASE] = process.argv.slice(2);
const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--no-sandbox", "--disable-dev-shm-usage", "--ignore-gpu-blocklist"] });
const points = JSON.parse(process.argv[4] || "{}");
const out = {};
for (const n of ["aec-architectural-design", "aec-snapping"]) for (const side of ["ref", "ortho"]) {
  const p = await b.newPage({ viewport: { width: 800, height: 600 } });
  await p.goto(`http://localhost:5460/cs/${side}/gallery/${n}/`);
  await p.waitForTimeout(60000);
  await p.screenshot({ path: `${OUT}/${n}-${side}.png` });
  if (PHASE === "shot") { await p.close(); continue; }
  const pts = points[n] || [];
  out[`${n}/${side}`] = await p.evaluate(({ side, pts }) => {
    const v = window.__csx.viewers[0], s = v.scene, C = window.__csx.Cesium;
    const tail = u => String(u || "").replace(/\?.*$/, "").split("/").slice(-3).join("/");
    const tilesets = [];
    for (let i = 0; i < s.primitives.length; i++) { const q = s.primitives.get(i); if (!q) continue; const url = q._url || q.url || q.resource?.url; if (q.constructor?.name !== "Cesium3DTileset" && !("tilesLoaded" in q)) continue; if (side === "ref") tilesets.push({ url: tail(url), trianglesSelected: q.statistics?.numberOfTrianglesSelected, show: q.show }); else { const st = q.orthoHandle?.stats; tilesets.push({ url: tail(url), stats: st ? { shown: st.shown, loaded: st.loaded, triangles: st.triangles, complete: st.complete, inflight: st.inflight, sseScale: st.sseScale, gpuMB: st.gpuMB } : null }); } }
    const mat = m => { if (!m) return null; const o = { alphaMode: m.alphaMode, doubleSided: m.doubleSided, unlit: m.unlit }; const mr = m.metallicRoughness; if (mr) Object.assign(o, { baseColorFactor: mr.baseColorFactor && [mr.baseColorFactor.x, mr.baseColorFactor.y, mr.baseColorFactor.z, mr.baseColorFactor.w].map(x => +(+x).toFixed(3)), baseColorTexture: !!mr.baseColorTexture, metallicFactor: mr.metallicFactor, roughnessFactor: mr.roughnessFactor }); if (m.emissiveFactor) o.emissiveFactor = [m.emissiveFactor.x, m.emissiveFactor.y, m.emissiveFactor.z]; for (const k of ["specular", "clearcoat", "transmission", "specularGlossiness", "anisotropy", "sheen", "iridescence"]) if (m[k]) o[k] = JSON.parse(JSON.stringify(m[k], (kk, vv) => (vv && typeof vv === "object" && vv.constructor && /Texture|Sampler/.test(vv.constructor.name)) ? "[texture]" : vv)); return o; };
    const picks = pts.map(([x, y]) => {
      let f; try { f = s.pick(new C.Cartesian2(x, y)); } catch (e) { return { x, y, err: String(e.message) }; }
      if (!f) return { x, y, hit: null };
      const r = { x, y };
      const ts = f.tileset || f.primitive; r.tileset = tail(ts?._url || ts?.url || ts?.resource?.url);
      try { const ids = f.getPropertyIds ? f.getPropertyIds() : []; const props = {}; for (const k of ids) props[k] = f.getProperty(k); r.props = JSON.stringify(props).slice(0, 300); } catch (e) { r.propsErr = String(e.message); }
      if (side === "ref") { try { const model = f.content?._model; const nodes = model?._sceneGraph?._components?.nodes || []; const mats = []; const seen = new Set(); for (const nd of nodes) for (const pr of nd.primitives || []) { const m = pr.material; const k = JSON.stringify(mat(m)); if (!seen.has(k)) { seen.add(k); mats.push(mat(m)); } } r.materials = mats.slice(0, 6); r.materialCount = seen.size; } catch (e) { r.matErr = String(e.message); } }
      return r;
    });
    return { tilesets, picks };
  }, { side, pts });
  await p.close();
}
if (PHASE !== "shot") fs.writeFileSync(`${OUT}/probe.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out).slice(0, 200));
await b.close();
