// 外来の標高ソース（dem-src.ts・qmesh-src.ts）の spec の正規化と、取得なしで決まる口（covers・範囲外の height／cell）の検定。
// タイルの取得と解読（fetch・createImageBitmap・OffscreenCanvas）はブラウザ側＝ここでは fetch を偽物に替えて「呼ばない」ことを見る。
import { normalizeDemSpec, createDemSource } from "../src/dem-src.ts";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const throws = f => { try { f(); return false; } catch { return true; } };
let fetched = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { fetched++; return new Response("", { status: 404 }); };
const warn = console.warn; console.warn = () => {};

// ── normalizeDemSpec ──
{
	const s = normalizeDemSpec({ tiles: ["https://a/{z}/{x}/{y}.png"] });
	ok("既定：terrarium・256px・z0..14・bounds なし・dtm false・credentials omit", s.encoding === "terrarium" && s.tileSize === 256 && s.minzoom === 0 && s.maxzoom === 14 && s.bounds === null && s.dtm === false && s.credentials === "omit" && s.headers === null && s.cellZoom === null);
	ok("既定：custom の係数 1/1/1/0（MapLibre と同じ）", s.redFactor === 1 && s.greenFactor === 1 && s.blueFactor === 1 && s.baseShift === 0);
	const b = [130, 30, 140, 40], t = normalizeDemSpec({ tiles: ["u"], encoding: "mapbox", tileSize: 512, minzoom: 2, maxzoom: 0, bounds: b, dtm: 1, cellZoom: 11, headers: { A: "1" }, credentials: "include", redFactor: 0, baseShift: -5 });
	ok("指定はそのまま（maxzoom 0・redFactor 0 も ?? で残る）", t.encoding === "mapbox" && t.tileSize === 512 && t.minzoom === 2 && t.maxzoom === 0 && t.dtm === true && t.cellZoom === 11 && t.headers.A === "1" && t.credentials === "include" && t.redFactor === 0 && t.baseShift === -5);
	ok("bounds は写し（元を書き換えても変わらない）", t.bounds.join() === b.join() && t.bounds !== b);
	ok("bounds が 4 つでなければ null", normalizeDemSpec({ tiles: ["u"], bounds: [1, 2, 3] }).bounds === null);
	ok("tiles も url も無ければ投げる", throws(() => normalizeDemSpec({})) && throws(() => normalizeDemSpec(null)) && throws(() => normalizeDemSpec({ tiles: [] })));
}

// ── createDemSource（取得なしで決まる口） ──
{
	const d = createDemSource({ tiles: ["https://a/{z}/{x}/{y}.png"], bounds: [139, 35, 140, 36] });
	ok("covers：bounds と重なるセル", d.covers(139.5, 35.5) && d.covers(138.5, 35.5) && !d.covers(141, 35) && !d.covers(139, 37));
	ok("covers：range（10° セル）", d.covers(130, 30, 10) && !d.covers(120, 30, 10));
	ok("height：範囲外は取らずに NaN", Number.isNaN(await d.height(10, 10)) && fetched === 0);
	ok("cell：範囲外は取らずに null", (await d.cell(10, 10)) === null && fetched === 0);
	const g = createDemSource({ tiles: ["u"] });
	ok("bounds なし＝どこでも covers", g.covers(-180, -85, 10) && g.covers(170, 80));
	ok("cell：タイルが多すぎる（> 400 枚）は取らずに null", (await g.cell(0, 0, 10, 1025 * 64)) === null && fetched === 0);
	const h = createDemSource({ tiles: ["https://a/{z}/{x}/{y}.png"], maxzoom: 3, minzoom: 1 });
	ok("height：404 なら親へ上がり minzoom で止まる（3 回取る）", Number.isNaN(await h.height(139, 35)) && fetched === 3, `fetched=${fetched}`);
}

// ── quantized-mesh の振り分け ──
{
	fetched = 0;
	const q = createDemSource({ type: "quantized-mesh", url: "https://q/layer.json", heights: "orthometric", heightOffset: "12", bounds: [1, 2, 3, 4] });
	ok("type quantized-mesh は qmesh の source（spec の正規化）", q.spec.type === "quantized-mesh" && q.spec.url === "https://q/layer.json" && q.spec.heights === "orthometric" && q.spec.heightOffset === 12 && q.spec.bounds.join() === "1,2,3,4" && q.spec.ion === null);
	ok("layer.json が 404 なら ready は null（既定の標高のまま）", (await q.ready) === null && fetched === 1);
	const e = createDemSource({ type: "quantized-mesh", ion: { assetId: 1 } });
	ok("ion：既定の heights は ellipsoidal・accessToken は空", e.spec.heights === "ellipsoidal" && e.spec.ion.assetId === 1 && e.spec.ion.accessToken === "" && e.spec.url === null);
	await e.ready;
	ok("url も ion も無ければ投げる", throws(() => createDemSource({ type: "quantized-mesh" })));
}

// ── 独自スキームの読み口（opts.load・spec.port）：画素（ImageData 形）は canvas を通さず encoding で解く・fetch は呼ばない ──
{
	const n = 4, px = new Uint8ClampedArray(n * n * 4);
	for (let i = 0; i < n * n; i++) { const e = 1234.5 + 32768, w = Math.floor(e); px[i * 4] = w >> 8; px[i * 4 + 1] = w & 255; px[i * 4 + 2] = (e - w) * 256; px[i * 4 + 3] = 255; }
	const asked = [], f0 = fetched;
	const d = createDemSource({ tiles: ["cs-terrain://t0/{z}/{x}/{y}"], maxzoom: 3 }, { load: async u => { asked.push(u); return { width: n, height: n, data: px }; } });
	const h = await d.height(139.7, 35.6);
	ok("load：画素の terrarium をそのまま解く", Math.abs(h - 1234.5) < 0.01, `h=${h}`);
	ok("load：型紙の z/x/y で頼む・fetch は呼ばない", asked[0] === "cs-terrain://t0/3/7/3" && fetched === f0, asked[0]);
	const none = createDemSource({ tiles: ["cs-terrain://t1/{z}/{x}/{y}"], maxzoom: 2, minzoom: 1 }, { load: async () => null });
	ok("load：null＝そこに無い（親へ上がって最後は NaN）", Number.isNaN(await none.height(10, 10)));
	const ch = new MessageChannel(), seen = [];
	ch.port1.onmessage = e => { seen.push(e.data.url); ch.port1.postMessage({ id: e.data.id, data: { width: n, height: n, data: px } }); };
	const viaPort = createDemSource({ tiles: ["cs-terrain://t2/{z}/{x}/{y}"], maxzoom: 1, port: ch.port2 });
	const hp = await viaPort.height(139.7, 35.6);
	ok("port：{ id, url } を送り { id, data } を受ける（worker の形）", Math.abs(hp - 1234.5) < 0.01 && seen[0] === "cs-terrain://t2/1/1/0", `${hp} ${seen[0]}`);
	ch.port1.close(); ch.port2.close();
}

globalThis.fetch = realFetch; console.warn = warn;
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ dem-spec 全 PASS");
process.exit(fail ? 1 : 0);
