// undo/redo（純粋モジュール＝Node試験可）。逆デルタのコマンドスタック＝O(編集量)・スナップショット禁止
// （100万頂点級で成立させる条件）。コマンドの適用/逆転は model 側の apply(cmd) / invert(cmd) に委譲＝
// history はスタック管理だけを持つ（試験が最小になる分担）。
export function createHistory(limit = 200) {
	const undoStack = [], redoStack = [];
	return {
		push(cmd) { undoStack.push(cmd); if (undoStack.length > limit) undoStack.shift(); redoStack.length = 0; },
		undo(apply, invert) {
			const cmd = undoStack.pop(); if (!cmd) return null;
			apply(invert(cmd)); redoStack.push(cmd); return cmd;
		},
		redo(apply) {
			const cmd = redoStack.pop(); if (!cmd) return null;
			apply(cmd); undoStack.push(cmd); return cmd;
		},
		get canUndo() { return undoStack.length > 0; },
		get canRedo() { return redoStack.length > 0; },
		clear() { undoStack.length = 0; redoStack.length = 0; },
	};
}
