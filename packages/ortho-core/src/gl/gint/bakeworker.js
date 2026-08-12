// gint bake worker ── GintBUF→メタ/tier梯子の全ベイクを render worker の外で行う（bake-ahead）。
// render worker 同居（1canvas統合）では set() の同期ベイク（nps_all 級で数百ms×交替毎）が
// 地図全体のフリーズになる＝ここへ逃がし、render worker は uploadBaked（テクスチャ搭載のみ）に徹する。
//
// プロトコル（一発完結型）:
//   in : { id, data: {arcBuffer, arcMeta, polyStream, lineStream, pointBuffer, point, polyCompBbox} }
//   out: { id, kind:'done', gint, artifacts, tiers } … 全 TypedArray は transfer（ゼロコピー中継用）
//        { id, kind:'error', message }               … 呼び出し側は同期経路へフォールバック
// tier を progressive にしない理由＝「眠っているスロット束への後着」問題を作らないため。全ベイクは
// 別スレッド＝表示中の層（海岸線）を描いたまま完成を待てる（nps_all 実測 0.3-0.5s 級）。
// 正規化（リング向き）は clone されたこちらの polyStream に施される＝render worker には正規化済みが届き、
// main の原本（unPackGint）は素のまま残る（冪等なので万一の同期経路フォールバックでも正しい）。

import { bakeBase, bakeTier, tierPlan } from './bake.js';

onmessage = e => {
	const { id, data } = e.data;
	try {
		const gintData = {
			arcBuffer:    data.arcBuffer   ?? null,
			arcMeta:      data.arcMeta     ?? null,
			polyStream:   data.polyStream?.length  ? data.polyStream  : null,
			lineStream:   data.lineStream?.length  ? data.lineStream  : null,
			pointBuffer:  data.pointBuffer?.length ? data.pointBuffer : null,
			point:        data.point ?? null,
			polyCompBbox: data.polyCompBbox ?? null,
			fillMaxEdges: data.fillMaxEdges ?? null,   // 層ごとの塗り上限上書き（コロプレス土台＝全密度塗りを通す）
		};
		const art = bakeBase(gintData);
		const plan = tierPlan(gintData, art.base.edgeCount, art.weightHist);
		const tiers = [];
		for (const w of [...plan].reverse()) tiers.push(bakeTier(gintData, w, art.polyBboxByFid));   // 粗い側から（台帳は minW ソートなので順序は表示に無関係）
		const { weightHist, ...artifacts } = art;   // hist は下流不要（tier まで焼き切った）＝落とす
		const bufs = new Set();
		for (const v of Object.values(gintData)) if (ArrayBuffer.isView(v)) bufs.add(v.buffer);
		if (artifacts.base?.metaU32)     bufs.add(artifacts.base.metaU32.buffer);
		if (artifacts.boundary?.metaU32) bufs.add(artifacts.boundary.metaU32.buffer);
		if (artifacts.pivot?.px)         bufs.add(artifacts.pivot.px.buffer);
		for (const t of tiers) if (t.metaU32) bufs.add(t.metaU32.buffer);
		postMessage({ id, kind: 'done', gint: gintData, artifacts, tiers }, [...bufs]);
	} catch (err) {
		postMessage({ id, kind: 'error', message: err?.message ?? String(err) });
	}
};
