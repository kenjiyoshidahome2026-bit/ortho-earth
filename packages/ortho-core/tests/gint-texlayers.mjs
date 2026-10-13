#!/usr/bin/env node
// gint WebGPU の分割送り（geopbf 改良点 ⑤・2026-10-12）＝group(2) テクスチャを 2D 配列（層ごと TEX_LAYER_H 行）で送る純関数の検定。
//   ① texLayerWrites：どの大きさでも writes が raw を過不足なく 1 回ずつ覆う・層と行がテクスチャの内に収まる・満杯の行は view のまま（tail は 1 行だけ）
//   ② 層の高さ：4096 行×4096 幅＝1 層の texel 数、1 層に収まる時は高さが行数そのもの（小データで 4096 行を確保しない）
//   ③ toStorageWGSL：2D 配列の宣言と 4 つのアクセサ本体だけが storage に変わり、textureLoad(arcTex…) が残らない（線・stencil・点＋切る派生）
//   ④ withLayerH：層の高さの差し替え（検定用 ?gintlh=）は TEX_LAYER_H の定数だけを変える・無い原本には例外
// 使い方: node packages/ortho-core/tests/gint-texlayers.mjs
import { texLayerWrites } from "../src/gpu/gint.js";
import * as G from "../src/gpu/gintwgsl.js";
let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// ① 覆いの検定（幅・層高・comps・minTexels を小さく振って全部の枝を踏む）
{
	let cases = 0, bad = [];
	for (const w of [4, 7, 64]) for (const LH of [1, 3, 8]) for (const comps of [1, 2, 4]) for (const rawLen of [0, 1, comps, comps * w - comps, comps * w, comps * w + 1, comps * w * LH, comps * w * LH + comps, comps * w * (LH * 3 + 2) + 3]) for (const minT of [0, w * LH * 2 + 1]) {
		cases++;
		const P = texLayerWrites(rawLen, comps, w, LH, minT);
		const rowLen = w * comps;
		const cov = new Uint8Array(rawLen);
		let order = 0, prevTo = 0, tails = 0;
		for (const x of P.writes) {
			if (x.layer < 0 || x.layer >= P.layers || x.y < 0 || x.y + x.rows > P.h) bad.push(`外 ${JSON.stringify([w, LH, comps, rawLen, minT, x])}`);
			if (x.from !== prevTo) bad.push(`飛び ${JSON.stringify([w, LH, comps, rawLen, minT, x])}`);
			prevTo = x.to;
			if (x.tail) { tails++; if (x.rows !== 1 || (x.to - x.from) >= rowLen) bad.push(`tail ${JSON.stringify([w, LH, comps, rawLen, x])}`); }
			else if ((x.to - x.from) !== x.rows * rowLen) bad.push(`満杯でない view ${JSON.stringify([w, LH, comps, rawLen, x])}`);
			for (let i = x.from; i < x.to; i++) cov[i]++;
			order++;
		}
		if (prevTo !== rawLen) bad.push(`末尾未到達 ${JSON.stringify([w, LH, comps, rawLen, minT, prevTo])}`);
		for (let i = 0; i < rawLen; i++) if (cov[i] !== 1) { bad.push(`覆い ${cov[i]} ${JSON.stringify([w, LH, comps, rawLen, i])}`); break; }
		if (tails > 1) bad.push(`tail が ${tails} 回 ${JSON.stringify([w, LH, comps, rawLen])}`);
		const texels = Math.max(minT, Math.ceil(rawLen / comps)), rows = Math.max(1, Math.ceil(texels / w));
		if (P.rows !== rows || P.layers !== Math.ceil(rows / LH) || P.h !== (P.layers > 1 ? LH : rows)) bad.push(`寸法 ${JSON.stringify([w, LH, comps, rawLen, minT, P.rows, P.layers, P.h])}`);
		if (P.layers * P.h < rows) bad.push(`行が溢れる ${JSON.stringify([w, LH, comps, rawLen, minT])}`);
	}
	ok(bad.length === 0, `① texLayerWrites が raw を過不足なく覆う（${cases} 通り）${bad.length ? "\n  " + bad.slice(0, 5).join("\n  ") : ""}`);
}
// ② 実寸（4096 幅・4096 行）：arc rg32uint＝8 B/texel＝1 層 128 MiB。16.7M 頂点＝ちょうど 1 層・+1 で 2 層。旧 1 枚 2D の天井（8192 行＝268 MB）を越える 40M 頂点＝3 層
{
	const one = texLayerWrites(4096 * 4096 * 2, 2, 4096, 4096), two = texLayerWrites(4096 * 4096 * 2 + 2, 2, 4096, 4096), big = texLayerWrites(40_000_000 * 2, 2, 4096, 4096);
	ok(one.layers === 1 && one.h === 4096 && one.writes.length === 1 && !one.writes[0].tail, `② 4096×4096 texel＝1 層 1 回送り（layers=${one.layers} h=${one.h} writes=${one.writes.length}）`);
	ok(two.layers === 2 && two.h === 4096 && two.writes.length === 2 && two.writes[1].tail && two.writes[1].layer === 1 && two.writes[1].y === 0, `② +1 texel＝2 層目の 1 行だけ tail（layers=${two.layers} writes=${two.writes.length}）`);
	ok(big.layers === 3 && big.rows === Math.ceil(40_000_000 / 4096), `② 40M 頂点（旧 268 MB の天井越え）＝3 層（layers=${big.layers} rows=${big.rows}）`);
	const small = texLayerWrites(2 * 9, 2, 4096, 4096), meta = texLayerWrites(4 * 10, 4, 4096, 4096, 5000);
	ok(small.layers === 1 && small.h === 1 && small.writes.length === 1 && small.writes[0].tail, `② 9 頂点＝1 層 1 行（4096 行を確保しない・h=${small.h}）`);
	ok(meta.rows === 2 && meta.h === 2 && meta.writes.length === 1, `② minTexels（meta の複製行）＝行数は下限から・送るのは raw ぶんだけ（rows=${meta.rows} writes=${meta.writes.length}）`);
}
// ③ storage 版への機械変換（素＋切る派生の 6 本）
{
	const srcs = ["GINT_LINE_WGSL", "GINT_STENCIL_WGSL", "GINT_POINT_WGSL", "GINT_LINE_CLIP_WGSL", "GINT_STENCIL_CLIP_WGSL", "GINT_POINT_CLIP_WGSL"];
	for (const k of srcs) {
		const src = G[k], out = G.toStorageWGSL(src);
		const isPt = /POINT/.test(k);
		const decl = isPt ? /var<storage, read> ptBuf: array<vec2u>;[\s\S]*var<storage, read> ptMetaBuf: array<u32>;/ : /var<storage, read> arcBuf: array<vec2u>;[\s\S]*var<storage, read> metaBuf: array<vec4u>;/;
		const acc = isPt ? /fn ptAt\(ptId: i32\) -> vec2u \{\n\treturn ptBuf\[u32\(ptId\)\];\n\}[\s\S]*fn ptMetaAt\(ptId: i32\) -> u32 \{\n\treturn ptMetaBuf\[u32\(ptId\)\];\n\}/ : /fn arcAt\(idx: u32\) -> vec2u \{\n\treturn arcBuf\[idx\];\n\}[\s\S]*fn metaAt\(edgeId: i32\) -> vec4u \{\n\treturn metaBuf\[u32\(edgeId\)\];\n\}/;
		ok(/texture_2d_array<u32>/.test(src) && !/texture_2d_array/.test(out) && !/textureLoad\((arcTex|metaTex|ptTex|ptMetaTex)/.test(out) && decl.test(out) && acc.test(out),
			`③ ${k}: 原本は 2D 配列・storage 版は宣言とアクセサ本体だけが変わり textureLoad が残らない`);
		// 呼び手は原本のまま（アクセサ経由）＝group(2) を直に textureLoad する箇所が原本に無い
		ok(!/textureLoad\((arcTex|metaTex|ptTex|ptMetaTex)/.test(src.replace(/fn (arcAt|metaAt|ptAt|ptMetaAt)[\s\S]*?\n\}/g, "")), `③ ${k}: group(2) の読みはアクセサ 4 つに閉じている`);
	}
	let threw = false; try { G.toStorageWGSL(G.GINT_LINE_WGSL.replace("fn arcAt(idx: u32) -> vec2u {", "fn arcAt(idx: u32) -> vec2u { // x")); } catch { threw = true; }
	ok(threw, "③ アクセサの書式が変わると変換漏れを例外で知らせる");
}
// ④ 層の高さの差し替え
{
	const o = G.withLayerH(G.GINT_LINE_WGSL, 16);
	ok(/const TEX_LAYER_H: i32 = 16;/.test(o) && !/TEX_LAYER_H: i32 = 4096/.test(o) && o.replace(/TEX_LAYER_H: i32 = 16/g, "TEX_LAYER_H: i32 = 4096") === G.GINT_LINE_WGSL, "④ withLayerH は TEX_LAYER_H の定数だけを変える");
	ok(G.withLayerH(G.GINT_LINE_WGSL, 4096) === G.GINT_LINE_WGSL && G.withLayerH(G.GINT_LINE_WGSL, 0) === G.GINT_LINE_WGSL, "④ 4096／0＝原本そのまま");
	ok(/TEX_LAYER_H: i32 = 8;/.test(G.withLayerH(G.toStorageWGSL(G.GINT_POINT_WGSL), 8)), "④ storage 版にも掛かる（定数は残る・未使用）");
	let threw = false; try { G.withLayerH(G.GINT_IDRESOLVE_WGSL, 8); } catch { threw = true; }
	ok(threw, "④ TEX_LAYER_H の無い原本には例外（黙って素通りしない）");
}
console.log(fails ? `\n${fails} 件失敗` : "\n全件通過");
process.exit(fails ? 1 : 0);
