// 段階 3（改善計画・2026-11-01）：gl/renderer.ts と gpu/renderer.ts が二重に持っていた純関数を src 直下へ抜いた物の門。
// 守るもの＝「抜いても値は同じ」：①framek.ts の係数は両 renderer に書かれていた式の写し（下の reference）と全入力で bit 同値（Object.is）
// ②meshcull.ts の LOD 打ち切り・マスクの選抜・OR、drawshared.ts の破線 uniform・差し込みの計画・強調の塗り・世界扇のレンジ、
// elevcell.ts の再標本化の uniform（28 語）、paintzoom.ts の memo＝旧の inline と同じ結果 ③両 renderer から旧の式が消えている（grep）。
// node tests/shared-purefns.mjs
import { readFileSync } from "node:fs";
import { fogKOf, fogFollow, fogNearOf, fogFarOf, terrainFogNearOf, fogFarCapOf, pitchFogK, pitchElevK, cityKOf, worldHypsoKOf, graticuleKOf, worldFadeOf, skyKOf, logCoefOf, mppxOf } from "../src/framek.ts";
import { meshLodCount, liftGroundROf, pickMeshMasks, orMaskBytes } from "../src/meshcull.ts";
import { dashU, userAnchorPlan, hiFillOf, worldFanRuns } from "../src/drawshared.ts";
import { packResampleParams, cpuResampleCell } from "../src/elevcell.ts";
import { evalPaintZoomMemo, evalPaintZoom } from "../src/paintzoom.ts";
import { terrainGridUV } from "../src/terrainlod.ts";
import { dashIntervals } from "../src/scene.ts";
import { worldRadiusM } from "../src/camera.ts";
import { downsampleFlipped, cropResample } from "../src/elevation.ts";

let fails = 0;
const ok = (c, msg) => { if (!c) fails++; console.log(`${c ? "✓" : "✗"} ${msg}`); };
const same = (a, b, msg) => ok(Object.is(a, b), `${msg}（${a} ≟ ${b}）`);
const zooms = [-1, 0, 0.3, 1, 1.9, 2.2, 3.7, 4.9, 5, 6.4, 6.5, 8, 12, 13.5, 13.7, 14, 16.9, 22], pitches = [undefined, 0, 0.05, 0.1, 0.2, 0.35, 0.5, 0.8, 1.2];

