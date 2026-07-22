#!/usr/bin/env node
// 日本域の標高 R01 タイル（1°×1°・3600×3600・Int16）を DSM(ALOS AW3D30) から DTM(地理院 DEM10B) へ焼き直す。
// 出典＝地理院標高タイル dem_png（DEM10B・z12）。水面(内水面)は DEM10B が欠測＝最寄り有効値で埋める
//（湖面は岸の高さ＝水面平坦化）。海（縁に接する欠測域で岸の中央値≤10m）は 0。
// 出力は packages/altpbf/src/altpbf.js encode() と同一フォーマット（pbf + deflateRaw）＋ gzip で bucket 形式。
//
// 使い方:
//   node scripts/bake-dem10b.mjs --cells E138N035,E135N035     # 指定セルのみ（検証用）
//   node scripts/bake-dem10b.mjs --japan                        # JAXA index ∩ 日本bbox の全セル
//   node scripts/bake-dem10b.mjs --upload                       # out の *.gz を bucket GIS/alt へ（要 ORTHO_API_KEY）
//   （--cells/--japan に --upload を併記すれば焼いた直後に上げる）
// 出力: apps/ortho-japan/dem10b-out/（gitignore 済み）

import Pbf from 'pbf';
import { deflateRawSync, gzipSync, inflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dem10b-out');
mkdirSync(OUT, { recursive: true });
const W = 3600, Z = 12, TZ = 256;            // 出力格子 1秒 / 地理院 dem_png z12（1.24秒/px＝格子と同オーダー）
const JP = { lngMin: 122, lngMax: 154, latMin: 20, latMax: 46 };
const L3 = n => String(n).padStart(3, '0');
const cellName = (lng, lat) => `${lat < 0 ? 'S' : 'N'}${L3(Math.abs(lat))}${lng < 0 ? 'W' : 'E'}${L3(Math.abs(lng))}`;   // JAXA index / encodeName の緯度先行表記

// ── PNG decode（8bit RGB/RGBA・非インターレース限定＝地理院 dem_png はこれ）──
function decodePNG(buf) {
	if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
	let pos = 8, w = 0, h = 0, bitDepth = 0, colorType = 0; const idat = [];
	while (pos < buf.length) {
		const len = buf.readUInt32BE(pos), type = buf.toString('ascii', pos + 4, pos + 8);
		const body = buf.subarray(pos + 8, pos + 8 + len);
		if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); bitDepth = body[8]; colorType = body[9];
			if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || body[12]) throw new Error(`png形式非対応 depth=${bitDepth} color=${colorType}`); }
		else if (type === 'IDAT') idat.push(body);
		else if (type === 'IEND') break;
		pos += 12 + len;
	}
	const bpp = colorType === 6 ? 4 : 3;
	const raw = inflateSync(Buffer.concat(idat));
	const stride = w * bpp, px = Buffer.alloc(h * stride);
	for (let y = 0; y < h; y++) {
		const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		const out = px.subarray(y * stride), prev = y ? px.subarray((y - 1) * stride) : null;
		for (let x = 0; x < stride; x++) {
			const a = x >= bpp ? out[x - bpp] : 0, b = prev ? prev[x] : 0, c = (prev && x >= bpp) ? prev[x - bpp] : 0;
			let v = row[x];
			if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
			else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
				v += (pa <= pb && pa <= pc) ? a : (pb <= pc) ? b : c; }
			out[x] = v;
		}
	}
	return { w, h, px, bpp };
}
// dem_png: x = R<<16|G<<8|B。x==2^23 無効、x>2^23 は (x−2^24)×0.01m、他 x×0.01m
const INVALID = -32768;
function demAt(tile, xi, yi) {
	const { px, bpp, w } = tile;
	const o = (yi * w + xi) * bpp, x = (px[o] << 16) | (px[o + 1] << 8) | px[o + 2];
	if (x === 8388608) return INVALID;
	return (x > 8388608 ? x - 16777216 : x) * 0.01;
}

// ── タイル取得（並列8・リトライ・404=全面無効として扱う）──
const tileCache = new Map();
let fetched = 0, missed = 0;
async function getTile(tx, ty) {
	const key = tx + '/' + ty;
	if (tileCache.has(key)) return tileCache.get(key);
	const url = `https://cyberjapandata.gsi.go.jp/xyz/dem_png/${Z}/${tx}/${ty}.png`;
	let tile = null;
	for (let a = 0; a < 3; a++) {
		try {
			const res = await fetch(url);
			if (res.status === 404) { missed++; break; }
			if (!res.ok) throw new Error('HTTP ' + res.status);
			tile = decodePNG(Buffer.from(await res.arrayBuffer())); fetched++;
			break;
		} catch (e) { if (a === 2) console.warn('tile失敗', url, e.message); else await new Promise(r => setTimeout(r, 500 * (a + 1))); }
	}
	tileCache.set(key, tile);
	return tile;
}
const merc = (lng, lat) => {
	const n = 2 ** Z;
	const x = (lng + 180) / 360 * n;
	const y = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n;
	return [x, y];
};

