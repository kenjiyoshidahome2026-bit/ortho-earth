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
	const map = this, mapEl = this.mapEl;
	const facade = {};
	const keys = ["start", "next", "prev", "exit", "play", "pause"];
	// 二重搭載を「同期で」弾く＝順序非依存。本体(demo.js)の #demo-btn ガードは import 解決“後”に走るため、
	// 同フレームで複数搭載すると、どの import() が先に解決するかで台本が入れ替わりうる（他モジュールの読込順で反転する実測あり）。
	// ∴ 有効な scenes を持つ搭載を同期で「予約」し、2発目以降は即・無害ファサードを返す。空 scenes は予約しない（非搭載＝後続の本物を妨げない）。
	const valid = Array.isArray(opts.scenes) && opts.scenes.length > 0;
	if (valid && mapEl.__orthoDemo) { for (const k of keys) facade[k] = () => undefined; facade.ready = Promise.resolve(null); return facade; }   // 二重搭載＝無害の no-op（import すらしない）
	if (valid) mapEl.__orthoDemo = true;   // 本物の搭載を同期予約（以降の valid 搭載を上で弾く）
	const pending = name => (...a) => facade.ready.then(g => (g && g[name]) ? g[name](...a) : undefined);
	for (const k of keys) facade[k] = pending(k);
	facade.ready = import("./demo.js")   // 搭載＝即・本体を取りに行く（バー構築が「搭載」の実務そのもの）
		.then(m => {
			const g = m.demo.call(map, opts);   // undefined=scenes空(slide:false で消滅含む)/二重搭載（本体のガード）
			if (!g && valid) mapEl.__orthoDemo = false;   // 本体が非搭載だった＝同期予約を戻す（後続の本物を妨げない）
			if (g) for (const k of keys) facade[k] = (...a) => (g[k] ? g[k](...a) : undefined);   // 到着後は同期直接委譲へ
			return g;
		})
		.catch(e => { console.error("[demo] 本体の読み込みに失敗", e); return null; });
	return facade;
}
