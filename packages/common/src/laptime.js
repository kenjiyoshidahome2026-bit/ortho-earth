export const laptime = (() => {
	let start = performance.now();
	let time = performance.now();
	let func = console.log;

	return (evnt) => {
		if (!evnt || typeof evnt === "function") {
			start = performance.now();
			func = evnt || func;
		}

		const now = performance.now();
		const lap = (now - time) / 1000;
		const total = (now - start) / 1000;

		if (evnt && typeof evnt !== "function") {
			func(`${evnt}: ${lap.toFixed(3)} ${total.toFixed(3)}[sec]`);
		}

		time = now;
	};
})();