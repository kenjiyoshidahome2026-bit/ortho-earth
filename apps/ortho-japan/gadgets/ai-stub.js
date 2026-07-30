// ガジェット：AI（会話して地図に描く）の玄関スタブ。搭載APIは従来どおり map.gadget.ai()＝同期で
// ファサード {ready, panel, ask, close} を即返す。重い本体（ai.js＋ai/{backend,interpret,catalog}＋将来のLLM）は
// 搭載の瞬間に一度だけ import()＝初期バンドルから完全隔離。将来AIが幾ら育っても起動コストは0のまま。
// print-stub と同じ流儀（同期ファサード＋遅延 import）＝呼び出し側の契約（g.ask は関数）を壊さない。
export function ai(opts = {}) {
	const map = this;
	// PC専用ガード＝本体を読み込む前にモバイルで弾く（本体 ai.js の同ガードと二重だが、モバイルでの無駄DLを断つ）。
	if (!opts.force && !matchMedia("(min-width: 900px) and (pointer: fine)").matches) {
		console.warn("[ai] PC専用（画面2分割）＝この画面には搭載しない");
		return;
	}
	// 搭載＝即・本体を取りに行く（右列パネルの構築が「搭載」の実務そのもの＝クリック待ちの print とはここが違う）。
	const ready = import("./ai.js")
		.then(m => m.ai.call(map, opts))
		.catch(e => { console.error("[ai] 本体の読み込みに失敗", e); return null; });
	// 同期ファサード：ask/close は本体到着を待って委譲。panel は DOM から引く（本体到着後に #ai が立つ）。
	return {
		ready,   // 本体到着の Promise（テスト・プログラム制御用）
		get panel() { return document.getElementById("ai"); },
		ask: (...a) => ready.then(g => g && g.ask(...a)),
		close: () => ready.then(g => g && g.close()),
	};
}
