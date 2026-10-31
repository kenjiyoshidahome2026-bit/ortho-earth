// 外来の DEM の生き替え（setDem）の世代の門（2026-10-25）：差し替える前に出したセルの取得が、差し替えた後に遅れて届いても
// ①新しい窓（同じ視点＝同じ窓の形）に書かれない ②標高のキャッシュ（sampleElev が引く）に入らない。
// 旧＝窓の鍵が視点だけで決まり、外す前と同じ窓は同じ鍵＝古い取得の .then が「今の窓」として書き、キャッシュも古い中身で上書きしていた
// （setTerrain(null) → setTerrain(DEM) を素早く行うと、DEM の山が平らなまま残る）。
// node tests/terrain-demgen.mjs
globalThis.self ??= globalThis;
const { createTerrain } = await import("../src/terrain.ts");
let fails = 0; const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
const J = v => JSON.stringify(v);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const N = 64;
const tileOf = (lng, lat, range, v) => ({ lng, lat, range, width: N, height: N, data: new Float32Array(N * N).fill(v), source: "test" });
// 読み手：呼ばれた順に保留し、検定から値を決めて解く
const pend = [];
const loader = Object.assign((lng, lat, range) => new Promise(res => pend.push({ lng, lat, range, res })), { byName: () => Promise.resolve(null) });
const writes = [];   // renderer に書かれたセル（slot・値）
const renderer = { set(slot, data) { if (/^elevCell/.test(slot)) writes.push({ slot, v: data instanceof Float32Array ? data[0] : data?.tile?.data?.[0] }); } };
const T = createTerrain({ renderer, requestDraw() {}, exag: 1, earthM: 6371000, tileLoader: loader, noMixed: true, noFar: true });
const cam = { center: [150.5, 30.5], zoom: 7.5, pitch: 0, bearing: 0, dpr: 1, fovy: 0.6435 };
const size = { w: 960, h: 600 };
ok(T.ensure(cam, size) !== false, "ensure が窓を作る");
await sleep(0);
const first = pend.splice(0);
const r10 = first.filter(p => p.range === 10);
ok(r10.length > 0, `R10 のセルを取りに行く（${r10.length} 枚）`);
// DEM を差し替える（ここでは外す＝null。中身は問わない：世代が進むことを見る）→ 同じ視点で窓を作り直す
T.setDem(null);
T.ensure(cam, size);
await sleep(0);
const second = pend.splice(0).filter(p => p.range === 10);
ok(second.length === r10.length, `差し替え後も同じ枚数を取り直す（${second.length}）`);
const k1 = T.debug().atlasKey;
// 新しい取得（値 2000）が先に届き、古い取得（値 -1）が後から届く
for (const p of second) p.res(tileOf(p.lng, p.lat, 10, 2000));
await sleep(10);
const nNew = writes.filter(w => w.v === 2000).length;
for (const p of r10) p.res(tileOf(p.lng, p.lat, 10, -1));
await sleep(10);
ok(nNew === second.length, `新しい取得は書かれる（${nNew}）`);
ok(!writes.some(w => w.v === -1), `古い取得は新しい窓に書かれない（${writes.filter(w => w.v === -1).length} 件）`);
ok(T.debug().atlasKey === k1, "窓の鍵は変わらない");
const e = T.sampleElev(150.5, 30.5);
ok(e === 2000, `標高のキャッシュは新しい中身（${e}）`);

