// メッシュ（建物・模型）の束の選び（改善計画の段階 3・2026-11-01）＝両 renderer が同式で持っていた純関数の正本。
// 「画面上 ~1px 未満の建物は描かない」の LOD 打ち切り・基図建物を伏せるマスクの選抜・マスクの OR＝GPU API を読まない。
import { worldRadiusM } from "./camera.ts";

/** LOD 打ち切りを持つ束＝index は建物高さ降順・lodCounts[k] で「高さ lodH[k] 以上だけ」を先頭打ち切り */
export interface LodBatch { bbox: ArrayLike<number>; count: number; lodH: ArrayLike<number> | null; lodCounts: ArrayLike<number> | null; two: number | boolean; keep2d: boolean }

/** 描く index の数。建物だけ＝橋梁（two＝両面）は「高さ 3〜5m×長さ数百 m」で小物と誤判定され桁が歯抜けになる（横浜ベイブリッジ実測）・
 *  keep2d（統計の押し出し）は低い値にも意味がある＝間引かない。遠方の束は距離で緩やかに閾値を上げる（チルト時の遠景は透視で 1px がもっと大きい＝控えめ側の近似） */
let lodScale = 1;   // 「描かない建物」の物差しの倍率（1＝画面 1px 未満を捨てる・既定）。?meshlod=N＝N px 未満を捨てる（非力 GPU の頂点代を下げる実験ノブ・2026-11-04）
/** LOD 打ち切りの倍率（renderer の起動で 1 回。0 以下＝1） */
export function setMeshLodScale(s: number): void { lodScale = s > 0 ? s : 1; }
// 動的な間引き（?meshshed=1・2026-11-08）：動的解像度が床（×0.55）でも GPU が間に合わない時、render worker が動いている間だけ
// 「高さ H m 未満の建物を描かない」を段階的に強める（m 単位＝LOD_H の段 3/6/12/24/48 に合わせる）。止まると 0 へ戻す＝静止の絵は不変。
// px の物差し（?meshlod）は z17.7 では ×10 でも 2〜3 m＝何も削れない（Mali-G615 実測 2026-11-08：meshlod=10 でコマ数不変）ので m で切る。
// Mali-G615 実測：丸の内→レインボーブリッジの滑走は PLATEAU メッシュの描画が 1 フレーム 86〜105 ms で解像度を落としても下がらない（塗りでなく頂点・描画量）
let shedMinH = 0;
// 動いている間の間引きは画面上の大きさで決める（2026-11-11・本人裁定）：m の段（6/12/24 m）と軽量 index（4 m² 未満）は丸の内を z17.7 で滑走する絵で
// 決めた値＝その縮尺（0.6 m/px）で 10〜40 px の建物・3 px の三角形。同じ m を z20 のデルフト（/nl・家は 6〜10 m）へ当てると、画面いっぱいの家が
// 動かすたびに消えた。物差し（m/px）が MOVE_REF_MPPX より細かい（寄っている）時は、m の段を画面上の同じ px 数へ縮める（H × mppx / 基準）＝
// 6/12/24 m は 12/24/48 px を上限に・軽量 index は 2 m の辺が 4 px を越える縮尺では使わない。基準より引いている時は従来の m のまま
/** 動いている間の間引きを決めた縮尺（m/px・mppxOf(z17.96)）＝これより寄ると m の段を px へ縮める */
export const MOVE_REF_MPPX = 0.5;
/** 動的な間引きの下限の高さ（m・0＝無し） */
export function setMeshShed(minHm: number): void { shedMinH = minHm > 0 ? minHm : 0; }
/** 今の動的な間引きの下限の高さ（m） */
export function meshShed(): number { return shedMinH; }
// 動いている間だけの軽量 index（?meshlitemove=A・2026-11-08）：mesh worker が段ごとに「残す三角形を先頭」に並べ替えた束（liteCounts）を、
// オンの間は段ごとの先頭だけ描く（renderer）。間引き（shed）と同じ時計で点き、止まると消える＝静止の形は不変
let liteOn = false;
/** 動いている間だけの軽量 index のオン/オフ（render worker が shed と同時に切り替える） */
export function setMeshLite(on: boolean): void { liteOn = !!on; }
/** 今、軽量 index で描いているか */
export function meshLite(): boolean { return liteOn; }
/** この縮尺（m/px）で軽量 index を使うか＝オンで、落とす三角形（2 m の辺）が画面上 4 px 以下の時だけ */
export function meshLiteAt(mppx: number): boolean { return liteOn && mppx >= MOVE_REF_MPPX; }
let rangeM = Infinity;   // 注視点からこの距離（m）より遠い束は描かない（Infinity＝切らない・既定）。?meshrange=KM＝傾けた時の遠景の頂点代を切る（非力 GPU の実験ノブ・2026-11-04）
/** 遠景の切り（km・0 以下＝切らない） */
export function setMeshRange(km: number): void { rangeM = km > 0 ? km * 1000 : Infinity; }
// ズームアウトの坂（?meshlodz=K・2026-11-05）：zoom < lodZ0 では物差しを K^(lodZ0−zoom) 倍＝引くほど「高い建物だけ」へ急に寄せる。
// 保持帯（Mac＝z14〜15 で立てた区を消さない）で区ごとの灰色の絨毯（全建物が 1px 超＝全部描く）が残るのを、高層の星座へ変える。
// zoom ≥ lodZ0 では 1 倍＝近景の絵は不変。K ≤ 1＝坂なし（既定）
let lodZ0 = 15, lodZK = 1;
/** ズームアウトの坂（renderer の起動で 1 回）：z0＝坂の上端（自動ロード線）・k＝1 ズーム引くごとの倍率（1 以下＝坂なし） */
export function setMeshLodZoom(z0: number, k: number): void { lodZ0 = z0 > 0 ? z0 : 15; lodZK = k > 1 ? k : 1; }
/** 坂を掛けた物差し（m/px）＝meshLodCount の mppx に渡す */
export function meshLodMppx(mppx: number, zoom: number): number { return lodZK > 1 && zoom < lodZ0 ? mppx * lodZK ** (lodZ0 - zoom) : mppx; }
export function meshLodCount(p: LodBatch, center: ArrayLike<number>, cosLat: number, mppx: number): number {
	if (p.keep2d) return p.count;
	if (rangeM !== Infinity) {   // 束の bbox の最寄りの縁までの距離（m）＝大きい束が注視点に掛かっている時は切らない
		const ex = Math.max(p.bbox[0] - center[0], 0, center[0] - p.bbox[2]) * 111320 * cosLat, ey = Math.max(p.bbox[1] - center[1], 0, center[1] - p.bbox[3]) * 111320;
		if (ex * ex + ey * ey > rangeM * rangeM) return 0;
	}
	if (!p.lodH || p.two) return p.count;
	const dm = Math.hypot(((p.bbox[0] + p.bbox[2]) / 2 - center[0]) * 111320 * cosLat, ((p.bbox[1] + p.bbox[3]) / 2 - center[1]) * 111320);
	const far = mppx * (1 + dm / 4000), minH = Math.max(far * lodScale, shedMinH * Math.min(1, far / MOVE_REF_MPPX));   // 動的な間引きは寄っている時だけ px へ縮める（上の注記）
	let li = 0;
	for (let i = p.lodH.length - 1; i > 0; i--) if (p.lodH[i] <= minH) { li = i; break; }
	return p.lodCounts![li];
}
/** 注視点の地面の高さ（持ち上げる束の間引きの第 2 候補・camera.ts liftedBboxVisible） */
export const liftGroundROf = (centerAlt: number | undefined): number => 1 + Math.max(0, centerAlt || 0) / worldRadiusM();

