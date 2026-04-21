export const history = async (opts = {}) => {
	// デフォルト値の結合をモダンな分割代入でスッキリと
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
		// 改良3: 参照を切る（完全なコピーを作る）ことで過去の履歴が書き換わるのを防ぐ
		const snapshot = structuredClone(Array.isArray(value) ? value : [value]);

		if (JSON.stringify(undo[0]) !== JSON.stringify(snapshot)) {
			undo.unshift(snapshot);
			// 改良2: メモリ上の配列も確実に max で切り詰める（メモリリーク防止）
			undo = undo.slice(0, max);
			// 改良1: 新しいアクションが起きたら「Redoの未来」は破棄する
			redo = [];

			await cache(key, undo);
		}
	};

	history.val = history.value = () => undo[0];

	history.exec = async () => {
		// 実行時も参照を切って渡すことで、外部でいじられても履歴が壊れない
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
		// 改良4: 他のkeydownイベントを上書きしないよう名前空間（.history）をつける
		d3.select(window).on("keydown.history", async e => {
			// e.whichは非推奨のため、環境依存しない e.key を使用
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
				e.preventDefault();
				e.shiftKey ? await history.forward() : await history.backward();
			}
		});
	}

	return history;
};