// 公式例の門（台帳 §8）の比べる部品 tests/mlexamples/compare.mjs の検定（node・網なし・Chrome なし）。
// PNG の読み（5 種のフィルタ×色の型）・標本の中央値・問い合わせの集合・2 回の走りの揺れの判定。
import zlib from "node:zlib";
import { decodePng, sampleMedian, colorDist, featSet, diffRuns, probeColors } from "./mlexamples/compare.mjs";

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

console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ mlexamples-compare 全 PASS");
process.exit(fail ? 1 : 0);
