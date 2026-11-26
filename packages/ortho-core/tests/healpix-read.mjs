// t-healpix-read: 標高の HEALPix タイルを読む側（src/elevation/healpixread.ts）の検定。
// 守るもの＝「HEALPix タイルの値が、経緯度の窓の正しい場所へ戻る」＝焼き（healpix-bake）の逆向き。
// 解析的な地形を全球のタイル（order 2・幅 32）に画素中心で置き、色々な窓（面の境・180° 線・両極をまたぐ物）を埋めて真値と比べる。
import { hpxSampleWindow, hpxTilesForWindow, hpxOrderFor, HPX_FACE_DEG } from "../src/elevation/healpixread.ts";
import { hpxCount, cellOf, hpxPixelLonLat } from "../src/healpix.ts";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const R = Math.PI / 180;
const f = (lon, lat) => 3000 * Math.cos(lat * R) * Math.sin(2 * lon * R) + 2000 * Math.sin(3 * lat * R) + 1500 * Math.cos(lat * R) ** 2 * Math.cos(5 * lon * R) - 500;

const ORDER = 2, W = 32, tiles = [];
for (let p = 0; p < hpxCount(ORDER); p++) {
	const t = new Float64Array(W * W), c = cellOf(ORDER, p);
	for (let row = 0; row < W; row++) for (let col = 0; col < W; col++) { const ll = hpxPixelLonLat(ORDER, c, W, col, row); t[row * W + col] = f(ll[0], ll[1]); }
	tiles.push(t);
}
const used = new Set(), get = p => { used.add(p); return tiles[p]; };

// 1. 窓ごとに真値と比べる（タイルの 1 画素＝0.46°＝バイリニアの誤差は数 m。向き・番地・面の継ぎが違えば数百 m 以上）
const wins = [
	["全球", -180, -90, 360, 180, 360, 180],
	["日本域", 122, 24, 26, 22, 130, 110],
	["180° 線をまたぐ", 170, -20, 20, 40, 80, 160],
	["北極の蓋", -180, 80, 360, 10, 360, 20],
	["南極の蓋", -180, -90, 360, 10, 360, 20],
	["3 面の角（経度 0・緯度 41.8）", -6, 36, 12, 12, 96, 96],
	["4 面の角（経度 45・緯度 0）", 39, -6, 12, 12, 96, 96],
];
for (const [name, lng0, lat0, sx, sy, NX, NY] of wins) {
	used.clear();
	const out = hpxSampleWindow(get, ORDER, W, lng0, lat0, sx, sy, NX, NY, true);
	let worst = 0, sum = 0;
	for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) { const e = Math.abs(out[j * NX + i] - f(lng0 + sx * (i + 0.5) / NX, lat0 + sy * (j + 0.5) / NY)); worst = Math.max(worst, e); sum += e; }
	ok(worst < 25 && sum / (NX * NY) < 4, `${name}：真値と合う（最大 ${worst.toFixed(1)} m・平均 ${(sum / (NX * NY)).toFixed(2)} m）`);
	const need = hpxTilesForWindow(lng0, lat0, sx, sy, NX, NY, ORDER, W);
	ok(need.size === used.size && [...used].every(p => need.has(p)), `${name}：要るタイルの一覧が、実際に引いたタイルと同じ（${need.size} 枚）`);
}
ok(hpxTilesForWindow(-180, -90, 360, 180, 360, 180, ORDER, W).size === hpxCount(ORDER), "全球の窓は全部のタイルを要る");
ok(hpxTilesForWindow(135, 35, 1, 1, 64, 64, ORDER, W).size <= 4, "小さい窓は高々 4 枚");

// 2. 海の扱い・無いタイル
{
	const sea = hpxSampleWindow(get, ORDER, W, -180, -90, 360, 180, 90, 45, true), land = hpxSampleWindow(get, ORDER, W, -180, -90, 360, 180, 90, 45, false);
	ok(sea.some(v => v < 0) && land.every(v => v >= 0) && land.every((v, i) => v === Math.max(0, sea[i])), "sea＝負値を通す・偽＝0 へ寄せる");
	ok(hpxSampleWindow(() => null, ORDER, W, 0, 0, 10, 10, 8, 8, true).every(v => v === 0), "無いタイルは 0");
}

// 3. order の選び方（幅 512）：1 画素＝58.6°/(512·2^k)
{
	const px = k => HPX_FACE_DEG / (512 * 2 ** k);
	ok(Math.abs(HPX_FACE_DEG - 58.6323) < 1e-3, "面の一辺＝58.63°");
	ok(hpxOrderFor(90 / 1024, 512, 0, 5) === 1 && hpxOrderFor(90 / 512, 512, 0, 5) === 0, "R90 の窓（1024／512 texel）→ Norder 1／0");
	ok(hpxOrderFor(10 / 2400, 512, 0, 5) === 5 && hpxOrderFor(10 / 512, 512, 0, 5) === 3, "R10 の窓（2400／512 texel）→ Norder 5／3");
	ok(hpxOrderFor(px(4), 512, 0, 5) === 4 && hpxOrderFor(1e-6, 512, 0, 5) === 5 && hpxOrderFor(10, 512, 0, 5) === 0, "ちょうどの密度はその order・範囲の外は端に収める");
}
console.log(fails ? `${fails} failed` : "all passed"); process.exit(fails ? 1 : 0);
