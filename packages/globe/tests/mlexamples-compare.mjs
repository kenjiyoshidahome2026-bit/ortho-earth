// 公式例の門（台帳 §8）の比べる部品 tests/mlexamples/compare.mjs の検定（node・網なし・Chrome なし）。
// PNG の読み（5 種のフィルタ×色の型）・標本の中央値・問い合わせの集合・2 回の走りの揺れの判定。
import zlib from "node:zlib";
import { decodePng, sampleMedian, colorDist, featSet, diffRuns, probeColors, grade, rankBlockers, splitUnsupported, normError, textMatch, inkHits, THRESH } from "./mlexamples/compare.mjs";

let fail = 0;
const ok = (name, cond, note = "") => { if (!cond) fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${note ? "  " + note : ""}`); };

// 試料の PNG を自前で組む（行ごとにフィルタを変える＝読み手の 5 種を全部通す）
const crc32 = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return b => { let c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }; })();
function chunk(type, data) {
	const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, ch, px /* (x,y)→[..ch] */) {
	const ctype = { 1: 0, 2: 4, 3: 2, 4: 6 }[ch], stride = w * ch, rows = [];
	let prev = new Uint8Array(stride);
	for (let y = 0; y < h; y++) {
		const cur = new Uint8Array(stride);
		for (let x = 0; x < w; x++) px(x, y).forEach((v, i) => { cur[x * ch + i] = v; });
		const f = y % 5, out = new Uint8Array(stride + 1); out[0] = f;
		for (let i = 0; i < stride; i++) {
			const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
			let pred = 0;
			if (f === 1) pred = a; else if (f === 2) pred = b; else if (f === 3) pred = (a + b) >> 1;
			else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
			out[i + 1] = (cur[i] - pred) & 255;
		}
		rows.push(out); prev = cur;
	}
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ctype;
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}
const colorAt = (x, y) => [(x * 37 + y * 11) & 255, (x * 5 + y * 53) & 255, (x * 19 ^ y * 7) & 255];

for (const ch of [3, 4, 1, 2]) {
	const w = 23, h = 17;
	const px = (x, y) => { const c = colorAt(x, y); return ch === 3 ? c : ch === 4 ? [...c, (x + y) & 255] : ch === 1 ? [c[0]] : [c[0], 200]; };
	const img = decodePng(encodePng(w, h, ch, px));
	let bad = 0;
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const o = (y * w + x) * 4, want = px(x, y);
		const got = [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2], img.rgba[o + 3]];
		const exp = ch === 3 ? [...want, 255] : ch === 4 ? want : ch === 1 ? [want[0], want[0], want[0], 255] : [want[0], want[0], want[0], want[1]];
		if (exp.some((v, i) => v !== got[i])) bad++;
	}
	ok(`decodePng 色の型 ${ch} ch・5 種のフィルタ`, img.w === w && img.h === h && bad === 0, bad ? `${bad} 画素違う` : "");
}
{
	let threw = false;
	try { decodePng(Buffer.from("not png at all")); } catch { threw = true; }
	ok("decodePng PNG でない物は投げる", threw);
}

// 中央値：灰の地に 1 画素の黒（注記の字）＝中央値は灰のまま
{
	const w = 9, h = 9, rgba = new Uint8Array(w * h * 4).fill(128);
	for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
	const o = (4 * w + 4) * 4; rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
	const img = { w, h, rgba };
	ok("sampleMedian 1 画素の黒に引かれない", JSON.stringify(sampleMedian(img, 4, 4)) === "[128,128,128]");
	ok("sampleMedian 縁から外れる点は null", sampleMedian(img, 1, 4) === null && sampleMedian(img, 4, 7) === null);
	ok("probeColors は標本の数だけ返す", probeColors(img, [{ x: 4, y: 4 }, { x: 0, y: 0 }]).length === 2);
}
ok("colorDist", colorDist([0, 0, 0], [3, 4, 0]) === 5 && colorDist(null, [1, 1, 1]) === null);

// 問い合わせの集合：symbol は外す・重複は 1 つ・並びに依らない
{
	const a = featSet([{ layer: "a", source: "s", id: 1 }, { layer: "lbl", type: "symbol", source: "s" }, { layer: "a", source: "s", id: 1 }, { layer: "b", source: "s" }]);
	const b = featSet([{ layer: "b", source: "s" }, { layer: "a", source: "s", id: 1 }]);
	ok("featSet symbol 除外・重複・順", JSON.stringify(a) === JSON.stringify(b) && a.length === 2);
}

// 揺れ：同じ記録は揺れない／色・層・問い合わせ・カメラの違いを名指す
{
	const probes = [{ feats: [{ layer: "a" }] }, { feats: [] }];
	const base = { map: true, layers: [{ id: "a" }], camera: { lng: 1, lat: 2, zoom: 3, bearing: 0, pitch: 0 }, probes, colors: [[10, 10, 10], [200, 0, 0]] };
	ok("diffRuns 同じ記録は揺れない", diffRuns(base, structuredClone(base)).stable);
	const c = structuredClone(base); c.colors[1] = [100, 0, 0];
	const d = diffRuns(base, c);
	ok("diffRuns 色の違いを名指す", !d.stable && d.reasons.some(r => r.startsWith("color(1/2")) && d.maxDist === 100);
	const l = structuredClone(base); l.layers.push({ id: "b" });
	ok("diffRuns 層の違い", diffRuns(base, l).reasons.includes("layers"));
	const q = structuredClone(base); q.probes[1].feats = [{ layer: "a" }];
	ok("diffRuns 問い合わせの違い", diffRuns(base, q).reasons.includes("query(1)"));
	const k = structuredClone(base); k.camera.zoom = 3.01;
	ok("diffRuns カメラの違い", diffRuns(base, k).reasons.includes("camera"));
	ok("diffRuns 地図が無い同士は揺れない", diffRuns({ map: false }, { map: false }).stable);
}

// 段の判定（段 4）
{
	const probes = (n, feats = []) => Array.from({ length: n }, (_, i) => ({ x: i, y: i, lng: i, lat: 0, ok: true, feats }));
	const rec = (o = {}) => ({ end: "stable", map: true, loadVia: "event", exceptions: [], consoleErrors: [], unsupported: [], layers: [{ id: "bg" }, { id: "route" }],
		camera: { lng: 0, lat: 0, zoom: 3, bearing: 0, pitch: 0 }, bounds: [[-10, -5], [10, 5]], markers: [], popups: [], added: ["route"],
		probes: [...probes(8, [{ layer: "bg" }]), ...probes(2, [{ layer: "route" }])], colors: Array(10).fill([100, 100, 100]), ...o });
	const R = rec();
	ok("grade 全部合えば 3", grade(R, rec()).level === 3);
	ok("grade 本物が落ちる＝分母の外", grade(rec({ exceptions: ["boom"] }), rec()).level === null);
	const ex = grade(R, rec({ exceptions: ["TypeError: map.foo is not a function"] }));
	ok("grade こちらの例外＝0・順位表の鍵は伏せ字", ex.level === 0 && ex.blockers[0] === "exception: TypeError: map.foo is not a function");
	const un = grade(R, rec({ unsupported: ["setSky() (semantic)", "option maplibreLogo (cosmetic)"] }));
	ok("grade 意味の unsupported は 1 止まり・見た目は塞がない", un.level === 1 && un.blockers.join() === "unsupported: setSky()" && un.unsupported.cosmetic[0] === "option maplibreLogo");
	const ly = grade(R, rec({ layers: [{ id: "bg" }] }));
	const ee = grade(R, rec({ consoleErrors: ['[mlshim] addLayer: addLayer: source "x" not found'] }));
	ok("grade 通訳が捕まえたエンジンのエラーは段 2 を塞ぐ", ee.level === 1 && ee.blockers.includes('engine error: addLayer: source "…" not found'), JSON.stringify(ee.blockers));
	ok("grade 層の違い＝1・順位表は抜けた型ごと", ly.level === 1 && ly.blockers.includes("getStyle lacks ? layers"), JSON.stringify(ly.blockers));
	const cols = Array(10).fill([100, 100, 100]); cols[8] = cols[9] = [250, 0, 0];
	const pic = grade(R, rec({ colors: cols }));
	ok("grade 足した層の色が違う＝2", pic.level === 2 && pic.blockers.includes("added layers look different"), JSON.stringify(pic.reasons));
	const few = rec({ added: ["route"], probes: [...probes(8, [{ layer: "bg" }]), ...probes(5, [{ layer: "route" }])], colors: Array(13).fill([100, 100, 100]) });
	const fewO = rec({ added: ["route"], probes: few.probes, colors: [...Array(12).fill([100, 100, 100]), [250, 0, 0]] });
	ok("grade 足した層の標本が少ない時は 1 点のはずれを許す（4/5＝3）", grade(few, fewO).level === 3);
	const fewO2 = rec({ added: ["route"], probes: few.probes, colors: [...Array(11).fill([100, 100, 100]), [250, 0, 0], [250, 0, 0]] });
	ok("grade 2 点はずれは許さない（3/5＝2）", grade(few, fewO2).level === 2);
	ok("grade 動く例は 2 まで（本物も 2）", grade(rec({ end: "animated" }), rec({ end: "animated" })).level === 2 && grade(rec({ end: "animated" }), rec()).refLevel === 2);
	ok("grade MapLibre のズームの下限（世界の高さ）に本物が居る時はカメラを比べない", grade(rec({ container: { H: 600 }, camera: { lng: 0, lat: 0, zoom: Math.log2(600 / 512), bearing: 0, pitch: 0 } }), rec({ camera: { lng: 40, lat: 30, zoom: 0, bearing: 0, pitch: 0 } })).level === 3);
	ok("grade 緯度の差のズームは許す（北緯 60°）", grade(rec({ camera: { lng: 0, lat: 60, zoom: 5, bearing: 0, pitch: 0 } }), rec({ camera: { lng: 0, lat: 60, zoom: 5.9, bearing: 0, pitch: 0 } })).level === 3);
	const rk = rankBlockers([{ name: "a", level: 1, refLevel: 3, blockers: ["x", "x", "y"] }, { name: "b", level: 0, refLevel: 3, blockers: ["x"] }, { name: "c", level: 3, refLevel: 3, blockers: ["z"] }]);
	ok("rankBlockers 1 例 1 回・多い順・届いた例は数えない", rk.length === 2 && rk[0].blocker === "x" && rk[0].n === 2 && rk[1].n === 1);
	ok("splitUnsupported・normError", splitUnsupported(["a (cosmetic)", "b"]).semantic[0] === "b" && normError("x 'abc' 12 https://a.b/c") === "x '…' N <url>");
}


// 文字（段 0）：本物が置いた点の記号 vs こちらの置いたラベル（層 id＋近さ）・線沿いは line・裏の点は分母の外・こちらだけの物は extra
{
	const R = { symbols: [
		{ layer: "city", placement: "point", geom: "Point", lng: 10, lat: 10, x: 100, y: 100 },
		{ layer: "city", placement: "point", geom: "Point", lng: 11, lat: 11, x: 200, y: 100 },
		{ layer: "city", placement: "point", geom: "Point", lng: 12, lat: 12, x: 300, y: 100 },
		{ layer: "road", placement: "line", geom: "LineString", lng: null, lat: null, x: null, y: null },
		{ layer: "city", placement: "point", geom: "Point", lng: 13, lat: 13, x: 400, y: 100 } ] };
	const O = { container: { W: 800, H: 600 },
		refSym: [{ x: 100, y: 100, front: 1, ok: true }, { x: 200, y: 100, front: 1, ok: true }, { x: 300, y: 100, front: 1, ok: true }, null, { x: 400, y: 100, front: -1, ok: false }],
		placed: [
			{ layer: "city", text: "A", x: 104, y: 98, w: 30, h: 12 },        // 近い＝hit
			{ layer: "city", text: "B", x: 200, y: 140, w: 30, h: 12 },       // 40px 下＝許し（16 か w/2+h=27）を超える＝miss
			{ layer: "town", text: "Z", x: 300, y: 100, w: 30, h: 12 },       // 層が違う＝hit にならず・本物に無い層＝extra にも数えない
			{ layer: "city", text: "C", x: 600, y: 300, w: 30, h: 12 },       // 本物に無い＝extra
			{ layer: "city", text: "D", x: 900, y: 100, w: 30, h: 12 } ],     // 画面の外＝数えない
		ink: [true, false, null, null, null] };
	const t = textMatch(R, O);
	ok("textMatch n（表の点だけ）", t.n === 3, JSON.stringify(t));
	ok("textMatch hit", t.hit === 1);
	ok("textMatch line", t.line === 1);
	ok("textMatch extra（同じ層でこちらだけ・画面の内）", t.extra === 2 && t.placedN === 4);
	ok("textMatch ink", t.ink === 1 && t.inkN === 2);
	ok("textMatch layers", t.layers.city.n === 3 && t.layers.city.hit === 1);
	ok("textMatch 無し", textMatch({ symbols: [] }, O).n === 0 && textMatch(null, null).n === 0);
	const base = { end: "stable", map: true, loadVia: "event", probes: [], layers: [], markers: [], popups: [] };   // grade の入口（runsWhy）を通る最小の記録
	ok("grade は text を持ち・既定では段を動かさない", (() => { const g = grade({ ...base, symbols: R.symbols }, { ...base, ...O }); return g.text?.n === 3 && !g.reasons.some(r => /^text/.test(r)); })());
	ok("textGate で段 2 の条件に", (() => { const g = grade({ ...base, symbols: [...R.symbols, ...R.symbols] }, { ...base, ...O, refSym: [...O.refSym, ...O.refSym], ink: [] }, { ...THRESH, textGate: true }); return g.reasons.some(r => /^text/.test(r)) && g.blockers.some(b => /^text/.test(b)); })());
}
// インク：文字あり／なしの差分＝点の周りの箱に閾を超える画素が min 個以上あれば true・箱の外の差分は拾わない・寸法違いは null
{
	const W = 120, H = 60, mk = f => ({ w: W, h: H, rgba: Uint8Array.from({ length: W * H * 4 }, (_, i) => { const px = (i / 4) | 0, x = px % W, y = (px / W) | 0, c = i % 4; return c === 3 ? 255 : f(x, y); }) });   // decodePng と同じ形
	const plain = mk(() => 200), inked = mk((x, y) => (x >= 30 && x <= 45 && y === 20) ? 0 : 200);   // 16 画素の横線＝x30..45, y20
	const r = inkHits(inked, plain, [[36, 22], [100, 40], null]);
	ok("inkHits 近くに文字＝true", r[0] === true, JSON.stringify(r));
	ok("inkHits 遠い＝false", r[1] === false);
	ok("inkHits null の点＝null", r[2] === null);
	ok("inkHits 寸法違い＝null", inkHits(inked, { w: 1, h: 1, rgba: new Uint8Array(4) }, [[1, 1]])[0] === null);
	ok("inkHits 本物の PNG の形（decodePng）で動く", (() => { const img = decodePng(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")); return inkHits(img, img, [[0, 0]])[0] === false; })());
}

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ mlexamples-compare 全 PASS");
process.exit(fail ? 1 : 0);
