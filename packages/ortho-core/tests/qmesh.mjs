#!/usr/bin/env node
// quantized-mesh（#110 段 1）の純関数 qmesh.js の検証。外部データ不要＝決定的（書き手 encodeQuantizedMesh で作った .terrain を読む）。
//   1. タイルの数え方（EPSG:4326・TMS・ルート 2×1・y は南から）
//   2. 書いて読む＝頂点・高さ（u16 量子化の刻み以内）・索引（高水位）・16bit と 32bit（頂点 65536 超）
//   3. 格子へ焼く＝円錐（中心 3000m・半径 0.1°）の格子点が解析解と合う（三角形の線形内挿の誤差以内）・隣り合う 2 枚の継ぎ目に穴が無い
//   5. ジオイド高（EGM96 30 分）：15 分格子の値と合う・日付変更線で途切れない・読む前は NaN
//   4. 1 点の標本・空のタイル（高さ 0..0）の判定・gzip のまま来る .terrain・layer.json（相対の型紙・鍵の引き継ぎ・在庫）
// 使い方: node packages/ortho-core/tests/qmesh.mjs
import zlib from "node:zlib";
import { loadGeoid, geoidHeight } from "../src/geoid.js";
import { qmTileSpan, qmTileBounds, qmTileAt, parseLayerJson, qmAvailable, decodeQuantizedMesh, qmGunzip, qmBake, qmSample, encodeQuantizedMesh } from "../src/qmesh.js";

let fails = 0;
const ok = (cond, label) => { if (cond) { console.log(`  ✓ ${label}`); return; } fails++; console.error(`  ✗ ${label}`); };

console.log("― タイルの数え方 ―");
ok(qmTileSpan(0) === 180 && qmTileBounds(0, 1, 0).join() === "0,-90,180,90", "z0＝2 枚（西・東）");
ok(qmTileAt(13, 7.65861, 45.97639).join() === "8540,6188", "マッターホルン z13＝8540/6188（swisstopo で実在を確かめたタイル）");
ok(qmTileAt(2, 180, 90).join() === "7,3", "端は内側へ畳む");

// 円錐の試料：タイル tb の上に G×G の格子の頂点・高さ＝3000·max(0, 1 − 距離/0.1°)
const cone = (lon, lat, c = [150.5, 30.5]) => 3000 * Math.max(0, 1 - Math.hypot(lon - c[0], lat - c[1]) / 0.1);
function makeTile(tb, G, hf = cone) {
	const verts = [], tris = [], [w, s, e, n] = tb;
	for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { const u = Math.round(i / (G - 1) * 32767), v = Math.round(j / (G - 1) * 32767); verts.push([u, v, hf(w + u / 32767 * (e - w), s + v / 32767 * (n - s))]); }
	const hs = verts.map(v => v[2]), minH = hs.reduce((a, b) => Math.min(a, b), Infinity), maxH = hs.reduce((a, b) => Math.max(a, b), -Infinity);
	// 高水位の順（索引を初めて使う順に 0,1,2…）に並べ替える＝仕様の符号の前提
	const order = [], seen = new Map(), mapI = i => { if (!seen.has(i)) { seen.set(i, order.length); order.push(i); } return seen.get(i); };
	for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) { const a = j * G + i, b = a + 1, c = a + G, d = c + 1; tris.push([a, b, c].map(mapI), [b, d, c].map(mapI)); }
	const vs = order.map(i => verts[i]);
	return { ab: encodeQuantizedMesh({ verts: vs, tris, minH, maxH }), verts: vs, minH, maxH };
}

console.log("― 書いて読む ―");
{
	const tb = qmTileBounds(10, 1880, 685);   // 150.5E 30.5N を含む z10
	const t = makeTile(tb, 33), m = decodeQuantizedMesh(t.ab);
	const dq = (t.maxH - t.minH) / 32767;
	let worst = 0; for (let i = 0; i < m.n; i++) worst = Math.max(worst, Math.abs(m.h[i] - t.verts[i][2]), Math.abs(m.u[i] - t.verts[i][0] / 32767));
	ok(m.n === 33 * 33 && m.tri.length === 32 * 32 * 6 && worst <= dq, `頂点 ${m.n}・三角形 ${m.tri.length / 3}・高さの差 ≤ 量子化の刻み（${worst.toFixed(3)} m）`);
	ok(Math.max(...m.tri) === m.n - 1 && m.tri[0] === 0 && !m.empty, "索引（高水位）と空でない");
	const big = makeTile(tb, 260), mb = decodeQuantizedMesh(big.ab);
	ok(mb.n === 260 * 260 && mb.n > 65536 && mb.tri.reduce((a, b) => Math.max(a, b), 0) === mb.n - 1, `32bit の索引（頂点 ${mb.n}）`);
	// 高水位の順でない索引（差が負＝16bit で折り返す・PDOK の書き手の形）も同じ三角形に戻る
	const wv = [[0, 0, 10], [32767, 0, 20], [0, 32767, 30], [32767, 32767, 40]], wt = [[3, 1, 2], [2, 1, 0]];
	const mw = decodeQuantizedMesh(encodeQuantizedMesh({ verts: wv, tris: wt, minH: 10, maxH: 40, wrap: true }));
	ok(Array.from(mw.tri).join() === wt.flat().join(), `折り返した索引（${Array.from(mw.tri).join()}）`);
	const z0 = makeTile(tb, 3, () => 0), mz = decodeQuantizedMesh(z0.ab);
	ok(mz.empty, "高さ 0..0 の置き物は空（PDOK の粗い段）");
}