// ── 1セル焼き ──
async function bakeCell(lng0, lat0) {
	const t0 = Date.now();
	tileCache.clear(); fetched = 0; missed = 0;
	// 必要タイルを先読み（並列8）
	const [txMin] = merc(lng0, lat0 + 1), [txMax] = merc(lng0 + 1, lat0);
	const [, tyMin] = merc(lng0, lat0 + 1), [, tyMax] = merc(lng0 + 1, lat0);
	const jobs = [];
	for (let tx = Math.floor(txMin); tx <= Math.floor(txMax) + 1; tx++)
		for (let ty = Math.floor(tyMin); ty <= Math.floor(tyMax) + 1; ty++) jobs.push([tx, ty]);
	for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map(([x, y]) => getTile(x, y)));

	// 格子サンプル（バイリニア・無効近傍は有効側だけの重み平均）。data[0]=北西（AW3D30 と同じ行順）
	const grid = new Float64Array(W * W).fill(INVALID);
	let nValid = 0;
	for (let r = 0; r < W; r++) {
		const lat = lat0 + 1 - (r + 0.5) / W;
		for (let c = 0; c < W; c++) {
			const lng = lng0 + (c + 0.5) / W;
			const [mx, my] = merc(lng, lat);
			const gx = mx * TZ - 0.5, gy = my * TZ - 0.5;         // 全球ピクセル座標（pixel center 基準）
			const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
			let wsum = 0, vsum = 0;
			for (let dy = 0; dy <= 1; dy++) for (let dx = 0; dx <= 1; dx++) {
				const px2 = x0 + dx, py2 = y0 + dy;
				const tile = tileCache.get(((px2 / TZ) | 0) + '/' + ((py2 / TZ) | 0));
				if (!tile) continue;
				const v = demAt(tile, px2 % TZ, py2 % TZ);
				if (v === INVALID) continue;
				const w2 = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
				wsum += w2; vsum += v * w2;
			}
			if (wsum > 0) { grid[r * W + c] = vsum / wsum; nValid++; }
		}
	}
	if (!nValid) return null;   // 全面欠測＝GSI 範囲外（このセルは焼かない＝JAXA 継続）

	// 欠測の分類と充填：
	//  1) 全体を multi-source BFS（有効セルから grassfire）＝各欠測セルへ「最寄り有効値」を配る（湖面＝岸の高さ）
	//  2) 縁に接する欠測連結成分で、境界有効値の中央値 ≤10m は海＝0 に上書き
	const filled = Float64Array.from(grid);
	const queue = new Int32Array(W * W); let qh = 0, qt = 0;
	for (let i = 0; i < W * W; i++) if (grid[i] !== INVALID) queue[qt++] = i;
	const NB = [-1, 1, -W, W];
	while (qh < qt) {
		const i = queue[qh++];
		const r = (i / W) | 0, c = i % W;
		for (const d of NB) {
			const j = i + d;
			if (d === -1 && c === 0) continue; if (d === 1 && c === W - 1) continue;
			if (j < 0 || j >= W * W) continue;
			if (filled[j] === INVALID) { filled[j] = filled[i]; queue[qt++] = j; }
		}
	}
	// 海判定（元 grid の欠測成分単位）
	const seen = new Uint8Array(W * W);
	const q2 = new Int32Array(W * W);
	for (let s = 0; s < W * W; s++) {
		if (grid[s] !== INVALID || seen[s]) continue;
		let h2 = 0, t2 = 0; q2[t2++] = s; seen[s] = 1;
		let touchesBorder = false; const ring = [];
		const comp = [];
		while (h2 < t2) {
			const i = q2[h2++]; comp.push(i);
			const r = (i / W) | 0, c = i % W;
			if (r === 0 || r === W - 1 || c === 0 || c === W - 1) touchesBorder = true;
			for (const d of NB) {
				if (d === -1 && c === 0) continue; if (d === 1 && c === W - 1) continue;
				const j = i + d; if (j < 0 || j >= W * W) continue;
				if (grid[j] === INVALID) { if (!seen[j]) { seen[j] = 1; q2[t2++] = j; } }
				else if (ring.length < 20000) ring.push(grid[j]);
			}
		}
		if (touchesBorder && (ring.length === 0 || median(ring) <= 10)) for (const i of comp) filled[i] = 0;   // 海
	}
	const data = new Int16Array(W * W);
	for (let i = 0; i < W * W; i++) data[i] = Math.max(-32767, Math.min(32767, Math.round(filled[i])));

	const name = `R01${cellName(lng0, lat0)}`;
	const bin = encodeAltpbf({ name, source: 'GSI DEM10B', lng: lng0, lat: lat0, range: 1, width: W, height: W, data });
	writeFileSync(path.join(OUT, name + '.gz'), gzipSync(bin, { level: 9 }));
	console.log(`${name}: valid=${(nValid / W / W * 100).toFixed(1)}% tiles=${fetched}(404:${missed}) ${(bin.length / 1e6).toFixed(1)}MB→gz ${(Date.now() - t0) / 1000 | 0}s`);
	return { name, data };
}
const median = a => { const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };

