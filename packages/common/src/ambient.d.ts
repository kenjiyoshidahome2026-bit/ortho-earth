// TS 化（段 B・2026-10-15）の補い＝lib.dom に無い物と、型を持たない隣の package の最小の宣言。
//   native-bucket＝段 A で並行して TS 化中（済めばこの宣言は要らない＝消す）。ここで使う Cache だけを書く。
//   showDirectoryPicker／queryPermission／requestPermission＝File System Access API（Chrome）＝lib.dom に未収録。
//   *.scss＝意匠の副作用 import（Vite が束ねる・tsc は何も出さない）。
declare module "*.scss" {}
declare module "native-bucket" {
	/** IDB の控え（name＝"db/table"）。idb(key)＝読む・idb(key, value)＝書く（native-bucket/src/Cache.js の返り） */
	export type CacheFn = (key: string | number, value?: unknown) => Promise<unknown>;
	export function Cache(name: string): Promise<CacheFn>;
}
interface Window {
	showDirectoryPicker(options?: { mode?: "read" | "readwrite"; id?: string; startIn?: unknown }): Promise<FileSystemDirectoryHandle>;
}
interface FileSystemHandle {
	queryPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
	requestPermission(descriptor?: { mode?: "read" | "readwrite" }): Promise<PermissionState>;
}
