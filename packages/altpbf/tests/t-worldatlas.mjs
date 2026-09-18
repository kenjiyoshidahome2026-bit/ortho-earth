// t-worldatlas: 全球アトラス（R90 8 枚 → 1 枚）の焼きと切り出しの検定。
// 守るもの＝「消費側が受け取る Float32 セルは、従来の downsampleFlipped(tile, N) と同じ物（Int16 丸め ±0.5m 以内）」。
// これが崩れると equal のハイプソと japan の R90 窓が、焼き前後で違う絵になる。
// あわせて encode/decode の往復（altpbf 形式に乗る・range=360 の規約外オブジェクト）と、標本関数の texel 中心規約を固定する。
import { bakeWorldAtlas, worldAtlasCell, sampleWorldAtlas, resampleTile, WORLD_ATLAS } from "../src/worldatlas.js";
import { encode, decode } from "../src/format.js";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };

// ortho-core elevation.js downsampleFlipped の写し（規約の正本＝ここと一致することを検定する）
function downsampleFlipped(tile, N) {
	const { data, width: w, height: h } = tile;
	const out = new Float32Array(N * N);
	const H = (x, y) => { const v = data[(h - 1 - y) * w + x]; return (v < -420 || v > 9000) ? 0 : v; };
	const M = 2;
	for (let j = 0; j < N; j++) {
		const gy = Math.min(Math.max((j + 0.5) / N * (h - 1), M), h - 1 - M), y0 = Math.min(gy | 0, h - 2), fy = gy - y0;
		for (let i = 0; i < N; i++) {
			const gx = Math.min(Math.max((i + 0.5) / N * (w - 1), M), w - 1 - M), x0 = Math.min(gx | 0, w - 2), fx = gx - x0;
			const a = H(x0, y0), b = H(x0 + 1, y0), c = H(x0, y0 + 1), d = H(x0 + 1, y0 + 1);
			const v = (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
			out[j * N + i] = v < 0 ? 0 : v;
		}
	}
	return out;
}

// 合成 R90 8 枚（270²・実物の 1/10 寸）：セル毎に違う地形＝経度の坂＋緯度の波＋海（負値）＋縁の fill（異常値）
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function synth(lng, lat) {
	const w = 270, h = 270, data = new Int16Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {   // 格納は北上げ（y=0 が北）
		let v = 1500 * Math.sin(x / 23 + lng / 30) * Math.cos(y / 31 + lat / 45) + (x - y) * 3 + 200 * rnd();
		if ((x + y + lng) % 7 === 0) v = -3000 - 500 * rnd();   // 海底
		if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) v = -9999;   // ALOS 型の縁 fill＝読まれてはいけない
		data[y * w + x] = Math.round(v);
	}
	return { name: `R90${lat < 0 ? "S" : "N"}${String(Math.abs(lat)).padStart(3, "0")}${lng < 0 ? "W" : "E"}${String(Math.abs(lng)).padStart(3, "0")}`, source: "SYNTH", lng, lat, range: 90, width: w, height: h, data };
}
const tiles = [];
for (const lat of [-90, 0]) for (const lng of [-180, -90, 0, 90]) tiles.push(synth(lng, lat));

const N = 64;
const atlas = bakeWorldAtlas(tiles, N);
ok(atlas.width === 4 * N && atlas.height === 2 * N && atlas.lng === -180 && atlas.lat === -90 && atlas.range === 360 && atlas.name === WORLD_ATLAS, `bake: ${atlas.width}×${atlas.height} @${atlas.lng},${atlas.lat} r${atlas.range} name=${atlas.name}`);

// 1) 切り出し（k=1）＝ downsampleFlipped と ±0.5 以内（Int16 丸めのみ）・全 8 セル・全 texel
let maxErr = 0, n = 0;
for (const t of tiles) {
	const cx = (t.lng + 180) / 90, cy = (t.lat + 90) / 90;
	const want = downsampleFlipped(t, N), got = worldAtlasCell(atlas, cx, cy, N);
	for (let i = 0; i < want.length; i++) { const e = Math.abs(want[i] - got[i]); if (e > maxErr) maxErr = e; n++; }
}
ok(maxErr <= 0.5, `cell k=1: max |atlas − downsampleFlipped| = ${maxErr} over ${n} texels (≤0.5)`);

// 2) 縁 fill（-9999）が漏れていない＝異常値は 0 扱い・実データは 2px 内側から
ok(!Array.from(atlas.data).some(v => v < -9000), "edge fill never leaks into the atlas");

