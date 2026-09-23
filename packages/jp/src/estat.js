// e-Stat 小地域（町丁目）の器＝日本の地域パックの部品（LAYERS.md 段階 2 S3・2026-09-23。旧＝apps/ortho-japan/overlay.js に同居）。
// worker（estat-worker.js）が fetch→gunzip→parse→ジオメトリ生成→transfer＝main をブロックしない。
// ホストからは拡張面（env）だけを受ける：renderer のスロット・cam・size/dpr・requestDraw・tip・say・t・spawnWorker・HI_MASK。
// 消費者（census2020）は map.estat（install.js が置く）で loadEstat / highlightKey / setIdentifyHandler / clearOverlay を呼ぶ。
export function createEstat({ renderer, cam, size, dpr, requestDraw, tip, say, t, spawnWorker, hiMask, unproject, cameraState }) {
	let estatActive = false;      // e-Stat 経路がアクティブ＝identify は worker へ
	let estatOpts = {};           // 直近 loadEstat の opts（moveCamera/quiet/onLoaded）＝派生アプリ用。既定は従来挙動
	let identifyHandler = null;   // identify 結果の派生アプリ受け口（setIdentifyHandler）。未登録なら従来の say パネル
	let highlightWait = null;     // highlightKey の完了待ち（worker 返信は直列＝最後の呼びが勝つで足りる）
	// worker は初めて要る時（loadEstat）に立てる＝census2020 以外の頁では起動しない
	let estatW = null;
	const estatWorker = () => estatW ??= Object.assign(spawnWorker("estat"), { onmessage: onEstatMessage });
	const onEstatMessage = e => {
		const m = e.data;
		if (m.type === "loaded") {
			const o = estatOpts;
			if (!m.ok) { if (!o.quiet) say(t("e-Stat load failed")); o.onLoaded?.({ ok: false, count: 0 }); return; }
			estatActive = true;
			renderer.set("overlay", m.overlay);
			renderer.set("overlayHover", null);   // ホバー境界は消す（overlayHi＝選択マスクは setSelected/highlightKey 管理＝ここで消すと市区町村選択マスクが即消える不具合）
			if (o.moveCamera !== false) { cam.center = [m.center[0], m.center[1]]; cam.zoom = 12; cam.pitch = 0; }   // 派生アプリは自前で寄せる＝直書きジャンプを抑止できる
			requestDraw();
			if (!o.quiet) say(t("e-Stat small areas: $1 features — click to identify (small-area code = the join key)", m.count));
			o.onLoaded?.({ ok: true, count: m.count, center: m.center });
		} else if (m.type === "identify") {
			// 生 identify は「当たり報告」だけ＝マスク(overlayHi)には触れない。選択マスクは選択フロー
			// （setSelectionMask＝県/市 ／ highlightKey＝町丁目）が単独で握る＝別市区町村クリック時の
			// 非同期上書き競合（旧市の hit<0 応答が新選択マスクを消す）を構造的に断つ（本人指摘2026-08-14「スパゲッティ」）。
			if (identifyHandler) { identifyHandler(m.hit >= 0 ? { hit: m.hit, props: m.props || {} } : null); return; }
			renderer.set("overlayHi", m.overlay || null, hiMask);   // ハンドラ未登録の自己完結デモ時だけ当たりを周辺マスクで示す
			if (m.hit >= 0) {
				const kv = Object.entries(m.props).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join("\n");
				say(`identify ✔ #${m.hit}\n${kv || "(no props)"}`);
			} else say(t("identify: no hit"));
			requestDraw();
		} else if (m.type === "highlighted") {
			renderer.set("overlayHi", m.overlay || null, hiMask);   // 町丁目(estat)選択＝周辺マスク（塗りつぶさない）
			if (highlightWait) { highlightWait(m.bbox ? { key: m.key, bbox: m.bbox, count: m.count } : null); highlightWait = null; }
			requestDraw();
		} else if (m.type === "hovertip") {
			tip?.(m.name || null);   // 町丁目名を tip へ（estat 中は gint 市区町村 tip でなくこれ＝紛らわしさ解消）
			renderer.set("overlayHover", m.overlay || null);   // ホバー中の町丁目境界を太線で（選択マスクとは別スロット＝両立）
			requestDraw();
		}
	};
	// ホバー tip：estat 経路の時だけ、指先の町丁目名を worker から取り tip へ（gint 市区町村 tip の代わり）。
	// 返り true＝estat が tip を担当したので呼び出し側は gint ホバーを出さない（紛らわしさ解消・本人裁定2026-08-14）。
	function hoverAt(clientX, clientY) {
		if (!estatActive) return false;
		const st = cameraState(cam, size.w, size.h);
		const ll = unproject(st, clientX * dpr, clientY * dpr);
		if (!ll) return false;   // 投影不能＝gint へ
		// bbox短絡は廃止＝毎ホバーきっちり点in面で識別（worker findHit）。ミス（町丁目外＝他市区町村上）は
		// hovertip name:null で返り、呼び出し側が gint ホバーへフォールバックする（本人指摘2026-08-14）。
		estatWorker().postMessage({ type: "hovertip", lon: ll[0], lat: ll[1] });   // 結果 hovertip は onmessage が tip＋境界へ
		return true;
	}
	// e-Stat 小地域（estat/{調査年}/{code}.geojsonl・gzip）：worker が fetch→gunzip→parse→ジオメトリ生成→transfer。
	// opts（派生アプリ用・省略時は従来挙動）: moveCamera:false=loaded時のカメラ直書きを抑止 / quiet=sayパネル抑止 / onLoaded(r)
	async function loadEstat(codes, year = "2020", style = null, opts = {}) {
		estatOpts = opts;
		if (!opts.quiet) say(t("Loading e-Stat small areas ($1 municipalities)…", codes.length));
		estatWorker().postMessage({ type: "load", codes, year, style, interiorOnly: !!opts.interiorOnly });   // interiorOnly＝census2020限定で内側メッシュのみ（既定=全ユニーク辺＝凍結デモ AI 経路）
	}
	// 小地域 KEY_CODE（9/11桁）でハイライト → {key,bbox,count}｜ヒットなし・estat未ロードは null
	function highlightKey(key) {
		if (!estatActive) return Promise.resolve(null);
		return new Promise(r => { highlightWait = r; estatWorker().postMessage({ type: "highlight", key: String(key) }); });
	}
	return {
		loadEstat, highlightKey, hoverAt,
		isEstatActive: () => estatActive,
		identify: (lon, lat) => estatWorker().postMessage({ type: "identify", lon, lat }),   // 結果は onmessage が描く
		clear: () => { estatActive = false; },
		setIdentifyHandler: fn => { identifyHandler = fn; },   // 派生アプリの identify 受け口（null で従来 say へ復帰）
		destroy: () => { estatW?.terminate(); estatW = null; },
	};
}
