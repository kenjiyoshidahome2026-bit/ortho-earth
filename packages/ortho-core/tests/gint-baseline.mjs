#!/usr/bin/env node
// 離散データ（国立公園 nps_all 級）の LOD 実効性の基準線計測（Phase 0）。
// v2 renderCleanScene/pickLineTier の選択ロジックを JS ミラーし、ズーム毎に
// 「実際に発行される辺数」を4シナリオで並べる：
//   A: tier 梯子あり（定常＝あるべき姿）
//   B: tier 梯子なし（z7 スロット交替直後〜構築完了までの実態ウィンドウ）
//   C: lowZoom 境界メタ経路（z<outlineZoom＝カリング無効 runs=null）
//   D: feature-rank 射影（Phase 2a: bbox がサブピクセルの地物を tier から落とした場合）
// 使い方: bash prep-data.sh nps_all nps && node packages/ortho-core/tests/gint-baseline.mjs [prefix=nps]

import { buildEdgeMeta, buildWeightHist, buildBoundaryEdgeMeta,
         normalizeRingOrientation, buildPolyBboxByFid, deriveOutlineZoom } from '../src/gl/gint/utility.js';
import { tierPlan, CHUNK_EDGES } from '../src/gl/gint/bake.js';   // 本番と同じ梯子/チャンク粒度＝drift しない
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const PREFIX = process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : 'nps';

