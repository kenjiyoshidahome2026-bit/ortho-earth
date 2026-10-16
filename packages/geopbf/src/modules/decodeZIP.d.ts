// modules/decodeZIP.js の型（TS化 段 3・convert/table が読む分）＝公開の types/decodeZIP.d.ts をそのまま。modules/decodeZIP.js が .ts になったらこのファイルは消す
export { decodeZIP, MAX_ENTRY_SIZE } from "../../types/decodeZIP.js";
export type { DecodeZIPOptions, ZipEntryInfo } from "../../types/decodeZIP.js";
