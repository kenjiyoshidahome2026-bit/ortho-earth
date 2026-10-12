// plugin 契約・registry・capabilities の単体検定（拡張点の整備・第 2 波 PR-F0・2026-10-12・src/plugin.js）。偽の map を相手に DOM 無しで。
// 使い方：node packages/globe/tests/plugin.mjs
import { definePlugin, createPluginHost, STATIC_CAPABILITIES } from "../src/plugin.js";

let bad = 0, n = 0;
const ok = (name, cond, note = "") => { n++; if (!cond) { bad++; console.log(`✗ ${name}${note ? ` (${note})` : ""}`); } };
const throws = f => { try { f(); return false; } catch { return true; } };

// definePlugin の検札
ok("define.needsName", throws(() => definePlugin({ install() {} })));
ok("define.badName", throws(() => definePlugin({ name: "1bad name", install() {} })));
ok("define.needsInstall", throws(() => definePlugin({ name: "a" })));
ok("define.frozen", Object.isFrozen(definePlugin({ name: "a.b-c_1", install() {} })));

// 偽の map と host
const gadgets = {}; const map = { gadget: Object.assign((name, fn) => { gadgets[name] = fn; map.gadget[name] = fn; }, gadgets) };
const coreFormats = new Map([["mvt", 1], ["geopbf", 1]]);
const host = createPluginHost(map, {
	getBackend: () => "webgl2", gadgetNames: () => Object.keys(map.gadget), defineGadget: (name, fn) => map.gadget(name, fn), removeGadget: name => { delete map.gadget[name]; },
	tileFormats: { register: sp => { if (coreFormats.has(sp.name)) throw new Error("dup"); coreFormats.set(sp.name, sp); }, has: k => coreFormats.has(k), names: () => [...coreFormats.keys()] },
	builtinTileFormats: [...coreFormats.keys()], pointcloud: {}, builtinDataKinds: ["points", "arcs", "trips", "polygons", "paths", "columns"], builtinPostEffects: ["bloom", "vignette"], builtinLights: ["directional", "point", "spot", "ambient", "hemisphere", "ibl"],
});
Object.assign(map, { use: host.use, unuse: host.unuse, plugins: host.plugins, registry: host.registry, supports: host.supports, capabilities: host.capabilities });
map.gadget("compass", () => "c");

// 静的な表の形
for (const [k, v] of Object.entries(STATIC_CAPABILITIES)) ok(`static.${k}`, ["builtin", "plugin", "spec", "no", "never"].includes(v.status) && typeof v.note === "string");
const c0 = map.capabilities();
ok("cap.mercatorNever", c0["projection.mercator"].status === "never" && !map.supports("projection.mercator"));
ok("cap.globe", map.supports("projection.globe"));
ok("cap.webgl2", c0["render.webgl2"].status === "builtin" && c0["render.webgpu"].status === "no");
ok("cap.dataBuiltin", map.supports("data.points") && map.supports("data.columns") && !map.supports("data.splat"));
ok("cap.gadgetLive", map.supports("gadget.compass"), JSON.stringify(c0["gadget.compass"]));
ok("cap.tiles", map.supports("tiles.mvt") && !map.supports("tiles.ktx2"));
ok("cap.postBuiltin", map.supports("post.bloom") && !map.supports("post.ssr"));
ok("cap.lightBuiltin", map.supports("light.directional") && !map.supports("light.point") && c0["light.point"].status === "spec");
ok("cap.laz", !map.supports("pointcloud.laz"));
ok("cap.unknown", !map.supports("nonsense.key"));

