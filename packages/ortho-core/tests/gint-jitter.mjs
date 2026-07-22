#!/usr/bin/env node
// 高ズーム座標揺らぎの常設ハーネス：gint の投影経路（worker.js drawNow ＋ bindSharedUniforms ＋
// programs.js fetchProject/deltaToRel）を Math.fround で f32 忠実にミラーし、パン中のフレーム間
// 画面座標ブレ（jitter px）を f64 参照との差分で測定する。
//
// 教訓（2026-07-22 修正）：頂点デルタは round(1e-7°) の u_ix_center 基準なのに、錨
//（u_origin_trig/u_clipT/u_origin_zr）を生の camera center から作ると ±0.5e-7° の不一致が
// パンで毎フレーム変わる全体オフセットになり z20+ で這う（z20=0.15px/z22=0.55px/z23=1.3px）。
// 修正＝錨も 1e-7° 量子化後の origin から計算（デルタと錨の共通原点を一致させる）→全ズーム 0.000px。
// タイル経路（glsl.js PROJECT・シーン原点固定）は元々揺れない＝比較列として掲載。
//
// 使い方: node packages/ortho-core/tests/gint-jitter.mjs   （閾値超えで exit 1）

import { cameraState, lonlatTo3D } from '../src/camera.js';
import * as mat from '../src/mat.js';

const fr = Math.fround;
const D2R = 0.017453292519943295;
const W = 1600, H = 1000;
const fmul = (a, b) => fr(a * b), fadd = (a, b) => fr(a + b), fsub = (a, b) => fr(a - b);

// deltaToRel（programs.js / glsl.js 共通式）の f32 ミラー
function deltaToRel32(dlonDeg, dlatDeg, trig) {
	const da = fmul(dlonDeg, fr(D2R)), db = fmul(dlatDeg, fr(D2R));
	const sda = fr(Math.sin(da)), sdb = fr(Math.sin(db));
	const sha = fr(Math.sin(fmul(da, fr(0.5)))), shb = fr(Math.sin(fmul(db, fr(0.5))));
	const cdaM1 = fmul(fr(-2), fmul(sha, sha)), cdbM1 = fmul(fr(-2), fmul(shb, shb));
	const cda = fadd(1, cdaM1), cdb = fadd(1, cdbM1);
	const ccM1 = fadd(fadd(cdaM1, cdbM1), fmul(cdaM1, cdbM1));
	const [cLon, sLon, cLat, sLat] = trig;
	const rx = fadd(fsub(fsub(fmul(fmul(cLat, cLon), ccM1), fmul(fmul(fmul(cLat, sLon), cdb), sda)), fmul(fmul(fmul(sLat, cLon), sdb), cda)), fmul(fmul(fmul(sLat, sLon), sdb), sda));
	const ry = fadd(fmul(sLat, cdbM1), fmul(cLat, sdb));
	const rz = fsub(fsub(fadd(fmul(fmul(cLat, sLon), ccM1), fmul(fmul(fmul(cLat, cLon), cdb), sda)), fmul(fmul(fmul(sLat, sLon), sdb), cda)), fmul(fmul(fmul(cLat, cLon), sdb), sda));
	return [rx, ry, rz];
}

function toScreen32(clipT32, mvp32, rel) {
	const c = [0, 1, 2, 3].map(r =>
		fadd(clipT32[r], fadd(fadd(fmul(mvp32[r], rel[0]), fmul(mvp32[4 + r], rel[1])), fmul(mvp32[8 + r], rel[2]))));
	const ndcx = fr(c[0] / c[3]), ndcy = fr(c[1] / c[3]);
	return [fr((ndcx * 0.5 + 0.5) * W), fr((1 - (ndcy * 0.5 + 0.5)) * H)];
}

function refScreen(st, lon, lat) {
	const p = lonlatTo3D(lon, lat);
	const c = mat.transform(st.mvp, [p[0], p[1], p[2], 1]);
	return [(c[0] / c[3] * 0.5 + 0.5) * W, (1 - (c[1] / c[3] * 0.5 + 0.5)) * H];
}

// encoder と同じく経度は [-180,180) に正規化して格納（Morton 域 [0, 360e7)）
const toE7 = (lon, lat) => [Math.round(((((lon + 180) % 360) + 360) % 360) * 1e7) >>> 0, Math.round((lat + 90) * 1e7) >>> 0];
function dlonE7(a, b) {   // programs.js の GLSL ミラー（畳み込みは uint＝exact、float 化は最後）
	let d = (Math.max(a, b) - Math.min(a, b)) >>> 0;
	let s2 = a >= b ? 1 : -1;
	if (d > 1800000000) { d = (3600000000 - d) >>> 0; s2 = -s2; }
	return fr(fr(d) * s2);
}

