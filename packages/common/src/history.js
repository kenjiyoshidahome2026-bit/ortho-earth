export const history = async (opts = {}) => {
	const {
		db = "s3_history.system",
		key = "undo",
		max = 100,
		initial = [[]],
		bindKey = false,
		exec,
		trigger
	} = opts;

	const cache = await d3.cache(db, trigger);

	let redo = [];
	let undo = (await cache(key)) || initial;

	const history = async (value) => {
		// Deep-clone the value so that mutations to the caller's array cannot corrupt the stored history.
		const snapshot = structuredClone(Array.isArray(value) ? value : [value]);

		if (JSON.stringify(undo[0]) !== JSON.stringify(snapshot)) {
			undo.unshift(snapshot);
			undo = undo.slice(0, max);
			// Discard redo history on any new action (new branch invalidates the redo stack).
			redo = [];

			await cache(key, undo);
		}
	};

	history.val = history.value = () => undo[0];

	history.exec = async () => {
		// Clone before passing to exec so external mutations cannot corrupt the stored state.
		if (exec) await exec(...structuredClone(undo[0]));
	};

	history.forward = async () => {
		if (redo.length) {
			undo.unshift(redo.shift());
			await history.exec();
		}
		return undo[0];
	};

	history.backward = async () => {
		if (undo.length > 1) {
			redo.unshift(undo.shift());
			await history.exec();
		}
		return undo[0];
	};

	history.get = () => undo;

	if (bindKey && exec) {
		// Namespace (.history) prevents clobbering other keydown listeners.
		d3.select(window).on("keydown.history", async e => {
			// e.which is deprecated; use e.key for reliable cross-platform detection.
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
				e.preventDefault();
				e.shiftKey ? await history.forward() : await history.backward();
			}
		});
	}

	return history;
};