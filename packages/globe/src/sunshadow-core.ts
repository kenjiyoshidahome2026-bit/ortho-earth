// 日影・可視域の純関数（2026-10-24）＝CPU 版（sunshadow.ts・model 役の worker）と GPU 版（render worker の読み戻し・api/shadows.ts）の共有部。
//   太陽の式（真太陽時・赤緯）・時刻の列・升目の色付け（日影時間の段彩と等時間線・可視域の緑と暗）。DOM も fetch も使わない＝node の検定で回る。
//   CPU 版から切り出した物＝式も定数も同じ（絵は 1 bit も変わらない）。GPU 版は数える所だけ GPU に置き、ここで同じ色を塗る＝CPU/GPU の答えを同じ目で比べられる。
export const D2R = Math.PI / 180, R_EARTH = 6371000;
/** 可視域の大気の屈折の係数（地球の丸みと合わせて遠方は d²/(2R)·(1−k) だけ下がる） */
export const K_REFR = 0.13;

// 太陽の高度・方位（北から時計回り）。solarHour＝真太陽時（12＝南中）。decl＝赤緯（度）
export function sunAt(latDeg: number, decl: number, solarHour: number): { alt: number; az: number } {
	const phi = latDeg * D2R, d = decl * D2R, H = (solarHour - 12) * 15 * D2R;
	const sinA = Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(H);
	const alt = Math.asin(Math.max(-1, Math.min(1, sinA)));
	const azS = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(d) * Math.cos(phi));   // 南から西回り
	return { alt, az: azS + Math.PI };   // 北から時計回り
}
// 日付 → 赤緯（度）と均時差（時）。時計の時刻を真太陽時へ直すのに使う
export function declOf(date: Date): { decl: number; eot: number } {
	const N = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 864e5);
	const decl = 23.44 * Math.sin(2 * Math.PI * (284 + N) / 365);
	const B = 2 * Math.PI * (N - 81) / 364, eot = (9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B)) / 60;
	return { decl, eot };
}
/** 日影の時刻の列と赤緯（CPU/GPU 共通）。瞬間＝与えた時計の時刻を真太陽時へ（経度と均時差）・時間＝hours を step で刻む。duration の既定の赤緯＝冬至 */
export function sunTimes(o: { mode?: "instant" | "duration"; date?: string | number | Date | null; decl?: number | null; hours?: number[]; step?: number }, lon0Deg: number): { times: number[]; decl: number; date: Date } {
	const mode = o.mode ?? "duration", hours = o.hours ?? [8, 16], step = o.step ?? 0.5;
	const date = o.date ? new Date(o.date) : new Date();
	const { decl: declD, eot } = declOf(date);
	const decl = o.decl ?? (mode === "duration" ? -23.44 : declD);
	const times: number[] = [];
	if (mode === "instant") { const utcH = date.getUTCHours() + date.getUTCMinutes() / 60; times.push(((utcH + lon0Deg / 15 + eot) % 24 + 24) % 24); }
	else for (let t = hours[0]; t <= hours[1] + 1e-9; t += step) times.push(t);
	return { times, decl, date };
}
/** 日の出ている時刻だけの太陽（高度 0.5° より上＝CPU 版と同じ門）。順は時刻の順 */
export function sunsOf(latDeg: number, decl: number, times: number[]): Array<{ alt: number; az: number; t: number }> {
	const out: Array<{ alt: number; az: number; t: number }> = [];
	for (const t of times) { const s = sunAt(latDeg, decl, t); if (s.alt > 0.5 * D2R) out.push({ alt: s.alt, az: s.az, t }); }
	return out;
}
/** 太陽の方向（単位球ワールド）＝地点の上（up）・東・北の基底に高度と方位を載せる。up＝その地点の鉛直（球なら動径・楕円体なら測地法線を正規化した物） */
export function sunDirAt(up: ArrayLike<number>, alt: number, az: number): number[] {
	let e = [-up[2], 0, up[0]];   // 東＝up × [0,1,0]（北極の軸）＝経度の増える向き
	const l = Math.hypot(e[0], e[1], e[2]) || 1; e = [e[0] / l, e[1] / l, e[2] / l];
	const n = [e[1] * up[2] - e[2] * up[1], e[2] * up[0] - e[0] * up[2], e[0] * up[1] - e[1] * up[0]];   // 北＝東 × up
	const ca = Math.cos(alt), sa = Math.sin(alt), cz = Math.cos(az), sz = Math.sin(az);
	return [sa * up[0] + ca * (cz * n[0] + sz * e[0]), sa * up[1] + ca * (cz * n[1] + sz * e[1]), sa * up[2] + ca * (cz * n[2] + sz * e[2])];
}