// ① framek＝旧 inline の式（gl/gpu の draw に書かれていた物をそのまま）
{
	const ref = {
		fogK: (sky, fogOff) => (sky ? (sky.groundBlend <= 0 ? 1e6 : 0.5 / sky.groundBlend) : fogOff ? 1e6 : 1),
		pfFog: (p) => Math.max(0, Math.min(1, ((p || 0) - 0.35) / 0.45)),
		pf: (p) => { const pt = Math.max(0, Math.min(1, ((p || 0) - 0.06) / 0.14)); return pt * pt * (3 - 2 * pt); },
		cityK: (z, td) => (td ? Math.max(0, Math.min(1, (z - 13.5) / 0.5)) : 0),
		whK: (z, whZ) => Math.max(0, Math.min(1, (whZ - z) / 0.8)),
		grat: (z, whZ) => Math.max(0, Math.min(1, (z - 1.7) / 0.5)) * Math.max(0, Math.min(1, (whZ - z) / 0.5)) * 0.5,
		worldFade: (z) => (z < 5 ? Math.min(1, (5 - z) / 0.5) : 0),
		skyK: (z) => { const zx = z - 1, zs = 1 + (zx > 0 ? zx + 0.25 * Math.log(1 + Math.exp(-zx / 0.25)) : 0.25 * Math.log(1 + Math.exp(zx / 0.25))); return (0.4 + 0.3 * zs) / 1.6; },
		logCoef: (camDist) => { const limb = Math.sqrt(Math.max((1 + camDist) * (1 + camDist) - 1, 1e-12)); return 2.0 / Math.log2(limb * 1.15 + camDist + 1.0); },
		mppx: (z) => 156543.03392 * 0.819 / Math.pow(2, z || 0),
	};
	let n = 0, bad = 0;
	const chk = (a, b) => { n++; if (!Object.is(a, b)) bad++; };
	for (const sky of [null, undefined, { groundBlend: 0 }, { groundBlend: -1 }, { groundBlend: 0.5 }, { groundBlend: 0.3 }, { groundBlend: 1 }]) for (const off of [false, true]) chk(fogKOf(sky, off), ref.fogK(sky, off));
	for (const p of pitches) { chk(pitchFogK(p), ref.pfFog(p)); chk(pitchElevK(p), ref.pf(p)); }
	for (const z of zooms) {
		chk(cityKOf(z, true), ref.cityK(z, true)); chk(cityKOf(z, false), 0);
		for (const whZ of [6.5, 5, 9.25]) { chk(worldHypsoKOf(z, whZ), ref.whK(z, whZ)); chk(graticuleKOf(z, whZ), ref.grat(z, whZ)); }
		chk(worldFadeOf(z), ref.worldFade(z)); chk(skyKOf(z), ref.skyK(z)); chk(mppxOf(z), ref.mppx(z));
	}
	chk(mppxOf(undefined), ref.mppx(undefined));
	for (const d of [1e-5, 0.0003, 0.01, 0.37, 1, 2.5, 7]) chk(logCoefOf(d), ref.logCoef(d));
	for (const fd of [0.01, 0.2, 1.3]) for (const k of [1, 0.5 / 0.3, 1e6]) for (const pfFog of [0, 0.4, 1]) {
		chk(fogNearOf(fd, k), fd * 2.5 * k); chk(fogFarOf(fd, k), fd * 14.0 * k);
		chk(terrainFogNearOf(fd, pfFog, k), Math.max(fd * 1.2, 0.008 * pfFog) * k); chk(fogFarCapOf(fd, pfFog, k), Math.max(fd * 5.0, 0.026 * pfFog) * k);
	}
	ok(bad === 0, `framek：係数 ${n} 組が旧 inline の式と bit 同値（違い ${bad}）`);
	// 臨界減衰追従＝旧の 3 行（初回・霧なし・飛び＝合わせる／追う／収束で止める）
	const follow = (prev, last, cam, k) => { let fogDist = prev; if (!fogDist || k >= 1e6 || cam > last * 2 || cam * 2 < last) fogDist = cam; else fogDist += (cam - fogDist) * 0.18; if (Math.abs(cam - fogDist) < cam * 0.002) fogDist = cam; return fogDist; };
	let fb = 0, fn = 0;
	for (const prev of [0, 0.5, 1.001, 2]) for (const last of [0, 0.4, 1, 3]) for (const cam of [0.3, 0.999, 1, 1.0001, 2.5]) for (const k of [1, 1e6]) { fn++; if (!Object.is(fogFollow(prev, last, cam, k), follow(prev, last, cam, k))) fb++; }
	ok(fb === 0, `framek：fogFollow ${fn} 組が旧の 3 行と同値（違い ${fb}）`);
	same(fogFollow(1, 1, 1.5, 1), 1 + 0.5 * 0.18, "fogFollow：追う（prev 1 → cam 1.5 は 0.18 だけ寄る）");
	same(fogFollow(1, 1, 2.1, 1), 2.1, "fogFollow：飛び（2 倍超）は合わせる");
}

