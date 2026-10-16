// modules/pbf.js の型（TS化 段 3・convert/mvt-decode・geoparquet が読む分だけ）。modules/pbf.js が .ts になったらこのファイルは消す
export type ReadField<T> = (tag: number, result: T, pbf: Pbf) => void;
export default class Pbf {
	constructor(buf?: Uint8Array | ArrayBuffer | ArrayBufferView);
	buf: Uint8Array;
	dataView: DataView;
	pos: number;
	type: number;
	length: number;
	readFields<T>(readField: ReadField<T>, result: T, end?: number): T;
	readMessage<T>(readField: ReadField<T>, result: T): T;
	readVarint(isSigned?: boolean): number;
	readVarint64(): number;
	readSVarint(): number;
	readBoolean(): boolean;
	readFixed32(): number;
	readSFixed32(): number;
	readFixed64(): number;
	readSFixed64(): number;
	readFloat(): number;
	readDouble(): number;
	readString(): string;
	readBytes(): Uint8Array;
	readPackedEnd(): number;
	readPackedVarint(arr?: number[], isSigned?: boolean): number[];
	readPackedSVarint(arr?: number[]): number[];
	readPackedBoolean(arr?: boolean[]): boolean[];
	readPackedFloat(arr?: number[]): number[];
	readPackedDouble(arr?: number[]): number[];
	readPackedFixed32(arr?: number[]): number[];
	readPackedSFixed32(arr?: number[]): number[];
	skip(val: number): void;
}
