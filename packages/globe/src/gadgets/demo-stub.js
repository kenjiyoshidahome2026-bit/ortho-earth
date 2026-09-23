// ガジェット：デモ（発表の台本再生）の玄関スタブ。搭載APIは従来どおり map.gadget.demo(script)＝
// 同期ファサード {ready, start, next, prev, exit, play, pause} を即返す。重い本体（再生エンジン＝demo.js：
// 球面フライトの振付・幕/スライド・目次・自動上演・将来の演出拡張）は搭載の瞬間に一度だけ import()＝
// 初期バンドルから隔離。将来デモ演出が幾ら育っても起動（FCP/LCP）は影響を受けない。
// ※ 操縦バー(#demo-bar)自体はマウント時に必要（点灯前でもDOMは在る）＝boot は即発火し、本体が
//   バー/ボタン/スライドを組む。クリック待ちの print/ai とは違い「即・本体が組む」点だけ demo 固有。
// ※ 契約：本体到着後はファサードのメソッドを本体への「同期」直接委譲へ差し替える＝マウントを待って
//   （ready/一拍後に）呼ぶ現実の使い方では元の同期契約そのまま（h.next() が即座に効く）。到着前の呼び出し
//   だけ Promise で待ち合わせる保険。本番はバーのボタン駆動＝本体を直に叩くので、この差し替えは主にAPI利用者向け。
import { gadgetStack } from "./stack.js";
import { ICON } from "./demo-icon.js";
import { tr } from "../i18n.js";
const t = tr();
export function demo(opts = {}) {
	const map = this, mapEl = this.mapEl;
	const facade = {};
	const keys = ["start", "next", "prev", "exit", "play", "pause"];   // 本体到着後は同期委譲・到着前は ready 待ち。ドロップ再生は start(0,{scenes,bare}) を直接呼ぶ（旧 load は廃止）
	// 二重搭載を「同期で」弾く＝順序非依存。本体(demo.js)の #demo-btn ガードは import 解決“後”に走るため、
	// 同フレームで複数搭載すると、どの import() が先に解決するかで台本が入れ替わりうる（他モジュールの読込順で反転する実測あり）。
	// ∴ 有効な scenes を持つ搭載を同期で「予約」し、2発目以降は即・無害ファサードを返す。空 scenes は予約しない（非搭載＝後続の本物を妨げない）。
	const valid = Array.isArray(opts.scenes) && opts.scenes.length > 0;
	if (valid && mapEl.__orthoDemo) { for (const k of keys) facade[k] = () => undefined; facade.ready = Promise.resolve(null); return facade; }   // 二重搭載＝無害の no-op（import すらしない）
	if (valid) mapEl.__orthoDemo = true;   // 本物の搭載を同期予約（以降の valid 搭載を上で弾く）
	// 遅延の形（opts.lazy＝台本を返す関数・2026-09-22）：▶ボタン（同じ顔・同じ位置）だけ先に出し、本体（demo.js）と台本は
	// 押された時・メソッドが呼ばれた時・ready に触れた時に初めて読む＝起動の転送から外す（サイトの組み込み台本用）。本体は btn を引き継ぐ。
	if (typeof opts.lazy === "function") {
		if (mapEl.__orthoDemo) { for (const k of keys) facade[k] = () => undefined; facade.ready = Promise.resolve(null); return facade; }
		mapEl.__orthoDemo = true;
		const btn = document.createElement("button");
		btn.id = "demo-btn"; btn.dataset.tip = t("Play demo"); btn.setAttribute("aria-label", t("Play demo"));
		btn.setAttribute("aria-pressed", "false");
		btn.innerHTML = ICON;
		gadgetStack(mapEl).append(btn);
		let body = null;
		const load = () => body ??= Promise.all([opts.lazy(), import("./demo.js")]).then(([extra, m]) => {
			btn.removeEventListener("click", onFirst);
			const { lazy, ...rest } = opts;
			const g = m.demo.call(map, { ...rest, ...extra, btn });
			if (!g) { mapEl.__orthoDemo = false; return null; }
			for (const k of keys) facade[k] = (...a) => (g[k] ? g[k](...a) : undefined);
			return g;
		}).catch(e => { console.error("[demo] failed to load module", e); return null; });
		const onFirst = () => load().then(g => { if (g) btn.click(); });   // 本体が btn に付けた ▶ の振る舞いへそのまま渡す
		btn.addEventListener("click", onFirst);
		for (const k of keys) facade[k] = (...a) => load().then(g => (g && g[k]) ? g[k](...a) : undefined);
		Object.defineProperty(facade, "ready", { get: load, enumerable: true });   // 触れたら読む（台本の上映が待つ）
		return facade;
	}
	const pending = name => (...a) => facade.ready.then(g => (g && g[name]) ? g[name](...a) : undefined);
	for (const k of keys) facade[k] = pending(k);
	facade.ready = import("./demo.js")   // 搭載＝即・本体を取りに行く（バー構築が「搭載」の実務そのもの）
		.then(m => {
			const g = m.demo.call(map, opts);   // undefined=scenes空(slide:false で消滅含む)/二重搭載（本体のガード）
			if (!g && valid) mapEl.__orthoDemo = false;   // 本体が非搭載だった＝同期予約を戻す（後続の本物を妨げない）
			if (g) for (const k of keys) facade[k] = (...a) => (g[k] ? g[k](...a) : undefined);   // 到着後は同期直接委譲へ
			return g;
		})
		.catch(e => { console.error("[demo] failed to load module", e); return null; });
	return facade;
}
