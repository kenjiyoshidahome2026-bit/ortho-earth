// 後処理の鎖（src/postchain.js・F3 2026-10-12）＝旧形の写し・既定・順番・enabled・知らない type・plugin の type・renderer へ渡す形
import { normPass, normPostChain, POST_TYPES } from "../src/postchain.ts";
let fail = 0; const ok = (name, c, note = "") => { console.log(`${c ? "✓" : "✗"} ${name}${note ? `（${note}）` : ""}`); if (!c) fail++; };
const J = v => JSON.stringify(v);
ok("types", POST_TYPES.join() === "bloom,vignette,fxaa,smaa,tonemap,lut,dof,ssr,silhouette,grey,brightness,nightVision,glsl,lensFlare,depthOfField,cesiumBloom");
// 画面の段（Cesium の postProcessStages 相当・2026-10-28）＝既定・並び順・renderer へは stages として・glsl の uniforms の選別・src の無い glsl は落ちる
{
	const st = normPostChain([{ type: "silhouette", color: [1, 1, 0], length: 0.5 }, { type: "grey", gradations: 3 }, { type: "brightness" }, { type: "nightVision", enabled: false }, { type: "glsl", src: "void main(){}", uniforms: { a: 1, b: [1, 2], c: true, d: "x", "1e": 2 } }]);
	ok("stage.defaults", J(st.passes[0]) === J({ type: "silhouette", enabled: true, color: [1, 1, 0, 1], length: 0.5 }) && st.passes[2].value === 0.5);
	ok("stage.toRenderer", J(st.post.stages) === J([{ type: "silhouette", color: [1, 1, 0, 1], length: 0.5 }, { type: "grey", gradations: 3 }, { type: "brightness", value: 0.5 }, { type: "glsl", src: "void main(){}", uniforms: { a: 1, b: [1, 2], c: true } }]) && st.post.bloom === null);
	ok("stage.glslNoSrc", normPass({ type: "glsl" }) === null && normPostChain([{ type: "nightVision", enabled: false }]).post === null);
}
// レンズフレア・被写界深度（2026-10-28）＝既定・URL・数の並びの形
{
	const st = normPostChain([{ type: "lensFlare", sun: [0.1, 0.2], earth: [0, 0, 0.4], camrot: 1, dirt: "d.jpg", star: "" }, { type: "depthOfField", focalDistance: 87, sigma: 3.78, earth: [0, 0, -2e7, 6378137], tan: [1, 1, 1] }]).post.stages;
	ok("stage.lensFlare", J(st[0]) === J({ type: "lensFlare", intensity: 2, distortion: 10, ghostDispersal: 0.4, haloWidth: 0.4, dirtAmount: 0.4, sun: [0.1, 0.2], earth: [0, 0, 0.4], space: true, camrot: 1, dirt: "d.jpg" }), J(st[0]));
	ok("stage.depthOfField", J(st[1]) === J({ type: "depthOfField", focalDistance: 87, delta: 1, sigma: 3.78, stepSize: 1, near: 1, far: 5e8, earth: [0, 0, -2e7, 6378137] }), J(st[1]));
	const cb = normPostChain([{ type: "cesiumBloom", contrast: 128, brightness: -0.3, sigma: 3.78, stepSize: 5, glowOnly: 1 }]).post.stages[0];
	ok("stage.cesiumBloom", J(cb) === J({ type: "cesiumBloom", contrast: 128, brightness: -0.3, delta: 1, sigma: 3.78, stepSize: 5, glowOnly: false }), J(cb));
}
ok("legacy", J(normPostChain({ bloom: true, vignette: { strength: 0.3 } })) === J({ passes: [{ type: "bloom", enabled: true, threshold: 0.75, strength: 0.5, radius: 1 }, { type: "vignette", enabled: true, strength: 0.3, radius: 0.8, softness: 0.5 }], post: { bloom: { threshold: 0.75, strength: 0.5, radius: 1 }, vignette: { strength: 0.3, radius: 0.8, softness: 0.5 } }, ssr: null }), J(normPostChain({ bloom: true, vignette: { strength: 0.3 } })));
ok("null", J(normPostChain(null)) === J({ passes: [], post: null, ssr: null }) && normPostChain([]).post === null);
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
{	// SSR（2026-11-01・WebGPU）＝既定・範囲・renderer への形（"post" とは別の ssr）・映す面が無い／強さ 0／off は null
	const d = normPass({ type: "ssr" });
	ok("ssr.defaults", J(d) === J({ type: "ssr", enabled: true, intensity: 1, maxDistance: 2000, thickness: 2, steps: 32, ocean: 0.5, ground: 0, facades: 0 }));
	const c = normPostChain([{ type: "ssr", ground: 0.3, facades: 2, ocean: -1, intensity: 0.8 }, { type: "fxaa" }]);
	ok("ssr.chain", J(c.ssr) === J({ intensity: 0.8, maxDistance: 2000, thickness: 2, steps: 32, ocean: 0, ground: 0.3, facades: 1 }) && c.post.fxaa === true && !("ssr" in c.post));
	ok("ssr.off", normPostChain([{ type: "ssr", enabled: false }]).ssr === null && normPostChain([{ type: "ssr", ocean: 0 }]).ssr === null && normPostChain([{ type: "ssr", intensity: 0 }]).ssr === null && normPostChain(null).ssr === null && normPostChain([{ type: "ssr" }]).post === null);
}
ok("pass.id", normPass({ id: "a", type: "fxaa" }).id === "a" && normPass("fxaa").type === "fxaa");
ok("pass.unknownNull", normPass({ type: "crt" }) === null);
let threw = false; try { normPostChain([{ type: "crt" }]); } catch { threw = true; } ok("unknownThrows", threw);
ok("plugin.kept", J(normPostChain([{ type: "crt", k: 1 }], t => t === "crt").passes) === J([{ type: "crt", k: 1, enabled: true }]));
console.log(fail ? `postchain: ${fail} failed` : "✓ postchain PASS");
process.exit(fail ? 1 : 0);
