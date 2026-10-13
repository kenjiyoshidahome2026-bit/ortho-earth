// 後処理の鎖（src/postchain.js・F3 2026-10-12）＝旧形の写し・既定・順番・enabled・知らない type・plugin の type・renderer へ渡す形
import { normPass, normPostChain, POST_TYPES } from "../src/postchain.js";
let fail = 0; const ok = (name, c, note = "") => { console.log(`${c ? "✓" : "✗"} ${name}${note ? `（${note}）` : ""}`); if (!c) fail++; };
const J = v => JSON.stringify(v);
ok("types", POST_TYPES.join() === "bloom,vignette,fxaa,smaa,tonemap,lut,dof,ssr");
ok("legacy", J(normPostChain({ bloom: true, vignette: { strength: 0.3 } })) === J({ passes: [{ type: "bloom", enabled: true, threshold: 0.75, strength: 0.5, radius: 1 }, { type: "vignette", enabled: true, strength: 0.3, radius: 0.8, softness: 0.5 }], post: { bloom: { threshold: 0.75, strength: 0.5, radius: 1 }, vignette: { strength: 0.3, radius: 0.8, softness: 0.5 } } }), J(normPostChain({ bloom: true, vignette: { strength: 0.3 } })));
ok("null", J(normPostChain(null)) === J({ passes: [], post: null }) && normPostChain([]).post === null);
const c = normPostChain([{ type: "tonemap", mode: "agx" }, { type: "vignette" }, { type: "bloom", strength: 2 }, { type: "fxaa", enabled: false }, "smaa"]);
ok("order", c.passes.map(p => p.type).join() === "tonemap,vignette,bloom,fxaa,smaa");
ok("spec.kept", c.passes[0].mode === "agx" && c.passes[0].exposure === 1 && c.passes[3].enabled === false && c.passes[4].preset === "medium");
ok("post.fromChain", J(c.post) === J({ bloom: { threshold: 0.75, strength: 2, radius: 1 }, vignette: { strength: 0.5, radius: 0.8, softness: 0.5 }, tonemap: { mode: "agx", exposure: 1 } }), J(c.post));
// W1（2026-10-12）：fxaa・tonemap・lut も renderer へ（on の時だけ鍵が生える）。url の無い lut・enabled:false・intensity 0 は渡らない
ok("w1.toRenderer", J(normPostChain([{ type: "fxaa" }, { type: "lut", url: "a.cube", size: 16, intensity: 0.5 }]).post) === J({ bloom: null, vignette: null, fxaa: true, lut: { url: "a.cube", size: 16, intensity: 0.5 } }));
ok("w1.legacy", normPostChain({ tonemap: true, fxaa: true, bloom: true }).passes.map(p => p.type).join() === "fxaa,bloom,tonemap" && normPostChain({ lut: { url: "x.png" } }).post.lut.size === 32);
ok("w1.off", normPostChain([{ type: "fxaa", enabled: false }, { type: "lut" }, { type: "lut", url: "b.png", intensity: 0 }]).post === null && normPostChain([{ type: "tonemap", exposure: 2 }]).post.tonemap.exposure === 2 && normPostChain(["smaa"]).post === null);
ok("disabledBloom", normPostChain([{ type: "bloom", enabled: false }]).post === null);
ok("zeroStrength", normPostChain([{ type: "bloom", strength: 0 }]).post === null && normPostChain([{ type: "bloom", strength: 0 }]).passes[0].strength === 0);
ok("pass.defaults", J(normPass({ type: "dof" })) === J({ type: "dof", enabled: true, focusDistance: 500, focalLength: 50, aperture: 2.8, maxBlur: 8 }) && normPass({ type: "lut" }).url === null && normPass({ type: "ssr", steps: 1000 }).steps === 256);
ok("pass.id", normPass({ id: "a", type: "fxaa" }).id === "a" && normPass("fxaa").type === "fxaa");
ok("pass.unknownNull", normPass({ type: "crt" }) === null);
let threw = false; try { normPostChain([{ type: "crt" }]); } catch { threw = true; } ok("unknownThrows", threw);
ok("plugin.kept", J(normPostChain([{ type: "crt", k: 1 }], t => t === "crt").passes) === J([{ type: "crt", k: 1, enabled: true }]));
console.log(fail ? `postchain: ${fail} failed` : "✓ postchain PASS");
process.exit(fail ? 1 : 0);
