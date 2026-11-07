// 点群 → Gaussian splat（@ortho-earth/splat の cloud・2026-11-06）の純関数＝計画（セルの大きさ・段の数）・ハッシュ（WGSL と同じ式）・CPU の参照実装（node の検定と CLI・ブラウザは WebGPU の cloud-gpu.ts）・
//   色（RGB／標高／強度／分類 → RGBA）・段の選び（画面の画素／m → どの段を描くか）・書き出し（共分散 → 尺と向き・SplatData・.spz・3D Tiles の tileset）。
// 変換の考え方（WebGPU と CPU で同じ）：
//   ① 点を格子（セル＝cell0・level L は cell0×2^L）にハッシュで振り分ける（数え上げの並べ替え＝starts[key]〜starts[key+1] がそのセルの点）
//   ② level 0＝セルごとに点をまとめて 1 つの splat：中心＝平均・共分散＝近傍（半径 r＝2×cell0・27 セル・最大 maxNb 個）の散らばりの平均＋セル内の中心のばらつき・色＝平均
//   ③ level L＝level L−1 の splat をセル 2 倍でまとめる：中心＝重み（点の数）つき平均・共分散＝Σw(C_i＋d_i d_iᵀ)/W（子の形＋子の中心のばらつき）・色＝重みつき平均
//   ④ 仕上げ＝対角に (fill×cell)² を足す（薄い面に厚みを与え・穴を埋める）・trace が (cap×cell)² を超えたら縮める（外れ値の巨大な楕円を抑える）
//   描く時は画面上の 1 splat の大きさ（cell×画素／m）が pxPerSplat 以上になる一番細かい段だけ描く（levelFor）。
// 層の形（描き手と同じ）＝ctr: vec4（x,y,z, w＝色の bit（u32 を f32 に bitcast）・描き手は xyz だけ読む）・cov: vec4×2（xx xy xz yy | yz zz 重み 0）・col: u32（RGBA）。
import type { SplatData } from "./formats.ts";

