#!/usr/bin/env node
// bake.js（純CPUベイク＝uploadGintTextures と bake worker の単一真実源）の検証ハーネス。
//   1. bakeBase の出力が utility.js builder 直呼び（旧 uploadGintTextures の CPU 部の写経）と byte-exact
//   2. tierPlan（hist 先読み 0.7 ガード）が「実構築の辺数」と一致＝作らない段は走査しない、の正確さ
//   3. bakeTier の出力が buildEdgeMeta 直呼びと byte-exact
//   4. 正規化の冪等性（bake を2回かけても polyStream 不変）＝bake worker とフォールバック同期経路の共存安全
// 実データ（nps/coast）は tests/data/ にあれば追加検証（無ければ合成のみ＝CI向き決定的）。
// 使い方: node packages/ortho-core/tests/gint-bake.mjs

import { bakeBase, bakeTier, tierPlan, CHUNK_EDGES } from '../src/gl/gint/bake.js';
import { buildEdgeMeta, buildBoundaryEdgeMeta, normalizeRingOrientation,
         buildPolyBboxByFid, deriveOutlineZoom, buildWeightHist } from '../src/gl/gint/utility.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
let fails = 0;
const ok = (cond, label) => { if (cond) return; fails++; console.error(`  ✗ ${label}`); };
const sameU32 = (a, b) => a.length === b.length && a.every ? a.every((v, i) => v === b[i]) : (() => {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
})();

// 決定的合成データ（gint-lod.mjs の genData と同系＝共有 arc・reversed・multi-ring 込み）
function mulberry32(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0;
	let x = Math.imul(a ^ a >>> 15, 1 | a); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; }; }
function genData(rnd, nArcs = 90, maxLen = 40) {
	const lens = [];
	for (let a = 0; a < nArcs; a++) lens.push(2 + Math.floor(rnd() * (maxLen - 2)));
	const total = lens.reduce((s, l) => s + l, 0);
	const arcU32 = new Uint32Array(total * 2);
	const arcMeta = new Uint32Array(lens.length * 8);
	let off = 0;
	lens.forEach((len, aid) => {
		arcMeta[aid * 8] = off; arcMeta[aid * 8 + 1] = len;
		const b = aid * 8; const x = Math.floor(rnd() * 3.6e9), y = Math.floor(rnd() * 1.8e9);
		arcMeta[b + 4] = x; arcMeta[b + 5] = y; arcMeta[b + 6] = x + 1e6; arcMeta[b + 7] = y + 1e6;
		for (let i = 0; i < len; i++) {
			const term = (i === 0 || i === len - 1);
			let w = 0; while (w < 62 && rnd() < 0.72) w++;
			arcU32[(off + i) * 2]     = term ? 0 : w;
			arcU32[(off + i) * 2 + 1] = term ? 0x80000000 : 0;
		}
		off += len;
	});
	const poly = [];
	for (let f = 0; f < Math.floor(nArcs / 3); f++) {
		const a1 = f * 3, a2 = f * 3 + 1;
		poly.push(f, 1, 2, a1, a2, 1000 + f, 1, 2, ~a2, ~a1);
	}
	const line = [];
	for (let a = Math.floor(nArcs / 3) * 3, f = 5000; a < nArcs; a += 2, f++) {
		const two = a + 1 < nArcs;
		line.push(f, 1, two ? 2 : 1, (a % 4 === 0) ? ~a : a);
		if (two) line.push((a % 3 === 0) ? ~(a + 1) : a + 1);
	}
	const mk = () => ({   // bake は polyStream を正規化で書き換える＝ケース毎に新品を作るファクトリ
		arcBuffer: { buffer: arcU32.buffer, byteOffset: 0, byteLength: arcU32.byteLength, length: total },
		arcMeta: arcMeta.slice(), polyStream: Int32Array.from(poly), lineStream: Int32Array.from(line),
		pointBuffer: null, point: null, polyCompBbox: null });
	return { mk, arcU32 };
}

function referenceBake(g) {   // 旧 uploadGintTextures の CPU 部（builder 直呼び）＝比較対象
	normalizeRingOrientation(g.arcBuffer, g.arcMeta, g.polyStream);
	const polyBboxByFid = buildPolyBboxByFid(g.polyStream, g.arcMeta);
	const metaOpts = { orderBbox: polyBboxByFid, chunkEdges: CHUNK_EDGES };
	const base = buildEdgeMeta(g.arcMeta, g.polyStream, g.lineStream, null, 0, metaOpts);
	const outlineZoom = deriveOutlineZoom(polyBboxByFid);
	const boundary = g.polyStream?.length ? buildBoundaryEdgeMeta(g.arcMeta, g.polyStream, g.lineStream, g.arcBuffer, 0) : null;
	return { base, boundary, polyBboxByFid, outlineZoom };
}