// plugin の搭載＝dataKinds・gadgets・tileFormats・postEffects（spec）に登録
let installed = 0, removed = 0;
const P = definePlugin({
	name: "demo", version: "0.1", provides: ["data.squares"],
	install(m, o) {
		installed++;
		ok("install.rawMap", m === map && o.size === 3);
		m.registry.dataKinds.add("squares", { create: (mm, data, opts) => ({ id: opts.id, kind: opts.kind, n: data.length }) });
		m.registry.gadgets.add("hello", function () { return "hi"; });
		m.registry.tileFormats.add("fakefmt", { decode: () => ({}) });
		m.registry.postEffects.add("fxaa", { pass: true });
		m.registry.lights.add("laser", { apply() {} });
		ok("reg.lightNeedsApply", throws(() => m.registry.lights.add("laser2", { kind: "x" })) && throws(() => m.registry.lights.add("point", { apply() {} })));
		return () => { removed++; };
	},
});
map.use(P, { size: 3 });
ok("use.installed", installed === 1 && map.plugins().length === 1 && map.plugins()[0].name === "demo" && map.plugins()[0].version === "0.1");
ok("use.dup", throws(() => map.use(P)));
ok("reg.dataKind", map.registry.dataKinds.has("squares") && map.registry.dataKinds.ownerOf("squares") === "demo" && !map.registry.dataKinds.isBuiltin("squares"));
ok("reg.dataKindBuiltinLocked", throws(() => map.registry.dataKinds.add("points", { create() {} })) && throws(() => map.registry.dataKinds.remove("points")));
ok("reg.gadgetWired", typeof map.gadget.hello === "function" && map.gadget.hello() === "hi" && map.registry.gadgets.has("hello"));
ok("reg.gadgetDupBuiltin", throws(() => map.registry.gadgets.add("compass", () => 0)));
ok("reg.tileFormatWired", coreFormats.has("fakefmt") && map.registry.tileFormats.ownerOf("fakefmt") === "demo");
ok("reg.tileFormatNoRemove", throws(() => map.registry.tileFormats.remove("fakefmt")));
const c1 = map.capabilities();
ok("cap.pluginData", c1["data.squares"].status === "plugin" && c1["data.squares"].via === "demo" && map.supports("data.squares"));
ok("cap.pluginGadget", c1["gadget.hello"].status === "plugin" && map.supports("gadget.hello"));
ok("cap.pluginTiles", c1["tiles.fakefmt"].status === "plugin");
ok("cap.specPost", c1["post.fxaa"].status === "spec" && !map.supports("post.fxaa") && /PR-F3/.test(c1["post.fxaa"].note), JSON.stringify(c1["post.fxaa"]));
ok("cap.pluginLight", c1["light.laser"].status === "plugin" && c1["light.laser"].via === "demo" && map.supports("light.laser"));
ok("reg.notWired", map.registry.postEffects.wired === false && map.registry.lights.wired === true && map.registry.dataKinds.wired === true);

// 撤去＝cleanup が呼ばれ・自分の登録が消える（tileFormats は process-wide＝残るが capabilities からは外れる）
ok("unuse", map.unuse("demo") === true && removed === 1 && map.plugins().length === 0);
ok("unuse.dropsOwned", !map.registry.dataKinds.has("squares") && !map.registry.postEffects.has("fxaa") && !map.registry.lights.has("laser") && !map.registry.gadgets.has("hello"));
ok("unuse.tileFormatStays", coreFormats.has("fakefmt") && !map.registry.tileFormats.has("fakefmt"));
ok("unuse.again", map.unuse("demo") === false);
ok("cap.afterUnuse", !map.supports("data.squares") && map.capabilities()["post.fxaa"].status === "no");   // 静的な表の「no」へ戻る

// install が投げたら登録は巻き戻す・搭載されない
ok("use.throwRollsBack", throws(() => map.use({ name: "boom", install(m) { m.registry.dataKinds.add("x", { create() {} }); throw new Error("boom"); } })) && !map.registry.dataKinds.has("x") && map.plugins().length === 0);
// 素の object も受ける・uninstall が優先
let un = 0;
map.use({ name: "plain", install() { return () => { un += 10; }; }, uninstall() { un += 1; } });
map.unuse({ name: "plain" }); ok("uninstallWins", un === 1);
// destroy＝全部撤去（逆順）
const order = [];
map.use({ name: "a", install() { return () => order.push("a"); } }); map.use({ name: "b", install() { return () => order.push("b"); } });
host.destroy(); ok("destroy.reverse", order.join("") === "ba" && map.plugins().length === 0);

console.log(bad ? `plugin: ${bad}/${n} problem(s)` : `✓ plugin PASS（${n} 件）`);
process.exit(bad ? 1 : 0);
