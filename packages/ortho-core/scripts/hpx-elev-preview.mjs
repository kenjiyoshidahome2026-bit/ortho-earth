#!/usr/bin/env node
// 焼いた標高の HEALPix タイル（bake-out/hpx/elev・scripts/bake-healpix-elev.mjs）を、正距円筒の段彩 PNG 1 枚にして目で確かめる（2026-11-27）。
// 画素ごとに 経緯度 → NESTED のタイルと画素（最近傍・補間なし）を引く＝番地や画素の向きが違えば大陸の形が崩れ、タイルの境がずれて見える。
//
// 使い方（repo の根から）:
//   node packages/ortho-core/scripts/hpx-elev-preview.mjs                       # Norder 2・全球・幅 2048
//   node packages/ortho-core/scripts/hpx-elev-preview.mjs --order 5 --bbox 128,30,146,46 --width 2400   # 日本のまわりを細かい段で
//   … --grid            # タイルの境に線を引く（継ぎ目を探す時）
//   … --in bake-out/hpx/elev --out bake-out/hpx/preview.png
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { decode } from "altpbf";
import { lonLatToXYF, nestOf, hpxPath } from "../src/healpix.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i < 0 ? def : process.argv[i + 1]; };
const ORDER = +arg("order", 2), GRID = process.argv.includes("--grid");
const [BW, BS, BE, BN] = arg("bbox", "-180,-90,180,90").split(",").map(Number);
const PW = +arg("width", 2048), PH = Math.max(1, Math.round(PW * (BN - BS) / (BE - BW)));
const IN = path.resolve(ROOT, arg("in", "bake-out/hpx/elev")), OUT = path.resolve(ROOT, arg("out", `bake-out/hpx/preview-N${ORDER}.png`));

// 段彩（m → RGB）。海は深さで青・陸は緑 → 黄土 → 茶 → 白
const STOPS = [[-8000, 8, 20, 70], [-4000, 20, 60, 130], [-200, 90, 150, 200], [-1, 170, 210, 230], [0, 60, 120, 70], [300, 130, 170, 90], [1000, 200, 190, 120], [2500, 160, 110, 80], [4500, 235, 235, 235], [8000, 255, 255, 255]];
function tint(h, o, i) {
	let k = 1; while (k < STOPS.length - 1 && h > STOPS[k][0]) k++;
	const a = STOPS[k - 1], b = STOPS[k], t = Math.min(1, Math.max(0, (h - a[0]) / (b[0] - a[0])));
	for (let c = 0; c < 3; c++) o[i + c] = a[c + 1] + (b[c + 1] - a[c + 1]) * t;
}

const tiles = new Map(), KEEP = 600;   // npix → { W, data }（無い＝null）
let W = 0, missing = 0;
async function tile(n) {
	if (tiles.has(n)) return tiles.get(n);
	const f = path.join(IN, hpxPath(ORDER, n, "altpbf"));
	let t = null;
	if (existsSync(f)) { const d = await decode(new Blob([readFileSync(f)])); t = { W: d.width, data: d.data }; W = d.width; } else missing++;
	if (tiles.size >= KEEP) tiles.delete(tiles.keys().next().value);
	tiles.set(n, t);
	return t;
}

const raw = Buffer.alloc((PW * 3 + 1) * PH), f = { face: 0, x: 0, y: 0 }, K = 2 ** ORDER;
let lo = Infinity, hi = -Infinity;
for (let py = 0; py < PH; py++) {
	const lat = BN - (py + 0.5) / PH * (BN - BS), row = py * (PW * 3 + 1) + 1;
	for (let px = 0; px < PW; px++) {
		lonLatToXYF(BW + (px + 0.5) / PW * (BE - BW), lat, f);
		const gx = f.x * K, gy = f.y * K, ix = Math.min(K - 1, Math.floor(gx)), iy = Math.min(K - 1, Math.floor(gy));
		const n = nestOf(ORDER, f.face, ix, iy), t = tiles.get(n) ?? await tile(n), o = row + px * 3;
		if (!t) { raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 255; continue; }   // 無いタイル＝紫
		const col = Math.min(t.W - 1, Math.floor((gx - ix) * t.W)), r = Math.min(t.W - 1, Math.floor((gy - iy) * t.W)), h = t.data[r * t.W + col];
		if (h < lo) lo = h; if (h > hi) hi = h;
		tint(h, raw, o);
		if (GRID && (col === 0 || r === 0)) { raw[o] = 255; raw[o + 1] = 60; raw[o + 2] = 60; }
	}
}

// PNG（RGB 8 bit・フィルタなし）
const chunk = (type, data) => { const len = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(PW, 0); ihdr.writeUInt32BE(PH, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(OUT, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
console.log(`[hpx-preview] Norder ${ORDER}・${PW}×${PH}・タイル幅 ${W}・標高 ${lo}〜${hi} m・無いタイル ${missing} → ${path.relative(ROOT, OUT)}`);
