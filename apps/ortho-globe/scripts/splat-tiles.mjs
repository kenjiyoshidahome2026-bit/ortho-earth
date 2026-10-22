#!/usr/bin/env node
// Gaussian splat の見本（Niantic の .spz・MIT）→ /globe/splat が読む 3D Tiles（glTF の KHR_gaussian_splatting＋SPZ 圧縮）と、掃除した 1 本の .spz を焼く（2026-10-21）。
// 置き場＝GitHub Pages（リポ ortho-data の globe/splat/<scene>/・本人裁定 10/14「uploader を使わずに github.io に置く」）。
// 焼いた先＝packages/world/out/splat/（world の out/ と同じ＝作り直せる生成物・git に入らない）→ 置くのは world の publish-pages.mjs：
//   node apps/ortho-globe/scripts/splat-tiles.mjs                      … Niantic の GitHub から .spz を取って 2 シーンを焼く（取った物は out/ の隣の .src/ に残す）
//   node apps/ortho-globe/scripts/splat-tiles.mjs --scene=hornedlizard  … 1 シーンだけ
//   node apps/ortho-globe/scripts/splat-tiles.mjs --src=DIR             … 手元の <scene>.spz から
//   npm run publish:pages -w world-data -- --only=splat            （予行）→ 同じに --write（commit して push）
// 焼く物（scene ごと）：
//   tileset.json       … 八分木（refine REPLACE）。根と中の節＝部分木の「重い順」の見本（不透明度×大きさ）・葉＝その箱の全部。root.transform＝置き場の東北上（ECEF）
//   t/<節>.glb         … glTF＋KHR_gaussian_splatting・KHR_gaussian_splatting_compression_spz_2（bufferView に .spz v2 の本体＝plugin の parseSpz が解く）
//   <scene>.spz        … 掃除した 1 本（遠くの外れ値と巨大な splat を落とし・床を y 0・中心を x z 0 に）＝頁の「1 本で読む」の側。SH 3 次のまま
//   meta.json          … 出典・ライセンス・個数・箱・節の数・bytes
// 座標＝.spz の約束（RUB・y 上）＝glTF と同じ向きのまま置く（タイルは y-up→z-up を 3D Tiles の決まりで受ける）。置き場の向きは root.transform の方位で回す（SH は plugin が視線を元の軸へ戻して評価する＝回さなくてよい）。
import fs from "node:fs"; import path from "node:path"; import { gzipSync } from "node:zlib"; import { fileURLToPath } from "node:url";
import { parseSpz, encodeSpzRaw } from "@ortho-earth/plugin-splat";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const arg = n => (process.argv.find(a => a.startsWith(`--${n}=`)) ?? "").slice(n.length + 3);
const OUT = path.resolve(arg("out") || path.join(ROOT, "packages/world/out/splat"));
const SRC = arg("src") ? path.resolve(arg("src")) : path.join(OUT, ".src");   // 取った元（.＝publish-pages の walk は見ない）
const LEAF = +arg("leaf") || 100000;          // 葉の最大の個数（これ以下なら割らない）
const INNER = +arg("inner") || 60000;         // 中の節の見本の上限
const INNER_RATIO = 0.35;                      // 中の節の見本＝部分木の 35%（親は子より必ず粗い）
const ONLY = arg("scene").split(",").filter(Boolean);
const SOURCE = "https://github.com/nianticlabs/spz", RAW = "https://raw.githubusercontent.com/nianticlabs/spz/main/samples/";
// 見本＝東京駅 丸の内駅前広場。origin の高さ＝標高（engine の高さは標高基準＝楕円体高ではない・Mac の実描画で 37 m 浮いた 2026-10-21）。
// scale＝実物の何倍で置くか：この地球儀の一番の寄りは約 150 m（z20 の上限）＝実寸のアライグマは数 px にしかならない → 10 倍（広場に 50〜60 m の像として立つ）。2 体は 90 m 離す
const SCENES = [
//   clip＝床の中心からの水平の半径（m）・clipY＝床からの高さの上限（m）・maxSigma＝これより大きい splat は捨てる（空や背景の巨大な楕円）。床＝y の最頻値（2 cm 刻み）＝床より 10 cm 下の浮き（floater）も捨てる
	{ id: "racoonfamily", file: "racoonfamily.spz", title: "Raccoon family", origin: [139.76560, 35.68150, 3.3], heading: 20, scale: 10, clip: 2.5, clipY: 2.5, maxSigma: 0.4 },
	{ id: "hornedlizard", file: "hornedlizard.spz", title: "Horned lizard", origin: [139.76560, 35.68070, 3.3], heading: -30, scale: 10, clip: 3, clipY: 2.5, maxSigma: 0.4 },
];
// 地面＝見本の下に敷く画像タイル（地理院の空中写真・z18 まで）。頁（/globe/）は地域を持たない決まりなので、どこの何を敷くかは index.json の側で申告する（verify-prod の static の門）
const GROUND = { url: "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", href: "https://maps.gsi.go.jp/development/ichiran.html#seamlessphoto", name: "GSI Aerial Photo", minZoom: 2, maxZoom: 18, bbox: [122, 20, 154, 46] };
const LICENSE = { source: "Niantic Labs — spz sample scenes", url: SOURCE, license: "MIT", note: "Copyright (c) 2024 Niantic Labs. Cleaned (clipped, re-centred), scaled up and re-encoded for the demo." };

