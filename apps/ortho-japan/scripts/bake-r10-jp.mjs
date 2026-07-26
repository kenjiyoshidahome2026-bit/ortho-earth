#!/usr/bin/env node
// 日本域の標高 R10 タイル（10°×10°・2400×2400・Int16）を GEBCO+DEM10B のマージで焼き直す。
// 動機: R10=GEBCO 2026 は内水面に偽山を持つ（琵琶湖実測: 水面84m に対し +30m超え 87/324点・最大1007m）
// ＝水面リフト+30m を貫通し、チルトで「湖の中の巨大な灰色の島」になる（レンダラでは尾根遮蔽と両立不能）。
// 解: 陸と内水面は bucket 常備の R01(GSI DEM10B＝hydro-flattening 済み) を 15×15 ダウンサンプルで転写、
//     海は GEBCO のバスメトリを温存（Google と同じ「データ側で水と地形の喧嘩を終わらせる」流儀）。
// GSI からの再取得は不要＝入力は全て自前 bucket（R10 GEBCO ベース + R01 DEM10B 群）。
//
// 使い方:
//   node scripts/bake-r10-jp.mjs                 # 日本bboxに掛かる全 R10 セルを焼く（R01 が1枚も無いセルはskip）
//   node scripts/bake-r10-jp.mjs --cells E130N30 # 指定セルのみ（検証用）
//   node scripts/bake-r10-jp.mjs --upload        # out の *.gz を bucket GIS/alt へ（要 ORTHO_API_KEY / uploader/.env.local）
//   node scripts/bake-r10-jp.mjs --verify        # 焼いた E130N30 の琵琶湖域を再サンプル（偽山消滅の確認）
// 出力: apps/ortho-japan/r10-out/（R01 のダウンロードキャッシュは r10-src/）
//
// ※クライアント側の追随: altpbf createGetHeight.js の staleDSM を拡張し、日本bboxに掛かる R10 で
//   source に DEM10B を含まない旧タイルを失効させる（IDB は upload 後の初回訪問で自己修復）。

import Pbf from 'pbf';
import { deflateRawSync, gzipSync, inflateRawSync, gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(DIR, '..', 'r10-out');
const SRC = path.join(DIR, '..', 'r10-src');   // R01/R10 ダウンロードキャッシュ（再実行を安く）
mkdirSync(OUT, { recursive: true });
mkdirSync(SRC, { recursive: true });

const JP = { lngMin: 122, lngMax: 154, latMin: 20, latMax: 46 };   // bake-dem10b.mjs / bakedJapan と同一
const R10W = 2400, R01W = 3600, SUB = 240, BLK = 15;               // 240=2400/10（1°分）・15=3600/240
const L3 = n => String(n).padStart(3, '0');
const cellName = (lng, lat) => `${lat < 0 ? 'S' : 'N'}${L3(Math.abs(lat))}${lng < 0 ? 'W' : 'E'}${L3(Math.abs(lng))}`;

// ── bucket タイルの取得と decode（altpbf.js encode()/decode() と同一フォーマット）──
async function fetchTile(name) {
	const cacheFile = path.join(SRC, name + '.bin');
	let buf;
	if (existsSync(cacheFile)) buf = readFileSync(cacheFile);
	else {
		const res = await fetch(`https://api.ortho-earth.com/bucket/GIS/alt/${name}`);
		if (res.status === 404) return null;
		if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
		buf = Buffer.from(await res.arrayBuffer());
		writeFileSync(cacheFile, buf);
	}
	if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
	let raw; try { raw = inflateRawSync(buf); } catch { raw = buf; }
	const pbf = new Pbf(raw), obj = {}, deltas = [];
	pbf.readFields(tag => {
		if (tag === 1) obj.name = pbf.readString();
		else if (tag === 2) obj.source = pbf.readString();
		else if (tag === 3) obj.width = pbf.readVarint();
		else if (tag === 4) obj.height = pbf.readVarint();
		else if (tag === 5) obj.lng = pbf.readSVarint();
		else if (tag === 6) obj.lat = pbf.readSVarint();
		else if (tag === 7) obj.range = pbf.readSVarint();
		else if (tag === 10) pbf.readPackedSVarint(deltas);
	});
	let s = 0; const data = new Int16Array(deltas.length);
	for (let i = 0; i < deltas.length; i++) data[i] = (s += deltas[i]);
	obj.data = data;
	return obj;
}

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
	return deflateRawSync(Buffer.from(pbf.finish()));
}

