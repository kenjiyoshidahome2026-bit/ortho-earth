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
		const attr = document.createElement("div");
		attr.id = "attr";
		attr.innerHTML = `出典：<a href="https://maps.gsi.go.jp/development/ichiran.html#optbv" target="_blank" rel="noopener">国土地理院最適化ベクトルタイル（提供実験）</a><br>
			<a href="https://www.mlit.go.jp/plateau/" target="_blank" rel="noopener">国土交通省 PLATEAU</a>・<a href="https://www.eorc.jaxa.jp/ALOS/jp/dataset/aw3d30/aw3d30_j.htm" target="_blank" rel="noopener">JAXA AW3D30</a><br>
			（各データを加工して作成）　© 2026 Kenji Yoshida`;
		els.push(attr);
	}
	mapEl.append(...els);
}
