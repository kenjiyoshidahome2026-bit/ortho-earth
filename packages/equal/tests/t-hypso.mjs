// 全球ハイプソの標高（hypso.ts）と空港の記号（labels.ts の mark 描画）の検定。配信へは出ない（fetch は全部 404）。
//   ・loadWorldElevation：焼き済みアトラスが無い＝8 枚の R90 へ退避・取れないセルは 0（平ら）のまま・寸法は 4N×2N
//   ・createNearElevation：z5.5 未満は何もしない／静止 180ms 後に視野のセル窓（経度の中心・解像度は 2 の冪）／
//     同じ窓は作り直さない／ズームアウトで null／stop で作りかけを捨てる
//   ・airportLabels＝記号だけ（名前なし）・minZoom の上書き・Point 以外は捨てる・draw で✈を塗る
globalThis.devicePixelRatio = 2;
globalThis.fetch = async () => new Response("no", { status: 404 });
globalThis.Path2D = class { constructor(d) { this.d = d; } };
const quiet = console.warn, qi = console.info; console.warn = console.info = () => {};
const { loadWorldElevation, createNearElevation, NEAR_MIN_ZOOM, loadClimate } = await import("../src/hypso.ts");
const { createLabels, airportLabels } = await import("../src/labels.ts");

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// ── 遠景（全球 R90）──
{
	let updates = 0;
	const A = await loadWorldElevation({ cellRes: 8, onUpdate: () => updates++ });
	ok("loadWorldElevation：4N×2N の Float32・取れない＝0", A.width === 32 && A.height === 16 && A.data instanceof Float32Array && A.data.every(v => v === 0));
	ok("取れたセルが無い＝onUpdate は呼ばない", updates === 0);
}

// ── 近景（R10 窓）──
{
	const atlases = [], busy = [];
	const N = createNearElevation({ maxTex: 4096, onAtlas: a => atlases.push(a), onBusy: b => busy.push(b) });
	const un = (view, spanLon, spanLat) => (sx, sy) => [view.lon + sx / 1000 * spanLon, view.lat - sy / 600 * spanLat];
	const v1 = { lon: 139.7, lat: 35.6, zoom: 4 };
	N.ensure(v1, 1000, 600, un(v1, 10, 6)); await wait(250);
	ok(`z${NEAR_MIN_ZOOM} 未満は何もしない`, atlases.length === 0 && busy.length === 0);
	const v2 = { lon: 139.7, lat: 35.6, zoom: 6 };
	N.ensure(v2, 1000, 600, un(v2, 12, 6)); await wait(100);
	ok("静止 180ms までは作らない", atlases.length === 0);
	await wait(300);
	const a = atlases[0];
	ok("視野のセル窓：bounds＝10° 刻み", a && a.bounds[0] === 130 && a.bounds[1] === 30 && a.bounds[2] === 20 && a.bounds[3] === 10, JSON.stringify(a?.bounds));
	const res = a && a.width / (a.bounds[2] / 10);
	ok("解像度は 2 の冪・128〜2048・高さも同じ", a && Number.isInteger(Math.log2(res)) && res >= 128 && res <= 2048 && a.height === res * a.bounds[3] / 10, String(res));
	ok("取れない＝0（海と同じ）・読込中の印は true→false", a && a.data.every(v => v === 0) && busy.join() === "true,false");
	N.ensure(v2, 1000, 600, un(v2, 12, 6)); await wait(250);
	ok("同じ窓は作り直さない", atlases.length === 1);
	const v3 = { lon: 179, lat: 0, zoom: 7 };
	N.ensure(v3, 1000, 600, un(v3, 6, 3)); await wait(250);
	const b = atlases[1];
	ok("日付変更線を跨ぐ窓（経度は中心セルから最短）", b && b.bounds[0] === 170 && b.bounds[2] === 20, JSON.stringify(b?.bounds));
	const wide = { lon: 0, lat: 0, zoom: 6 };
	N.ensure(wide, 1000, 600, un(wide, 300, 160)); await wait(250);
	const c = atlases[2];
	ok("広すぎる窓は 10×10 セルに切り詰める", c && c.bounds[2] <= 100 && c.bounds[3] <= 100, JSON.stringify(c?.bounds));
	N.ensure({ ...v2, zoom: 3 }, 1000, 600, un(v2, 12, 6));
	ok("ズームアウト＝null を渡す", atlases.length === 4 && atlases[3] === null);
	N.ensure({ ...v2, zoom: 3 }, 1000, 600, un(v2, 12, 6));
	ok("続けてのズームアウトは何も渡さない", atlases.length === 4);
	N.ensure(v2, 1000, 600, un(v2, 12, 6)); N.stop(); await wait(300);
	ok("stop＝静止待ちを捨てる", atlases.length === 4);
	N.ensure(v2, 1000, 600, () => null); await wait(250);
	ok("視野が地図の外ばかり＝作らない", atlases.length === 4);
}

// ── 気候場の画像 ──
{
	globalThis.Image = class { set src(u) { this.u = u; setTimeout(() => u.includes("bad") ? this.onerror(new Error("x")) : this.onload(), 0); } };
	const img = await loadClimate("koppen.png");
	let err = false; try { await loadClimate("bad.png"); } catch { err = true; }
	ok("loadClimate：読めたら画像・失敗は reject", img.u === "koppen.png" && err);
}

// ── 空港の記号 ──
{
	const feats = [
		{ properties: { scalerank: 2, type: "major" }, geometry: { type: "Point", coordinates: [139.78, 35.55] } },
		{ properties: {}, geometry: { type: "LineString", coordinates: [] } },
		{ properties: {}, geometry: null },
	];
	const pal = { city: "#111", airport: "#06c", halo: "#fff" };
	const A = airportLabels(feats, pal, { minZoom: 3, size: 14 });
	ok("airportLabels：Point だけ・記号だけ・色は airport", A.length === 1 && A[0].text === "" && A[0].mark === "plane" && A[0].kind === "airport" && A[0].color === "#06c" && A[0].size === 14 && A[0].minZoom === 3);
	const D = airportLabels(feats.slice(0, 1), { city: "#111", halo: "#fff" });
	ok("airportLabels：既定の大きさ 12・minZoom は正本の規則・色が無ければ city", D[0].size === 12 && Number.isFinite(D[0].minZoom) && D[0].color === "#111");
	const calls = [];
	const ctx = new Proxy({}, { get: (t, k) => k === "measureText" ? s => ({ width: s.length * 7 }) : (...a) => calls.push([k, a]), set: () => true });
	const L = createLabels({ width: 0, height: 0, getContext: () => ctx });
	L.setLabels(A);
	L.draw({ lon: 139.78, lat: 35.55, zoom: 6 }, 800, 600, 1, 1000);
	L.draw({ lon: 139.78, lat: 35.55, zoom: 6 }, 800, 600, 1, 1200);
	ok("draw：✈ を当選させ、ハローを敷いてから塗る（Path2D）", L.debug().winners.includes("airport:") && calls.some(c => c[0] === "stroke" && c[1][0] instanceof Path2D) && calls.some(c => c[0] === "fill" && c[1][0] instanceof Path2D) && !calls.some(c => c[0] === "fillText"));
}

console.warn = quiet; console.info = qi;
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ t-hypso 全 PASS");
process.exit(fail ? 1 : 0);