/** map.addData(pointcloudUrl, { kind: "splat", cloud: {…} }) の cloud の opts */
export interface CloudParams {
	/** level 0 のセル＝点の間隔 × detail（既定 1＝点の間隔・2＝2 倍に粗く＝splat は約 1/4） */ detail?: number;
	/** 段の数（既定＝自動＝最も粗い段のセルが範囲の 1/16 になるまで・1〜8） */ levels?: number;
	/** 厚み＝対角に足す (fill × cell)²（既定 0.35） */ fill?: number;
	/** 楕円の上限＝trace が (cap × cell)² を超えたら縮める（既定 4） */ cap?: number;
	/** 近傍の最大個数（既定 32） */ maxNb?: number;
	/** 近傍の半径＝cell0 × radius（既定 2） */ radius?: number;
	/** 描く段の選び＝1 splat が画面で何 px 以上なら細かい段へ（既定 1.5） */ pxPerSplat?: number;
}
/** 計画＝点の数と範囲から決めた数（WebGPU・CPU 共通） */
export interface CloudPlan { spacing: number; cell0: number; levels: number; r: number; hashBits: number; fill: number; cap: number; maxNb: number; pxPerSplat: number }
/** 1 段の中身（描き手の層の形） */
export interface CloudLevel { n: number; cell: number; ctr: Float32Array; cov: Float32Array; col: Uint32Array; bb: number[]; radius: number }
export const CLOUD_DEFAULTS = Object.freeze({ detail: 1, fill: 0.35, cap: 4, maxNb: 32, radius: 2, pxPerSplat: 1.5 });
export const CLOUD_FORMATS: readonly string[] = Object.freeze(["las", "laz", "zip"]);
/** 点群の URL／ファイル名か（.las／.laz（COPC も）／.zip の中の LAS） */
export const cloudFormatOf = (u: unknown): "las" | "laz" | "zip" | null => { const m = String(u).match(/\.(las|laz|zip)(\?|#|$)/i); return m ? m[1].toLowerCase() as "las" | "laz" | "zip" : null; };

/** 点の数と範囲（東北上の min xyz・max xyz）から計画を立てる */
export function cloudPlan(n: number, bb: ArrayLike<number>, p: CloudParams = {}): CloudPlan {
	const dx = Math.max(bb[3] - bb[0], 1e-3), dy = Math.max(bb[4] - bb[1], 1e-3), dz = Math.max(bb[5] - bb[2], 0);
	const area = dx * dy, N = Math.max(1, n);
	// 点の間隔＝点は面（地表・壁）に散っている物として √(一番広い面の面積/点数)（航空レーザ＝地表の 1 層・MMS＝路面と壁。体積で量ると建物の高さの分だけ粗くなりすぎる）
	let spacing = Math.sqrt(Math.max(area, dx * dz, dy * dz) / N);
	if (!(spacing > 0) || !Number.isFinite(spacing)) spacing = 1;
	const detail = p.detail ?? CLOUD_DEFAULTS.detail;
	if (!(detail > 0)) throw new RangeError("splat: cloud.detail must be > 0");
	const cell0 = spacing * detail, ext = Math.max(dx, dy, dz);
	let levels = p.levels ?? Math.ceil(Math.log2(Math.max(1, ext / (16 * cell0)))) + 1;
	levels = Math.max(1, Math.min(8, Math.round(levels)));
	const fill = p.fill ?? CLOUD_DEFAULTS.fill, cap = p.cap ?? CLOUD_DEFAULTS.cap, maxNb = Math.max(1, Math.min(64, Math.round(p.maxNb ?? CLOUD_DEFAULTS.maxNb)));
	for (const [k, v] of [["fill", fill], ["cap", cap], ["pxPerSplat", p.pxPerSplat ?? CLOUD_DEFAULTS.pxPerSplat], ["radius", p.radius ?? CLOUD_DEFAULTS.radius]] as const) if (!(v >= 0) || !Number.isFinite(v)) throw new RangeError(`splat: cloud.${k} must be a finite number ≥ 0`);
	let hashBits = 10; while ((1 << hashBits) < 2 * N && hashBits < 23) hashBits++;   // 桶の数 ≥ 2n（衝突は検める＝セルの座標も見るので結果は変わらない・速さだけ）
	return { spacing, cell0, levels, r: cell0 * (p.radius ?? CLOUD_DEFAULTS.radius), hashBits, fill, cap, maxNb, pxPerSplat: p.pxPerSplat ?? CLOUD_DEFAULTS.pxPerSplat };
}
/** セルの座標（floor(p / cell)）のハッシュ＝WGSL（cloud-gpu.ts）と同じ式（Math.imul＝32 bit の掛け算） */
export const cellHash = (cx: number, cy: number, cz: number, mask: number): number => ((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663) ^ Math.imul(cz, 83492791)) >>> 0) & mask;
/** 描く段＝1 splat（level L のセル）が画面で pxPerSplat px 以上になる一番細かい段（ppm＝錨の所の画素／m・0＝一番粗い段） */
export function levelFor(ppm: number, cells: ArrayLike<number>, pxPerSplat: number): number {
	const L = cells.length; if (L <= 1) return 0;
	if (!(ppm > 0)) return L - 1;
	const want = pxPerSplat / ppm;   // 1 splat に要る m
	for (let i = 0; i < L; i++) if (cells[i] >= want) return i;
	return L - 1;
}
/** 錨の所の画素／m（mvp＝錨の東北上 m → clip・画面 w×h px）＝splat-gpu.ts の pixelsPerMeter と同じ式（ここは依存ゼロの写し） */
export function pixelsPerMeterOf(mvp: ArrayLike<number>, w: number, h: number): number {
	const cw = mvp[15]; if (!(cw > 1e-9)) return 0;
	const nx = mvp[12] / cw, ny = mvp[13] / cw; let best = 0;
	for (let j = 0; j < 3; j++) { const dx = (mvp[j * 4] - nx * mvp[j * 4 + 3]) / cw * 0.5 * w, dy = (mvp[j * 4 + 1] - ny * mvp[j * 4 + 3]) / cw * 0.5 * h, l = Math.hypot(dx, dy); if (l > best) best = l; }
	return best;
}

// ---- 色（map.readPointCloud の点 → RGBA）----
export type CloudColor = "auto" | "rgb" | "elevation" | "intensity" | "classification";
// ASPRS の分類の色（copc-gl と同じ目＝0 未分類 灰・1 未割当 灰・2 地面 茶・3〜5 植生 緑・6 建物 赤・7 低い点 紫・9 水 青・10 鉄道・11 道路 暗灰・17 橋 橙・他 灰）
const CLASS_RGB: Record<number, [number, number, number]> = { 0: [160, 160, 160], 1: [190, 190, 190], 2: [168, 120, 72], 3: [120, 200, 90], 4: [70, 170, 60], 5: [30, 130, 40], 6: [230, 80, 70], 7: [160, 60, 200], 9: [60, 120, 230], 10: [110, 110, 90], 11: [80, 80, 80], 12: [200, 200, 200], 13: [240, 200, 60], 14: [240, 160, 60], 17: [240, 140, 40], 18: [255, 60, 200] };
// 標高の段彩（青 → 水色 → 緑 → 黄 → 赤・copc-gl の elevation と同じ系統）
const RAMP: Array<[number, number, number]> = [[40, 60, 200], [40, 180, 220], [60, 190, 80], [230, 220, 60], [220, 60, 40]];
const ramp = (t: number): [number, number, number] => { const x = Math.max(0, Math.min(1, t)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x)), f = x - i, a = RAMP[i], b = RAMP[i + 1]; return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]; };
/** 点の色＝RGBA（n×4）。mode auto＝RGB があれば rgb・無ければ elevation。opacity＝α */
export function colorize(d: { n: number; rgb: Uint8Array | null; elev?: Float32Array | null; intensity?: Uint16Array | null; cls?: Uint8Array | null }, mode: CloudColor = "auto", { opacity = 1, elevationRange, intensityRange }: { opacity?: number; elevationRange?: [number, number] | null; intensityRange?: [number, number] | null } = {}): Uint8Array<ArrayBuffer> {
	const n = d.n, out = new Uint8Array(n * 4), a = Math.max(0, Math.min(255, Math.round(opacity * 255)));
	const m = mode === "auto" ? (d.rgb ? "rgb" : "elevation") : mode;
	if (m === "rgb") { if (!d.rgb) throw new Error("splat: the point cloud has no RGB (use color: \"elevation\" | \"intensity\" | \"classification\")"); for (let i = 0; i < n; i++) { out[i * 4] = d.rgb[i * 3]; out[i * 4 + 1] = d.rgb[i * 3 + 1]; out[i * 4 + 2] = d.rgb[i * 3 + 2]; out[i * 4 + 3] = a; } }
	else if (m === "elevation") {
		const e = d.elev; if (!e) throw new Error("splat: no elevations");
		let lo = elevationRange?.[0], hi = elevationRange?.[1];
		if (lo == null || hi == null) { lo = Infinity; hi = -Infinity; for (let i = 0; i < n; i++) { if (e[i] < lo) lo = e[i]; if (e[i] > hi) hi = e[i]; } }
		const sc = hi > lo ? 1 / (hi - lo) : 0;
		for (let i = 0; i < n; i++) { const c = ramp((e[i] - lo) * sc); out[i * 4] = c[0]; out[i * 4 + 1] = c[1]; out[i * 4 + 2] = c[2]; out[i * 4 + 3] = a; }
	} else if (m === "intensity") {
		const v = d.intensity; if (!v) throw new Error("splat: no intensities");
		const lo = intensityRange?.[0] ?? 0, hi = intensityRange?.[1] ?? 65535, sc = hi > lo ? 255 / (hi - lo) : 0;
		for (let i = 0; i < n; i++) { const g = Math.max(0, Math.min(255, Math.round((v[i] - lo) * sc))); out[i * 4] = g; out[i * 4 + 1] = g; out[i * 4 + 2] = g; out[i * 4 + 3] = a; }
	} else if (m === "classification") {
		const c = d.cls; if (!c) throw new Error("splat: no classifications");
		for (let i = 0; i < n; i++) { const k = CLASS_RGB[c[i]] ?? CLASS_RGB[0]; out[i * 4] = k[0]; out[i * 4 + 1] = k[1]; out[i * 4 + 2] = k[2]; out[i * 4 + 3] = a; }
	} else throw new RangeError(`splat: color must be auto | rgb | elevation | intensity | classification (got ${JSON.stringify(mode)})`);
	return out;
}

