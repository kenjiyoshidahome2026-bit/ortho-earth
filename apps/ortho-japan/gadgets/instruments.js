// ガジェット：計器盤（デバッグログ・座標テーブル・距離スケール・出典）。DOMのみ＝更新は main.js。
// keys＝orthoJapan({instruments}) の起動パラメータ：true=全部（既定）／配列=選択的（"pos","scale","attr","log"）。
// 出典の文言＝日本のデータ源の名乗り。DOM順は最後尾群＝下辺の静かな層。
// ★"attr"（出典）を出さない場合でも、地理院タイル・PLATEAU・AW3D30 の出典明記義務は消えない＝
//   埋め込み側が自分のページのどこかに同等の出典を記述すること（README「出典表記」参照）。
const KEYS = ["log", "pos", "scale", "attr"];
export function mountInstruments(mapEl, keys = true) {
	if (Array.isArray(keys))   // typo は黙って0個になる＝開発時の迷子防止に一声
		for (const k of keys) if (!KEYS.includes(k)) console.warn(`[instruments] 未知のキー "${k}"（有効: ${KEYS.join(", ")}）`);
	const want = k => keys === true || (Array.isArray(keys) && keys.includes(k));
	const els = [];
	if (want("log")) {   // デバッグログ（常時非表示＝devtoolsで#logを出す人向け）
		const log = document.createElement("div");
		log.id = "log"; log.textContent = "起動中…";
		els.push(log);
	}
	if (want("pos")) {   // 座標読み取り（左下）。非搭載なら標高照会も止まる（main側 hasPos ゲート）
		const pos = document.createElement("div");
		pos.id = "pos";
		els.push(pos);
	}
	if (want("scale")) {   // 距離スケール（下辺中央・真俯瞰のみ）
		const scale = document.createElement("div");
		scale.id = "scale"; scale.innerHTML = `<span id="scale-txt"></span><div id="scale-bar"></div>`;
		els.push(scale);
	}
	if (want("attr")) {   // 出典（右下・最も静か）
		// 養子縁組（LCP前倒し・2026-08-04）：index.html が同文の静的 #attr[data-boot] を幕の上に先描き
		//（初回ペイントでLCP確定＝従来はここでの生成~2.0sが律速）。あれば実体を引き取り #map 配下へ移す。
		// data-boot を剥がすと boot 用インラインCSSが外れ quiet-mono の #attr 意匠へ自然に切り替わる。
		// 埋め込みページ（静的版なし）は従来どおり新規生成。
		const boot = document.querySelector("#attr[data-boot]");
		const attr = boot || document.createElement("div");
		if (boot) boot.removeAttribute("data-boot"); else attr.id = "attr";
		// 行割りは iPhone 幅（375px・11px 字）で折り返さないことを基準に3行固定：
		//   1行目=長い正式名称を単独で／2行目=残りのデータ源3つ／3行目=加工注記+©。#attr の text-wrap:balance は超狭幅の保険
		// オランダの入口（/nl/）では出典もオランダのものに差し替える＝3DBAG は CC BY 4.0＝表示が義務。
		// 日本のデータを出していない画面に地理院・PLATEAU を並べるのは、義務以前に嘘になる。
		const nl = /^\/nl(\/|$)/.test(location.pathname) || /[?&]nl=1/.test(location.search);
		attr.innerHTML = nl
			? `出典：<a href="https://3dbag.nl/" target="_blank" rel="noopener">3DBAG（TU Delft）CC BY 4.0</a><br>
			BAG（建物登記）・AHN（国土LiDAR）より自動生成<br>
			（データを加工して作成）© 2026 <a href="https://www.ortho-earth.com/docs/introduction.html" target="_blank" rel="noopener">Kenji Yoshida</a>`
			: `出典：<a href="https://maps.gsi.go.jp/development/ichiran.html#optbv" target="_blank" rel="noopener">国土地理院最適化ベクトルタイル（提供実験）</a><br>
			<a href="https://maps.gsi.go.jp/development/ichiran.html#dem" target="_blank" rel="noopener">標高タイル（DEM10B）</a>・<a href="https://www.mlit.go.jp/plateau/" target="_blank" rel="noopener">国土交通省 PLATEAU</a>・<a href="https://www.eorc.jaxa.jp/ALOS/jp/dataset/aw3d30/aw3d30_j.htm" target="_blank" rel="noopener">JAXA AW3D30</a><br>
			（各データを加工して作成）© 2026 <a href="https://www.ortho-earth.com/docs/introduction.html" target="_blank" rel="noopener">Kenji Yoshida</a>`;
		els.push(attr);
	} else document.querySelector("#attr[data-boot]")?.remove();   // 出典を出さない構成＝静的版も残さない（埋め込み側の出典明記義務は README どおり）
	mapEl.append(...els);
}
