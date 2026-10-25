// 外来の DEM の生き替え（setDem）の世代の門（2026-10-25）：差し替える前に出したセルの取得が、差し替えた後に遅れて届いても
// ①新しい窓（同じ視点＝同じ窓の形）に書かれない ②標高のキャッシュ（sampleElev が引く）に入らない。
// 旧＝窓の鍵が視点だけで決まり、外す前と同じ窓は同じ鍵＝古い取得の .then が「今の窓」として書き、キャッシュも古い中身で上書きしていた
// （setTerrain(null) → setTerrain(DEM) を素早く行うと、DEM の山が平らなまま残る）。
// node tests/terrain-demgen.mjs
globalThis.self ??= globalThis;
const { createTerrain } = await import("../src/terrain.ts");
let fails = 0; const ok = (c, m) => { if (!c) { console.error("✗", m); fails++; } else console.log("✓", m); };
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
console.log(fails ? `FAIL ${fails}` : "PASS");
process.exit(fails ? 1 : 0);
