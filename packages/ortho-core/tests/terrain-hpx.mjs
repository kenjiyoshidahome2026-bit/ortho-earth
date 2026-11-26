// t-terrain-hpx: 地形の R10 のセルを HEALPix の標高タイルから埋める道（?hpx=1・src/elevation/healpixsrc.ts と terrain.ts の cell10）の検定。
// 守るもの＝①セルの値が真値と合う（向き・番地）②セルの密度に合う order を選ぶ ③HEALPix が取れない時は従来の R10 へ落ちる
// ④既定（hpx 無し）は従来どおり R10 を取りに行く ⑤ラベルの標高（sampleElev）が HEALPix のセルから引ける。
// node tests/terrain-hpx.mjs
globalThis.self ??= globalThis;
const { createHpxElevSource } = await import("../src/elevation/healpixsrc.ts");
const { createTerrain } = await import("../src/terrain.ts");
const { cellOf, hpxPixelLonLat } = await import("../src/healpix.ts");
let fails = 0; const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const R = Math.PI / 180;
const f = (lon, lat) => 3000 * Math.cos(lat * R) * Math.sin(2 * lon * R) + 2000 * Math.sin(3 * lat * R) + 1500 * Math.cos(lat * R) ** 2 * Math.cos(5 * lon * R) - 500;
// 合成のタイル（幅 32・画素中心に真値）。asked＝取りに行った (order, npix)
const W = 32, asked = [];
const fetchTile = async (order, npix) => {
	asked.push([order, npix]);
	const t = new Int16Array(W * W), c = cellOf(order, npix);
	for (let row = 0; row < W; row++) for (let col = 0; col < W; col++) { const ll = hpxPixelLonLat(order, c, W, col, row); t[row * W + col] = Math.round(f(ll[0], ll[1])); }
	return t;
};
const errOf = (c) => { let worst = 0; for (let j = 0; j < c.N; j++) for (let i = 0; i < c.N; i++) worst = Math.max(worst, Math.abs(c.grid[j * c.N + i] - f(c.lng + c.range * (i + 0.5) / c.N, c.lat + c.range * (j + 0.5) / c.N))); return worst; };

// 1. 源：セルを埋める
{
	const src = createHpxElevSource({ fetchTile, tileWidth: W, rowsPerSlice: 16 });
	const c = await src.cell(130, 30, 10, 64, true);
	ok(c && c.N === 64 && c.grid.length === 64 * 64 && c.order === 4, `10° のセルを 64² で＝order ${c?.order}（1 画素 0.156° に足る最も粗い段）`);
	ok(errOf(c) < 6, `値が真値と合う（最大 ${errOf(c).toFixed(1)} m）`);
	ok(asked.length > 0 && asked.every(a => a[0] === 4) && new Set(asked.map(a => a[1])).size === asked.length, `要るタイルだけを 1 回ずつ取る（${asked.length} 枚）`);
	const n0 = asked.length, c2 = await src.cell(130, 30, 10, 64, true);
	ok(c2 === c && asked.length === n0, "同じセルは埋め直さない");
	const fine = await src.cell(130, 30, 10, 256, true);
	ok(fine.order === 5 && errOf(fine) < 3, `細かいセル（256²）は上限の order 5（最大 ${errOf(fine).toFixed(1)} m）`);
	const land = await src.cell(130, 30, 10, 64, false);
	ok(land.grid.every(v => v >= 0) && c.grid.some(v => v < 0), "sea＝偽は負値を 0 へ寄せる");
	const v = src.sample(135.3, 34.7);
	ok(v !== null && Math.abs(v - f(135.3, 34.7)) < 6 && src.sample(0, 0) === null, `1 点の標高は手元の最も細かいセルから（${v?.toFixed(0)} m・真値 ${f(135.3, 34.7).toFixed(0)}）・無い所は null`);
	const pole = await src.cell(-180, 80, 10, 64, true), date = await src.cell(170, -10, 10, 64, true);
	ok(errOf(pole) < 12 && errOf(date) < 6, `極のセル・180° 線の際のセルも合う（${errOf(pole).toFixed(1)}・${errOf(date).toFixed(1)} m）`);
	const dead = createHpxElevSource({ fetchTile: async () => { throw new Error("offline"); }, tileWidth: W });
	const warn = console.warn; console.warn = () => {};
	ok(await dead.cell(130, 30, 10, 64) === null, "タイルに届かない＝null（呼び手が従来の経路へ落とす）");
	console.warn = warn;
	const light = createHpxElevSource({ fetchTile, tileWidth: W, skipAbove: 4 });
	ok(await light.cell(130, 30, 10, 256) === null && (await light.cell(130, 30, 10, 64))?.order === 4, "skipAbove＝それより細かい段を要るセルは出さない（呼び手が R10 へ落とす）");
	const none = createHpxElevSource({ fetchTile: async () => null, tileWidth: W });
	ok((await none.cell(130, 30, 10, 64)).grid.every(v => v === 0), "無いタイル（404）は 0 m");
}

// 2. 地形：?hpx の時は R10 を取りに行かず、HEALPix から埋めたセルを書く
{
	const cam = { center: [150.5, 30.5], zoom: 7.5, pitch: 0, bearing: 0, dpr: 1, fovy: 0.6435 }, size = { w: 960, h: 600 };
	const run = async (hpx) => {
		const loads = [], writes = [];
		const loader = Object.assign(async (lng, lat, range) => { loads.push(range); return { lng, lat, range, width: 8, height: 8, data: new Float32Array(64).fill(1234), source: "test" }; }, { byName: async () => null });
		const T = createTerrain({ renderer: { set(slot, data, at) { if (/^elevCell/.test(slot)) writes.push({ data, at }); } }, requestDraw() {}, exag: 1, earthM: 6371000, tileLoader: loader, noMixed: true, noFar: true, hpx });
		T.ensure(cam, size);
		for (let i = 0; i < 200 && T.debug().pendingElev; i++) await sleep(5);
		return { T, loads, writes };
	};
	const log = console.log; console.log = () => {};
	const base = await run(null);
	const src = createHpxElevSource({ fetchTile, tileWidth: W });
	const on = await run(src);
	const warn = console.warn; console.warn = () => {};
	const fall = await run(createHpxElevSource({ fetchTile: async () => { throw new Error("offline"); }, tileWidth: W }));
	console.warn = warn; console.log = log;
	ok(base.loads.filter(r => r === 10).length > 0 && base.writes.length > 0, `既定＝従来どおり R10 を取りに行く（${base.loads.filter(r => r === 10).length} 枚）`);
	ok(on.loads.filter(r => r === 10).length === 0 && on.writes.length === base.writes.length, `hpx＝R10 は取らず、同じ枚数のセルを書く（${on.writes.length} 枚）`);
	const w = on.writes.find(x => x.data instanceof Float32Array), N = w?.at?.cellRes;
	ok(w && w.data.length === N * N, `書くのは窓の密度そのままの Float32（${N}²）`);
	const e = on.T.sampleElev(150.5, 30.5), tv = Math.max(0, f(150.5, 30.5));
	ok(Math.abs(e - tv) < 6, `ラベルの標高は HEALPix のセルから（${e.toFixed(0)} m・真値 ${tv.toFixed(0)}）`);
	ok(fall.loads.filter(r => r === 10).length === base.loads.filter(r => r === 10).length && fall.writes.length === base.writes.length, "HEALPix に届かない時は従来の R10 へ落ちる（絵は欠けない）");
}
console.log(fails ? `${fails} failed` : "all passed"); process.exit(fails ? 1 : 0);