// ---- CPU の参照実装（node の検定・CLI の --cpu・ブラウザは使わない＝WebGPU が無ければ断る）----
/** level 0 の入力＝点（東北上 m・n×3）と色（RGBA・n×4）→ 段の列。WebGPU（cloud-gpu.ts）と同じ手順・同じ式（並べ替えの順が違う分の丸めだけ） */
export function buildCloudCpu(pts: Float32Array, rgba: Uint8Array, n: number, plan: CloudPlan): CloudLevel[] {
	const H = 1 << plan.hashBits, mask = H - 1;
	// 入力の列（pos＝xyz＋色の bit・cov＝6＋重み）
	let pos = new Float32Array(n * 4), cov: Float32Array | null = null, cnt = n;
	const colIn = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
	for (let i = 0; i < n; i++) { pos[i * 4] = pts[i * 3]; pos[i * 4 + 1] = pts[i * 3 + 1]; pos[i * 4 + 2] = pts[i * 3 + 2]; }
	let posU = new Uint32Array(pos.buffer); for (let i = 0; i < n; i++) posU[i * 4 + 3] = colIn[i];
	const out: CloudLevel[] = [];
	const starts = new Uint32Array(H + 1), order = new Uint32Array(n), cell = [0, 0, 0];
	const cellOf = (P: Float32Array, i: number, inv: number): void => { cell[0] = Math.floor(P[i * 4] * inv); cell[1] = Math.floor(P[i * 4 + 1] * inv); cell[2] = Math.floor(P[i * 4 + 2] * inv); };
	for (let L = 0; L < plan.levels; L++) {
		const c = plan.cell0 * 2 ** L, inv = 1 / c, r2 = plan.r * plan.r, fill2 = (plan.fill * c) ** 2, cap2 = (plan.cap * c) ** 2;
		// ① 数え上げの並べ替え（鍵＝セルのハッシュ）
		starts.fill(0);
		const keys = new Uint32Array(cnt);
		for (let i = 0; i < cnt; i++) { cellOf(pos, i, inv); const k = cellHash(cell[0], cell[1], cell[2], mask); keys[i] = k; starts[k + 1]++; }
		for (let k = 0; k < H; k++) starts[k + 1] += starts[k];
		const cursor = starts.slice(0, H);
		for (let i = 0; i < cnt; i++) order[cursor[keys[i]]++] = i;
		// ② セルの先頭（leader）＝同じ run の中で同じセルの最初の物
		const sameCell = (P: Float32Array, j: number, cx: number, cy: number, cz: number): boolean => Math.floor(P[j * 4] * inv) === cx && Math.floor(P[j * 4 + 1] * inv) === cy && Math.floor(P[j * 4 + 2] * inv) === cz;
		const leaders: number[] = [];
		for (let i = 0; i < cnt; i++) {
			cellOf(pos, i, inv); const k = keys[i], cx = cell[0], cy = cell[1], cz = cell[2];
			let first = -1;
			for (let q = starts[k]; q < starts[k + 1]; q++) { const j = order[q]; if (sameCell(pos, j, cx, cy, cz)) { first = j; break; } }
			if (first === i) leaders.push(i);
		}
		const m = leaders.length, nctr = new Float32Array(m * 4), ncov = new Float32Array(m * 8), ncol = new Uint32Array(m), nctrU = new Uint32Array(nctr.buffer);
		const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; let rad2 = 0;
		const C = [0, 0, 0, 0, 0, 0], nb = [0, 0, 0, 0, 0, 0];
		// 近傍の散らばり（level 0 だけ）＝27 セル・半径 r・最大 maxNb 個
		const nbCov = (i: number): void => {
			nb.fill(0); let k = 0;
			const px = pos[i * 4], py = pos[i * 4 + 1], pz = pos[i * 4 + 2], cx = Math.floor(px * inv), cy = Math.floor(py * inv), cz = Math.floor(pz * inv);
			outer: for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
				const kk = cellHash(cx + dx, cy + dy, cz + dz, mask);
				for (let q = starts[kk]; q < starts[kk + 1]; q++) {
					const j = order[q]; if (j === i || !sameCell(pos, j, cx + dx, cy + dy, cz + dz)) continue;
					const ex = pos[j * 4] - px, ey = pos[j * 4 + 1] - py, ez = pos[j * 4 + 2] - pz, d2 = ex * ex + ey * ey + ez * ez;
					if (d2 > r2) continue;
					nb[0] += ex * ex; nb[1] += ex * ey; nb[2] += ex * ez; nb[3] += ey * ey; nb[4] += ey * ez; nb[5] += ez * ez;
					if (++k >= plan.maxNb) break outer;
				}
			}
			if (k >= 2) for (let t = 0; t < 6; t++) nb[t] /= k;
			else { const s2 = (0.5 * c) ** 2; nb[0] = s2; nb[3] = s2; nb[5] = s2; nb[1] = nb[2] = nb[4] = 0; }
		};
		for (let li = 0; li < m; li++) {
			const i = leaders[li], k = keys[i]; cellOf(pos, i, inv); const cx = cell[0], cy = cell[1], cz = cell[2];
			let W = 0, mx = 0, my = 0, mz = 0, cr = 0, cg = 0, cb = 0, ca = 0;
			for (let q = starts[k]; q < starts[k + 1]; q++) {
				const j = order[q]; if (!sameCell(pos, j, cx, cy, cz)) continue;
				const w = cov ? cov[j * 8 + 6] : 1, col = posU[j * 4 + 3];
				W += w; mx += w * pos[j * 4]; my += w * pos[j * 4 + 1]; mz += w * pos[j * 4 + 2];
				cr += w * (col & 255); cg += w * ((col >>> 8) & 255); cb += w * ((col >>> 16) & 255); ca += w * (col >>> 24);
			}
			mx /= W; my /= W; mz /= W; C.fill(0);
			for (let q = starts[k]; q < starts[k + 1]; q++) {
				const j = order[q]; if (!sameCell(pos, j, cx, cy, cz)) continue;
				const w = cov ? cov[j * 8 + 6] : 1, dx = pos[j * 4] - mx, dy = pos[j * 4 + 1] - my, dz = pos[j * 4 + 2] - mz;
				let s: ArrayLike<number>; if (cov) s = cov.subarray(j * 8, j * 8 + 6); else { nbCov(j); s = nb; }
				C[0] += w * (s[0] + dx * dx); C[1] += w * (s[1] + dx * dy); C[2] += w * (s[2] + dx * dz); C[3] += w * (s[3] + dy * dy); C[4] += w * (s[4] + dy * dz); C[5] += w * (s[5] + dz * dz);
			}
			for (let t = 0; t < 6; t++) C[t] /= W;
			C[0] += fill2; C[3] += fill2; C[5] += fill2;
			const tr = C[0] + C[3] + C[5]; if (tr > cap2) { const s = cap2 / tr; for (let t = 0; t < 6; t++) C[t] *= s; }
			nctr[li * 4] = mx; nctr[li * 4 + 1] = my; nctr[li * 4 + 2] = mz;
			const col = ((Math.round(cr / W) & 255) | ((Math.round(cg / W) & 255) << 8) | ((Math.round(cb / W) & 255) << 16) | ((Math.round(ca / W) & 255) << 24)) >>> 0;
			ncol[li] = col; nctrU[li * 4 + 3] = col;
			for (let t = 0; t < 6; t++) ncov[li * 8 + t] = C[t]; ncov[li * 8 + 6] = W;
			if (mx < bb[0]) bb[0] = mx; if (my < bb[1]) bb[1] = my; if (mz < bb[2]) bb[2] = mz; if (mx > bb[3]) bb[3] = mx; if (my > bb[4]) bb[4] = my; if (mz > bb[5]) bb[5] = mz;
			const d2 = mx * mx + my * my + mz * mz; if (d2 > rad2) rad2 = d2;
		}
		if (!m) bb.fill(0);
		out.push({ n: m, cell: c, ctr: nctr, cov: ncov, col: ncol, bb, radius: Math.sqrt(rad2) });
		pos = nctr; posU = nctrU; cov = ncov; cnt = m;   // 色の bit も次の段の物を読む（旧＝level 0 の列を読み続けていた＝粗い段の色が別の点の色）
		if (m <= 1) break;
	}
	return out;
}

