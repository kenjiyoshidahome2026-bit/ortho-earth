// t-healpix-bake: 標高の HEALPix タイルの焼き（src/elevation/healpixbake.ts）の検定。
// 守るもの＝「大元（R90／R10 の経緯度タイル）の値が、正しい場所・正しい向きで HEALPix タイルに載る」。
// 滑らかな解析的な地形を合成の大元（8 枚・1°/画素）に置き、焼いたタイルの各画素をその画素の中心での真値と比べる
// ＝番地・画素の向き・北上げの格納・180° 線の巻き・極のクランプ・面の境のどれが崩れても落ちる。
import { hpxTilePoints, cellsForPoints, sampleCells, bakeHpxTile, hpxParentTile, hpxElevName, parseHpxElevName } from "../src/elevation/healpixbake.ts";
import { hpxCount, cellOf, hpxPixelLonLat, hpxNeighbors, lonLatToNest } from "../src/healpix.ts";
import { encode, decode } from "altpbf";

let fails = 0;
const ok = (cond, msg) => { if (!cond) { console.error("✗", msg); fails++; } else console.log("✓", msg); };
const R = Math.PI / 180;
// 経度に周期的・極で経度に依らない地形（m）。海底の負値も持つ
const f = (lon, lat) => 3000 * Math.cos(lat * R) * Math.sin(2 * lon * R) + 2000 * Math.sin(3 * lat * R) + 1500 * Math.cos(lat * R) ** 2 * Math.cos(5 * lon * R) - 500;

// 合成の大元＝R90 の形（90° セル・w 画素・北上げ・画素中心）
const RANGE = 90, w = 180;
const tiles = new Map();
for (let cy = 0; cy < 2; cy++) for (let cx = 0; cx < 4; cx++) {
	const data = new Int16Array(w * w);
	for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) data[(w - 1 - y) * w + x] = Math.round(f(cx * 90 - 180 + (x + 0.5) * 90 / w, cy * 90 - 90 + (y + 0.5) * 90 / w));
	tiles.set(cx + "," + cy, { data, width: w, height: w });
}
const get = (cx, cy) => tiles.get(cx + "," + cy) ?? null;

// 1. 全球の order 1（48 枚・幅 16）を焼いて真値と比べる
const ORDER = 1, W = 16, baked = [];
{
	let worst = 0, sum = 0, n = 0;
	for (let p = 0; p < hpxCount(ORDER); p++) {
		const t = bakeHpxTile(get, RANGE, w, ORDER, p, W); baked.push(t);
		const c = cellOf(ORDER, p);
		for (let row = 0; row < W; row++) for (let col = 0; col < W; col++) {
			const ll = hpxPixelLonLat(ORDER, c, W, col, row), e = Math.abs(t[row * W + col] - f(ll[0], ll[1]));
			worst = Math.max(worst, e); sum += e; n++;
		}
	}
	// 大元は 0.5°/画素＝バイリニアの誤差は数 m（振幅 3000 m の地形で）。向きや番地が違えば数百〜数千 m
	ok(worst < 12 && sum / n < 2, `全球 48 枚の全画素が真値と合う（最大 ${worst.toFixed(1)} m・平均 ${(sum / n).toFixed(2)} m）`);
}

