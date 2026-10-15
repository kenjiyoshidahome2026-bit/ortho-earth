// "geopbf/pbf"（src/modules/pbf.js）＝protobuf の wire 読み書き（旧 pbf パッケージと同じ API・1.6 で内蔵）。GeoPBF の class ではない（それは "geopbf"／"geopbf/pbf-base"）
// 名簿は src/modules/pbf.js の prototype と 1:1（tests/t-dts.mjs が照合）。64bit 値は Number（2^53 を超える精度は落ちる）
export default class Pbf {
	constructor(buf?: Uint8Array | ArrayBuffer | ArrayBufferView);
	buf: Uint8Array; dataView: DataView; pos: number; type: number; length: number;

	// ── 読み（result は無くてもよい＝ハンドラが閉包で集める書き方）
	readFields<T = undefined>(readField: (tag: number, result: T, pbf: Pbf) => void, result?: T, end?: number): T;
	readMessage<T = undefined>(readField: (tag: number, result: T, pbf: Pbf) => void, result?: T): T;
	readVarint(isSigned?: boolean): number;
	/** 符号付き 64bit varint（int64）＝readVarint(true) */
	readVarint64(): number;
	readSVarint(): number; readBoolean(): boolean;
	readFixed32(): number; readSFixed32(): number; readFixed64(): number; readSFixed64(): number;
	readFloat(): number; readDouble(): number; readString(): string;
	/** buf の上の subarray（コピーではない） */
	readBytes(): Uint8Array;
	readPackedEnd(): number;
	readPackedVarint(arr?: number[], isSigned?: boolean): number[]; readPackedSVarint(arr?: number[]): number[]; readPackedBoolean(arr?: boolean[]): boolean[];
	readPackedFloat(arr?: number[]): number[]; readPackedDouble(arr?: number[]): number[];
	readPackedFixed32(arr?: number[]): number[]; readPackedSFixed32(arr?: number[]): number[]; readPackedFixed64(arr?: number[]): number[]; readPackedSFixed64(arr?: number[]): number[];
	skip(val: number): void;

	// ── 書き
	realloc(min: number): void;
	finish(): Uint8Array;
	writeTag(tag: number, type: number): void; writeVarint(val: number): void; writeSVarint(val: number): void; writeBoolean(val: boolean): void;
	writeFixed32(val: number): void; writeSFixed32(val: number): void; writeFixed64(val: number): void; writeSFixed64(val: number): void;
	writeFloat(val: number): void; writeDouble(val: number): void; writeString(str: string): void; writeBytes(buffer: Uint8Array | ArrayLike<number>): void;
	writeRawMessage<T>(fn: (obj: T, pbf: Pbf) => void, obj?: T): void; writeMessage<T>(tag: number, fn: (obj: T, pbf: Pbf) => void, obj?: T): void;
	writePackedVarint(tag: number, arr: number[]): void; writePackedSVarint(tag: number, arr: number[]): void; writePackedBoolean(tag: number, arr: boolean[]): void;
	writePackedFloat(tag: number, arr: number[]): void; writePackedDouble(tag: number, arr: number[]): void;
	writePackedFixed32(tag: number, arr: number[]): void; writePackedSFixed32(tag: number, arr: number[]): void; writePackedFixed64(tag: number, arr: number[]): void; writePackedSFixed64(tag: number, arr: number[]): void;
	writeVarintField(tag: number, val: number): void; writeSVarintField(tag: number, val: number): void; writeBooleanField(tag: number, val: boolean): void;
	writeStringField(tag: number, str: string): void; writeBytesField(tag: number, buffer: Uint8Array | ArrayLike<number>): void; writeFloatField(tag: number, val: number): void; writeDoubleField(tag: number, val: number): void;
	writeFixed32Field(tag: number, val: number): void; writeSFixed32Field(tag: number, val: number): void; writeFixed64Field(tag: number, val: number): void; writeSFixed64Field(tag: number, val: number): void;
}