// ② meshcull
{
	const center = [139.7, 35.68], cosLat = Math.cos(center[1] * Math.PI / 180), mppx = mppxOf(16.5);
	const refCount = (p) => { let count = p.count; if (p.lodH && !p.two && !p.keep2d) { const dm = Math.hypot(((p.bbox[0] + p.bbox[2]) / 2 - center[0]) * 111320 * cosLat, ((p.bbox[1] + p.bbox[3]) / 2 - center[1]) * 111320); const minH = mppx * (1 + dm / 4000); let li = 0; for (let i = p.lodH.length - 1; i > 0; i--) if (p.lodH[i] <= minH) { li = i; break; } count = p.lodCounts[li]; } return count; };
	const P = [
		{ bbox: [139.69, 35.67, 139.71, 35.69], count: 900, lodH: [0, 1, 3, 10, 30], lodCounts: [900, 700, 400, 100, 20], two: 0, keep2d: false },
		{ bbox: [139.0, 35.0, 139.2, 35.2], count: 900, lodH: [0, 1, 3, 10, 30], lodCounts: [900, 700, 400, 100, 20], two: 0, keep2d: false },   // 遠い＝閾値が上がる
		{ bbox: [139.69, 35.67, 139.71, 35.69], count: 900, lodH: [0, 1, 3, 10, 30], lodCounts: [900, 700, 400, 100, 0], two: 1, keep2d: false },   // 橋梁＝全描画
		{ bbox: [139.69, 35.67, 139.71, 35.69], count: 900, lodH: [0, 1, 3, 10, 30], lodCounts: [900, 700, 400, 100, 0], two: 0, keep2d: true },   // 統計＝間引かない
		{ bbox: [139.69, 35.67, 139.71, 35.69], count: 900, lodH: null, lodCounts: null, two: 0, keep2d: false },
		{ bbox: [139.69, 35.67, 139.71, 35.69], count: 900, lodH: [0, 1e9], lodCounts: [900, 0], two: 0, keep2d: false },   // 0＝描かない
	];
	ok(P.every(p => meshLodCount(p, center, cosLat, mppx) === refCount(p)), `meshLodCount：${P.length} 束が旧 inline と同じ（${P.map(p => meshLodCount(p, center, cosLat, mppx)).join(",")}）`);
	ok(meshLodCount(P[1], center, cosLat, mppx) < meshLodCount(P[0], center, cosLat, mppx), "meshLodCount：遠い束ほど打ち切りが強い");
	same(liftGroundROf(100), 1 + 100 / worldRadiusM(), "liftGroundROf：注視点の高さ 100 m"); same(liftGroundROf(-5), 1, "liftGroundROf：負は 0"); same(liftGroundROf(undefined), 1, "liftGroundROf：未指定は 1");
	const masks = new Map([["far", { bbox: [140, 36, 141, 37] }], ["near", { bbox: [139.6, 35.6, 139.8, 35.8] }], ["hidden", { bbox: [139.7, 35.68, 139.71, 35.69] }], ["mid", { bbox: [139.9, 35.9, 140, 36] }]]);
	const picked = pickMeshMasks(masks, new Set(["hidden"]), center, 2);
	ok(picked.length === 2 && picked[0] === masks.get("near") && picked[1] === masks.get("mid"), "pickMeshMasks：近い順に max 個・非表示区は載せない");
	const b1 = new Uint8Array(8), b2 = new Uint8Array(8);
	orMaskBytes(b1, [1, 5, 99], null); orMaskBytes(b2, null, [0, 1, 0, 0, 0, 1, 0, 0, 1, 1]);
	ok(b1.join() === "0,255,0,0,0,255,0,0" && b2.join() === b1.join(), "orMaskBytes：格子の番号（範囲外は無視）＝旧 worker の全量（はみ出しは無視）");
	b1[0] = 255; orMaskBytes(b1, [1], null); ok(b1[0] === 255, "orMaskBytes：単調（立てた物は消えない）");
}

