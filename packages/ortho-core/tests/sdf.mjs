#!/usr/bin/env node
// 字の SDF・棚詰め・書体の基準化（sdf.ts・テキスト GPU 化 T-P1）の検定（Node）
import { sdfFromAlpha, sdfDist, shelfPacker, baseFont, SDF_R, SDF_CUTOFF } from "../src/sdf.ts";
import { pxNumOf } from "../src/textsink.ts";
let fails = 0;
const ok = (cond, label) => { if (cond) return; fails++; console.error(`  ✗ ${label}`); };
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);

// 円（半径 10・アンチエイリアスは画素の被覆率を 4×4 の点で近似）＝距離は解析的に分かる
{
	const W = 48, H = 48, cx = 24, cy = 24, r = 10, a = new Uint8Array(W * H);
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		let c = 0; for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { const dx = x + (i + 0.5) / 4 - cx, dy = y + (j + 0.5) / 4 - cy; if (dx * dx + dy * dy <= r * r) c++; }
		a[y * W + x] = Math.round(c / 16 * 255);
	}
	const s = sdfFromAlpha(a, W, H);
	let worst = 0, n = 0;
	for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
		const want = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r;   // 外が正
		if (want > SDF_R * (1 - SDF_CUTOFF) - 0.5 || want < -SDF_R * SDF_CUTOFF + 0.5) continue;   // 表せる幅の中だけ
		worst = Math.max(worst, Math.abs(sdfDist(s[y * W + x]) - want)); n++;
	}
	ok(n > 300, `円：表せる幅の画素が足りない（${n}）`);
	ok(worst < 0.75, `円：距離の誤差 ${worst.toFixed(3)}px（< 0.75）`);
	ok(s[24 * W + 24] === 255 && s[0] === 0, `円：中心は飽和・隅は 0（${s[24 * W + 24]}, ${s[0]}）`);
	// 縁の位置＝行 y=24 で距離が 0 を跨ぐ所（画素の中心の間を線形に）＝解析の縁（x = 34 − 微小）に 0.25px 以内
	let zx = NaN; for (let x = 30; x < 38; x++) { const d0 = sdfDist(s[24 * W + x]), d1 = sdfDist(s[24 * W + x + 1]); if (d0 <= 0 && d1 > 0) zx = x + 0.5 + d0 / (d0 - d1); }
	const wantX = cx + Math.sqrt(r * r - 0.25);
	ok(Math.abs(zx - wantX) < 0.25, `円：縁の位置 ${zx.toFixed(3)}（解析 ${wantX.toFixed(3)}）`);
}
// 全部空・全部塗り＝端の値
{
	const z = sdfFromAlpha(new Uint8Array(16), 4, 4), f = sdfFromAlpha(new Uint8Array(16).fill(255), 4, 4);
	ok(z.every(v => v === 0), "空＝全部 0");
	ok(f.every(v => v === 255), "塗り＝全部 255");
}
// 棚詰め＝重ならない・尽きたら null・reset(size, y0) で下の段から
{
	const sh = shelfPacker(64), boxes = [];
	for (let i = 0; i < 40; i++) { const w = 5 + (i * 7) % 11, h = 4 + (i * 5) % 9, at = sh.add(w, h); if (!at) break; boxes.push([...at, w, h]); }
	let overlap = false, out = false;
	for (let i = 0; i < boxes.length; i++) {
		const [x, y, w, h] = boxes[i]; if (x < 1 || y < 1 || x + w > 63 || y + h > 63) out = true;
		for (let j = 0; j < i; j++) { const [X, Y, Wj, Hj] = boxes[j]; if (x < X + Wj && X < x + w && y < Y + Hj && Y < y + h) overlap = true; }
	}
	ok(boxes.length > 10 && !overlap && !out, `棚：${boxes.length} 個・重なり ${overlap}・はみ出し ${out}`);
	ok(sh.add(70, 4) === null, "棚：広さより大きい箱は null");
	let full = 0; while (sh.add(8, 8)) full++;
	ok(sh.add(8, 8) === null, "棚：尽きたら null");
	sh.reset(128, 65); eq(sh.add(10, 10), [1, 65], "棚：reset(128, 65)＝旧い領域の下から");
	eq(sh.size, 128, "棚：広さ");
}
// 書体の基準化＝最初の「数 px」だけ 32px に
{
	eq(baseFont("bold 12.5px \"Noto Sans JP\", sans-serif", pxNumOf), ["bold 32px \"Noto Sans JP\", sans-serif", 12.5], "bold 12.5px");
	eq(baseFont("italic 700 16px \"Open 3px Sans\"", pxNumOf), ["italic 700 32px \"Open 3px Sans\"", 16], "family 中の px は触らない");
	eq(baseFont("sans-serif", pxNumOf), ["32px sans-serif", 16], "大きさが無い＝16px とみなす");
}
if (fails) { console.error(`✗ sdf: ${fails} 件失敗`); process.exit(1); }
console.log("✓ sdf: SDF・棚詰め・書体の基準化 OK");
