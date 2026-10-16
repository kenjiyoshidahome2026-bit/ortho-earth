// czml-time.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝czml-time.js が TS になれば消える。

/** CZML／GPX の時刻つきの軌跡（trackOf の戻り） */
export interface CzmlTrack {
	id?: string | null; name?: string | null;
	/** 標本の時刻（ms・昇順）・位置（ECEF×3・m） */
	t: Float64Array; p: Float64Array;
	/** 補間の次数（線形＝1）・慣性系で補間するか */
	degree: number; inertial: boolean;
	/** 出ている区間（ms・null＝いつも） */
	avail: Array<[number, number]> | null;
	czml: Record<string, unknown>;
	[k: string]: unknown;
}
/** 見た目（styleOf の戻り）。show・lead・trail・resolution は CZML の生の値（時刻つきもある＝boolAt／numberAt で引く） */
export interface CzmlStyle {
	point: { size: number; color: string; outline: string | null; outlineWidth: number; show: unknown } | null;
	image: { src: string; scale: number; offset: [number, number]; show: unknown } | null;
	label: { text: string | null; color: string; outline?: string; px: number; offset: [number, number]; align: string; show: unknown } | null;
	path: { show: unknown; width: number; color: string; lead: unknown; trail: unknown; resolution: unknown } | null;
}
/** 区間（"a/b" の ISO・その配列）→ [[a, b]…]（ms）｜null（無指定＝いつも） */
export function parseIntervals(v: unknown): Array<[number, number]> | null;
/** 時刻つきの数（CZML の number プロパティ） */
export function numberAt(v: unknown, ms: number, dflt?: number | null): number | null;
/** 地物 → 軌跡（時刻付きの線でなければ null） */
export function trackOf(f: unknown): CzmlTrack | null;
/** 出ている区間の中か */
export function availableAt(tr: CzmlTrack, ms: number): boolean;
/** path の時刻の列（ms） */
export function pathTimes(tr: CzmlTrack, ms: number, opts?: { lead?: number | null; trail?: number | null; resolution?: number | null }): number[];
/** 時刻つきの真偽（show） */
export function boolAt(v: unknown, ms: number, dflt?: boolean): boolean;
/** 地物 → 見た目 */
export function styleOf(f: unknown): CzmlStyle;
/** 地心直交（m）→ [lon, lat, h m] */
export function ecefToLlh(x: number, y: number, z: number): [number, number, number];
/** 時刻 ms の位置（地心直交 m）・範囲外は null */
export function positionAt(tr: CzmlTrack, ms: number): [number, number, number] | null;