// ③ drawshared
{
	for (const [dash, cj] of [[[2, 1], 0], [[2, 1], 1], [[0, 2], 0], [[1, 1, 3, 1, 2, 1, 4, 1, 5, 1], 2], [undefined, 0]]) {
		const d = dashU(dash, cj);
		if (!dash) { ok(d === null, "dashU：破線なし＝null"); continue; }
		const round = !(cj & 3), { P, iv } = dashIntervals(dash, round), a = new Float32Array(8); a.set(iv.length ? iv.slice(0, 8) : [-2 * P, -2 * P]);
		ok(d.P === P && d.n === Math.max(1, Math.min(4, iv.length >> 1)) && d.round === (round ? 1 : 0) && d.iv.join() === a.join(), `dashU：[${dash}] cj=${cj} → P=${d.P} n=${d.n} round=${d.round}`);
	}
	const plan = userAnchorPlan([[10, 19, 40], [20, 29, 5], [30, 39, 40]], "base");
	ok(plan.host === "base" && plan.anchors.join() === "5,40" && plan.anchorOf(15) === 40 && plan.anchorOf(25) === 5 && plan.anchorOf(99) === Infinity, "userAnchorPlan：境は昇順・重なりなし・表に無い li は Infinity");
	ok(userAnchorPlan([], "base").host === null && userAnchorPlan([[0, 1, 2]], null).host === null, "userAnchorPlan：枠が無い／表が空＝host null（全部最後）");
	ok(hiFillOf(null).color.join() === "0.95,0.55,0.15,0.6" && !hiFillOf(null).mask, "hiFillOf：既定＝橙 60%");
	ok(hiFillOf([1, 0, 0, 1]).color.join() === "1,0,0,1" && !hiFillOf([1, 0, 0, 1]).mask, "hiFillOf：配列＝面塗り");
	ok(hiFillOf(new Float32Array([0, 1, 0, 1])).color.length === 4 && !hiFillOf(new Float32Array(4)).mask, "hiFillOf：型付き配列も面塗り");
	ok(hiFillOf({ mask: true }).color.join() === "0,0,0,0.15" && hiFillOf({ mask: true }).mask && hiFillOf({ color: [1, 1, 1, 0.5] }).mask === false, "hiFillOf：{mask,color}＝周辺マスク（色の既定は黒 15%）");
	// 世界扇：目の真下の feature は見える・対蹠点は見えない・連続レンジは結合
	const eye = [0, 0, 3], feats = [{ C: [0, 0, 1], cosR: Math.cos(0.1), sinR: Math.sin(0.1), start: 0, count: 6 }, { C: [0, 1, 0], cosR: Math.cos(0.1), sinR: Math.sin(0.1), start: 6, count: 9 }, { C: [0, 0, -1], cosR: Math.cos(0.1), sinR: Math.sin(0.1), start: 15, count: 3 }, { C: [0.1, 0, 1], cosR: Math.cos(0.1), sinR: Math.sin(0.1), start: 18, count: 3 }];
	const runs = []; worldFanRuns(feats, eye, (f, c) => runs.push([f, c]));
	ok(JSON.stringify(runs) === "[[0,6],[18,3]]", `worldFanRuns：真下 ✓・横 ✗（地平の外）・対蹠 ✗・分かれたレンジは別 draw（${JSON.stringify(runs)}）`);
	const runs2 = []; worldFanRuns([feats[0], { ...feats[3], start: 6, count: 3 }], eye, (f, c) => runs2.push([f, c]));
	ok(JSON.stringify(runs2) === "[[0,9]]", "worldFanRuns：連続レンジは 1 つの draw に結合");
}

// ④ elevcell：uniform の詰め（旧 gl/gpu の inline と同じ語の位置）
{
	const tile = { width: 256, height: 256, lng: 138, lat: 35, range: 1, data: new Float32Array(256 * 256).map((_, i) => (i % 97)) };
	const u = new Uint32Array(28), f = new Float32Array(u.buffer);
	ok(packResampleParams(u, f, { mode: "down", tile, edge: 0, sea: true }, 3, 2, 64) && u[20] === 64 && u[21] === 256 && u[22] === 128 && u[23] === 1 && u[24] === 64 && u[25] === 256 && u[26] === 128 && u[16] === 0 && u[0] === 256 && u[1] === 256 && u[12] === 192 && u[13] === 128 && u[14] === 64 && u[19] === 1 && u[3] === 0, "packResampleParams down：ix/iy=(N,w,2N,1)・box.x=edge・o=(cx N, cy N, N)・box.w=sea");
	ok(packResampleParams(u, f, { mode: "crop", tile, lng0: 138.5, lat0: 35.25, span: 0.25 }, 0, 0, 64) && u[3] === 3 && Math.abs(f[4] - (0.5 * 256 - 0.5)) < 1e-6 && u[19] === 0 && u[2] === 0, "packResampleParams crop（端数）：mode 3 の f32 一般形・海底なし");
	const tileI = { ...tile, range: 2 };
	ok(packResampleParams(u, f, { mode: "crop", tile: tileI, lng0: 139, lat0: 36, span: 1, sea: true }, 1, 1, 64) && u[3] === 2 && u[20] === 1 * 2 * 64 * 256 + 64 * 2 && u[21] === 256 && u[22] === 2 * 64 * 2 && u[19] === 1, "packResampleParams crop（整数）：mode 2 の分数（Ax, Bx, D）");
	const atlas = { width: 1024, height: 512, data: new Float32Array(0) };
	ok(packResampleParams(u, f, { mode: "world", atlas, cx: 2, cy: 0.5 }, 0, 0, 64) && u[3] === 1 && u[15] === 4 && u[16] === 1024 && u[17] === 128 && u[18] === 512 && u[19] === 0, "packResampleParams world：mode 1・C/N・格子の位置（sea は読まない）");
	ok(!packResampleParams(u, f, { mode: "world", atlas, cx: 0, cy: 0 }, 0, 0, 100), "packResampleParams world：C % N≠0 は GPU で焼けない（false）");
	ok(!packResampleParams(u, f, { mode: "down", tile: { ...tile, width: 1 } }, 0, 0, 64), "packResampleParams：1 画素のタイルは false");
	const a = cpuResampleCell({ mode: "down", tile, edge: 2 }, 32), b = downsampleFlipped(tile, 32, 2, false);
	ok(a.length === 1024 && a.every((v, i) => v === b[i]), "cpuResampleCell down＝downsampleFlipped");
	const c = cpuResampleCell({ mode: "crop", tile, lng0: 138.25, lat0: 35.25, span: 0.5, sea: true }, 16), d = cropResample(tile, 138.25, 35.25, 0.5, 16, true);
	ok(c.every((v, i) => v === d[i]), "cpuResampleCell crop＝cropResample");
}