// ── 1つの R10 セルを焼く ──
// 行順は R01/R10 とも「row0=北」（AW3D30 由来の規約。calcHeight/downsampleFlipped がこの前提で読む）。
async function bakeR10(lngT, latT) {
	const t0 = Date.now();
	const name = `R10${cellName(lngT, latT)}`;
	const base = await fetchTile(name);
	if (!base) { console.log(`${name}: bucket にベース無し＝skip`); return null; }
	if (base.width !== R10W || base.height !== R10W) { console.log(`${name}: 想定外寸法 ${base.width}x${base.height}＝skip`); return null; }
	const grid = Int16Array.from(base.data);
	let replaced = 0, subs = 0;

	for (let lat0 = Math.max(latT, JP.latMin); lat0 < Math.min(latT + 10, JP.latMax); lat0++) {
		for (let lng0 = Math.max(lngT, JP.lngMin); lng0 < Math.min(lngT + 10, JP.lngMax); lng0++) {
			const r01 = await fetchTile(`R01${cellName(lng0, lat0)}`);
			if (!r01) continue;   // DEM10B 未収録（海のみ・GSI範囲外）＝GEBCO 温存
			if (!String(r01.source || '').includes('DEM10B')) { console.log(`  R01${cellName(lng0, lat0)}: source=${r01.source}＝DEM10B でないので skip`); continue; }
			subs++;
			// サブセルの転写先（R10 内・row0=北）：この 1° の北端行 = (latT+10 − (lat0+1)) × 240
			const rowOff = (latT + 10 - (lat0 + 1)) * SUB;
			const colOff = (lng0 - lngT) * SUB;
			for (let rr = 0; rr < SUB; rr++) {
				for (let cc = 0; cc < SUB; cc++) {
					// 15×15 ブロック平均。DEM10B の 0 は「海」（bake-dem10b.mjs が海成分を 0 に規約化）＝
					// 全ゼロブロックは GEBCO（バスメトリ）を温存。非ゼロを含むブロック（陸・内水面・负値の干拓地）は
					// 0 も含めた全平均＝海岸で滑らかに 0 へ落ちる（ALOS 流のダウンサンプルと同じ肌理）。
					let sum = 0, nonZero = 0;
					const r0 = rr * BLK, c0 = cc * BLK;
					for (let dy = 0; dy < BLK; dy++) {
						const off = (r0 + dy) * R01W + c0;
						for (let dx = 0; dx < BLK; dx++) { const v = r01.data[off + dx]; sum += v; if (v !== 0) nonZero++; }
					}
					if (!nonZero) continue;
					grid[(rowOff + rr) * R10W + colOff + cc] = Math.max(-32767, Math.min(32767, Math.round(sum / (BLK * BLK))));
					replaced++;
				}
			}
		}
	}
	if (!subs) { console.log(`${name}: R01 サブセル無し＝焼かない（GEBCO のまま）`); return null; }
	const source = `GEBCO 2026 + GSI DEM10B(JP)`;
	const bin = encodeAltpbf({ name, source, lng: lngT, lat: latT, range: 10, width: R10W, height: R10W, data: grid });
	writeFileSync(path.join(OUT, name + '.gz'), gzipSync(bin, { level: 9 }));
	console.log(`${name}: R01×${subs}枚を転写 texel置換=${(replaced / (R10W * R10W) * 100).toFixed(1)}% ${(bin.length / 1e6).toFixed(1)}MB ${(Date.now() - t0) / 1000 | 0}s`);
	return name;
}

// ── 検証（琵琶湖の偽山が消えたか）──
function verify() {
	const f = path.join(OUT, 'R10N030E130.gz');
	if (!existsSync(f)) { console.log('R10N030E130.gz が無い（先に焼く）'); return; }
	let buf = gunzipSync(readFileSync(f));
	const raw = inflateRawSync(buf);
	const pbf = new Pbf(raw); const deltas = []; let W2 = 0, H2 = 0, lngO = 0, latO = 0, src = '';
	pbf.readFields(tag => {   // 未処理タグは readFields が自動 skip（手動 skip は枠組みを壊す）
		if (tag === 2) src = pbf.readString();
		else if (tag === 3) W2 = pbf.readVarint();
		else if (tag === 4) H2 = pbf.readVarint();
		else if (tag === 5) lngO = pbf.readSVarint();
		else if (tag === 6) latO = pbf.readSVarint();
		else if (tag === 10) pbf.readPackedSVarint(deltas);
	});
	let s = 0; const data = new Int16Array(deltas.length);
	for (let i = 0; i < deltas.length; i++) data[i] = (s += deltas[i]);
	let over = 0, max = -9999, total = 0;
	for (let lat = 3505; lat <= 3540; lat += 2) for (let lng = 13590; lng <= 13625; lng += 2) {
		const x = Math.min(W2 - 1, Math.round((lng / 100 - lngO) / 10 * W2));
		const y = Math.min(H2 - 1, Math.round((lat / 100 - latO) / 10 * H2));
		const v = data[(H2 - Math.max(1, y)) * W2 + x];
		total++;
		if (v > 114) { over++; if (v > max) max = v; }
	}
	console.log(`[verify] source=${src} 琵琶湖域 ${total}点中 114m超え=${over}点 最大=${max}m（焼き前: 87点/最大1007m）`);
}

// ── アップロード（bake-dem10b.mjs と同一流儀）──
async function upload() {
	let key = process.env.ORTHO_API_KEY;
	if (!key) {
		const envPath = path.join(DIR, '../../uploader/.env.local');
		if (existsSync(envPath)) {
			const txt = readFileSync(envPath, 'utf8');
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
} else if (!args.includes('--upload') && !args.includes('--verify')) {
	// 日本bboxに掛かる全 R10 セル（10° 刻み）
	for (let lat = Math.floor(JP.latMin / 10) * 10; lat < JP.latMax; lat += 10)
		for (let lng = Math.floor(JP.lngMin / 10) * 10; lng < JP.lngMax; lng += 10) targets.push([lng, lat]);
}
if (targets.length) {
	console.log(`${targets.length} セル候補`);
	for (const [lng, lat] of targets) {
		if (existsSync(path.join(OUT, `R10${cellName(lng, lat)}.gz`)) && !args.includes('--force')) { console.log(`skip R10${cellName(lng, lat)}（既存）`); continue; }
		await bakeR10(lng, lat);
	}
}
if (args.includes('--verify')) verify();
if (args.includes('--upload')) await upload();
