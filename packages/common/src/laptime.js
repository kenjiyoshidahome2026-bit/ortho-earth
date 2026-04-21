export const laptime = (() => {
	// 改良1 & 4: performance.now() による超高精度タイマーと let の使用
	let start = performance.now();
	let time = performance.now();
	let func = console.log;

	return (evnt) => {
		// 改良2: d3.isFunction を標準の typeof に変更
		if (!evnt || typeof evnt === "function") {
			start = performance.now();
			func = evnt || func;
		}

		const now = performance.now();
		const lap = (now - time) / 1000;
		const total = (now - start) / 1000;

		// 改良3: evnt が文字列（または数値など）の場合のみログを出力する
		if (evnt && typeof evnt !== "function") {
			func(`${evnt}: ${lap.toFixed(3)} ${total.toFixed(3)}[sec]`);
		}

		time = now;
	};
})();