// MapLibre の口の remove() の後始末の検定（2026-11-16）。エンジン（../globe.ts）を偽物に差し替え、rAF を手で回す。
// 確かめること：on("render") の rAF の鎖が remove() で止まる・聞き手が空になる・壊した地図へ render を出さない・
// 起動中の remove() は出来たエンジンを畳み load を出さない・2 度呼んでも 1 度と同じ・DOM の聞き手が外れる。
// 使い方：node packages/globe/tests/mlremove.mjs
import { registerHooks } from "node:module";

// ── 偽のエンジン ──
const engines = [];
let loadGate = null;   // 値があれば once("load") はそれを待つ
globalThis.__fakeCreateGlobe = async () => {
	const e = { destroyed: 0 };
	engines.push(e);
	return new Proxy(e, { get: (o, k) => k in o ? o[k]
		: k === "destroy" ? () => { o.destroyed++; }
		: k === "once" ? () => loadGate ?? Promise.resolve()
		: k === "getZoom" || k === "getBearing" || k === "getPitch" || k === "getRoll" ? () => 0
		: k === "getCenter" ? () => ({ lng: 0, lat: 0 })
		: k === "then" ? undefined
		: () => undefined });
};
registerHooks({
	resolve(spec, ctx, next) {
		if (spec === "../globe.ts" && ctx.parentURL?.endsWith("/maplibre/map.ts")) return { url: "data:text/javascript,export const createGlobe = o => globalThis.__fakeCreateGlobe(o); export class Marker {} export class Popup {}", shortCircuit: true };
		return next(spec, ctx);
	},
});

// ── 頁の偽物（rAF は手で回す）──
let rafQ = new Map(), rafId = 0;
globalThis.requestAnimationFrame = fn => { rafQ.set(++rafId, fn); return rafId; };
globalThis.cancelAnimationFrame = id => { rafQ.delete(id); };
const frame = () => { const q = rafQ; rafQ = new Map(); for (const fn of q.values()) fn(performance.now()); };
const win = new EventTarget(); let winAdds = 0, winLive = 0;
const wAdd = win.addEventListener.bind(win);
win.addEventListener = (t, fn, o) => { winAdds++; winLive++; o?.signal?.addEventListener("abort", () => winLive--); return wAdd(t, fn, o); };
globalThis.window = win;
globalThis.CustomEvent ??= class extends Event { constructor(t, o) { super(t, o); this.detail = o?.detail; } };
globalThis.document = { getElementById: () => null, createElement: () => ({ style: {}, appendChild() {} }) };
const container = () => Object.assign(new EventTarget(), { appendChild() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) });

const { Map: MLMap } = await import("../src/maplibre/map.ts");

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const settle = () => new Promise(r => setTimeout(r, 0));

// 1. 読み込み後の render の鎖が remove() で止まる
{
	const map = new MLMap({ container: container() });
	await map.once("load");
	let renders = 0, removes = 0;
	map.on("render", () => renders++);
	map.on("remove", () => removes++);
	frame(); frame(); frame();
	ok("render の鎖が毎フレーム render を出す", renders === 3, `renders=${renders}`);
	ok("window の聞き手が付いている", winLive > 0, `live=${winLive}`);
	map.remove();
	ok("remove() で rAF の予約が空になる", rafQ.size === 0, `queued=${rafQ.size}`);
	const before = renders;
	frame(); frame();
	ok("remove() 後は render を出さない", renders === before, `renders=${renders}`);
	ok("remove の事象は 1 度届く", removes === 1);
	ok("remove() 後は聞き手が空（listens）", !map.listens("render") && !map.listens("remove"));
	ok("エンジンを 1 度だけ畳む", engines.at(-1).destroyed === 1);
	ok("window の聞き手が外れる", winLive === 0, `live=${winLive}`);
	map.remove();
	ok("2 度目の remove() は何もしない（畳むのも remove の事象も 1 度）", engines.at(-1).destroyed === 1 && removes === 1);
	map.on("render", () => renders++);
	frame();
	ok("remove() 後の on(\"render\") は鎖を始めない", rafQ.size === 0 && renders === before);
	ok("remove() 後は isStyleLoaded() が false", map.isStyleLoaded() === false);
}

// 2. 地図を作っては外す（SPA）＝鎖が溜まらない
{
	for (let i = 0; i < 5; i++) {
		const map = new MLMap({ container: container() });
		await map.once("load");
		map.on("render", () => {});
		frame();
		map.remove();
	}
	ok("5 回作って外しても rAF の予約は 0", rafQ.size === 0, `queued=${rafQ.size}`);
	frame();
	ok("…次のフレームも 0", rafQ.size === 0);
}

// 3. 起動中（load の前）の remove()
{
	let release; loadGate = new Promise(r => { release = r; });
	const map = new MLMap({ container: container() });
	let loads = 0, renders = 0;
	map.on("load", () => loads++);
	map.on("render", () => renders++);
	await settle();   // createGlobe は済み・load を待っている
	const eng = engines.at(-1);
	map.remove();
	ok("load 前の remove() でも鎖を止める", rafQ.size === 0);
	ok("load 前の remove() でエンジンを畳む", eng.destroyed === 1);
	release(); await settle(); await settle();
	ok("load 前に remove() した地図は load を出さない", loads === 0 && map.isStyleLoaded() === false);
	frame();
	ok("…render も出さない", renders === 0);
	loadGate = null;
}

// 4. createGlobe が返る前の remove()＝出来たエンジンをすぐ畳む
{
	const n = engines.length;
	const map = new MLMap({ container: container() });
	map.remove();   // createGlobe の Promise はまだ返っていない
	await settle(); await settle();
	ok("作り終わる前の remove()＝出来たエンジンをすぐ畳む", engines.length === n + 1 && engines.at(-1).destroyed === 1);
}

console.log(fail ? `\n${fail} FAIL` : "\nall PASS");
process.exit(fail ? 1 : 0);
