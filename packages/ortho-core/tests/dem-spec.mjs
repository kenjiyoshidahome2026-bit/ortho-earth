// 外来の標高ソース（dem-src.ts・qmesh-src.ts）の spec の正規化と、取得なしで決まる口（covers・範囲外の height／cell）の検定。
// タイルの取得と解読（fetch・createImageBitmap・OffscreenCanvas）はブラウザ側＝ここでは fetch を偽物に替えて「呼ばない」ことを見る。
import { normalizeDemSpec, createDemSource, sniffImageType, frameToRGBA, decodeImageRGBA } from "../src/dem-src.ts";

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
	const pm = normalizeDemSpec({ url: "pmtiles://https://a/gel.pmtiles", encoding: "mapbox" });
	ok("url が pmtiles:// ならアーカイブ 1 つを tiles に（MapLibre の pmtiles プロトコルの書き方）", pm.tiles.length === 1 && pm.tiles[0] === "pmtiles://https://a/gel.pmtiles" && pm.encoding === "mapbox");
	ok("tiles があれば url より tiles", normalizeDemSpec({ tiles: ["t"], url: "pmtiles://u" }).tiles[0] === "t");
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
	// heightSync＝届いているタイルだけから同期で（load の口で画素を直に渡す＝terrarium の 1 枚（全画素 h＝100m））
	const n = 4, px = new Uint8ClampedArray(n * n * 4); for (let i = 0; i < n * n; i++) { px[i * 4] = 32768 + 100 >> 8; px[i * 4 + 1] = (32768 + 100) & 255; px[i * 4 + 2] = 0; px[i * 4 + 3] = 255; }
	let loads = 0; const s = createDemSource({ tiles: ["https://a/{z}/{x}/{y}.png"], maxzoom: 6, minzoom: 0 }, { load: async () => { loads++; return { width: n, data: px }; } });
	ok("heightSync：未要求なら NaN（取りには出さない＝読むだけ）", Number.isNaN(s.heightSync(139, 35, 5)) && loads === 0, `loads=${loads}`);
	await s.height(139, 35, 5);
	ok("heightSync：届いた後は同期で値が出る（100m）", Math.abs(s.heightSync(139, 35, 5) - 100) < 1e-6 && loads === 1, `v=${s.heightSync(139, 35, 5)} loads=${loads}`);
	ok("heightSync：子が未要求でも届いている親から（z6 を聞いても z5 で答え・取りには出さない）", Math.abs(s.heightSync(139, 35, 6) - 100) < 1e-6 && loads === 1, `loads=${loads}`);
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

// ── 値のままの標高（標高 COG・DemHeights＝{ width, height, heights }）：encoding を通さず Float32 のまま・NaN は無い所 ──
{
	const n = 4, hs = new Float32Array(n * n).fill(42.25);
	const f0 = fetched, asked = [];
	const d = createDemSource({ tiles: ["cog://{z}/{x}/{y}"], encoding: "gsi", maxzoom: 3 }, { load: async u => { asked.push(u); return { width: n, height: n, heights: hs }; } });
	const h = await d.height(139, 35, 3);
	ok("heights：値のまま（gsi の復号を通さない）", Math.abs(h - 42.25) < 1e-6, `h=${h}`);
	ok("heights：cog:// の型紙で頼む・fetch は呼ばない", asked[0] === "cog://3/7/3" && fetched === f0, asked[0]);
}