// gint 経路。quantizeAnchor=true が現行実装（worker.js drawNow の量子化 origin）、false が旧実装の再現。
function gintFrame(cam, vertsE7, quantizeAnchor) {
	const st = cameraState(cam, W, H);
	let lon = ((cam.center[0] % 360) + 540) % 360 - 180, lat = cam.center[1];
	const ixc = Math.round((lon + 180) * 1e7) >>> 0, iyc = Math.round((lat + 90) * 1e7) >>> 0;
	if (quantizeAnchor) { lon = ixc / 1e7 - 180; lat = iyc / 1e7 - 90; }
	const T = lonlatTo3D(lon, lat);
	const clipT32 = mat.transform(st.mvp, [T[0], T[1], T[2], 1]).map(fr);
	const mvp32 = Array.from(st.mvp, fr);
	const lr = lon * D2R, br = lat * D2R;
	const trig32 = [fr(Math.cos(lr)), fr(Math.sin(lr)), fr(Math.cos(br)), fr(Math.sin(br))];
	return vertsE7.map(([vx, vy]) => {
		const dlon = fmul(dlonE7(vx, ixc), fr(1e-7));
		const dlat = fmul(fr((vy - iyc) | 0), fr(1e-7));
		return toScreen32(clipT32, mvp32, deltaToRel32(dlon, dlat, trig32));
	});
}

// タイル経路（シーン原点固定）
function tileFrame(cam, origin, dLLs) {
	const st = cameraState(cam, W, H);
	const T = lonlatTo3D(origin[0], origin[1]);
	const clipT32 = mat.transform(st.mvp, [T[0], T[1], T[2], 1]).map(fr);
	const mvp32 = Array.from(st.mvp, fr);
	const lr = origin[0] * D2R, br = origin[1] * D2R;
	const trig32 = [fr(Math.cos(lr)), fr(Math.sin(lr)), fr(Math.cos(br)), fr(Math.sin(br))];
	return dLLs.map(([dx, dy]) => toScreen32(clipT32, mvp32, deltaToRel32(dx, dy, trig32)));
}

let fails = 0;
const CENTERS = [[141.354, 43.062], [139.70, 35.68], [179.99999, -16.8]];   // 札幌・東京・antimeridian跨ぎ
console.log('center            zoom | gint旧(未量子化) | gint現行 | tile   （jitter px＝フレーム間ブレ最大）');
for (const C0 of CENTERS) {
	for (const z of [16, 18, 20, 21, 22, 23]) {
		const degPerPx = 360 / (2 ** z * 512);
		const vertLL = [];
		for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++)
			vertLL.push([C0[0] + i * 300 * degPerPx, C0[1] + j * 250 * degPerPx * 0.7]);
		const vertsE7 = vertLL.map(([lo, la]) => toE7(lo, la));
		const sceneOrigin = [Math.round(C0[0] * 512) / 512, Math.round(C0[1] * 512) / 512];
		const dLLs = vertLL.map(([lo, la]) => [fr(lo - sceneOrigin[0]), fr(la - sceneOrigin[1])]);
		const errsOld = [], errsNew = [], errsTile = [];
		for (let f = 0; f < 120; f++) {
			const cam = { center: [C0[0] + f * 0.2 * degPerPx, C0[1] + f * 0.13 * degPerPx], zoom: z, pitch: 0, bearing: 0 };
			const st = cameraState(cam, W, H);
			const ref = vertLL.map(([lo, la]) => refScreen(st, lo, la));
			const errOf = fm => fm.map((p, i) => [p[0] - ref[i][0], p[1] - ref[i][1]]);
			errsOld.push(errOf(gintFrame(cam, vertsE7, false)));
			errsNew.push(errOf(gintFrame(cam, vertsE7, true)));
			errsTile.push(errOf(tileFrame(cam, sceneOrigin, dLLs)));
		}
		const jitter = errs => {
			let m = 0;
			for (let f = 1; f < errs.length; f++)
				for (let i = 0; i < errs[f].length; i++)
					m = Math.max(m, Math.hypot(errs[f][i][0] - errs[f - 1][i][0], errs[f][i][1] - errs[f - 1][i][1]));
			return m;
		};
		const jo = jitter(errsOld), jn = jitter(errsNew), jt = jitter(errsTile);
		// 現行実装は全ズームでサブ 1/50px（人間には静止）。タイル経路も同水準を維持していること。
		if (jn > 0.02) { fails++; console.error(`  ✗ gint現行 jitter ${jn.toFixed(3)}px @z${z} ${C0}`); }
		if (jt > 0.02) { fails++; console.error(`  ✗ tile jitter ${jt.toFixed(3)}px @z${z} ${C0}`); }
		console.log(`${String(C0[0]).padEnd(10)} z${String(z).padEnd(3)} | ${jo.toFixed(3).padStart(8)} | ${jn.toFixed(3).padStart(8)} | ${jt.toFixed(3).padStart(6)}`);
	}
}
console.log(fails ? `\n✗ ${fails} 件失敗` : '\n✓ PASS（gint 現行＝量子化錨・tile とも jitter ≤ 0.02px @ z16-23）');
process.exit(fails ? 1 : 0);
