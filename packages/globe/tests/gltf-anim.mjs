// glTF の rigid アニメ（W4）＝補間・階層・世界座標への写しの検定（DOM 無し）
import { rigFromGltf, sampleChannel, samplePose, worldXf, batchXf, wrapTime, m4affineInv, m4trs, m4mul } from "../src/gltf-anim.js";
let fails = 0; const ok = (name, c, info = "") => { console.log(`${c ? "PASS" : "FAIL"} ${name}${info ? " " + info : ""}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const I3 = { A: [1, 0, 0, 0, 1, 0, 0, 0, 1], T: [0, 0, 0] }, IF = { L: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const idPlace = { G: I3, F: IF };
// 手で作った「postProcessGLTF 後」の形（nodes の children は実体・accessors は value）
const S2 = Math.SQRT1_2;
const nodes = [{ name: "root", children: [] }, { name: "spin", translation: [10, 0, 0] }, { name: "leaf", translation: [0, 5, 0] }, { name: "still" }];
nodes[0].children = [nodes[1], nodes[3]]; nodes[1].children = [nodes[2]];
const gltf = {
	nodes,
	accessors: [{ value: Float32Array.of(0, 1.5) }, { value: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 0) }, { value: Float32Array.of(0, 1, 2) }, { value: Float32Array.of(0, 0, 0, 1, 0, 0, 2, 0, 0) },
		{ value: Float32Array.of(0, 1) }, { value: Float32Array.of(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0) }],   // 5＝CUBICSPLINE（in・値・out）×2 の平行移動＝値は 0→1（接線 0）
	animations: [
		{ name: "Spin", channels: [{ sampler: 0, target: { node: 1, path: "rotation" } }], samplers: [{ input: 0, output: 1, interpolation: "LINEAR" }] },
		{ channels: [{ sampler: 0, target: { node: 3, path: "translation" } }], samplers: [{ input: 2, output: 3, interpolation: "STEP" }] },
		{ name: "Ease", channels: [{ sampler: 0, target: { node: 3, path: "translation" } }], samplers: [{ input: 4, output: 5, interpolation: "CUBICSPLINE" }] },
	],
};
const rig = rigFromGltf(gltf);
ok("rig.nodes", rig && rig.nodes.length === 4 && rig.nodes[1].parent === 0 && rig.nodes[2].parent === 1 && rig.nodes[3].parent === 0 && rig.nodes[0].parent === -1);
ok("rig.anims", rig.animations.length === 3 && rig.animations[0].name === "Spin" && near(rig.animations[0].duration, 1.5) && rig.animations[1].name === "animation1" && rig.animations[1].duration === 2 && rig.animations[2].channels[0].interpolation === "CUBICSPLINE");
ok("rig.animated", rig.animated.join() === "1,2,3", rig.animated.join());   // spin とその子 leaf・still（translation）。root は動かない
ok("rig.none", rigFromGltf({ nodes, animations: [] }) === null);
// 補間
const ch = rig.animations[0].channels[0];
const q = sampleChannel(ch, 0.75);
ok("slerp.half", near(q[2], S2) && near(q[3], S2) && near(q[0], 0), q.join());
ok("slerp.ends", sampleChannel(ch, -1)[3] === 1 && sampleChannel(ch, 9)[2] === 1);
const st = rig.animations[1].channels[0];
ok("step", sampleChannel(st, 0.99)[0] === 0 && sampleChannel(st, 1)[0] === 1 && sampleChannel(st, 1.5)[0] === 1 && sampleChannel(st, 2)[0] === 2, [0.99, 1, 1.5, 2].map(t => sampleChannel(st, t)[0]).join());
const cu = rig.animations[2].channels[0];
ok("cubic", near(sampleChannel(cu, 0.5)[0], 0.5) && near(sampleChannel(cu, 0.25)[0], 0.15625) && sampleChannel(cu, 0)[0] === 0 && sampleChannel(cu, 1)[0] === 1, [0, 0.25, 0.5, 1].map(t => sampleChannel(cu, t)[0]).join());
ok("wrap", near(wrapTime(1.7, 1.5, true), 0.2) && wrapTime(1.7, 1.5, false) === 1.5 && near(wrapTime(-0.2, 1.5, true), 1.3) && wrapTime(3, 0, true) === 0);
// pose＝階層（leaf は spin の回転を継ぐ・still は自分だけ・root は恒等）
const pose = samplePose(rig, 0, 0.75);
const xfSpin = worldXf(pose, 1, idPlace), xfLeaf = worldXf(pose, 2, idPlace), xfRoot = worldXf(pose, 0, idPlace), xfStill = worldXf(pose, 3, idPlace);
ok("pose.root", xfRoot === null && xfStill === null);
// spin＝(10,0,0) を中心に Z 回り 90°：L は回転・trace 1・平行移動は中心が動かない分 t = c − L·c
ok("pose.spin.L", xfSpin && near(xfSpin.L[0] + xfSpin.L[4] + xfSpin.L[8], 1) && near(xfSpin.L[1], 1) && near(xfSpin.L[3], -1), xfSpin && [...xfSpin.L].map(v => +v.toFixed(3)).join());
ok("pose.spin.t", xfSpin && near(xfSpin.t[0], 10) && near(xfSpin.t[1], -10) && near(xfSpin.t[2], 0), xfSpin && xfSpin.t.join());
// leaf は親の回転を継ぐ＝同じ剛体変換（leaf 自身の平行移動は W と W0 の両方に入る）
ok("pose.leaf", xfLeaf && [...xfLeaf.L].every((v, i) => near(v, xfSpin.L[i])) && xfLeaf.t.every((v, i) => near(v, xfSpin.t[i])));
// 点の検算＝leaf の原点（world (10,5,0)）は中心 (10,0,0) から Z 回り 90° で (5,0,0) へ
const p = [10, 5, 0], L = xfLeaf.L, moved = [L[0]*p[0] + L[3]*p[1] + L[6]*p[2] + xfLeaf.t[0], L[1]*p[0] + L[4]*p[1] + L[7]*p[2] + xfLeaf.t[1], L[2]*p[0] + L[5]*p[1] + L[8]*p[2] + xfLeaf.t[2]];
ok("pose.point", near(moved[0], 5) && near(moved[1], 0) && near(moved[2], 0), moved.map(v => +v.toFixed(4)).join());
// 時刻 0＝恒等
ok("pose.t0", worldXf(samplePose(rig, 0, 0), 1, idPlace) === null);
// still＝STEP の平行移動（t=1.5 で x+1）
const xfS = worldXf(samplePose(rig, 1, 1.5), 3, idPlace);
ok("pose.still", xfS && near(xfS.t[0], 1) && near(xfS.L[0], 1) && near(xfS.L[4], 1), xfS && xfS.t.join());
// place＝G（Y-up→Z-up の軸入替 ×2 倍・ECEF へ 1000 ずらす）と F（ECEF → 世界座標 1/R で縮め・原点ずらし）を通しても、点の写しは「G・F で写した点に同じ回転を掛けた物」と一致
const SW = [1, 0, 0, 0, 0, 1, 0, -1, 0].map(v => v * 2), G = { A: SW, T: [1000, 2000, 3000] }, R = 6371000, F = { L: [1 / R, 0, 0, 0, 1 / R, 0, 0, 0, 1 / R], t: [0.3, 0.4, 0.5] };
const place = { G, F }, xfW = worldXf(pose, 2, place);
const apply = (A, T, v) => [A[0]*v[0] + A[3]*v[1] + A[6]*v[2] + T[0], A[1]*v[0] + A[4]*v[1] + A[7]*v[2] + T[1], A[2]*v[0] + A[5]*v[1] + A[8]*v[2] + T[2]];
const w0 = apply(F.L, F.t, apply(G.A, G.T, p)), w1 = apply(F.L, F.t, apply(G.A, G.T, moved)), wx = apply(xfW.L, xfW.t, w0);
ok("place.point", wx.every((v, i) => near(v, w1[i], 1e-9)), `${wx.map(v => v.toExponential(6))} vs ${w1.map(v => v.toExponential(6))}`);
ok("place.rigid", near(xfW.L[0]*xfW.L[0] + xfW.L[1]*xfW.L[1] + xfW.L[2]*xfW.L[2], 1, 1e-9));   // 等方なスケールは G・G⁻¹ で消える＝回転のまま
// batchXf＝原点相対：O + (L·a + xt) が L·(O+a) + t と同じ
const O = w0, bx = batchXf(xfW, O), a = [1e-6, -2e-6, 3e-6], v = [O[0] + a[0], O[1] + a[1], O[2] + a[2]];
const full = apply(xfW.L, xfW.t, v), rel = apply(bx, [bx[9], bx[10], bx[11]], a).map((x, i) => x + O[i]);
ok("batchXf", bx.length === 12 && rel.every((x, i) => near(x, full[i], 1e-7)) && batchXf(null, O) === null, `${rel} vs ${full}`);
// 逆行列
const M = m4trs([1, 2, 3], [0, S2, 0, S2], [2, 2, 2]), P = m4mul(M, m4affineInv(M));
ok("affineInv", [...P].every((x, i) => near(x, i % 5 === 0 ? 1 : 0, 1e-12)));
if (fails) { console.error(`${fails} failed`); process.exit(1); } else console.log("ALL PASS gltf-anim");