/** 基図建物を伏せるマスクの選抜＝注視点に近い bbox 順に max 個（同率は sort 安定性で Map 挿入順＝フレーム間で選抜が揺れない）。非表示区のマスクは載せない＝基図建物が戻る */
export function pickMeshMasks<M extends { bbox: ArrayLike<number> }>(masks: Map<string, M>, hidden: Set<string>, center: ArrayLike<number>, max: number): M[] {
	const mcx = center[0], mcy = center[1], mcw = Math.cos(mcy * Math.PI / 180);
	const mdist = (m: M): number => { const bb = m.bbox; const dx = Math.max(bb[0] - mcx, 0, mcx - bb[2]) * mcw, dy = Math.max(bb[1] - mcy, 0, mcy - bb[3]); return dx * dx + dy * dy; };
	return [...masks.entries()].filter(([w]) => !hidden.has(w)).map(([, m]) => m).sort((a, b) => mdist(a) - mdist(b)).slice(0, max);
}
/** 断片（maskCells）が触れた行の範囲 [r0, r1]（N×N 格子）＝テクスチャの部分上げ用。空＝[N, -1] */
export function maskRows(maskCells: ArrayLike<number>, N: number): [number, number] {
	let r0 = N, r1 = -1;
	for (let i = 0; i < maskCells.length; i++) { const c = maskCells[i]; if (c >= N * N) continue; const r = (c / N) | 0; if (r < r0) r0 = r; if (r > r1) r1 = r; }
	return [r0, r1];
}
/** マスクの OR（単調＝破壊しない）：maskCells＝立てる格子の番号（新 worker）・mask＝全量（旧 worker 互換） */
export function orMaskBytes(bytes: Uint8Array, maskCells: ArrayLike<number> | null | undefined, mask: ArrayLike<number> | null | undefined): void {
	if (maskCells) { for (let i = 0; i < maskCells.length; i++) { const c = maskCells[i]; if (c < bytes.length) bytes[c] = 255; } }
	else if (mask) for (let i = 0; i < mask.length && i < bytes.length; i++) if (mask[i]) bytes[i] = 255;
}
