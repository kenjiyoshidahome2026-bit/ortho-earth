// "geopbf/decodeZIP"（src/modules/decodeZIP.js）＝zip（Blob か URL・Range で中央ディレクトリから引く）→ File の列。
//   target＝文字列：その 1 本だけ（無ければ null）・false：目録だけ（展開しない）・null／省略：全部。第 2 引数にまとめて渡す形（options）も同じ意味。
//   zip として読めなければ console.warn して null
/** 1 エントリの伸長後サイズの上限（既定 4 GiB）＝{ maxEntrySize } で変える */
export const MAX_ENTRY_SIZE: number;
export interface DecodeZIPOptions {
	target?: string | false | null;
	/** エントリ名の文字コード（UTF-8 フラグが無い時・既定 shift-jis） */
	encoding?: string | null;
	/** FetchStart／FetchProgress／FetchEnd を投げる先（既定＝window か self） */
	eventTarget?: EventTarget | null;
	/** URL の時、HEAD を省くための既知の全長 */
	totalLength?: number;
	maxEntrySize?: number;
}
/** 目録（target＝false）の 1 行 */
export interface ZipEntryInfo { name: string; size: number; cSize: number; lastModified: number; type: string }
export function decodeZIP(source: Blob | string, target?: null, encoding?: string | null): Promise<File[] | null>;
export function decodeZIP(source: Blob | string, target: string, encoding?: string | null): Promise<File | null>;
export function decodeZIP(source: Blob | string, target: false, encoding?: string | null): Promise<ZipEntryInfo[] | null>;
export function decodeZIP(source: Blob | string, target?: string | false | null | DecodeZIPOptions, encoding?: string | null): Promise<File[] | File | ZipEntryInfo[] | null>;
