// WGSL の Frame／Globe 構造体の並びと、CPU の詰め順（gpu/renderer.ts packFrame・globe の g[]）の突き合わせ。node packages/ortho-core/tests/frame-layout.mjs
// 守るもの：欄を構造体の途中に足すと後ろの欄が全部ずれる（#714 で cg/cgP/cgC を sun の前に入れ、F.sun が光の色を読んで
// 影・PBR・夜景の窓・切断が WebGPU だけ壊れた＝2026-10-27 の deploy 停止）。オフセットは WGSL の uniform 並びの規則で数える
import assert from "node:assert/strict";
import { TERRAIN_WGSL, GLOBE_WGSL } from "../src/gpu/wgsl.ts";
const SZ = { "mat4x4f": [64, 16], "vec4f": [16, 16], "vec3f": [12, 16], "vec2f": [8, 8], "f32": [4, 4] };
function layout(src, name) {
	const head = `struct ${name} {`, i = src.indexOf(head);
	assert.ok(i >= 0, `struct ${name}`);
	const body = src.slice(i + head.length, src.indexOf("};", i));
	const off = {};
	let o = 0;
	for (const raw of body.split("\n")) {
		const line = raw.split("//")[0].trim();
		if (!line) continue;
		const c = line.indexOf(":"), field = line.slice(0, c).trim(), type = line.slice(c + 1).replace(",", "").trim();
		const [size, align] = SZ[type] || [];
		assert.ok(size, `${name}.${field} の型 ${type}`);
		o = Math.ceil(o / align) * align;
		off[field] = o / 4;   // Float32 の添字
		o += size;
	}
	return { off, f32: Math.ceil(o / 16) * 4 };
}
const F = layout(TERRAIN_WGSL, "Frame");
// packFrame の詰め順（f[...]）
const FRAME_AT = { mvp: 0, rayF: 16, clipT: 32, trig: 36, originPt: 40, eye: 44, origin: 48, viewport: 50, fogColor: 52, params: 56,
	elevBounds: 60, elevP: 64, mesh: 68, farBounds: 72, farP: 76, ellTrig: 80, ellP: 84, cogP: 88, gnd0: 92, gnd3: 104, eyeO: 108, elevOff: 112,
	sun: 116, cg: 120, cgP: 124, cgC: 128 };
for (const [k, v] of Object.entries(FRAME_AT)) assert.equal(F.off[k], v, `Frame.${k} は f[${v}]（packFrame）`);
assert.equal(F.f32, 132, "Frame の大きさ＝FRAME_F32");
const G = layout(GLOBE_WGSL, "Globe");
// globe の g[]（gpu/renderer.ts）
const GLOBE_AT = { rayF: 0, land: 16, atmo: 20, elevBounds: 24, whP: 28, seaC: 32, farBounds: 36, farP: 40, misc: 44, sun: 48, anc: 52, anc2: 56, eyeO: 60,
	atmP: 64, cogOff: 68, gndOff0: 72, gndOff3: 84, elevOff: 88, cg: 92, cgP: 96, cgC: 100, gm: 104, gmC: 108, gmP: 112 };   // gm*＝地面の材質（packGroundMat(g, 104)）
for (const [k, v] of Object.entries(GLOBE_AT)) assert.equal(G.off[k], v, `Globe.${k} は g[${v}]`);
assert.equal(G.f32, 116, "Globe の大きさ＝g の Float32Array(116)");
console.log("✓ frame-layout 全項目 PASS");