// ---- 借りた点（隣の図郭の縁）だけのセルを捨てる（継ぎ目・2026-11-07）----
// 借りた点は色の α を 0 にして変換する＝近傍の形と、縁のセルの中心（内側へ寄らない）には効く。セルの α＝点の α の重みつき平均＝借りた点だけのセルは 0。
// 変換の後に α が 0 のセルを捨て、残りの α を自分の点の α（a）に戻す（縁のセルは自分と借りた点の混ざり＝薄くなっていた）。段ごとに独立（粗い段も細かい段の借りたセルを含めて作ってから捨てる）。
/** 借りた点だけのセル（α 0）を捨て、残りの α を a（0〜255）に戻した段。a が 0（不透明度 0）なら何も捨てない */
export function dropGhostCells(L: CloudLevel, a: number): CloudLevel {
	a = Math.max(0, Math.min(255, Math.round(a)));
	if (!a) return L;
	let m = 0; for (let i = 0; i < L.n; i++) if (L.col[i] >>> 24) m++;
	const ctr = new Float32Array(m * 4), cov = new Float32Array(m * 8), col = new Uint32Array(m), ctrU = new Uint32Array(ctr.buffer);
	const bb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]; let rad2 = 0;
	for (let i = 0, j = 0; i < L.n; i++) {
		if (!(L.col[i] >>> 24)) continue;
		const c = ((L.col[i] & 0xffffff) | (a << 24)) >>> 0, x = L.ctr[i * 4], y = L.ctr[i * 4 + 1], z = L.ctr[i * 4 + 2];
		ctr[j * 4] = x; ctr[j * 4 + 1] = y; ctr[j * 4 + 2] = z; ctrU[j * 4 + 3] = c; col[j] = c;
		cov.set(L.cov.subarray(i * 8, i * 8 + 8), j * 8);
		if (x < bb[0]) bb[0] = x; if (y < bb[1]) bb[1] = y; if (z < bb[2]) bb[2] = z; if (x > bb[3]) bb[3] = x; if (y > bb[4]) bb[4] = y; if (z > bb[5]) bb[5] = z;
		const d2 = x * x + y * y + z * z; if (d2 > rad2) rad2 = d2;
		j++;
	}
	if (!m) bb.fill(0);
	return { n: m, cell: L.cell, ctr, cov, col, bb, radius: Math.sqrt(rad2) };
}

