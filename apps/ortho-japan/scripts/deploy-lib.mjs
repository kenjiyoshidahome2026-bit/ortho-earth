// deploy.mjs の純関数（常設検定 tests/t-deploy.mjs が食う）。
// failedPages＝globe の門（packages/globe の ui-runner）の出力から落ちた頁を拾う。行の形＝`FAIL  <頁>  <表題>  〔12.3s〕`
// （deploy.mjs の pipe で `[globe 123s] ` が頭に付く）。頁は query 込み（例 t-mlcompat?g=layers）＝そのまま verify:webgpu の引数に渡せる。
export const failedPages = lines => {
	const out = [];
	for (const raw of lines) {
		const m = /^(?:\[[^\]]*\]\s*)?FAIL\s{2,}(\S+)/.exec(String(raw));
		if (m && !out.includes(m[1])) out.push(m[1]);
	}
	return out;
};
