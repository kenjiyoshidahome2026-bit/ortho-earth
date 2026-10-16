// @ortho-earth/google-tiles（W8）＝key の付与・session の引き回し・よその host は触らない・出典・add3DTiles への受け渡し・plugin の形（DOM 無し）
import { googleRequestTransform, googleAttribution, addGoogle3DTiles, googleTilesPlugin, GOOGLE_3D_TILES_ROOT } from "../src/index.ts";
let fails = 0; const ok = (n, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${n}${info ? " " + info : ""}`); if (!c) fails++; };
const throws = f => { try { f(); return false; } catch { return true; } };
const K = "TEST_KEY";
{
	const rt = googleRequestTransform({ key: K });
	const r0 = rt(GOOGLE_3D_TILES_ROOT, "Source");
	ok("key.root", r0 && new URL(r0.url).searchParams.get("key") === K && !new URL(r0.url).searchParams.has("session") && rt.session === null, r0?.url);
	// 子の tileset の URI に session（Google が root.json の中で渡す）→ 覚える
	const r1 = rt("https://tile.googleapis.com/v1/3dtiles/datasets/CgA/files/UlRPVEYu.json?session=S1", "Source");
	ok("session.seen", rt.session === "S1" && new URL(r1.url).searchParams.get("session") === "S1" && new URL(r1.url).searchParams.get("key") === K);
	// その中の相対 URI（session 無し）→ 足す
	const r2 = rt("https://tile.googleapis.com/v1/3dtiles/datasets/CgA/files/AbC.glb", "Tile");
	const u2 = new URL(r2.url);
	ok("session.carried", u2.searchParams.get("session") === "S1" && u2.searchParams.get("key") === K && u2.pathname.endsWith("/AbC.glb"), r2.url);
	// 新しい session が来たら替える・既に key がある URL は二重にしない
	const r3 = rt(`https://tile.googleapis.com/v1/3dtiles/x.json?session=S2&key=${K}`, "Source");
	ok("session.updated", rt.session === "S2" && new URL(r3.url).searchParams.getAll("key").length === 1);
	// よその host＝null（触らない＝key が漏れない）・壊れた URL も null
	ok("foreignHost", rt("https://example.com/a.glb", "Tile") === null && rt("not a url", "Tile") === null);
	ok("hosts", googleRequestTransform({ key: K, hosts: ["localhost:5173"] })("http://localhost:5173/t/root.json")?.url.includes("key=TEST_KEY") && googleRequestTransform({ key: K, hosts: ["localhost:5173"] })(GOOGLE_3D_TILES_ROOT) === null);
	ok("initialSession", new URL(googleRequestTransform({ key: K, session: "S0" })("https://tile.googleapis.com/a.glb").url).searchParams.get("session") === "S0");
	ok("noKeyThrows", throws(() => googleRequestTransform({})) && throws(() => googleTilesPlugin({})));
}
ok("attribution", googleAttribution(["Data SIO, NOAA", "Landsat / Copernicus", "Google"]) === "Google; Data SIO, NOAA; Landsat / Copernicus" && googleAttribution() === "Google" && googleAttribution(["  ", "google"]) === "Google");
// add3DTiles への受け渡し（偽の map）
{
	let got = null;
	const map = { add3DTiles: async (url, opts) => { got = { url, opts }; return { id: opts.id }; } };
	const h = await addGoogle3DTiles(map, { key: K, maxSSE: 8, fit: false });
	ok("add.args", h.id === "google-3d" && got.url === GOOGLE_3D_TILES_ROOT && got.opts.maxSSE === 8 && got.opts.fit === false && typeof got.opts.requestTransform === "function" && got.opts.attribution === googleAttribution);
	ok("add.key", new URL(got.opts.requestTransform(GOOGLE_3D_TILES_ROOT).url).searchParams.get("key") === K);
	await addGoogle3DTiles(map, { key: K, root: "http://localhost:9999/fake/root.json", id: "g2" });
	ok("add.localRoot", got.opts.id === "g2" && got.opts.requestTransform("http://localhost:9999/fake/a.json")?.url.includes("key=") && got.opts.requestTransform(GOOGLE_3D_TILES_ROOT) === null);
	ok("add.noMap", throws(() => addGoogle3DTiles({}, { key: K })));
}
// plugin の形：registry.gadgets に関数を足す（本体は map が第 1 引数＝registerGadget の形）
{
	const added = new Map(), calls = [];
	const map = { registry: { gadgets: { add: (n, f) => added.set(n, f) } }, add3DTiles: async (url, opts) => { calls.push({ url, opts }); return {}; } };
	const p = googleTilesPlugin({ key: K, maxSSE: 12 });
	p.install(map);
	await added.get("googleTiles")(map, { fit: false });
	ok("plugin", p.name === "google-tiles" && added.has("googleTiles") && calls[0].opts.maxSSE === 12 && calls[0].opts.fit === false && calls[0].url === GOOGLE_3D_TILES_ROOT);
}
if (fails) { console.error(`${fails} failed`); process.exit(1); } else console.log("ALL PASS google-tiles");