function verify(label, mkA, mkB, arcU32ForHist) {
	console.log(`■ ${label}`);
	const gA = mkA(), gB = mkB();
	const art = bakeBase(gA);
	const ref = referenceBake(gB);
	ok(sameU32(gA.polyStream ?? new Int32Array(0), gB.polyStream ?? new Int32Array(0)), '正規化後 polyStream 一致');
	ok(art.base.edgeCount === ref.base.edgeCount, `base edgeCount ${art.base.edgeCount} == ${ref.base.edgeCount}`);
	ok(art.base.polyEdgeCount === ref.base.polyEdgeCount, 'base polyEdgeCount 一致');
	ok(sameU32(art.base.metaU32, ref.base.metaU32), 'base metaU32 byte-exact');
	ok(JSON.stringify(art.base.chunks) === JSON.stringify(ref.base.chunks), 'chunks 台帳一致');
	ok(JSON.stringify([...art.polyBboxByFid ?? []]) === JSON.stringify([...ref.polyBboxByFid ?? []]), 'polyBboxByFid 一致');
	ok((art.outlineZoom ?? null) === (ref.outlineZoom ?? null) ||
		Math.abs(art.outlineZoom - ref.outlineZoom) < 1e-12, `outlineZoom ${art.outlineZoom} == ${ref.outlineZoom}`);
	const bA = art.boundary, bB = ref.boundary?.edgeCount > 0 ? ref.boundary : null;
	ok(!!bA === !!bB && (!bA || (bA.edgeCount === bB.edgeCount && sameU32(bA.metaU32, bB.metaU32))), '境界メタ byte-exact');

	// tierPlan（hist 先読み）＝実構築の辺数と厳密一致（0.7 ガードの判定材料の正確さ）
	const { hist, nUsages } = buildWeightHist(gA.arcMeta, gA.polyStream, gA.lineStream, arcU32ForHist);
	for (const w of tierPlan(gA, art.base.edgeCount, null)) {
		const t = bakeTier(gA, w, art.polyBboxByFid);
		ok(hist[w] - nUsages === t.edgeCount, `tierPlan w${w}: hist予測 ${hist[w] - nUsages} == 実構築 ${t.edgeCount}`);
		const r = buildEdgeMeta(gA.arcMeta, gA.polyStream, gA.lineStream, gA.arcBuffer, w, { orderBbox: art.polyBboxByFid, chunkEdges: CHUNK_EDGES });
		ok(sameU32(t.metaU32, r.metaU32), `bakeTier w${w} byte-exact`);
	}

	// 冪等性：もう一度 bakeBase しても polyStream / base が不変（_ringsNormalized フラグ＋正規化の冪等）
	const again = bakeBase(gA);
	ok(sameU32(again.base.metaU32, art.base.metaU32), '2回目 bakeBase 不変（冪等）');
	console.log(fails ? `  → 失敗あり` : '  ✓ 全一致');
}

{	// 合成データ
	const g1 = genData(mulberry32(0xC0A57));
	const g2 = genData(mulberry32(0xC0A57));   // 同シード＝同一データの独立コピー
	verify('合成データ（共有arc・reversed・multi-ring）', g1.mk, g2.mk, g1.arcU32);
}

// 実データ（あれば）：nps（離散ポリゴン・451万辺）と coast（純ライン・41万辺）
for (const [prefix, label] of [['nps', '国立公園 nps_all'], ['coast', 'NE10m 海岸線']]) {
	const p = n => path.join(DATA, `${prefix}-${n}.bin`);
	if (!existsSync(p('arcbuf'))) continue;
	const rd = n => { const b = readFileSync(p(n)); return new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
	const arcU32 = rd('arcbuf'), arcMeta = rd('arcmeta');
	const ps = existsSync(p('polystream')) ? new Int32Array(rd('polystream').buffer) : null;
	const ls = existsSync(p('linestream')) ? new Int32Array(rd('linestream').buffer) : null;
	const mk = () => ({
		arcBuffer: { buffer: arcU32.buffer.slice(0), byteOffset: arcU32.byteOffset, byteLength: arcU32.byteLength, length: arcU32.length / 2 },
		arcMeta: arcMeta.slice(), polyStream: ps ? ps.slice() : null, lineStream: ls ? ls.slice() : null,
		pointBuffer: null, point: null, polyCompBbox: null });
	verify(`実データ: ${label}`, mk, mk, arcU32);
}

console.log(fails ? `✗ ${fails} 件失敗` : '✓ gint-bake 全項目 PASS');
process.exit(fails ? 1 : 0);