/** 日影時間の段（日影規制の 1〜5 時間の境） */
export const band = (h: number): number => h >= 5 ? 5 : h >= 4 ? 4 : h >= 3 ? 3 : h >= 2 ? 2 : h >= 1 ? 1 : 0;
const PAL: Array<number[] | null> = [null, [120, 180, 255, 90], [80, 140, 240, 120], [60, 90, 220, 145], [120, 60, 200, 165], [200, 40, 120, 185]];
/** 日影の升目の色付け（cnt＝時刻ごとに影だった回数・step＝時）。瞬間＝影の範囲の一色／時間＝段彩＋等時間線。戻り＝RGBA と最大の日影時間 */
export function paintSunShadow(cnt: ArrayLike<number>, W: number, H: number, step: number, mode: "instant" | "duration"): { rgba: Uint8ClampedArray<ArrayBuffer>; maxH: number } {
	const rgba = new Uint8ClampedArray(W * H * 4);
	let maxH = 0;
	if (mode === "instant") {
		for (let i = 0; i < W * H; i++) if (cnt[i]) { rgba[i * 4] = 20; rgba[i * 4 + 1] = 24; rgba[i * 4 + 2] = 60; rgba[i * 4 + 3] = 150; }
	} else {
		const hrs = new Float32Array(W * H);
		for (let i = 0; i < W * H; i++) { hrs[i] = cnt[i] * step; if (hrs[i] > maxH) maxH = hrs[i]; const c = PAL[band(hrs[i])]; if (c) { rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2]; rgba[i * 4 + 3] = c[3]; } }
		for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {   // 段の境＝等時間線
			const i = y * W + x, b = band(hrs[i]);
			if (b >= 2 && (band(hrs[i + 1]) < b || band(hrs[i + W]) < b || band(hrs[i - 1] ?? 0) < b || band(hrs[i - W] ?? 0) < b)) { rgba[i * 4] = 30; rgba[i * 4 + 1] = 20; rgba[i * 4 + 2] = 60; rgba[i * 4 + 3] = 235; }
		}
	}
	return { rgba, maxH };
}
/** 可視域の升目の色付け（vis＝見える 1・ox/oy＝視点の升目・rCells＝半径の升目）。半径の外は透明。戻り＝RGBA・半径の中の升目の数・見える数 */
export function paintViewshed(vis: ArrayLike<number>, N: number, ox: number, oy: number, rCells: number): { rgba: Uint8ClampedArray<ArrayBuffer>; inR: number; seen: number } {
	const rgba = new Uint8ClampedArray(N * N * 4);
	let inR = 0, seen = 0;
	for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
		const i = y * N + x; if (Math.hypot(x + 0.5 - ox, y + 0.5 - oy) > rCells) continue;
		inR++; if (vis[i]) { seen++; rgba[i * 4] = 40; rgba[i * 4 + 1] = 200; rgba[i * 4 + 2] = 110; rgba[i * 4 + 3] = 120; } else { rgba[i * 4] = 60; rgba[i * 4 + 1] = 40; rgba[i * 4 + 2] = 70; rgba[i * 4 + 3] = 90; }
	}
	return { rgba, inR, seen };
}
/** 日影の升目の寸法（CPU/GPU 共通）：bbox の局所 m の幅・升目の一辺（既定 0.5m・maxCells に収まるまで粗く）・升目の数 */
export function sunGrid(bbox: readonly number[], cell: number | null | undefined, maxCells: number): { W: number; H: number; cell: number; spanX: number; spanY: number; lon0: number; lat0: number; kx: number; ky: number } {
	const [w, s, e, n] = bbox, lon0 = (w + e) / 2 * D2R, lat0 = (s + n) / 2 * D2R, kx = Math.cos(lat0) * R_EARTH, ky = R_EARTH;
	const spanX = (e - w) * D2R * kx, spanY = (n - s) * D2R * ky;
	const c = Math.max(cell ?? 0.5, Math.sqrt(spanX * spanY / maxCells));
	return { W: Math.max(1, Math.ceil(spanX / c)), H: Math.max(1, Math.ceil(spanY / c)), cell: c, spanX, spanY, lon0, lat0, kx, ky };
}
