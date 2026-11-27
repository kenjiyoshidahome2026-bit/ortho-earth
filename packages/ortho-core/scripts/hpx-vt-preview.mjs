#!/usr/bin/env node
// 焼いた HEALPix のベクタタイル（bake-out/hpx/osm・scripts/bake-healpix-osm.mjs）を、正距円筒の PNG 1 枚に描いて目で確かめる（2026-11-27）。
// 範囲に掛かるタイルを読み、タイルの中の座標を経緯度へ戻して線で描く＝番地や座標の向きが違えば道の形が崩れ、タイルの境で線がずれて見える。
//
// 使い方（repo の根から）:
//   node packages/ortho-core/scripts/hpx-vt-preview.mjs --order 8 --bbox 138.5,34.8,140.5,36.2 --width 2400
//   … --grid            # タイルの境を薄く描く
//   … --in bake-out/hpx/osm --out bake-out/hpx/osm-preview.png
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { hpxPath, hpxBoundary } from "../src/healpix.ts";
import { hpxTileGeoms, hpxTilePointLonLat } from "../src/healpixvt.ts";
import { decodeTile } from "../../geopbf/src/convert/mvt-decode.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const arg = (name, def) => { const i = process.argv.indexOf("--" + name); return i < 0 ? def : process.argv[i + 1]; };
const ORDER = +arg("order", 8), GRID = process.argv.includes("--grid");
const [BW, BS, BE, BN] = arg("bbox", "138.5,34.8,140.5,36.2").split(",").map(Number);
const PW = +arg("width", 2000), PH = Math.max(1, Math.round(PW * (BN - BS) / (BE - BW) / Math.cos((BS + BN) / 2 * Math.PI / 180)));
const IN = path.resolve(ROOT, arg("in", "bake-out/hpx/osm")), OUT = path.resolve(ROOT, arg("out", `bake-out/hpx/osm-preview-N${ORDER}.png`));

const img = Buffer.alloc(PW * PH * 3, 250);
const px = (x, y, c) => { if (x >= 0 && y >= 0 && x < PW && y < PH) { const o = (y * PW + x) * 3; img[o] = c[0]; img[o + 1] = c[1]; img[o + 2] = c[2]; } };
const X = lon => Math.round((lon - BW) / (BE - BW) * PW), Y = lat => Math.round((BN - lat) / (BN - BS) * PH);
function seg(a, b, c) {   // 経緯度の線分
	let ax = a[0], bx = b[0]; if (bx - ax > 180) bx -= 360; else if (ax - bx > 180) bx += 360;
	let x0 = X(ax), y0 = Y(a[1]), x1 = X(bx), y1 = Y(b[1]);
	if ((x0 < 0 && x1 < 0) || (y0 < 0 && y1 < 0) || (x0 >= PW && x1 >= PW) || (y0 >= PH && y1 >= PH) || Math.abs(x1 - x0) + Math.abs(y1 - y0) > 4 * (PW + PH)) return;
	const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let e = dx + dy;
	for (;;) { px(x0, y0, c); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } }
}
const COLOR = { water: [70, 130, 200], buildings: [170, 150, 140] };
const ROADC = { highway: [200, 60, 40], major_road: [220, 140, 40], minor_road: [120, 120, 120], path: [170, 190, 150], rail: [40, 40, 40] };

// 範囲に掛かるタイル＝範囲の矩形を同じ切り方で切って番号を得る
const want = hpxTileGeoms({ type: "polygon", coords: [[[BW, BS], [BE, BS], [BE, BN], [BW, BN]]] }, ORDER).map(t => t.npix);
let read = 0, missing = 0, feats = 0, bytes = 0; const perLayer = {};
for (const n of want) {
	if (GRID) { const b = hpxBoundary(ORDER, n, 4); for (let i = 0; i < b.length; i++) seg(b[i], b[(i + 1) % b.length], [225, 225, 235]); }
	const f = path.join(IN, hpxPath(ORDER, n, "mvt"));
	if (!existsSync(f)) { missing++; continue; }
	const buf = readFileSync(f); read++; bytes += buf.length;
	for (const L of decodeTile(buf)) for (const ft of L.features) {
		feats++; perLayer[L.name] = (perLayer[L.name] || 0) + 1;
		const c = L.name === "roads" ? ROADC[ft.props.kind] ?? [120, 120, 120] : COLOR[L.name] ?? [90, 90, 90];
		for (const g of ft.geometry) {
			const ll = []; for (let i = 0; i < g.length; i += 2) ll.push(hpxTilePointLonLat(ORDER, n, g[i], g[i + 1], L.extent, []));
			// 多角形の、タイルの縁に沿う辺は切り口＝描かない（読む側の輪郭線と同じ扱い）
			const E = L.extent, cut = (i, j) => ft.type === 3 && ((g[2 * i] === g[2 * j] && (g[2 * i] === 0 || g[2 * i] === E)) || (g[2 * i + 1] === g[2 * j + 1] && (g[2 * i + 1] === 0 || g[2 * i + 1] === E)));
			for (let i = 1; i < ll.length; i++) if (!cut(i - 1, i)) seg(ll[i - 1], ll[i], c);
			if (ft.type === 3 && ll.length > 2 && !cut(ll.length - 1, 0)) seg(ll[ll.length - 1], ll[0], c);
		}
	}
}
const raw = Buffer.alloc((PW * 3 + 1) * PH); for (let y = 0; y < PH; y++) img.copy(raw, y * (PW * 3 + 1) + 1, y * PW * 3, (y + 1) * PW * 3);
const chunk = (type, data) => { const len = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body) >>> 0); return Buffer.concat([len, body, crc]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(PW, 0); ihdr.writeUInt32BE(PH, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(OUT, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
console.log(`[hpx-vt-preview] Norder ${ORDER}・${PW}×${PH}・タイル ${read} 枚（${(bytes / 1e3).toFixed(0)} KB・無い ${missing}）・地物 ${feats}（${Object.entries(perLayer).map(([k, v]) => `${k} ${v}`).join("・")}）→ ${path.relative(ROOT, OUT)}`);