// ⑤ paintzoom の memo と地形の uv
{
	const pz = { o: { kind: "ml" }, c: ["interpolate", ["linear"], ["zoom"], 5, "#ff0000", 10, "#0000ff"], w: ["interpolate", ["linear"], ["zoom"], 5, 1, 10, 6] };
	const memo = new WeakMap();
	const m1 = evalPaintZoomMemo(memo, pz, 7.3, 1), v = evalPaintZoom(pz, 7.3), dz = 1;
	ok(m1.z === 7.3 && m1.c.join() === v.c.join() && m1.hw === v.hw && m1.hwF === evalPaintZoom({ o: pz.o, w: pz.w }, Math.floor(7.3 - dz) + dz).hw && m1.off === v.off, `evalPaintZoomMemo：旧 inline と同じ（hw ${m1.hw} hwF ${m1.hwF}）`);
	ok(evalPaintZoomMemo(memo, pz, 7.3, 1) === m1, "evalPaintZoomMemo：同じ z は同じ物（評価しない）");
	ok(evalPaintZoomMemo(memo, pz, 8, 1) !== m1 && memo.get(pz).z === 8, "evalPaintZoomMemo：z が変われば評価し直す");
	const uv = terrainGridUV(4);
	ok(uv.length === 32 && uv[0] === 0 && uv[1] === 0 && uv[2] === Math.fround(1 / 3) && uv[30] === 1 && uv[31] === 1, "terrainGridUV：i/(G−1), j/(G−1)");
}

// ⑥ 両 renderer から旧の式が消えている（二重化の再発を止める）
{
	const gl = readFileSync(new URL("../src/gl/renderer.ts", import.meta.url), "utf8"), gpu = readFileSync(new URL("../src/gpu/renderer.ts", import.meta.url), "utf8");
	const gone = [/156543\.03392/, /\(zx > 0 \? zx \+ 0\.25 \* Math\.log/, /- 13\.5\) \/ 0\.5\)/, /- 0\.35\) \/ 0\.45\)/, /- 0\.06\) \/ 0\.14\)/, /0\.026 \* pfFog/, /0\.008 \* pfFog/, /fogDist \* 2\.5 \* fogK/, /fogDist \* 14\.0 \* fogK/, /\(5 - cam\.zoom\) \/ 0\.5/, /limb \* 1\.15/, /function dashU\(/, /dashIntervals\(dash/, /\[\.\.\.new Set\(R\.map/, /mdist = \(m/, /lodH\[i\] <= minH/, /f\.cosR \* cosH/, /u\[26\] = 2 \* N/, /uv\[k\] = i \/ \(G - 1\)/, /evalPaintZoom\(\{ o: pz\.o/];
	for (const [name, src] of [["gl", gl], ["gpu", gpu]]) { const left = gone.filter(re => re.test(src)).map(String); ok(!left.length, `${name}/renderer.ts に旧 inline の式が残っていない${left.length ? "：" + left.join(" ") : ""}`); }
	for (const mod of ["framek", "meshcull", "drawshared", "elevcell"]) ok(gl.includes(`"../${mod}.ts"`) && gpu.includes(`"../${mod}.ts"`), `両 renderer が ${mod}.ts を読む`);
}

console.log(fails ? `✗ shared-purefns: ${fails} 件` : "✓ shared-purefns: 共有の純関数＝旧 inline と同値・両 renderer から二重の式は消えた");
process.exit(fails ? 1 : 0);
