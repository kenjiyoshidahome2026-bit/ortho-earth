#!/usr/bin/env node
// GPU Dynamic LOD（前方スナップ/gap無し）の不変条件を Node で実証する常設ハーネス。
// シェーダ（programs.js lodSnap）と同一ロジックの JS ミラーを、buildEdgeMeta の実出力に対して回し、
// 「CPU 参照実装（rank>=t の kept 頂点を弧順に直結）と全閾値で完全一致」を確認する＝gap無し・重複無しの証明。
//
// 使い方:
//   node packages/ortho-core/tests/gint-lod.mjs                 # 合成データのみ（決定的・CI向き）
//   bash packages/ortho-core/tests/prep-data.sh                 # 実データ（NE10m海岸線）を tests/data/ に焼く
//   node packages/ortho-core/tests/gint-lod.mjs --coast         # 合成＋実データ等価性＋桁の実測表
//
// 検証項目:
//   1. 基準メタ: 全閾値 t=0..63 で sim(meta,t) == ref(t)（reversed arc・共有 arc・multi-ring 込み）
//   2. tier メタ（minWeight=w）: t>=w で sim(tier,t) == ref(t)＝「tier は見た目不変」の証明
//   3. 4096 walk cap: 長大 arc での破綻検出（capped>0 なら gap が実在）＝tier 梯子が必要な根拠
//   4. 実測: zoom→rank→tier 選定で VS起動数 / texelFetch数 / 最大walk を旧経路(基準メタ直)と比較

import { buildEdgeMeta, buildWeightHist } from '../src/gl/gint/utility.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const TIER_RANKS = [38, 42, 46, 50, 54, 58];   // textures.js と同じ梯子（変えたら両方変える）
let fails = 0;
const ok = (cond, label) => { if (!cond) { fails++; console.error(`  ✗ ${label}`); } };

// ── シェーダミラー（programs.js lodSnap と1行ずつ対応。texture padding = 0 も再現）──
function simDraw(metaU32, edgeCount, t, getRank) {
	const segs = []; let fetches = 0, maxWalk = 0, capped = 0;
	for (let e = 0; e < edgeCount; e++) {
		const A = metaU32[e * 4];
		fetches++;                                  // fetchRank(lodA)
		if (getRank(A) < t) continue;
		let B = metaU32[e * 4 + 1];
		let k = 1;
		for (; k < 4096; k++) {
			fetches++;                              // fetchRank(lodB)
			if (getRank(B) >= t) break;
			fetches++;                              // fetchEdgeMeta(e+k)
			const i = (e + k) * 4;
			const mr = i < edgeCount * 4 ? metaU32[i] : 0;
			if (mr !== B) break;
			B = metaU32[i + 1];
		}
		if (k === 4096) capped++;                   // ループ満了＝B が kept に届かないまま描画（gap の証拠）
		if (k - 1 > maxWalk) maxWalk = k - 1;
		segs.push(A * 0x40000000 + B);              // 頂点 idx < 2^30 前提の完全パック（Number 精度内）
	}
	return { segs, fetches, maxWalk, capped };
}

// ── CPU 参照実装：usage（stream の arc 出現）ごとに rank>=t の頂点を弧順（reversed は逆順）に直結 ──
function refSegments(arcMeta, streams, t, getRank) {
	const segs = [];
	for (const stream of streams) {
		if (!stream) continue; let p = 0;
		while (p < stream.length) {
			p++; const ng = stream[p++];
			for (let g = 0; g < ng; g++) { const ac = stream[p++];
				for (let a = 0; a < ac; a++) {
					const ai = stream[p++], aid = ai < 0 ? ~ai : ai;
					const off = arcMeta[aid * 8], len = arcMeta[aid * 8 + 1];
					let prev = -1;
					const step = ai >= 0 ? 1 : -1, i0 = ai >= 0 ? 0 : len - 1, i1 = ai >= 0 ? len : -1;
					for (let i = i0; i !== i1; i += step) {
						const idx = off + i;
						if (getRank(idx) < t) continue;
						if (prev !== -1) segs.push(prev * 0x40000000 + idx);
						prev = idx;
					}
				}
			}
		}
	}
	return segs;
}

const sameMultiset = (a, b) => {
	if (a.length !== b.length) return false;
	const sa = Float64Array.from(a).sort(), sb = Float64Array.from(b).sort();
	for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
	return true;
};

const rankOf = (arcU32) => (idx) => (arcU32[idx * 2 + 1] & 0x80000000) ? 63 : (arcU32[idx * 2] & 0x3F);

// ── 合成データ生成（決定的 PRNG）：weights は VW 風の幾何分布、arc 両端は anchor ──
function mulberry32(seed) { let a = seed; return () => { a |= 0; a = a + 0x6D2B79F5 | 0;
	let x = Math.imul(a ^ a >>> 15, 1 | a); x = x + Math.imul(x ^ x >>> 7, 61 | x) ^ x; return ((x ^ x >>> 14) >>> 0) / 4294967296; }; }

