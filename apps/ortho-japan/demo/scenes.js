// デモの台本（map.gadget.demo に渡す opts 丸ごと）。index.html はこのファイルを読むだけ＝台本編集はここ1枚。
// スライド画像は public/demo/ に置く（URLは "demo/〜" で参照）。※publicのJSはvite掟でimport不可＝台本はソース側のここ。
// ★台本の一行＝共有URLハッシュそのまま（アドレスバーからコピーして貼るだけでシーンになる）。フルスペック（l= 込み）推奨。
// ・slide="画像URL"（public/demo/ に置く）か "生テキスト"（紙のカードに一言・\n改行可）
// ・caption: "〜"＝オート上映（▷）の静止中に画面上部へ出す字幕（無ければ title を代用表示）
// ・view+slide併記＝(地図)→›(幕)→›(地図)→›次 の三拍子／slideだけ＝入場で幕
// ・glide=近距離滑走（シーン内の動き）：起きずに 位置→方位→チルト の時分割で滑る（引き・回り込み・立ち上がり）
// ・pre: "#〜"＝入場の見せ玉：まず pre の画へ飛び、着地から1秒後に view を遷移なしで重ねる。
//   pre と view は同座標で書く＝実際に動くのは l= だけ（素の地図が着いてからレイヤが「点く」）
// ・c=付きシーン＝配色の幕替わり（暗転reload→自動再開）例: { title: "夜の部", view: "#4.86/37.783/137.628/l=place/c=dark" }
// ・シーン毎 hold: ms＝自動上演(▷)の「静止」時間の上書き（既定は hold=7000）。静止はフライト/滑走の着地後から数える
//   ＝遷移の長いシーンでも見る時間は削られない。幕（スライド）は slideHold: ms（既定4000・シーン毎上書き可）。
//   幕前の地図は最大2秒・幕後の三拍目は最大1.5秒＝自動で短い
// ・mobile: Δz＝縦長画面（スマホ縦）でだけ z に足す差分（例 mobile: -1.2＝一段引く）。
//   横パノラマ構図の左右切り落とし対策＝中心・チルト・方位はそのまま、ズームだけ。
//   scenes と並ぶ最上位に書けば台本全体の既定、シーン毎に書けばそのシーンだけ上書き（mobile: 0＝明示無効）
// ・公開チュートリアル（スライド抜き）にするなら export に slide: false を足す
export default { mobile:-1.2,
	scenes: [
		{ title: "白地図の日本", view: "#5/37/137/l=/c=mono", slide: "demo/slide-start.svg" },
		{ title: "地球は丸い", view: "#3/37/137/l=/c=mono", slide:"The earth is round.\nOrgthographic" },
		{ title: "白地図", view: "#8.14/35.57334/138.11457/0r/l=/c=mono", slide:"4 types of the map style:\ngsi・dark・sepia・mono(default)" },
		{ title: "地理院地図", view: "#8.14/35.57334/138.11457/0r/l=place.terrain.rail.road.facility/c=gsi" },
		{ title: "ナイト・モード", view: "#8.14/35.57334/138.11457/0r/l=place.terrain.rail.road.facility/c=dark" },
		{ title: "セピア・モード", view: "#8.14/35.57334/138.11457/0r/l=place.terrain/c=sepia" },
		{ title: "淡色地図", view: "#8.14/35.57334/138.11457/0r/l=place.terrain.rail.road.facility/c=mono"},
		{ title: "鉄道地図", pre: "#13.52/35.68696/139.72975/l=", view:"#13.52/35.68696/139.72975/l=rail" },
		{ title: "道路地図", pre: "#9.85/35.67159/139.59375/l=", view: "#9.85/35.67159/139.59375/l=road" },
		{ title: "富士山(等高線)", view: "#12.01/35.44874/138.73829/0t/0r/l=terrain", slide:"Hey, stand up, please!"},
		{ title: "富士山(3D)", view: "#12.01/35.44874/138.73829/73t/0r/l=terrain" },
		{ title: "八ヶ岳", glide: "#12.50/36.01337/138.35989/75t/-2r/l=terrain" },
		{ title: "富山湾から北アルプスを望む", glide: "#10.86/36.70497/137.54506/70t/145r/l=terrain" },
		{ title: "出羽三山から庄内平野を望む", view: "#12.04/38.61201/139.99247/74t/2r/l=place.facility" },
		{ title: "ルスツ・羊蹄山・ニセコ", view: "#12.49/42.76177/140.86911/70t/-42r/l=place.rail.road.facility" },
		{ title: "阿寒湖・屈斜路湖・摩周湖", view: "#10.58/43.60954/144.29614/75t/7r/l=place.road.facility" },
		{ title: "阿蘇五岳・外輪山・遠くに桜島", view: "#11.21/32.87603/131.04202/71t/-156r/l=place.facility" },
		{ title: "東京駅(Plateau)", view: "#18.87/35.68209/139.76340/75t/86r/l=", slide: "Plateau: 3D Libraries\nby MILT" },
		{ title: "丸の内", glide: "#16.70/35.67569/139.76455/60t/l=" },
		{ title: "レインボーブリッジ", glide: "#16.00/35.63672/139.76048/55t/160r/l=" },
		{ title: "東京羽田国際空港", glide: "#16.42/35.54889/139.78846/71t/-57r/l=" },
		{ title: "隅田川とスカイツリー", view: "#16.33/35.72628/139.81200/75t/-180r/l=" },
		{ title: "新宿高層ビル街", glide: "#16.24/35.68990/139.69321/75t/50r/l=" },
		{ title: "横浜・みなとみらい", view: "#16.33/35.45658/139.63297/72t/-91r/l=" },
		{ title: "大阪城", view: "#18.30/34.68755/135.52583/75t/-27r" },
		{ title: "京都・二条城", view: "#16.95/35.01410/135.74622/67t/-99r" },
		{ title: "日本列島", glide: "#6/35.01410/135.74622/67t/20r/l=" },
		{ title: "地球と天体", pre: "#1/35.01410/135.74622/67t/20r/l=", glide: "#1/35.01410/135.74622/67t/20r/l=sky" },
		{ title: "最後に", view: "#5/37/137/l=/c=mono", slide: "demo/slide-end.svg" },
	],
};