// 外来の DEM が全画素そろうセルは既定のタイルを待たない（2026-10-29）：バケット未収録の R01（フランス）は JAXA の 5° zip の取り寄せで
// 1 分前後かかり、その間 CWT の標高も書かれず地面が 0 m だった
{
	const { encodeQuantizedMesh } = await import("../src/qmesh.ts");
	const G = 5, verts = [], tris = [];
	for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) verts.push([Math.round(i / (G - 1) * 32767), Math.round(j / (G - 1) * 32767), 777]);
	const order = [], seen = new Map(), mapI = i => { if (!seen.has(i)) { seen.set(i, order.length); order.push(i); } return seen.get(i); };   // 高水位の順（qmesh.mjs の makeTile と同じ）
	for (let j = 0; j < G - 1; j++) for (let i = 0; i < G - 1; i++) { const a = j * G + i; tris.push([a, a + 1, a + G].map(mapI), [a + 1, a + G + 1, a + G].map(mapI)); }
	const ab = encodeQuantizedMesh({ verts: order.map(i => verts[i]), tris, minH: 777, maxH: 777 });
	globalThis.fetch = async (u) => String(u).endsWith("layer.json")
		? { ok: true, json: async () => ({ format: "quantized-mesh-1.0", tiles: ["{z}/{x}/{y}.terrain"], maxzoom: 14 }) }
		: { ok: true, arrayBuffer: async () => ab.slice(0) };
	const asked = [], w2 = [];
	const slow = Object.assign((lng, lat, range) => { asked.push(range); return new Promise(() => {}); }, { byName: () => Promise.resolve(null) });   // 既定のタイルは届かない
	const T2 = createTerrain({ renderer: { set(slot, data) { if (/^elevCell/.test(slot)) w2.push(data instanceof Float32Array ? data[0] : data?.tile?.data?.[0]); } }, requestDraw() {}, exag: 1, earthM: 6371000, tileLoader: slow, noMixed: true, noFar: true, noNear: true });
	T2.setDem({ type: "quantized-mesh", url: "https://d.test/layer.json", heights: "orthometric" });
	T2.ensure(cam, size);
	for (let i = 0; i < 50 && !w2.length; i++) await sleep(20);
	ok(w2.length > 0 && w2.every(v => Math.abs(v - 777) < 1), `外来の DEM の標高が書かれる（${w2.length} 枚・${w2[0]}）`);
	ok(!asked.includes(10), `全画素そろう R10 のセルは既定のタイルを取りに行かない（取った段 ${[...new Set(asked)].join(",") || "無し"}）`);
}

// 負の標高をそのまま描く DEM（Cesium World Terrain の楕円体高 negative / 海底 seafloor）＝アトラスの記述子に negative を立てる（2026-10-31）：
// 描画側はこれで地形面の低地フェード（海抜 1m 未満は透かして 0m の球に任せる）を止める。旧＝サンフランシスコ湾岸（海面 −30m）の地面が丸ごと透け、
// 0m の球に同じ画像が出て 30m 浮いていた（photogrammetry-classification）
{
	const descs = [], never = Object.assign(() => new Promise(() => {}), { byName: () => Promise.resolve(null) });   // 既定のタイルは届かない（記述子だけ見る）
	const T3 = createTerrain({ renderer: { set(slot, data) { if (slot === "elevAtlas" || slot === "elevAtlasStage") descs.push({ slot, negative: !!data.negative }); } }, requestDraw() {}, exag: 1, earthM: 6371000, tileLoader: never, noMixed: true, noFar: true });
	T3.ensure(cam, size); await sleep(0);
	ok(descs.length === 1 && descs[0].negative === false, `既定の DEM＝negative 無し（${J(descs)}）`);
	T3.setDem({ type: "quantized-mesh", url: "https://d.test/layer.json", heights: "orthometric", negative: true });
	T3.ensure(cam, size); await sleep(0);
	ok(descs.length === 2 && descs[1].negative === true, `negative:true の DEM＝記述子に negative（${J(descs)}）`);
	T3.setDem({ type: "quantized-mesh", url: "https://d.test/layer.json", heights: "orthometric", seafloor: true });
	T3.ensure(cam, size); await sleep(0);
	ok(descs.length === 3 && descs[2].negative === true, `seafloor:true の DEM も negative（${J(descs)}）`);
	T3.setDem(null);
	T3.ensure(cam, size); await sleep(0);
	ok(descs.length === 4 && descs[3].negative === false, `外した後は negative 無し（${J(descs)}）`);
	// 両バックエンドの地形面シェーダが記述子の negative で低地フェードを止める（GL＝u_terrNeg・WebGPU＝elevP.w）
	const { TERRAIN_FS } = await import("../src/gl/glsl.ts"), W = await import("../src/gpu/wgsl.ts");
	ok(/float t = u_terrNeg > 0\.5 \? 1\.0 : smoothstep/.test(TERRAIN_FS), "GL TERRAIN_FS：u_terrNeg で低地フェードを止める");
	const wsrc = Object.values(W).filter(v => typeof v === "string").join("\n");
	ok(/let t = select\(smoothstep\(1\.0, clamp\(2\.0 \* mpp, 2\.0, 100\.0\), in\.h\), 1\.0, F\.elevP\.w > 0\.5\)/.test(wsrc), "WGSL：elevP.w で低地フェードを止める");
}
console.log(fails ? `FAIL ${fails}` : "PASS");
process.exit(fails ? 1 : 0);