function genData(rnd, { nArcs = 60, maxLen = 40, longArcs = 0, longLen = 6000 } = {}) {
	const lens = [];
	for (let a = 0; a < nArcs; a++) lens.push(2 + Math.floor(rnd() * (maxLen - 2)));
	for (let a = 0; a < longArcs; a++) lens.push(longLen);
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
			// weight 幾何分布（高 rank ほど稀）＝実データの VW 分布を模す
			let w = 0; while (w < 62 && rnd() < 0.72) w++;
			arcU32[(off + i) * 2]     = term ? 0 : w;
			arcU32[(off + i) * 2 + 1] = term ? 0x80000000 : 0;
		}
		off += len;
	});
	// polyStream: 隣接 fid が同じ arc を逆向きに共有（共有境界の実態を再現）
	const nA = lens.length;
	const poly = [];
	for (let f = 0; f < Math.floor(nA / 3); f++) {
		const a1 = f * 3, a2 = f * 3 + 1;
		poly.push(f, 1, 2, a1, a2);                     // fid f: ring = [a1, a2]
		poly.push(1000 + f, 1, 2, ~a2, ~a1);            // fid 1000+f: 共有 arc を reversed で
	}
	// lineStream: 残りの arc を折れ線に（forward/reversed 混在・multi-set）
	const line = [];
	for (let a = Math.floor(nA / 3) * 3, f = 5000; a < nA; a += 2, f++) {
		const two = a + 1 < nA;
		line.push(f, 1, two ? 2 : 1, (a % 4 === 0) ? ~a : a);
		if (two) line.push((a % 3 === 0) ? ~(a + 1) : a + 1);
	}
	return { arcU32, arcMeta,
		polyStream: Int32Array.from(poly), lineStream: Int32Array.from(line),
		arcBuffer: { buffer: arcU32.buffer, byteOffset: 0, byteLength: arcU32.byteLength, length: total } };
}

// ── 1+2: 合成データで基準メタ・tier メタの全閾値等価性 ──
{
	console.log('■ 合成データ（決定的）: 基準メタ + tier メタ equivalence');
	const rnd = mulberry32(0xC0A57);
	const d = genData(rnd, { nArcs: 90 });
	const getRank = rankOf(d.arcU32);
	const base = buildEdgeMeta(d.arcMeta, d.polyStream, d.lineStream);
	const streams = [d.polyStream, d.lineStream];
	for (let t = 0; t <= 63; t++) {
		const sim = simDraw(base.metaU32, base.edgeCount, t, getRank);
		ok(sameMultiset(sim.segs, refSegments(d.arcMeta, streams, t, getRank)), `base t=${t} equivalence`);
		ok(sim.capped === 0, `base t=${t} capped=0`);
	}
	// hist の先読み件数（edgeCount(w)=hist[w]-nUsages）＝実構築の edgeCount と一致
	//（textures.js の遅延構築は 0.7 ガードを hist で構築前に判定する＝その正確さの証明）
	const { hist, nUsages } = buildWeightHist(d.arcMeta, d.polyStream, d.lineStream, d.arcU32);
	for (const w of TIER_RANKS) {
		const tier = buildEdgeMeta(d.arcMeta, d.polyStream, d.lineStream, d.arcBuffer, w);
		ok(hist[w] - nUsages === tier.edgeCount, `hist予測 w${w} (${hist[w] - nUsages}) == 実構築 (${tier.edgeCount})`);
		for (const t of [w, w + 2, w + 4, 63]) {
			const sim = simDraw(tier.metaU32, tier.edgeCount, t, getRank);
			ok(sameMultiset(sim.segs, refSegments(d.arcMeta, streams, t, getRank)), `tier w${w} t=${t} equivalence`);
		}
	}
	console.log(fails ? `  → ${fails} 件失敗` : '  ✓ 全閾値・全tier 一致（gap無し・重複無し）');
}

// ── 3: 4096 walk cap の破綻検出（長大 arc・全頂点低 rank）──
{
	console.log('■ 4096 walk cap（長大 arc）');
	const rnd = mulberry32(0xBEEF);
	const d = genData(rnd, { nArcs: 0, longArcs: 1, longLen: 6000 });   // 長大 arc 1本だけ＝lineStream に載る
	const getRank = rankOf(d.arcU32);
	const base = buildEdgeMeta(d.arcMeta, d.polyStream, d.lineStream);
	const sim = simDraw(base.metaU32, base.edgeCount, 63, getRank);   // anchor のみ kept
	// 6000 頂点 arc は 4096 cap に当たる＝capped>0 を「検出できる」ことを確認（＝tier 梯子の存在理由）
	ok(sim.capped > 0, 'cap 検出（このケースは capped>0 が正）');
	console.log(`  capped=${sim.capped} maxWalk=${sim.maxWalk}（→ 粗 tier が walk を桁で短縮し cap を回避する）`);
}

