// vite の ?url（ファイルの URL を文字列で受ける）＝installer が同一フレームのオーバーレイの module を渡す（TS 化 段 4・batch 1）
declare module "*?url" {
	const url: string;
	export default url;
}