const pad4 = b => { const n = (4 - b.length % 4) % 4; return n ? Buffer.concat([b, Buffer.alloc(n, 0)]) : b; };
const kb = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${(n / 1e3).toFixed(0)}KB`;
const pct = (arr, p) => { const a = Float64Array.from(arr).sort(); return a[Math.min(a.length - 1, Math.floor(a.length * p))]; };
// 東北上（ENU）→ ECEF の列優先 4×4（3D Tiles の root.transform）。heading＝北から時計回り（度）＝glTF の −z（前）がその向きになるよう上の軸で回す
function enuTransform([lng, lat, h], heading = 0) {
	const lo = lng * Math.PI / 180, la = lat * Math.PI / 180, a = 6378137, e2 = 0.00669437999014, N = a / Math.sqrt(1 - e2 * Math.sin(la) ** 2);
	const O = [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - e2) + h) * Math.sin(la)];
	const E = [-Math.sin(lo), Math.cos(lo), 0], Nn = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)], U = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
	const t = heading * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);   // 時計回り（上から見て）＝東 → 南 へ回す向き
	const X = [E[0] * c - Nn[0] * s, E[1] * c - Nn[1] * s, E[2] * c - Nn[2] * s], Y = [E[0] * s + Nn[0] * c, E[1] * s + Nn[1] * c, E[2] * s + Nn[2] * c];
	return [...X, 0, ...Y, 0, ...U, 0, ...O, 1];
}
// glTF（KHR_gaussian_splatting＋SPZ 圧縮）＝accessor は bufferView 無し（個数と箱だけ）・本体は bufferView 0 の .spz
function splatGlb(spzBytes, n, mn, mx, shDeg) {
	const bin = pad4(Buffer.from(spzBytes));
	const attributes = { POSITION: 0, "KHR_gaussian_splatting:SCALE": 1, "KHR_gaussian_splatting:ROTATION": 2, "KHR_gaussian_splatting:OPACITY": 3, "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0": 4 };
	const accessors = [{ componentType: 5126, count: n, type: "VEC3", min: mn, max: mx }, { componentType: 5126, count: n, type: "VEC3" }, { componentType: 5126, count: n, type: "VEC4" }, { componentType: 5126, count: n, type: "SCALAR" }, { componentType: 5126, count: n, type: "VEC3" }];
	for (let l = 1; l <= shDeg; l++) for (let k = 0; k < 2 * l + 1; k++) { attributes[`KHR_gaussian_splatting:SH_DEGREE_${l}_COEF_${k}`] = accessors.length; accessors.push({ componentType: 5126, count: n, type: "VEC3" }); }
	const json = { asset: { version: "2.0", generator: "ortho-earth splat-tiles.mjs", copyright: "Niantic Labs (MIT)" }, extensionsUsed: ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"], extensionsRequired: ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"],
		scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ attributes, mode: 0, extensions: { KHR_gaussian_splatting: { kernel: "ellipse", colorSpace: "srgb_rec709_display" }, KHR_gaussian_splatting_compression_spz_2: { bufferView: 0 } } }] }],
		accessors, buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: spzBytes.length }] };
	const J = pad4(Buffer.from(JSON.stringify(json))); for (let i = J.length - 1; i >= 0 && J[i] === 0; i--) J[i] = 0x20;   // JSON の詰めは空白
	const head = Buffer.alloc(12); head.write("glTF", 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + J.length + 8 + bin.length, 8);
	const cj = Buffer.alloc(8); cj.writeUInt32LE(J.length, 0); cj.writeUInt32LE(0x4E4F534A, 4);
	const cb = Buffer.alloc(8); cb.writeUInt32LE(bin.length, 0); cb.writeUInt32LE(0x004E4942, 4);
	return Buffer.concat([head, cj, J, cb, bin]);
}
// 添字の列 → SplatData の部分（sh も）
function subset(d, idx) {
	const n = idx.length, K = d.sh ? d.sh.length / d.n : 0;
	const o = { n, positions: new Float32Array(n * 3), scales: new Float32Array(n * 3), rotations: new Float32Array(n * 4), colors: new Uint8Array(n * 4), sh: K ? new Float32Array(n * K) : undefined };
	for (let j = 0; j < n; j++) {
		const i = idx[j];
		o.positions.set(d.positions.subarray(i * 3, i * 3 + 3), j * 3); o.scales.set(d.scales.subarray(i * 3, i * 3 + 3), j * 3);
		o.rotations.set(d.rotations.subarray(i * 4, i * 4 + 4), j * 4); o.colors.set(d.colors.subarray(i * 4, i * 4 + 4), j * 4);
		if (K) o.sh.set(d.sh.subarray(i * K, i * K + K), j * K);
	}
	return o;
}
const bboxOf = (d, idx) => { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (const i of idx) for (let k = 0; k < 3; k++) { const v = d.positions[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; } return [mn, mx]; };
// 3D Tiles の箱（タイルの枠＝root.transform の東北上）＝glTF の (x, y, z) → (x, −z, y)。σ の 3 倍だけ膨らます
const tileBox = (mn, mx, pad) => { const c = [(mn[0] + mx[0]) / 2, -(mn[2] + mx[2]) / 2, (mn[1] + mx[1]) / 2], h = [(mx[0] - mn[0]) / 2 + pad, (mx[2] - mn[2]) / 2 + pad, (mx[1] - mn[1]) / 2 + pad]; return { box: [...c, h[0], 0, 0, 0, h[1], 0, 0, 0, h[2]] }; };

async function bake(sc) {
	const t0 = performance.now();
	const dir = path.join(OUT, sc.id), src = path.join(SRC, sc.file);
	let bytes;
	if (fs.existsSync(src)) { console.log(`${sc.id}: ${src}`); bytes = fs.readFileSync(src); }
	else {
		console.log(`${sc.id}: ${RAW + sc.file} を取る…`);
		const r = await fetch(RAW + sc.file); if (!r.ok) throw new Error(`${sc.file}: ${r.status}`);
		bytes = Buffer.from(await r.arrayBuffer()); fs.mkdirSync(SRC, { recursive: true }); fs.writeFileSync(src, bytes);
	}
	const d = await parseSpz(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)), n0 = d.n, K = d.sh ? d.sh.length / n0 : 0, shDeg = K === 45 ? 3 : K === 24 ? 2 : K === 9 ? 1 : 0;
	console.log(`  ${n0.toLocaleString()} 個・SH ${shDeg} 次・${kb(bytes.length)}`);
	// 掃除：中心（x z の中央値）・床（y の最頻値＝2 cm 刻み・中央値の ±3 m の中）を決め、半径 clip の外・床より 10 cm 下・clipY より上・σ が maxSigma 超・ほぼ透明 を捨てる
	const med = [0, 1, 2].map(k => pct(d.positions.filter((_, i) => i % 3 === k), 0.5));
	const yh = new Map(); for (let i = 0; i < n0; i++) { const y = d.positions[i * 3 + 1] - med[1]; if (Math.abs(y) < 3) { const b = Math.round(y * 50); yh.set(b, (yh.get(b) || 0) + 1); } }
	const floor = med[1] + [...yh].sort((a, b) => b[1] - a[1])[0][0] / 50;
	const keep = [];
	for (let i = 0; i < n0; i++) {
		const x = d.positions[i * 3] - med[0], y = d.positions[i * 3 + 1] - floor, z = d.positions[i * 3 + 2] - med[2];
		if (Math.hypot(x, z) > sc.clip || y < -0.1 || y > sc.clipY) continue;
		if (Math.max(d.scales[i * 3], d.scales[i * 3 + 1], d.scales[i * 3 + 2]) > sc.maxSigma) continue;
		if (d.colors[i * 4 + 3] < 5) continue;
		keep.push(i);
	}
	const c = subset(d, keep), n = c.n;
	for (let i = 0; i < n; i++) { c.positions[i * 3] -= med[0]; c.positions[i * 3 + 1] -= floor; c.positions[i * 3 + 2] -= med[2]; }
	const S = sc.scale || 1;   // 拡大＝位置と σ を S 倍（タイルにも 1 本にも焼き込む＝頁は何も足さない）
	if (S !== 1) for (let i = 0; i < n * 3; i++) { c.positions[i] *= S; c.scales[i] *= S; }
	const pad = 3 * sc.maxSigma * S;   // 箱の余白＝一番大きい σ の 3 倍（拡大後）
	console.log(`  床 y=${floor.toFixed(3)}（元の座標）・中心 x=${med[0].toFixed(3)} z=${med[2].toFixed(3)}`);
	const all = Array.from({ length: n }, (_, i) => i), [MN, MX] = bboxOf(c, all);
	console.log(`  掃除 → ${n.toLocaleString()} 個（${(100 * n / n0).toFixed(1)}%）・箱 x ${MN[0].toFixed(2)}..${MX[0].toFixed(2)} y ${MN[1].toFixed(2)}..${MX[1].toFixed(2)} z ${MN[2].toFixed(2)}..${MX[2].toFixed(2)} m`);
	// 重さ＝不透明度 × 一番大きい σ（plugin の importanceRank と同じ目）
	const w = new Float64Array(n); for (let i = 0; i < n; i++) w[i] = c.colors[i * 4 + 3] / 255 * Math.max(c.scales[i * 3], c.scales[i * 3 + 1], c.scales[i * 3 + 2]);
	fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(path.join(dir, "t"), { recursive: true });
	let tiles = 0, bytesOut = 0, depthMax = 0;
	const write = (name, idx) => { const [mn, mx] = bboxOf(c, idx), s = subset(c, idx), glb = splatGlb(gzipSync(encodeSpzRaw(s), { level: 9 }), idx.length, mn, mx, shDeg); fs.writeFileSync(path.join(dir, "t", name), glb); tiles++; bytesOut += glb.length; return [mn, mx]; };
	// 八分木（添字で割る）。節の名＝経路（r・r0..r7・…）。中の節＝部分木の重い順の見本
	const node = (idx, name, depth) => {
		depthMax = Math.max(depthMax, depth);
		const [mn, mx] = bboxOf(c, idx), ext = Math.max(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]);
		if (idx.length <= LEAF || ext < 0.05) { write(`${name}.glb`, idx); return { boundingVolume: tileBox(mn, mx, pad), geometricError: 0, content: { uri: `t/${name}.glb` } }; }
		const sample = idx.slice().sort((a, b) => w[b] - w[a]).slice(0, Math.min(INNER, Math.ceil(idx.length * INNER_RATIO)));
		write(`${name}.glb`, sample);
		const mid = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2], bins = Array.from({ length: 8 }, () => []);
		for (const i of idx) bins[(c.positions[i * 3] >= mid[0] ? 1 : 0) | (c.positions[i * 3 + 1] >= mid[1] ? 2 : 0) | (c.positions[i * 3 + 2] >= mid[2] ? 4 : 0)].push(i);
		const children = bins.map((b, k) => b.length ? node(b, `${name}${k}`, depth + 1) : null).filter(Boolean);
		// 画面の誤差＝節の大きさの 1/4（maxSSE 16 px なら、節の広がりが画面で約 64 px 以上になった時に子へ）
		return { boundingVolume: tileBox(mn, mx, pad), geometricError: Math.max(0.02, ext / 4), refine: "REPLACE", content: { uri: `t/${name}.glb` }, children };
	};
	const root = node(all, "r", 0);
	root.transform = enuTransform(sc.origin, sc.heading);
	const tileset = { asset: { version: "1.1", generator: "ortho-earth splat-tiles.mjs", copyright: "Niantic Labs (MIT)" }, geometricError: Math.max(root.geometricError * 4, 1), extensionsUsed: ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"], extensionsRequired: ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"], root };
	fs.writeFileSync(path.join(dir, "tileset.json"), JSON.stringify(tileset));
	// 掃除した 1 本（SH つき）
	const one = gzipSync(encodeSpzRaw(c), { level: 9 }); fs.writeFileSync(path.join(dir, `${sc.id}.spz`), one);
	const meta = { ...LICENSE, scene: sc.id, title: sc.title, file: sc.file, origin: sc.origin, heading: sc.heading, scale: S, splats: n, splatsSource: n0, shDegree: shDeg, bbox: { min: MN, max: MX }, tiles, depth: depthMax, bytesTiles: bytesOut, bytesSpz: one.length, leaf: LEAF, inner: INNER, baked: new Date().toISOString().slice(0, 10) };
	fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 1));
	console.log(`  → ${tiles} 枚・深さ ${depthMax}・タイル ${kb(bytesOut)}・1 本 ${kb(one.length)}・${((performance.now() - t0) / 1000).toFixed(1)} s`);
	return meta;
}
const metas = [];
for (const sc of SCENES.filter(s => !ONLY.length || ONLY.includes(s.id))) metas.push(await bake(sc));
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify({ ...LICENSE, ground: GROUND, scenes: metas.map(m => ({ id: m.scene, title: m.title, origin: m.origin, heading: m.heading, scale: m.scale, splats: m.splats, tiles: m.tiles, bytesTiles: m.bytesTiles, bytesSpz: m.bytesSpz })) }, null, 1));
console.log(`index.json → ${OUT}`);