// altpbf.js encode() と同一（TAGS/delta-SVarint/deflateRaw）
function encodeAltpbf({ name, source, lng, lat, range, width, height, data }) {
	const pbf = new Pbf();
	pbf.writeStringField(1, name);
	pbf.writeStringField(2, source);
	pbf.writeSVarintField(5, lng);
	pbf.writeSVarintField(6, lat);
	pbf.writeSVarintField(7, range);
	pbf.writeVarintField(3, width);
	pbf.writeVarintField(4, height);
	let sum = 0;
	const deltas = Array.from(data, t => { const v = t - sum; sum = t; return v; });
	pbf.writePackedSVarint(10, deltas);
	return deflateRawSync(Buffer.from(pbf.finish()));   // finish() の戻り値が本体（pbf.pos は finish 後 0）
}

// ── セル列挙（JAXA index ∩ 日本bbox）──
async function japanCells() {
	const txt = await (await fetch('https://www.eorc.jaxa.jp/ALOS/jp/dataset/aw3d30/data/List_of_all_tiles_in_AW3D30.txt')).text();
	const cells = [];
	for (const line of txt.split('\n')) {
		const m = line.match(/([NS])(\d+)([WE])(\d+)/); if (!m) continue;
		const lat = +m[2] * (m[1] === 'S' ? -1 : 1), lng = +m[4] * (m[3] === 'W' ? -1 : 1);
		if (lng >= JP.lngMin && lng < JP.lngMax && lat >= JP.latMin && lat < JP.latMax) cells.push([lng, lat]);
	}
	return cells;
}

// ── アップロード（bucket GIS/alt・put＝gzip 済みをそのまま）──
async function upload() {
	// キーの所在は uploader と同じ流儀＝apps/uploader/.env.local の VITE_API_KEY（gitignore済み）。env が優先。
	let key = process.env.ORTHO_API_KEY;
	if (!key) {
		const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../uploader/.env.local');
		if (existsSync(envPath)) {
			const txt = readFileSync(envPath, 'utf8');
			// VITE_API_KEY=... 形式（uploader 用）とキー裸置きの両対応
			key = txt.match(/^VITE_API_KEY=(.+)$/m)?.[1]?.trim() ?? (/^\S+$/.test(txt.trim()) ? txt.trim() : null);
		}
	}
	if (!key) { console.error('APIキー未設定：ORTHO_API_KEY env か apps/uploader/.env.local の VITE_API_KEY'); process.exit(1); }
	const files = readdirSync(OUT).filter(f => f.endsWith('.gz'));
	for (const f of files) {
		const name = f.replace(/\.gz$/, '');
		const body = readFileSync(path.join(OUT, f));
		const res = await fetch(`https://api.ortho-earth.com/bucket/GIS/alt/${name}`, {
			method: 'POST', body,
			headers: { 'X-Action': 'put', 'X-API-Key': key, 'X-Metadata-Type': 'application/octet-stream', 'X-Content-Encoding': 'gzip' },
		});
		console.log(res.ok ? `↑ ${name} (${(body.length / 1e6).toFixed(1)}MB)` : `✗ ${name} HTTP ${res.status}`);
		if (!res.ok) process.exit(1);
	}
}

// ── main ──
const args = process.argv.slice(2);
const arg = k => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] ?? true) : null; };
const targets = [];
if (arg('--cells')) for (const s of String(arg('--cells')).split(',')) {
	const m = s.match(/([EW])(\d+)([NS])(\d+)/i) || s.match(/([NS])(\d+)([EW])(\d+)/i);
	if (!m) { console.error('セル名不正:', s); process.exit(1); }
	const a = { [m[1].toUpperCase()]: +m[2], [m[3].toUpperCase()]: +m[4] };
	targets.push([(a.E ?? -a.W), (a.N ?? -a.S)]);
}
if (args.includes('--japan')) targets.push(...await japanCells());
if (targets.length) {
	console.log(`${targets.length} セルを焼く`);
	for (const [lng, lat] of targets) {
		if (existsSync(path.join(OUT, `R01${cellName(lng, lat)}.gz`)) && !args.includes('--force')) { console.log(`skip R01${cellName(lng, lat)}（既存）`); continue; }
		await bakeCell(lng, lat);
	}
}
if (args.includes('--upload')) await upload();
if (!targets.length && !args.includes('--upload')) console.log('使い方: --cells E138N035,... | --japan [--force] [--upload]');