// 3) 向き：北半球のセル（lat=0）は行 0 側、南半球は行 N 側。セル内も北上げ。
{
	const t = tiles.find(t => t.lng === 0 && t.lat === 0), want = downsampleFlipped(t, N);
	// want は row0=南。アトラス北上げの (row 0, col 2N) は want の最北行(N-1)
	ok(Math.abs(atlas.data[0 * (4 * N) + 2 * N] - want[(N - 1) * N + 0]) <= 0.5, "north-up: atlas row 0 of cell (0,0) is the northmost row of downsampleFlipped");
	ok(Math.abs(atlas.data[(N - 1) * (4 * N) + 2 * N] - want[0]) <= 0.5, "north-up: atlas row N-1 of cell (0,0) is the southmost row");
}

// 4) k=2（512 相当）＝箱平均。各 texel は 2×2 の平均（負値は 0 に寄せ）
{
	const cx = 1, cy = 1, M = N / 2, got = worldAtlasCell(atlas, cx, cy, M);
	let bad = 0;
	for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
		const rowS = (1 - cy) * N + (N - 1 - j * 2), col = cx * N + i * 2, AW = 4 * N;
		const s = (atlas.data[rowS * AW + col] + atlas.data[rowS * AW + col + 1] + atlas.data[(rowS - 1) * AW + col] + atlas.data[(rowS - 1) * AW + col + 1]) / 4;
		if (Math.abs(got[j * M + i] - Math.max(0, s)) > 1e-4) bad++;
	}
	ok(bad === 0, `cell k=2: 2×2 box average (bad=${bad})`);
}

// 5) 直書き（out/W/ox/oy）＝ equal の 4096×2048 型
{
	const W = 4 * N, H = 2 * N, out = new Float32Array(W * H);
	for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 4; cx++) worldAtlasCell(atlas, cx, cy, N, out, W, cx * N, cy * N);
	let bad = 0;
	for (const t of tiles) {
		const cx = (t.lng + 180) / 90, cy = (t.lat + 90) / 90, want = downsampleFlipped(t, N);
		for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (Math.abs(out[(cy * N + j) * W + cx * N + i] - want[j * N + i]) > 0.5) bad++;
	}
	ok(bad === 0, `blit into a 4×2 Float32 atlas (row0=south) matches per-cell downsampleFlipped (bad=${bad})`);
}

// 6) 標本：texel 中心で厳密一致（負値は 0）・端でクランプ
{
	const W = 4 * N, H = 2 * N;
	const i = 100, j = 30, lon = (i + 0.5) / W * 360 - 180, lat = 90 - (j + 0.5) / H * 180;
	const raw = atlas.data[j * W + i];
	ok(Math.abs(sampleWorldAtlas(atlas, lon, lat) - Math.max(0, raw)) < 1e-6, `sample at texel center = raw (${raw})`);
	ok(Number.isFinite(sampleWorldAtlas(atlas, -180, 90)) && Number.isFinite(sampleWorldAtlas(atlas, 180, -90)), "sample clamps at the corners");
}

// 7) encode/decode 往復（altpbf 形式に乗る）
{
	const blob = new Blob([await encode(atlas)]);
	const back = await decode(blob);
	let same = back.width === atlas.width && back.height === atlas.height && back.range === 360 && back.lng === -180 && back.lat === -90 && back.name === WORLD_ATLAS;
	for (let i = 0; same && i < atlas.data.length; i++) if (back.data[i] !== atlas.data[i]) same = false;
	ok(same, `encode/decode round-trip byte-exact (${blob.size} bytes for ${atlas.data.byteLength} raw)`);
}

// 8) 入力の検札：欠け・R90 でない
{
	let threw = false; try { bakeWorldAtlas(tiles.slice(0, 7), N); } catch { threw = true; }
	ok(threw, "7/8 cells throws");
	threw = false; try { bakeWorldAtlas([...tiles.slice(0, 7), { ...tiles[7], range: 10 }], N); } catch { threw = true; }
	ok(threw, "non-R90 tile throws");
	threw = false; try { worldAtlasCell(atlas, 0, 0, 48); } catch { threw = true; }
	ok(threw, "N that does not divide the cell throws");
	ok(typeof resampleTile === "function", "resampleTile exported");
}

console.log(fails ? `\n${fails} failure(s)` : "\nall passed");
process.exit(fails ? 1 : 0);