console.log("― 格子へ焼く ―");
{
	// 1° のセル（150〜151E・30〜31N）の 257×257 格子へ、z10 の 2 枚（東西に隣接）を焼く
	const N = 257, grid = { data: new Float32Array(N * N).fill(NaN), N, lng: 150, lat: 30, range: 1 };
	const [x0, y0] = qmTileAt(10, 150.5, 30.5);
	let wrote = 0;
	for (const x of [x0 - 1, x0]) { const tb = qmTileBounds(10, x, y0), t = makeTile(tb, 65); wrote += qmBake(decodeQuantizedMesh(t.ab), tb, grid); }
	const tbW = qmTileBounds(10, x0 - 1, y0), tbE = qmTileBounds(10, x0, y0);
	let worst = 0, holes = 0, cnt = 0;
	for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
		const lon = 150 + c / (N - 1), lat = 31 - r / (N - 1);
		const inside = lon >= tbW[0] && lon <= tbE[2] && lat >= tbW[1] && lat <= tbW[3];
		const v = grid.data[r * N + c];
		if (!inside) { if (v === v) holes++; continue; }
		if (v !== v) { holes++; continue; }
		cnt++; worst = Math.max(worst, Math.abs(v - cone(lon, lat)));
	}
	// 円錐の稜（頂点・縁）は三角形の線形では丸まる＝格子の刻み（0.176°/64）×勾配（3000m/0.1°）ぶんまで
	const tol = 0.176 / 64 * 30000 * 1.5;
	ok(cnt > 100 && holes === 0 && worst < tol, `2 枚の範囲の格子点 ${cnt} 点・穴 ${holes}・解析解との差 ${worst.toFixed(1)} m（< ${tol.toFixed(0)}）`);
	const tb = qmTileBounds(10, x0, y0), m = decodeQuantizedMesh(makeTile(tb, 65).ab);
	const pt = [150.47, 30.52], hs = qmSample(m, tb, ...pt);
	ok(Math.abs(hs - cone(...pt)) < tol, `1 点の標本（${hs.toFixed(1)} m・解析解 ${cone(...pt).toFixed(1)} m）`);
	ok(Number.isNaN(qmSample(m, tb, 149.0, 30.5)), "タイルの外は NaN");
}

console.log("― gzip・layer.json ―");
{
	const tb = qmTileBounds(10, 1880, 685), t = makeTile(tb, 9);
	const gz = zlib.gzipSync(Buffer.from(t.ab)), un = await qmGunzip(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength));
	ok(decodeQuantizedMesh(un).n === 81 && (await qmGunzip(t.ab)) === t.ab, "gzip のまま来る .terrain を解く・素はそのまま");
	const L = parseLayerJson({ format: "quantized-mesh-1.0", projection: "EPSG:4326", scheme: "tms", version: "1.2.0", tiles: ["{z}/{x}/{y}.terrain?v={version}"], maxzoom: 15,
		available: [[{ startX: 0, startY: 0, endX: 1, endY: 0 }], [{ startX: 2, startY: 1, endX: 3, endY: 1 }]] }, "https://example.org/terrain/layer.json?access_token=KEY");
	ok(L.tiles[0] === "https://example.org/terrain/{z}/{x}/{y}.terrain?v={version}&access_token=KEY", `相対の型紙を絶対に・鍵を引き継ぐ（${L.tiles[0]}）`);
	ok(qmAvailable(L, 1, 3, 1) && !qmAvailable(L, 1, 0, 0) && !qmAvailable(L, 5, 0, 0), "在庫（段ごとの矩形・無い段は無い）");
	let threw = 0; try { parseLayerJson({ format: "quantized-mesh-1.0", projection: "EPSG:3857" }, "https://x/layer.json"); } catch { threw = 1; }
	ok(threw, "EPSG:3857 は断る");
}

console.log("― ジオイド高（段 5）―");
{
	const before = geoidHeight(139.75, 35.75);
	await loadGeoid();
	const AMS = 42.883, T = geoidHeight(139.75, 35.75), A = geoidHeight(4.5, 52.5), I = geoidHeight(78, 5);   // AMS＝15 分格子の (4.5, 52.5) の値
	ok(Number.isNaN(before), "読む前は NaN");
	ok(Math.abs(A - AMS) < 0.01 && Math.abs(I + 104.68) < 0.01, `30 分の格子点は 15 分格子の値そのまま（アムステルダム ${A.toFixed(2)}・インド洋 ${I.toFixed(2)} m）`);
	ok(Math.abs(T - 36.81) < 1, `格子の間は双一次（東京 ${T.toFixed(2)} m・15 分格子 36.81 m）`);
	const e = geoidHeight(179.99, -17), w = geoidHeight(-179.99, -17);
	ok(Math.abs(e - w) < 0.2, `日付変更線で途切れない（${e.toFixed(2)} / ${w.toFixed(2)}）`);
}

if (fails) { console.error(`FAIL ${fails}`); process.exit(1); }
console.log("PASS qmesh");