// ── 4: 実データ（NE10m 海岸線）──
if (process.argv.includes('--coast')) {
	const need = ['arcbuf', 'arcmeta', 'linestream'].map(n => path.join(DATA, `coast-${n}.bin`));
	if (!need.every(existsSync)) {
		console.error(`■ 実データ無し: 先に bash packages/ortho-core/tests/prep-data.sh を実行（→ ${DATA}/）`);
		process.exit(1);
	}
	const rd = n => readFileSync(path.join(DATA, `coast-${n}.bin`));
	const abuf = rd('arcbuf'), ameta = rd('arcmeta'), lstr = rd('linestream');
	const arcU32 = new Uint32Array(abuf.buffer, abuf.byteOffset, abuf.byteLength / 4);
	const arcMeta = new Uint32Array(ameta.buffer, ameta.byteOffset, ameta.byteLength / 4);
	const lineStream = new Int32Array(lstr.buffer, lstr.byteOffset, lstr.byteLength / 4);
	const arcBuffer = { buffer: arcU32.buffer, byteOffset: arcU32.byteOffset, byteLength: arcU32.byteLength, length: arcU32.length / 2 };
	const getRank = rankOf(arcU32);
	const nArcs = arcMeta.length / 8;
	let maxArcLen = 0; for (let a = 0; a < nArcs; a++) maxArcLen = Math.max(maxArcLen, arcMeta[a * 8 + 1]);
	console.log(`■ 実データ: NE10m 海岸線 — arcs=${nArcs} 頂点=${arcU32.length / 2} 最長arc=${maxArcLen}頂点`);

	const base = buildEdgeMeta(arcMeta, null, lineStream);
	const streams = [null, lineStream];
	// 等価性（重い全 t でなく実用域を刻む）
	for (const t of [0, 20, 38, 45, 52, 58, 61, 63]) {
		const sim = simDraw(base.metaU32, base.edgeCount, t, getRank);
		ok(sameMultiset(sim.segs, refSegments(arcMeta, streams, t, getRank)), `coast base t=${t} equivalence`);
	}
	// tier 群（textures.js と同じ構築規則）＋等価性
	const tiers = [];
	let prevEdges = base.edgeCount;
	for (const w of TIER_RANKS) {
		const r = buildEdgeMeta(arcMeta, null, lineStream, arcBuffer, w);
		if (!r.edgeCount || r.edgeCount >= prevEdges * 0.7) continue;
		tiers.push({ minW: w, meta: r.metaU32, edgeCount: r.edgeCount });
		prevEdges = r.edgeCount;
		const sim = simDraw(r.metaU32, r.edgeCount, w + 2, getRank);
		ok(sameMultiset(sim.segs, refSegments(arcMeta, streams, w + 2, getRank)), `coast tier w${w} t=${w + 2} equivalence`);
	}
	console.log(`  tiers: ${tiers.map(t => `w${t.minW}=${t.edgeCount}辺`).join(' / ') || '(なし)'}`);

	// 桁の実測表: 旧経路（基準メタ直＝tier 無し）vs 新経路（梯子＋200k 閾値）
	const pickTier = rank => { let best = null;
		for (const t of tiers) if (t.minW <= rank && (!best || t.edgeCount < best.edgeCount)) best = t;
		return best; };
	console.log('  zoom rank | 旧: VS起動 fetch maxWalk cap | 新: tier VS起動 fetch maxWalk | VS比');
	for (const z of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
		const rank = Math.max(0, Math.min(63, Math.floor(63.0 - 3 * z)));
		const old = simDraw(base.metaU32, base.edgeCount, rank, getRank);
		const tier = pickTier(rank);
		const neu = tier ? simDraw(tier.meta, tier.edgeCount, rank, getRank) : old;
		const nEdges = tier ? tier.edgeCount : base.edgeCount;
		ok(sameMultiset(old.segs, neu.segs), `coast z${z} 新旧同一描画`);
		console.log(`  z${String(z).padEnd(3)} r${String(rank).padEnd(2)} | ${String(base.edgeCount).padStart(7)} ${String(old.fetches).padStart(8)} ${String(old.maxWalk).padStart(5)} ${String(old.capped).padStart(3)} | ${tier ? 'w' + tier.minW : 'base'} ${String(nEdges).padStart(7)} ${String(neu.fetches).padStart(8)} ${String(neu.maxWalk).padStart(5)} | ×${(base.edgeCount / nEdges).toFixed(1)}`);
	}
}

console.log(fails ? `\n✗ ${fails} 件失敗` : '\n✓ 全チェック PASS');
process.exit(fails ? 1 : 0);
