// ガジェット：計器盤（デバッグログ・座標テーブル・距離スケール・出典）。DOMのみ＝更新は main.js。
// 出典の文言＝日本のデータ源の名乗り。DOM順は最後尾群＝下辺の静かな層。
export function mountInstruments(mapEl) {
	const log = document.createElement("div");
	log.id = "log"; log.textContent = "起動中…";
	const pos = document.createElement("div");
	pos.id = "pos";
	const scale = document.createElement("div");
	scale.id = "scale"; scale.innerHTML = `<span id="scale-txt"></span><div id="scale-bar"></div>`;
	const attr = document.createElement("div");
	attr.id = "attr";
	attr.innerHTML = `出典：<a href="https://maps.gsi.go.jp/development/ichiran.html#optbv" target="_blank" rel="noopener">国土地理院最適化ベクトルタイル（提供実験）</a><br>
		<a href="https://www.mlit.go.jp/plateau/" target="_blank" rel="noopener">国土交通省 PLATEAU</a>・<a href="https://www.eorc.jaxa.jp/ALOS/jp/dataset/aw3d30/aw3d30_j.htm" target="_blank" rel="noopener">JAXA AW3D30</a><br>
		（各データを加工して作成）　© 2026 Kenji Yoshida`;
	mapEl.append(log, pos, scale, attr);
}
