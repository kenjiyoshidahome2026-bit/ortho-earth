// 地形メッシュの LOD（perf plan P4・2026-09-27）＝両バックエンド共通の純関数。
// step B（チャンク刈り）：単位格子 G×G の index をチャンク主導（CH×CH・各チャンクの三角形が連続）に並べ替え、
// 毎フレーム CPU が各チャンクの箱（経緯度×標高 0〜hMax）を視錐台と地平線で判定＝可視チャンクの連続区間だけ drawIndexed。
// 三角形の分割（a-c-b / b-c-d）と巻きは従来と同一＝絵は不変（描かないのは「全画素が discard される／画面外」のチャンクだけ）。
// 地平線の判定＝TERRAIN FS の `front < -0.0015 → discard`（front = dot(dir, eye) − 1・dir は半径 1 の球点＝標高に依らない）を頂点側で先取り：
// チャンクの全標本点の front がその閾値を下回れば描いても全画素が捨てられる＝刈って厳密に同じ絵。
import { lonlatTo3D, projectClip } from "./camera.js";

export const TERR_CH = 16;   // 一辺のチャンク数（16×16＝256・G=1536 で 96 quad/辺）
export const TERR_HMAX_M = 9000;   // 視錐台判定に使う標高の上限（m・全球＝エベレスト級）。保守的なほど刈りが甘いだけ＝絵は変わらない

// G×G 頂点（uv = i/(G−1)）の index をチャンク主導で。chunks[k]＝{ first, count, u0, u1, v0, v1 }（index の位置と数・uv の箱）
export function buildChunkIndex(G, CH = TERR_CH) {
	const Q = G - 1, idx = new Uint32Array(Q * Q * 6), chunks = [];
	let p = 0;
	for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CH; cx++) {
		const i0 = Math.floor(cx * Q / CH), i1 = Math.floor((cx + 1) * Q / CH), j0 = Math.floor(cy * Q / CH), j1 = Math.floor((cy + 1) * Q / CH);
		const first = p;
		for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) {
			const a = j * G + i, b = a + 1, c = a + G, d = c + 1;
			idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d;
		}
		chunks.push({ first, count: p - first, u0: i0 / Q, u1: i1 / Q, v0: j0 / Q, v1: j1 / Q });
	}
	return { idx, chunks };
}

const wrapNear = (lon, ref) => lon + 360 * Math.round((ref - lon) / 360);

// 1 チャンクの可視判定。箱＝経緯度 [l0,l1]×[b0,b1]・半径 [1, rMax]。標本点＝4 隅＋辺の中点＋中心（球面の膨らみ）＋カメラ直下点を箱へ clamp した点（front 最大の候補）。
// 1) 全標本点が地平線の閾値以下（箱の大きさぶんの余裕込み）＝不可視。2) 全標本点がカメラ背後（w≤0）＝不可視。3) 標本点（海面と rMax）が全て同じ視錐台面の外＝不可視。
// 背後と前方が混在する箱は判定しない（描く）＝保守側。eps＝面をわずかに外へ（標本の間の膨らみ・f32 の丸め）。
export function chunkVisible(l0, l1, b0, b1, st, rMax, sub) {
	const E = st.eye;
	const lm = (l0 + l1) / 2, bm = (b0 + b1) / 2;
	const cl = Math.min(l1, Math.max(l0, wrapNear(sub[0], lm))), cb = Math.min(b1, Math.max(b0, sub[1]));
	const pts = [[l0, b0], [l1, b0], [l0, b1], [l1, b1], [lm, b0], [lm, b1], [l0, bm], [l1, bm], [lm, bm], [cl, cb]];
	// 地平線：front の最大を標本点で近似＝角距離 δ（箱の対角程度）の欠け |E|(1−cos δ) ≈ |E|δ²/2 を余裕に足す
	const spanRad = Math.hypot(l1 - l0, b1 - b0) * Math.PI / 180;
	const margin = sub[2] * spanRad * spanRad / 2;
	let maxFront = -Infinity;
	for (const [lo, la] of pts) { const u = lonlatTo3D(lo, la); const f = u[0] * E[0] + u[1] * E[1] + u[2] * E[2] - 1; if (f > maxFront) maxFront = f; }
	if (maxFront < -0.0015 - margin) return false;
	let outL = true, outR = true, outB = true, outT = true, behind = 0, n = 0;
	for (const [lo, la] of pts) for (const rad of [1, rMax]) {
		const c = projectClip(st, lo, la, rad); n++;
		if (c[3] <= 1e-9) { behind++; continue; }
		const w = c[3] * 1.02;
		if (c[0] >= -w) outL = false; if (c[0] <= w) outR = false; if (c[1] >= -w) outB = false; if (c[1] <= w) outT = false;
	}
	if (behind === n) return false;
	if (behind > 0) return true;
	return !(outL || outR || outB || outT);
}

// 可視チャンクの描画区間 [[first, count], …]（連続する可視チャンクは 1 本に併合＝draw 数を減らす）。
// mesh＝[oLng, oLat, spanLng, spanLat]（Frame.mesh／u_mesh と同じ窓）・st＝cameraState・elevScale＝m→世界単位（elev.scale）。
// stats（任意）＝{ drawn, of } を埋める（?perf=1／HUD の物差し）
export function visibleChunkRuns(chunks, mesh, st, elevScale, stats = null) {
	const [oLng, oLat, sLng, sLat] = mesh;
	const E = st.eye, eLen = Math.hypot(E[0], E[1], E[2]);
	const sub = [Math.atan2(E[2], E[0]) * 180 / Math.PI, Math.asin(Math.max(-1, Math.min(1, E[1] / eLen))) * 180 / Math.PI, eLen];   // カメラ直下点（β空間の近似で十分＝clamp の基準）
	const rMax = 1 + TERR_HMAX_M * (elevScale || 0);
	const runs = []; let cur = null, drawn = 0;
	for (const c of chunks) {
		if (!chunkVisible(oLng + sLng * c.u0, oLng + sLng * c.u1, oLat + sLat * c.v0, oLat + sLat * c.v1, st, rMax, sub)) continue;
		drawn++;
		if (cur && cur[0] + cur[1] === c.first) cur[1] += c.count; else runs.push(cur = [c.first, c.count]);
	}
	if (stats) { stats.drawn = drawn; stats.of = chunks.length; }
	return runs;
}