// ── 画像の復号は canvas を通さない（#1209）：ImageDecoder（WebCodecs）→ VideoFrame.copyTo → 詰めた RGBA ──
//   実物の Chromium（ImageDecoder・lossless WebP／PNG・α あり／なし）で画素一致は手元で確認済み。ここは型の見分けと並べ替えを偽の frame で
{
	const B = a => new Uint8Array(a);
	ok("sniff：PNG・WebP・JPEG・AVIF・不明", sniffImageType(B([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])) === "image/png" && sniffImageType(B([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])) === "image/webp"
		&& sniffImageType(B([0xff, 0xd8, 0xff, 0xe0])) === "image/jpeg" && sniffImageType(B([0, 0, 0, 28, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66])) === "image/avif" && sniffImageType(B([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) === null);
	// 2×1 画素（R=128,G=51,B=102,A=255｜R=129,G=0,B=7,A=0）を各形で持つ偽の frame
	const px = [[128, 51, 102, 255], [129, 0, 7, 0]];
	const frame = (format, conv = true) => ({ format, codedWidth: 2, codedHeight: 1, visibleRect: { width: 2, height: 1 }, closed: 0, close() { this.closed++; },
		async copyTo(dst, o = {}) { const f = o.format ?? format; if (o.format && !conv) throw new Error("no conv"); px.forEach((p, i) => { const q = f.startsWith("BGR") ? [p[2], p[1], p[0], p[3]] : p; dst.set(f.endsWith("X") ? [q[0], q[1], q[2], 99] : q, i * 4 + (o.layout?.[0].offset ?? 0)); }); } });
	const want = (a0, a1) => [128, 51, 102, a0, 129, 0, 7, a1].join();
	ok("frame RGBA：そのまま", (await frameToRGBA(frame("RGBA"))).data.join() === want(255, 0));
	ok("frame BGRA：R と B を入れ替え・α はそのまま（α 0＝無効値が残る）", (await frameToRGBA(frame("BGRA"))).data.join() === want(255, 0));
	ok("frame BGRX：入れ替え・X は 255（Chromium の不透明な画像はこの形）", (await frameToRGBA(frame("BGRX"))).data.join() === want(255, 255));
	ok("frame RGBX：X は 255", (await frameToRGBA(frame("RGBX"))).data.join() === want(255, 255));
	ok("frame I420 など：copyTo の format:RGBA に任せる・出来なければ null", (await frameToRGBA({ ...frame("I420"), format: "I420", async copyTo(dst, o) { if (o.format !== "RGBA") throw 0; dst.set([128, 51, 102, 255, 129, 0, 7, 0]); } })).data.join() === want(255, 0) && (await frameToRGBA(frame("I420", false))) === null);
	ok("ImageDecoder が無ければ null（呼び手は従来の canvas）", (await decodeImageRGBA(new ArrayBuffer(16))) === null);
	// 偽の ImageDecoder：色変換なし・前乗算なしで頼むこと、frame と decoder を閉じること、load の口（Blob）から地形の標高まで
	const seen = []; let fr;
	globalThis.ImageDecoder = class { static async isTypeSupported(t) { return t === "image/webp"; } constructor(init) { seen.push(init); this.closed = 0; } async decode() { fr = frame("BGRX"); fr.codedWidth = fr.visibleRect.width = 2; fr.codedHeight = fr.visibleRect.height = 2;
		fr.copyTo = async dst => { for (let i = 0; i < 4; i++) dst.set([102, 51, 128, 0], i * 4); }; return { image: fr }; } close() { seen.push("closed"); } };
	const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]).buffer;
	const d = createDemSource({ tiles: ["cs-webp://{z}/{x}/{y}"], maxzoom: 2 }, { load: async () => new Blob([webp]) });
	const h = await d.height(139, 35, 2);
	ok("ImageDecoder：load の Blob を canvas なしで解く（terrarium 128/51/102 → 51.398m）", Math.abs(h - (128 * 256 + 51 + 102 / 256 - 32768)) < 1e-4, `h=${h}`);
	ok("ImageDecoder：type は先頭のバイトから・colorSpaceConversion none・premultiplyAlpha none・閉じる", seen[0].type === "image/webp" && seen[0].colorSpaceConversion === "none" && seen[0].premultiplyAlpha === "none" && seen[1] === "closed" && fr.closed === 1);
	ok("ImageDecoder：解けない型（PNG を断る）は null", (await decodeImageRGBA(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]).buffer)) === null);
	delete globalThis.ImageDecoder;
}

globalThis.fetch = realFetch; console.warn = warn;
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ dem-spec 全 PASS");
process.exit(fail ? 1 : 0);