// ── データ読込（polystream/linestream はどちらか欠けてよい）──
const p = n => path.join(DATA, `${PREFIX}-${n}.bin`);
if (!existsSync(p('arcbuf'))) { console.error(`データ無し: bash prep-data.sh <bucket名> ${PREFIX} を先に`); process.exit(1); }
const rd = n => { const b = readFileSync(p(n)); return new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
const arcU32  = rd('arcbuf');
const arcMeta = rd('arcmeta');
const polyStream = existsSync(p('polystream')) ? new Int32Array(rd('polystream').buffer) : null;
const lineStream = existsSync(p('linestream')) ? new Int32Array(rd('linestream').buffer) : null;
const arcBuffer = { buffer: arcU32.buffer, byteOffset: arcU32.byteOffset, byteLength: arcU32.byteLength, length: arcU32.length / 2 };
const nArcs = arcMeta.length / 8;
console.log(`■ ${PREFIX}: arcs=${nArcs.toLocaleString()} 頂点=${(arcU32.length / 2).toLocaleString()}` +
	` poly=${polyStream ? '有' : '無'} line=${lineStream ? '有' : '無'}`);

// ── textures.js uploadGintTextures と同順の CPU 側ベイク（時間も計る＝render worker ブロック実測）──
const t0 = performance.now();
normalizeRingOrientation(arcBuffer, arcMeta, polyStream);
const tNorm = performance.now();
const polyBboxByFid = buildPolyBboxByFid(polyStream, arcMeta);
const metaOpts = { orderBbox: polyBboxByFid, chunkEdges: CHUNK_EDGES };
const base = buildEdgeMeta(arcMeta, polyStream, lineStream, null, 0, metaOpts);
const tBase = performance.now();
const outlineZoom = deriveOutlineZoom(polyBboxByFid);
const bnd = polyStream ? buildBoundaryEdgeMeta(arcMeta, polyStream, lineStream, arcBuffer, 0) : { edgeCount: 0, polyEdgeCount: 0 };
const tBnd = performance.now();
const { hist, nUsages } = buildWeightHist(arcMeta, polyStream, lineStream, arcU32);
const tHist = performance.now();

console.log(`  基準メタ: ${base.edgeCount.toLocaleString()}辺 (poly ${base.polyEdgeCount.toLocaleString()}) チャンク${base.chunks?.length}個`);
console.log(`  境界メタ: ${bnd.edgeCount.toLocaleString()}辺 = 基準比 ${(100 * bnd.edgeCount / Math.max(1, base.edgeCount)).toFixed(1)}%` +
	`（netting ${bnd.edgeCount / Math.max(1, base.edgeCount) > 0.7 ? '効かず＝離散データ' : '有効'}）`);
console.log(`  outlineZoom(v2 derive) = ${outlineZoom?.toFixed(2) ?? 'null'} → lowZoom境界経路は z<${outlineZoom?.toFixed(1)}（移動中は +1.5z）`);
console.log(`  ベイク時間(このマシン): 正規化 ${(tNorm - t0).toFixed(0)}ms / bbox+基準メタ ${(tBase - tNorm).toFixed(0)}ms` +
	` / 境界メタ ${(tBnd - tBase).toFixed(0)}ms / hist ${(tHist - tBnd).toFixed(0)}ms`);

// ── tier 採否（本番 tierPlan＝weightHist 分位点の適応梯子・単一真実源）＋実構築 ──
const plan = tierPlan({ arcBuffer, arcMeta, polyStream, lineStream }, base.edgeCount, { hist, nUsages });
for (const w of plan) console.log(`  tier w${w}: hist予測 ${Math.max(0, hist[w] - nUsages).toLocaleString()}辺`);
const tTier0 = performance.now();
const tiers = plan.map(w => {
	const r = buildEdgeMeta(arcMeta, polyStream, lineStream, arcBuffer, w, metaOpts);
	return { minW: w, edgeCount: r.edgeCount, chunks: r.chunks };
});
const tTier1 = performance.now();
console.log(`  梯子: ${tiers.map(t => `w${t.minW}=${t.edgeCount.toLocaleString()}辺`).join(' / ') || '(なし)'}` +
	`（構築 ${(tTier1 - tTier0).toFixed(0)}ms＝交替毎にrender workerが払う遅延構築の総量）`);

// ── feature-rank（Phase 2a 射影の材料）: fid→bboxランク と fid→minW別辺数 ──
// featureRank = 「地物 bbox 面積が 1px を割るランク」（VW と同系式・cosφ 補正）。
const featureRank = new Map();
if (polyBboxByFid) for (const [fid, bb] of polyBboxByFid) {
	const latC = ((bb[1] + bb[3]) / 2) * 1e-7 - 90;
	const area = Math.max(1e-30, (bb[2] - bb[0]) * 1e-7 * Math.cos(latC * Math.PI / 180) * (bb[3] - bb[1]) * 1e-7);
	featureRank.set(fid, Math.max(0, Math.min(63, Math.floor(1.5 * Math.log2(area) + 61.524))));
}
// fid ごとの kept 辺数（minW 別）＝ polyStream を1周し arc の kept を数える
const getW = idx => (arcU32[idx * 2 + 1] & 0x80000000) ? 63 : (arcU32[idx * 2] & 0x3F);
function edgesByFid(minW) {
	const m = new Map();
	if (!polyStream) return m;
	let p2 = 0;
	while (p2 < polyStream.length) {
		const fid = polyStream[p2++], nr = polyStream[p2++];
		let e = m.get(fid) ?? 0;
		for (let r = 0; r < nr; r++) { const ac = polyStream[p2++];
			for (let a = 0; a < ac; a++) {
				const ai = polyStream[p2++], aid = ai < 0 ? ~ai : ai;
				const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
				if (!minW) { e += len - 1; continue; }
				let kept = 0;
				for (let i = 0; i < len; i++) if (getW(off + i) >= minW) kept++;
				e += Math.max(0, kept - 1);
			}
		}
		m.set(fid, e);
	}
	return m;
}

// ── ズーム毎の発行辺数（A/B/C/D）──
// 視野: 1280×800 CSS px を日本中央 (138E, 37N) に置く。可視チャンク判定は visibleRuns と同式。
const visEdges = (chunks, total, vb) => {
	if (!chunks?.length || !vb) return total;
	const mg = 10000; let sum = 0;
	for (const c of chunks) { const b = c.bbox;
		if (!(b[2] < vb[0] - mg || b[0] > vb[2] + mg || b[3] < vb[1] - mg || b[1] > vb[3] + mg)) sum += c.end - c.start;
	}
	return sum;
};
const CX = 138, CY = 37, W = 1280, H = 800;
const viewBbox = z => {
	const degPerPx = 360 / (256 * 2 ** z);   // 256px世界・CSS px
	const lonHalf = W / 2 * degPerPx / Math.cos(CY * Math.PI / 180), latHalf = H / 2 * degPerPx;
	return [(CX - lonHalf + 180) * 1e7, (CY - latHalf + 90) * 1e7, (CX + lonHalf + 180) * 1e7, (CY + latHalf + 90) * 1e7];
};
const pickTier = rank => { let best = null;
	for (const t of tiers) if (t.minW <= rank && (!best || t.edgeCount < best.edgeCount)) best = t;
	return best; };
const finest = tiers.length ? tiers.reduce((a, b) => (a.minW < b.minW ? a : b)) : null;

console.log('\n  zoom rank(dpr1/dpr2) | A:定常(tier)      | B:交替直後(梯子なし) | C:lowZoom境界 | D:feature-rank射影');
const edgesByFidCache = new Map();
for (let z = 2; z <= 13; z++) {
	const rank  = Math.max(0, Math.min(63, Math.round(63 - 3 * z)));
	const rank2 = Math.max(0, rank - 3);   // dpr=2: pxArea が device px 基準＝3ランク細かい側
	const vb = viewBbox(z);
	// A: pickLineTier（tier なければ基準メタ＋可視run。安全弁＝最細tier×1.5 は tier がある時だけ）
	const nom = pickTier(rank);
	let selA = nom ? { label: `w${nom.minW}`, e: visEdges(nom.chunks, nom.edgeCount, vb) }
	               : { label: 'base', e: visEdges(base.chunks, base.edgeCount, vb) };
	if (!nom && finest && selA.e > finest.edgeCount * 1.5)
		selA = { label: `安全弁w${finest.minW}`, e: visEdges(finest.chunks, finest.edgeCount, vb) };
	// B: 梯子ゼロ（交替直後）＝基準メタ＋可視run のみ・安全弁なし
	const eB = visEdges(base.chunks, base.edgeCount, vb);
	// C: z<outlineZoom の境界メタ経路（runs=null＝カリング無し・全量）
	const inC = outlineZoom != null && z < outlineZoom;
	// D: 定常 tier から featureRank<rank の地物を落とした場合（可視性は無視＝全国分。比較は B/A の全国分と）
	let eD = '-';
	if (nom && featureRank.size) {
		if (!edgesByFidCache.has(nom.minW)) edgesByFidCache.set(nom.minW, edgesByFid(nom.minW));
		const ef = edgesByFidCache.get(nom.minW);
		let sum = 0;
		for (const [fid, e] of ef) if ((featureRank.get(fid) ?? 63) >= rank) sum += e;
		eD = `${sum.toLocaleString()} (地物${[...ef.keys()].filter(f => (featureRank.get(f) ?? 63) >= rank).length}/${ef.size})`;
	}
	console.log(`  z${String(z).padStart(2)}  r${rank}/${rank2}`.padEnd(16) +
		` | ${selA.label} ${selA.e.toLocaleString()}辺`.padEnd(20) +
		` | ${eB.toLocaleString()}辺`.padEnd(15) +
		` | ${inC ? `${bnd.edgeCount.toLocaleString()}辺 全量` : '-'}`.padEnd(16) +
		` | ${eD}`);
}
console.log('\n  ※ A/B は可視チャンク run 後の発行辺数（×6頂点=VS起動）。C は runs=null＝カリング無効の全量。');
console.log('  ※ D は「全国に散る全地物のうち bbox≥1px の地物だけ tier に収載」した場合の全国総辺数（チャンクカリング前）。');
