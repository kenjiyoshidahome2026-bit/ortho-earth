// ガジェットの CSS を <head> に 1 回だけ足す（inspect・marker・model-gizmo が同じ「cssOn の旗＋<style>」を持っていた＝一本化・2026-11-05）。
// 返す関数を呼んだ時に初めて DOM に触る＝モジュールの読み込み時には触らない（worker・node からの import も無害）。

/** css を 1 回だけ <head> へ足す関数を作る（2 回目からは何もしない） */
export const cssOnce = (css: string): (() => void) => {
	let on = false;
	return () => { if (on) return; on = true; const s = document.createElement("style"); s.textContent = css; document.head.append(s); };
};
