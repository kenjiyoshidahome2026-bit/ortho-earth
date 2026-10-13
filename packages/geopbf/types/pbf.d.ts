// "geopbf/pbf"（src/modules/pbf.js）＝protobuf の wire 読み書き（旧 pbf パッケージと同じ API・1.6 で内蔵）。GeoPBF の class ではない（それは "geopbf"／"geopbf/pbf-base"）
export default class Pbf {
	constructor(buf?: Uint8Array | ArrayBuffer | ArrayBufferView);
	buf: Uint8Array; dataView: DataView; pos: number; type: number; length: number;
	readFields<T>(readField: (tag: number, result: T, pbf: Pbf) => void, result: T, end?: number): T;
	readMessage<T>(readField: (tag: number, result: T, pbf: Pbf) => void, result: T): T;
	readVarint(isSigned?: boolean): number;
	readSVarint(): number; readBoolean(): boolean; readFloat(): number; readDouble(): number; readString(): string; readBytes(): Uint8Array;
	readPackedVarint(arr?: number[], isSigned?: boolean): number[]; readPackedSVarint(arr?: number[]): number[]; readPackedBoolean(arr?: boolean[]): boolean[];
	readPackedFloat(arr?: number[]): number[]; readPackedDouble(arr?: number[]): number[]; readPackedEnd(): number;
	skip(val: number): void;
	realloc(min: number): void;
	finish(): Uint8Array;
	writeTag(tag: number, type: number): void; writeVarint(val: number): void; writeSVarint(val: number): void; writeBoolean(val: boolean): void;
	writeFloat(val: number): void; writeDouble(val: number): void; writeString(str: string): void; writeBytes(buffer: Uint8Array | ArrayLike<number>): void;
	writeRawMessage<T>(fn: (obj: T, pbf: Pbf) => void, obj?: T): void; writeMessage<T>(tag: number, fn: (obj: T, pbf: Pbf) => void, obj?: T): void;
	writePackedVarint(tag: number, arr: number[]): void; writePackedSVarint(tag: number, arr: number[]): void; writePackedBoolean(tag: number, arr: boolean[]): void;
	writePackedFloat(tag: number, arr: number[]): void; writePackedDouble(tag: number, arr: number[]): void;
	writeVarintField(tag: number, val: number): void; writeSVarintField(tag: number, val: number): void; writeBooleanField(tag: number, val: boolean): void;
	writeStringField(tag: number, str: string): void; writeBytesField(tag: number, buffer: Uint8Array | ArrayLike<number>): void; writeFloatField(tag: number, val: number): void; writeDoubleField(tag: number, val: number): void;
}