// 2. タイルの境（面の境・180° 線・極を含む）で値が繋がる＝隣のタイルの縁の画素との差が、タイルの中の隣の画素との差と同じ程度
{
	let inner = 0, seam = 0;
	for (let p = 0; p < baked.length; p++) for (let r = 0; r < W; r++) for (let q = 0; q + 1 < W; q++) inner = Math.max(inner, Math.abs(baked[p][r * W + q] - baked[p][r * W + q + 1]));
	for (let p = 0; p < baked.length; p++) {
		const c = cellOf(ORDER, p);
		for (let r = 0; r < W; r++) {   // 東の縁（col＝W−1）の少し外の点が落ちる隣のタイルの画素
			const ll = hpxPixelLonLat(ORDER, c, W, W - 1, r), deep = lonLatToNest(ll[0], ll[1], ORDER + 4);
			for (const nb of hpxNeighbors(ORDER + 4, deep)) {
				if (nb < 0) continue;
				const tp = Math.floor(nb / 256), cc = cellOf(ORDER + 4, nb), tc = cellOf(ORDER, tp);
				if (tp === p) continue;
				seam = Math.max(seam, Math.abs(baked[p][r * W + W - 1] - baked[tp][(cc.iy - tc.iy * W) * W + (cc.ix - tc.ix * W)]));
			}
		}
	}
	ok(seam <= inner * 1.5, `タイルの境で値が繋がる（境をまたぐ隣の画素との最大差 ${seam} m・タイルの中 ${inner} m）`);
}

// 3. 先に読むセルの見積り（cellsForPoints）が、標本化が実際に触るセルを全部含む
{
	let bad = 0, total = 0;
	for (const p of [0, 5, 17, 23, 30, 44, 47]) {
		const pts = hpxTilePoints(ORDER, p, W, 2), need = cellsForPoints(pts, RANGE, w), touched = new Set();
		sampleCells(pts, (cx, cy) => { touched.add(cx + "," + cy); return get(cx, cy); }, RANGE, w);
		for (const k of touched) { total++; if (!need.has(k)) bad++; }
	}
	ok(bad === 0 && total > 7, `cellsForPoints：標本化が触るセル（延べ ${total}）を全部挙げる`);
}

// 4. 親＝子 4 枚の 2×2 平均。order 0 を直に焼いた物（副標本 2）と近い
{
	const parent = hpxParentTile([baked[4 * 6], baked[4 * 6 + 1], baked[4 * 6 + 2], baked[4 * 6 + 3]], W);
	const ch1 = baked[4 * 6 + 1];
	ok(parent[W / 2] === Math.round((ch1[0] + ch1[1] + ch1[W] + ch1[W + 1]) / 4), "hpxParentTile：子 1 の左上 2×2 の平均が親の (列 W/2, 行 0)");
	const direct = bakeHpxTile(get, RANGE, w, 0, 6, W, 4);
	let worst = 0; for (let i = 0; i < W * W; i++) worst = Math.max(worst, Math.abs(parent[i] - direct[i]));
	ok(worst < 40, `親（2×2 平均）≒ order 0 を副標本で直に焼いた物（最大差 ${worst} m）`);
	let threw = false; try { hpxParentTile([baked[0], baked[1], baked[2]], W); } catch { threw = true; }
	ok(threw, "hpxParentTile：子が 4 枚でなければ投げる");
}

// 5. 無いセルは 0・寸法の違うセルは投げる
{
	const t = bakeHpxTile(() => null, RANGE, w, 0, 0, 4);
	ok(t.every(v => v === 0), "大元に無いセル＝0 m");
	let threw = false; try { bakeHpxTile(() => ({ data: new Int16Array(4), width: 2, height: 2 }), RANGE, w, 0, 0, 4); } catch { threw = true; }
	ok(threw, "幅の違うセルが混じれば投げる");
}

// 6. altpbf に載る（名前 H{order}P{npix}・range 0）
{
	const name = hpxElevName(1, 25), bin = await encode({ name, source: "HEALPix 16px from SYNTH", lng: 0, lat: 0, range: 0, width: W, height: W, data: baked[25] });
	const back = await decode(new Blob([bin])), nm = parseHpxElevName(back.name);
	ok(name === "H01P25" && nm.order === 1 && nm.npix === 25 && back.width === W && back.data.every((v, i) => v === baked[25][i]), "encode → decode で名前と値が戻る");
	ok(parseHpxElevName("R01N035E139") === null, "経緯度タイルの名前は HEALPix の名前でない");
}

if (fails) { console.error(`\n${fails} failed`); process.exit(1); }
console.log("\nall passed");
