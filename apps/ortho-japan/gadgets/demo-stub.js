// ガジェット：デモ（発表の台本再生）の玄関スタブ。搭載APIは従来どおり map.gadget.demo(script)＝
// 同期ファサード {ready, start, next, prev, exit, play, pause} を即返す。重い本体（再生エンジン＝demo.js：
// 球面フライトの振付・幕/スライド・目次・自動上演・将来の演出拡張）は搭載の瞬間に一度だけ import()＝
// 初期バンドルから隔離。将来デモ演出が幾ら育っても起動（FCP/LCP）は影響を受けない。
// ※ 操縦バー(#demo-bar)自体はマウント時に必要（点灯前でもDOMは在る）＝boot は即発火し、本体が
//   バー/ボタン/スライドを組む。クリック待ちの print/ai とは違い「即・本体が組む」点だけ demo 固有。
// ※ 契約：本体到着後はファサードのメソッドを本体への「同期」直接委譲へ差し替える＝マウントを待って
//   （ready/一拍後に）呼ぶ現実の使い方では元の同期契約そのまま（h.next() が即座に効く）。到着前の呼び出し
//   だけ Promise で待ち合わせる保険。本番はバーのボタン駆動＝本体を直に叩くので、この差し替えは主にAPI利用者向け。
export function demo(opts = {}) {
	const map = this;
	const facade = {};
	const pending = name => (...a) => facade.ready.then(g => (g && g[name]) ? g[name](...a) : undefined);
	for (const k of ["start", "next", "prev", "exit", "play", "pause"]) facade[k] = pending(k);
	facade.ready = import("./demo.js")   // 搭載＝即・本体を取りに行く（バー構築が「搭載」の実務そのもの）
		.then(m => {
			const g = m.demo.call(map, opts);   // undefined=scenes空/二重搭載（本体のガード）
			if (g) for (const k of ["start", "next", "prev", "exit", "play", "pause"]) facade[k] = (...a) => (g[k] ? g[k](...a) : undefined);   // 到着後は同期直接委譲へ
			return g;
		})
		.catch(e => { console.error("[demo] 本体の読み込みに失敗", e); return null; });
	return facade;
}