// ---- 書き出し（共分散 → 尺と向き）----
/** 対称 3×3（xx xy xz yy yz zz）の固有分解（Jacobi）→ 尺（σ＝√λ・3 つ）と向き（四元数 x,y,z,w） */
export function covToScaleRot(c: ArrayLike<number>, o = 0): { scales: [number, number, number]; rot: [number, number, number, number] } {
	const A = [c[o], c[o + 1], c[o + 2], c[o + 1], c[o + 3], c[o + 4], c[o + 2], c[o + 4], c[o + 5]], V = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	for (let sweep = 0; sweep < 24; sweep++) {
		const off = Math.abs(A[1]) + Math.abs(A[2]) + Math.abs(A[5]); if (off < 1e-12 * (Math.abs(A[0]) + Math.abs(A[4]) + Math.abs(A[8]) + 1e-30)) break;
		for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
			const apq = A[p * 3 + q]; if (Math.abs(apq) < 1e-30) continue;
			const app = A[p * 3 + p], aqq = A[q * 3 + q], theta = (aqq - app) / (2 * apq), t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1)), cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
			for (let k = 0; k < 3; k++) { const akp = A[k * 3 + p], akq = A[k * 3 + q]; A[k * 3 + p] = cs * akp - sn * akq; A[k * 3 + q] = sn * akp + cs * akq; }
			for (let k = 0; k < 3; k++) { const apk = A[p * 3 + k], aqk = A[q * 3 + k]; A[p * 3 + k] = cs * apk - sn * aqk; A[q * 3 + k] = sn * apk + cs * aqk; }
			for (let k = 0; k < 3; k++) { const vkp = V[k * 3 + p], vkq = V[k * 3 + q]; V[k * 3 + p] = cs * vkp - sn * vkq; V[k * 3 + q] = sn * vkp + cs * vkq; }
		}
	}
	// 右手系に（det > 0）
	const det = V[0] * (V[4] * V[8] - V[5] * V[7]) - V[1] * (V[3] * V[8] - V[5] * V[6]) + V[2] * (V[3] * V[7] - V[4] * V[6]);
	if (det < 0) { V[2] = -V[2]; V[5] = -V[5]; V[8] = -V[8]; }
	const scales: [number, number, number] = [Math.sqrt(Math.max(A[0], 1e-12)), Math.sqrt(Math.max(A[4], 1e-12)), Math.sqrt(Math.max(A[8], 1e-12))];
	// 回転行列（列＝固有ベクトル）→ 四元数
	const m00 = V[0], m01 = V[1], m02 = V[2], m10 = V[3], m11 = V[4], m12 = V[5], m20 = V[6], m21 = V[7], m22 = V[8], tr = m00 + m11 + m22;
	let x: number, y: number, z: number, w: number;
	if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
	else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s; }
	else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s; }
	else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4; }
	const l = Math.hypot(x, y, z, w) || 1;
	return { scales, rot: [x / l, y / l, z / l, w / l] };
}
/** 段 → SplatData（crs "local"＝錨の東北上 m・transform は錨から別に作る）＝.spz の書き出し・3D Tiles の glTF の材料 */
export function cloudLevelToSplatData(L: CloudLevel): SplatData & { n: number; crs: "local" } {
	const n = L.n, positions = new Float32Array(n * 3), scales = new Float32Array(n * 3), rotations = new Float32Array(n * 4), colors = new Uint8Array(n * 4);
	for (let i = 0; i < n; i++) {
		positions[i * 3] = L.ctr[i * 4]; positions[i * 3 + 1] = L.ctr[i * 4 + 1]; positions[i * 3 + 2] = L.ctr[i * 4 + 2];
		const { scales: s, rot } = covToScaleRot(L.cov, i * 8);
		scales.set(s, i * 3); rotations.set(rot, i * 4);
		const c = L.col[i]; colors[i * 4] = c & 255; colors[i * 4 + 1] = (c >>> 8) & 255; colors[i * 4 + 2] = (c >>> 16) & 255; colors[i * 4 + 3] = c >>> 24;
	}
	return { n, crs: "local", positions, scales, rotations, colors };
}
const WGS_A = 6378137, WGS_E2 = 6.69437999014e-3, D2R = Math.PI / 180;
/** 錨（[lon, lat, 標高 m]）の東北上 → ECEF の列優先 4×4（3D Tiles の root.transform・tileset の局所座標＝東・北・上 m） */
export function enuToEcefTransform(lon: number, lat: number, h: number): number[] {
	const l = lon * D2R, f = lat * D2R, sl = Math.sin(l), cl = Math.cos(l), sf = Math.sin(f), cf = Math.cos(f), N = WGS_A / Math.sqrt(1 - WGS_E2 * sf * sf);
	const O = [(N + h) * cf * cl, (N + h) * cf * sl, (N * (1 - WGS_E2) + h) * sf];
	return [-sl, cl, 0, 0, -sf * cl, -sf * sl, cf, 0, cf * cl, cf * sl, sf, 0, O[0], O[1], O[2], 1];
}
/** 段の列（粗い順に親 → 子）の tileset.json（3D Tiles 1.1・REPLACE・KHR_gaussian_splatting の glb を level ごとに 1 枚）。uri＝`${prefix}${L}.glb`。geometricError＝段のセル × gePerCell（既定 16＝画面で 16 px を超えたら細かい段へ） */
export function cloudTileset(levels: Array<Pick<CloudLevel, "cell" | "bb">>, anchor: ArrayLike<number>, { prefix = "level", gePerCell = 16 }: { prefix?: string; gePerCell?: number } = {}): Record<string, unknown> {
	if (!levels.length) throw new Error("splat: no levels");
	const box = (bb: number[]) => ({ box: [(bb[0] + bb[3]) / 2, (bb[1] + bb[4]) / 2, (bb[2] + bb[5]) / 2, Math.max(1, (bb[3] - bb[0]) / 2 + 2 * levels[0].cell), 0, 0, 0, Math.max(1, (bb[4] - bb[1]) / 2 + 2 * levels[0].cell), 0, 0, 0, Math.max(1, (bb[5] - bb[2]) / 2 + 2 * levels[0].cell)] });
	let tile: Record<string, unknown> | null = null;
	for (let L = 0; L < levels.length; L++) {   // 細かい段から包む（level 0 が葉）
		const lv = levels[L];
		const t: Record<string, unknown> = { boundingVolume: box(lv.bb), geometricError: L === 0 ? 0 : lv.cell * gePerCell, refine: "REPLACE", content: { uri: `${prefix}${L}.glb` } };
		if (tile) t.children = [tile];
		tile = t;
	}
	const root = tile!; root.transform = enuToEcefTransform(anchor[0], anchor[1], anchor[2]);
	return { asset: { version: "1.1" }, geometricError: (levels[levels.length - 1].cell * gePerCell) * 4, extensionsUsed: ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"], root };
}
/** 段 → glb（KHR_gaussian_splatting＋KHR_gaussian_splatting_compression_spz_2＝bufferView に .spz（gzip 済み）の本体・属性の accessor は bufferView 無し＝globe の meshdecode が読む形）。
 *  glTF は Y 上＝東北上（E, N, U）を (x=E, y=U, z=−N) に写す＝tileset の transform は東北上のまま（globe の tiles3d が Y-up → Z-up を直す） */
export function cloudLevelGlb(d: SplatData & { n: number }, spzGz: Uint8Array): Uint8Array<ArrayBuffer> {
	const n = d.n, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { const v = d.positions[i * 3 + k]; if (v < mn[k]) mn[k] = v; if (v > mx[k]) mx[k] = v; }
	if (!n) { mn.fill(0); mx.fill(0); }
	const json = { asset: { version: "2.0", generator: "@ortho-earth/splat cloud" }, extensionsUsed: ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"], extensionsRequired: ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"],
		scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
		meshes: [{ primitives: [{ attributes: { POSITION: 0, "KHR_gaussian_splatting:SCALE": 1, "KHR_gaussian_splatting:ROTATION": 2, "KHR_gaussian_splatting:OPACITY": 3, "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0": 4 }, mode: 0,
			extensions: { KHR_gaussian_splatting: { kernel: "ellipse", colorSpace: "srgb_rec709_display" }, KHR_gaussian_splatting_compression_spz_2: { bufferView: 0 } } }] }],
		accessors: [{ componentType: 5126, count: n, type: "VEC3", min: mn, max: mx }, { componentType: 5126, count: n, type: "VEC3" }, { componentType: 5126, count: n, type: "VEC4" }, { componentType: 5126, count: n, type: "SCALAR" }, { componentType: 5126, count: n, type: "VEC3" }],
		bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: spzGz.length }], buffers: [{ byteLength: Math.ceil(spzGz.length / 4) * 4 }] };
	const J = new TextEncoder().encode(JSON.stringify(json)), jl = Math.ceil(J.length / 4) * 4, bl = Math.ceil(spzGz.length / 4) * 4;
	const out = new Uint8Array(12 + 8 + jl + 8 + bl), dv = new DataView(out.buffer);
	out.set([0x67, 0x6c, 0x54, 0x46]); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
	dv.setUint32(12, jl, true); dv.setUint32(16, 0x4e4f534a, true); out.set(J, 20); for (let i = 20 + J.length; i < 20 + jl; i++) out[i] = 0x20;
	dv.setUint32(20 + jl, bl, true); dv.setUint32(24 + jl, 0x004e4942, true); out.set(spzGz, 28 + jl);
	return out;
}
/** SplatData の軸を東北上（x=E, y=N, z=U）から glTF（x=E, y=U, z=−N）へ（位置・尺・四元数） */
export function enuToGltfAxes(d: SplatData & { n: number }): SplatData & { n: number } {
	const n = d.n, P = new Float32Array(n * 3), S = new Float32Array(n * 3), R = new Float32Array(n * 4);
	// 軸の入れ替え＝回転 q_a（x 軸まわり −90°）を左から掛ける：v' = M v・M＝[[1,0,0],[0,0,1],[0,−1,0]]（E,N,U → E,U,−N）
	const hx = -Math.SQRT1_2, hw = Math.SQRT1_2;   // q_a＝(sin(−45°), 0, 0, cos(−45°))
	for (let i = 0; i < n; i++) {
		P[i * 3] = d.positions[i * 3]; P[i * 3 + 1] = d.positions[i * 3 + 2]; P[i * 3 + 2] = -d.positions[i * 3 + 1];
		S.set(d.scales.subarray(i * 3, i * 3 + 3), i * 3);
		const x = d.rotations[i * 4], y = d.rotations[i * 4 + 1], z = d.rotations[i * 4 + 2], w = d.rotations[i * 4 + 3];   // q' = q_a ⊗ q
		R[i * 4] = hw * x + hx * w; R[i * 4 + 1] = hw * y - hx * z; R[i * 4 + 2] = hw * z + hx * y; R[i * 4 + 3] = hw * w - hx * x;
	}
	return { ...d, positions: P, scales: S, rotations: R };
}
