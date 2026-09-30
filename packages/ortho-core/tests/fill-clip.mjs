// build.js の clipToExtent＝塗りをタイルの extent で切り抜く（MVT の余白を隣同士が両方描くと半透明の塗りが二重＝縁の濃い帯・ズーム中のチラチラ・2026-09-30）
import { clipToExtent, subdivideTris } from "../src/build.js";
import earcut from "earcut";
let fail = 0; const ok = (n, c) => { if (!c) fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}`); };
const E = 4096, area = (f, t) => { let a = 0; for (let i = 0; i < t.length; i += 3) { const [a0,b0,c0]=[t[i]*2,t[i+1]*2,t[i+2]*2]; a += ((f[b0]-f[a0])*(f[c0+1]-f[a0+1]) - (f[c0]-f[a0])*(f[b0+1]-f[a0+1]))/2; } return Math.abs(a); };
// inside → same object
const sq = new Float64Array([100,100, 1000,100, 1000,1000, 100,1000]); const r0 = clipToExtent(sq, [], E); ok("窓の中＝同じ配列（コピー無し）", r0[0] === sq);
// crossing right/bottom edges: square from 3000..5000 → clipped 3000..4096 area 1096²
const sq2 = new Float64Array([3000,3000, 5000,3000, 5000,5000, 3000,5000]); const r1 = clipToExtent(sq2, [], E); ok("右下の縁を跨ぐ四角＝面積 1096²", Math.abs(area(r1[0], earcut(r1[0], r1[1], 2)) - 1096*1096) < 1e-6);
// polygon with hole, both crossing edge: outer -500..4500, hole 3500..4500 → area = 4096² − 596²
const o = new Float64Array([-500,-500, 4500,-500, 4500,4500, -500,4500, 3500,3500, 3500,4500, 4500,4500, 4500,3500]);
const r2 = clipToExtent(o, [4], E); ok("穴も一緒に切る＝面積 4096²−596²", Math.abs(area(r2[0], earcut(r2[0], r2[1], 2)) - (4096*4096 - 596*596)) < 1e-6 && r2[1].length === 1);
// fully outside → null ; hole fully outside dropped
ok("全部が外＝null", clipToExtent(new Float64Array([-100,-100,-10,-100,-10,-10,-100,-10]), [], E) === null);
const o2 = new Float64Array([0,0, E,0, E,E, 0,E, -50,-50, -50,-10, -10,-10, -10,-50]); ok("外に出た穴は捨てる", clipToExtent(o2, [4], E)[1].length === 0);

// subdivideTris＝格子で切る細分：面積が保たれ・T 字の接点（ある頂点が別の三角形の辺の途中に乗る）が無い＝球の上で継ぎ目（白い筋）が出ない
{
	const flat = new Float64Array([0, 0, 4096, 0, 4096, 4096, 0, 4096, 2000, 1300]), tris = [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4];   // 内点を中心の扇＝斜めの辺を共有する 4 三角形
	const [pts, out] = subdivideTris(flat, tris, 1024);
	const a0 = area(flat, tris), a1 = area(pts, out);
	ok("格子細分＝面積が保たれる", Math.abs(a0 - a1) < 1e-6 * a0);
	let tj = 0; const V = pts.length >> 1;
	for (let v = 0; v < V; v++) { const x = pts[v * 2], y = pts[v * 2 + 1];
		for (let i = 0; i < out.length; i += 3) for (let e = 0; e < 3; e++) { const p = out[i + e], q = out[i + (e + 1) % 3]; if (p === v || q === v) continue;
			const px = pts[p * 2], py = pts[p * 2 + 1], qx = pts[q * 2], qy = pts[q * 2 + 1], cr = (qx - px) * (y - py) - (qy - py) * (x - px), dot = (x - px) * (qx - px) + (y - py) * (qy - py), L = (qx - px) ** 2 + (qy - py) ** 2;
			if (Math.abs(cr) < 1e-6 * Math.sqrt(L) && dot > 1e-6 && dot < L - 1e-6) tj++; } }
	ok("格子細分＝T 字の接点が無い（隣同士が同じ頂点を共有）", tj === 0);
	ok("格子の中に収まる三角形は増えない", subdivideTris(new Float64Array([10, 10, 100, 10, 50, 100]), [0, 1, 2], 1024)[1].length === 3);
}
console.log(fail ? `\n✗ ${fail} 件失敗` : "\n✓ fill-clip 全 PASS"); process.exit(fail ? 1 : 0);
