// pbf-base.js の型（TS化 段 3・cog／convert が読む分）＝公開の types/geopbf.d.ts の GeoPBFBase に、convert が直に触る内部（pbf・fmap・props・
// setBodyAsync・getPosition）を足した物。pbf-base.js が .ts になったら（段 4）このファイルは消す
import type { GeoPBFBase, GeoPBFOptions, WireTags, MakeKeys } from "../types/geopbf.js";
import type Pbf from "./modules/pbf.js";
export type { Feature, FeatureCollection, Geometry, GeometryType, Properties, Position, GeoPBFOptions, HeaderMeta, UnPackGint, WireTags } from "../types/geopbf.js";
export interface GeoPBF extends GeoPBFBase {
	/** ワイヤの読み書き（modules/pbf.js）＝convert/geoparquet が幾何を整数のまま読む */
	pbf: Pbf;
	/** 地物ごとの位置表 [pos, geomPos, gtype, …]（GeometryCollection は [3]＝要素の位置の配列・[4]＝要素の型の配列） */
	fmap: number[][];
	/** 属性の行（keys の順の疎配列・遅延の器＝worker 経路では undefined が並ぶ） */
	props: (unknown[] | undefined)[] | null;
	/** setBody と同じく 1 回だけ（FARRAY は 1 個）＝非同期の書き手（行の逐次読み）向け */
	setBodyAsync(fn: () => Promise<void>): Promise<this>;
	/** ヘッダと地物の位置表を読み直す（close() の後に呼ぶ＝length・props が揃う） */
	getPosition(options?: { skipProps?: boolean }): Promise<this>;
}
export const GeoPBF: {
	new (options?: GeoPBFOptions): GeoPBF;
	prototype: GeoPBF;
	readonly TAGS: WireTags;
	readonly makeKeys: MakeKeys;
	dataType(value: unknown): number;
	readonly dataTypeNames: readonly string[];
	setProperty(name: string | Record<string, unknown>, value?: unknown): void;
	setGetter(name: string, func: (this: GeoPBF) => unknown): void;
	setPrototype(name: string, func: (this: GeoPBF, ...args: unknown[]) => unknown): void;
};
export const makeKeys: MakeKeys;
export function propsKeyOf(row: unknown[]): string;
export function canUseWorker(self: GeoPBFBase, factory?: (() => Worker | null) | null): boolean;
