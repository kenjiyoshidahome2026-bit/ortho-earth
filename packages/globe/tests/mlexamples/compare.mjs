// 公式例の門（台帳 §8）の比べる部品＝純関数だけ（node の検定 tests/mlexamples-compare.mjs で確かめる）。
// 段 1 の分：PNG を読む・標本点の色（5×5 の中央値）・同じ側の 2 回の走りの突き合わせ（揺れの無い例の選別）。
// 段 4 で：本物とこちらの位置合わせ・段の判定を足す。
import zlib from "node:zlib";

// ── PNG（Chrome の captureScreenshot＝8bit・非インターレース）→ { w, h, rgba } ──
export function decodePng(buf) {
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
	let off = 8, w = 0, h = 0, depth = 0, ctype = 0, inter = 0;
	const idat = [];
	while (off < buf.length) {
		const len = buf.readUInt32BE(off), type = buf.toString("latin1", off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
		if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; inter = data[12]; }
		else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		off += 12 + len;
	}
	const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype];
	if (depth !== 8 || !ch || inter) throw new Error(`unsupported PNG (depth ${depth} type ${ctype} interlace ${inter})`);
	const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, out = new Uint8Array(w * h * 4);
	let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let i = 0; i < stride; i++) {
			const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
			let v = row[i];
			if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
			else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
			cur[i] = v & 255;
		}
		for (let x = 0; x < w; x++) {
			const o = (y * w + x) * 4, s = x * ch;
			if (ch === 1 || ch === 2) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = ch === 2 ? cur[s + 1] : 255; }
			else { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = ch === 4 ? cur[s + 3] : 255; }
		}
		[prev, cur] = [cur, prev];
	}
	return { w, h, rgba: out };
}

// 点のまわり (2r+1)² の画素の、明るさの中央値の画素の色（外れる点は null）。中央値＝注記の細い字・線の縁の 1 画素に引かれない
export function sampleMedian(img, x, y, r = 2) {
	const cx = Math.round(x), cy = Math.round(y);
	if (cx - r < 0 || cy - r < 0 || cx + r >= img.w || cy + r >= img.h) return null;
	const px = [];
	for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
		const o = ((cy + j) * img.w + (cx + i)) * 4;
		px.push([img.rgba[o], img.rgba[o + 1], img.rgba[o + 2]]);
	}
	px.sort((p, q) => (p[0] * 299 + p[1] * 587 + p[2] * 114) - (q[0] * 299 + q[1] * 587 + q[2] * 114));
	return px[px.length >> 1];
}

// 色の距離＝RGB のユークリッド（0〜441）。知覚の差ではないが、同じ絵かどうかの門には足りる（閾値は段 5 で本人の目で決める）
export const colorDist = (a, b) => (a && b) ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : null;

// 標本点ごとの色（probes＝[{x,y,…}]・x,y は容れ物の左上原点の CSS px＝canvas だけの写しと同じ座標）
export const probeColors = (img, probes, r = 2) => probes.map(p => sampleMedian(img, p.x, p.y, r));

// 問い合わせの集合の鍵（層・source・source-layer・id）。symbol の層は注記の衝突で揺れる＝外す（段 2 の判定と同じ）
export const featKey = f => `${f.layer}|${f.source ?? ""}|${f.sourceLayer ?? ""}|${f.id ?? ""}`;
export const featSet = (feats, { dropSymbol = true } = {}) => [...new Set((feats || []).filter(f => !(dropSymbol && f.type === "symbol")).map(featKey))].sort();
const sameArr = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// 同じ側の 2 回の走り（run＝走らせ台の 1 例の記録 JSON＋色）を突き合わせる。戻り＝{ stable, reasons[], maxDist, p95 }
export function diffRuns(a, b, { tolColor = 24, tolCam = 1e-6 } = {}) {
	const reasons = [];
	if (!!a.map !== !!b.map) return { stable: false, reasons: ["map 有無が違う"] };
	if (!a.map) return { stable: true, reasons: [] };
	const la = (a.layers || []).map(l => l.id), lb = (b.layers || []).map(l => l.id);
	if (!sameArr(la, lb)) reasons.push("layers");
	const ca = a.camera, cb = b.camera;
	if (ca && cb && ["lng", "lat", "zoom", "bearing", "pitch"].some(k => Math.abs(ca[k] - cb[k]) > tolCam)) reasons.push("camera");
	let qd = 0;
	const n = Math.min(a.probes?.length || 0, b.probes?.length || 0);
	for (let i = 0; i < n; i++) if (!sameArr(featSet(a.probes[i].feats), featSet(b.probes[i].feats))) qd++;
	if (qd) reasons.push(`query(${qd})`);
	const d = [];
	for (let i = 0; i < n; i++) { const v = colorDist(a.colors?.[i], b.colors?.[i]); if (v != null) d.push(v); }
	d.sort((x, y) => x - y);
	const maxDist = d.length ? d[d.length - 1] : 0, p95 = d.length ? d[Math.floor(d.length * 0.95)] : 0;
	const over = d.filter(v => v > tolColor).length;
	if (over) reasons.push(`color(${over}/${d.length} > ${tolColor})`);
	return { stable: !reasons.length, reasons, maxDist: Math.round(maxDist), p95: Math.round(p95) };
}
