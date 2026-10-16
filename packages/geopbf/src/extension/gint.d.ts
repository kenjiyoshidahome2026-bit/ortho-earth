// extension/gint.js の型（TS化 段 3・convert/node-gint が読む分だけ）。extension/gint.js が .ts になったら（段 4）このファイルは消す
export class gint {
	/** wasm（wasm/pkg/gint_wasm）を読み込む。2 回目以降は即 return */
	static initialize(): Promise<void>;
}
