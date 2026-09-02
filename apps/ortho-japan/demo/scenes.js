// デモの台本（map.gadget.demo に渡す opts 丸ごと）。index.html はこのファイルを読むだけ＝台本編集はここ1枚。
// スライド画像(svg)はこのファイルと同じ demo/ に置き、下の `?url` import でvite にバンドルさせる
//   ＝base(/japan/)差替えも vite が面倒を見る（生URL "demo/〜" 直書きは public/ に無いと 404 になるので使わない）。
// ★台本の一行＝共有URLハッシュそのまま（アドレスバーからコピーして貼るだけでシーンになる）。フルスペック（l= 込み）推奨。
// ・slide=画像URL（下の import 変数を渡す）か "生テキスト"（紙のカードに一言・\n改行可）
// ・caption: "〜"＝オート上映（▷）の静止中に画面上部へ出す字幕（無ければ title を代用表示）
// ・view+slide併記＝(地図)→›(幕)→›(地図)→›次 の三拍子／slideだけ＝入場で幕
// ・glide=近距離滑走（シーン内の動き）：起きずに 位置→方位→チルト の時分割で滑る（引き・回り込み・立ち上がり）
// ・pre: "#〜"＝入場の見せ玉：まず pre の画へ飛び、着地から1秒後に view を遷移なしで重ねる。
//   pre と view は同座標で書く＝実際に動くのは l= だけ（素の地図が着いてからレイヤが「点く」）
// ・c=付きシーン＝配色の幕替わり（暗転reload→自動再開）例: { title: "夜の部", view: "#5.86/37.783/137.628/l=place/c=dark" }
// ・シーン毎 hold: 秒＝自動上演(▷)の「静止」時間の上書き（既定は 5.5 秒）。静止はフライト/滑走の着地後から数える
//   ＝遷移の長いシーンでも見る時間は削られない。幕（スライド）は slideHold: 秒（既定4秒・シーン毎上書き可）。
//   幕前の地図は最大2秒・幕後の三拍目は最大1.5秒＝自動で短い。時間は台本もオプションも全部「秒」（v2統一）。
// ・{ via: "#〜", travel: 秒 } 行＝通過点（連続ドリー）：view/glide 行の間に挟むと、直前の着点から次の着点まで
//   1本のスプラインで貫く（5自由度：経緯度=曲線／zoom/pitch/bearing=区間補間）。travel＝その点に到達するまでの
//   区間尺[秒]（省略＝経路長比例の自動）・着点行の travel＝最終区間。via はシーンに数えない（歩数・目次に出ない）。
//   道中はカメラのみ＝l=/c= は直前シーンで設定しておく。書式は .scenes（ドロップ台本）と完全に同一＝demo/scene-format.md が正典。
// ・mobile: Δz＝縦長画面（スマホ縦）でだけ z に足す差分（例 mobile: -1.2＝一段引く）。
//   横パノラマ構図の左右切り落とし対策＝中心・チルト・方位はそのまま、ズームだけ。
//   scenes と並ぶ最上位に書けば台本全体の既定、シーン毎に書けばそのシーンだけ上書き（mobile: 0＝明示無効）
// ・言語＝en基準・拡張可能：title は英語が正。シーンに言語コードのフィールド（jp: "〜"・en: "〜"…）を足すと
//   ?lang=jp 等で表示が切替わる（バー・字幕・一覧が追随）。解決は scene[lang] → 無ければ title を使用
// ・公開チュートリアル（スライド抜き）にするなら export に slide: false を足す
import slideStart from "./slide-start.svg?url";   // vite が /assets/…svg にバンドル＝base 差替え自動
import slideEnd   from "./slide-end.svg?url";
export default { mobile:-1.2,
	// preload＝重いデータ（3D都市）の明示先読みリスト（この順に▶の瞬間から焼く）。名は public/plateau-sets.json のカタログ名そのまま。
	// 未指定なら台本の停止位置から自動導出（重心タイブレーク）だが、明示＝決定的＝台本と一緒に手で調整できる。
	// 橋梁（「◯◯（橋梁）」）はサイズ一桁小さい割にシーンの主役（レインボーブリッジ等）＝中心区とペアで前へ。
	"hold": 3,
	"slideHold": 3,
	preload: ["千代田区（橋梁）", "千代田区", "中央区（橋梁）", "中央区", "港区（橋梁）", "港区",
		"大田区", "大田区（橋梁）", "墨田区", "墨田区（橋梁）", "新宿区",
		"横浜西区", "横浜市（橋梁）", "大阪中央区", "大阪市（橋梁）", "京都中京区",
		"荒川区", "横浜中区", "京都右京区"],
	scenes: [
		{ title: "Blank Map of Japan", jp: "白地図の日本", view: "#6.6/37/137/l=/c=mono", hold:0, slide: slideStart, mobile: 0 },   // z6.6＝world既定化(9/2)後も基図帯（z<6.5は全球ハイプソ＝白にならない）。mobile:0＝-1.2既定だと5.4で色が付くため据置（幕が主役の開幕＝切れは許容）
		{ title: "The Earth is Round = orthographic", jp: "地球は丸い", view: "#4/37/137/l=/c=mono" },
		{ title: "4 map styles", jp: "4つの地図モード", view: "#9.14/35.57334/138.11457/0r/l=/c=mono" },
		{ title: "GSI Mode", jp: "地理院地図", view: "#9.14/35.57334/138.11457/0r/l=place.terrain.rail.road.facility/c=gsi", hold: 1.5 },
		{ title: "Dark Mode", jp: "ダーク・モード", view: "#9.14/35.57334/138.11457/0r/l=place.terrain.rail.road.facility/c=dark", hold: 1.5 },
		{ title: "Sepia Mode", jp: "セピア・モード", view: "#9.14/35.57334/138.11457/0r/l=place.terrain/c=sepia", hold: 1.5 },
		{ title: "Mono Mode", jp: "淡色地図", view: "#9.14/35.57334/138.11457/0r/l=place.terrain.rail.road.facility/c=mono", hold: 1.5 },
		{ title: "Railway Map", jp: "鉄道地図", pre: "#14.52/35.68696/139.72975/l=", view:"#14.52/35.68696/139.72975/l=rail" },
		{ title: "Road Map", jp: "道路地図", pre: "#10.85/35.67159/139.59375/l=", view: "#10.85/35.67159/139.59375/l=road" },
		{ title: "Hey! stand up, please.", jp: "さあ、立ちあがろう！", view: "#13.01/35.44874/138.73829/0t/0r/l=terrain",hold:1},
		{ title: "Mt. Fuji", jp: "富士山", view: "#13.01/35.44874/138.73829/73t/0r/l=terrain" },
		{ title: "Yatsugatake", jp: "八ヶ岳", glide: "#13.50/36.01337/138.35989/75t/-2r/l=terrain", hold:1 },
		{ title: "Northern Alps from Toyama Bay", jp: "富山湾から北アルプスを望む", glide: "#11.86/36.70497/137.54506/70t/145r/l=terrain" },
	//	{ title: "Shonai Plain from Dewa Sanzan", jp: "出羽三山から庄内平野を望む", view: "#13.04/38.61201/139.99247/74t/2r/l=place.facility" },
	//	{ title: "Rusutsu, Mt. Yotei & Niseko", jp: "ルスツ・羊蹄山・ニセコ", view: "#13.49/42.76177/140.86911/70t/-42r/l=place.rail.road.facility" },
		{ title: "Lakes Akan, Kussharo & Mashu", jp: "阿寒湖・屈斜路湖・摩周湖", view: "#11.58/43.60954/144.29614/75t/7r/l=place.road.facility" },
		{ title: "Aso Caldera, Sakurajima Afar", jp: "阿蘇五岳・外輪山・遠くに桜島", view: "#12.21/32.87603/131.04202/71t/-156r/l=place.facility" },
		{ title: "Plateau: Tokyo Station", jp: "東京駅", view: "#18.67/35.68183/139.76306/75t/108r/l=" },
		{ title: "Marunouchi", jp: "丸の内", glide: "#17.70/35.67569/139.76455/60t/l=" },
		{ title: "Rainbow Bridge", jp: "レインボーブリッジ", glide: "#17.00/35.63672/139.76048/55t/160r/l=" },
		{ title: "Tokyo Haneda Airport", jp: "東京羽田国際空港", glide: "#17.42/35.54889/139.78846/71t/-57r/l=" },
		{ title: "Sumida River & Tokyo Skytree", jp: "隅田川とスカイツリー", view: "#17.33/35.72628/139.81200/75t/-180r/l=" },
		{ title: "Shinjuku Skyscrapers", jp: "新宿高層ビル街", glide: "#17.24/35.68990/139.69321/75t/50r/l=" },
		{ title: "Yokohama Minato Mirai", jp: "横浜・みなとみらい", view: "#17.33/35.45658/139.63297/72t/-91r/l=" },
		// { title: "Sapporo Station", jp: "札幌駅前", view: "#16.84/43.06595/141.35100/46t/132r/l=" },
		// { title: "Hiroshima Station", jp: "広島駅", view: "#17.96/34.39602/132.47498/59t/24r/l=place" },
		// { title: "Hiroshima Castle Park", jp: "広島城公園", glide: "#18.18/34.39903/132.45364/75t/47r/l=place" },
		// { title: "International Conference Center", jp: "国際会議場", glide: "#17.88/34.39041/132.45141/52t/-6r/l=place.facility" },
		// { title: "Matsuyama Station", jp: "松山駅", view: "#19.09/33.84073/132.75194/75t/37r/l=place" },
		// { title: "Matsuyama Castle", jp: "松山城", glide: "#19.38/33.84599/132.76597/75t/37r/l=place" },
		// { title: "Dogo Onsen", jp: "道後温泉", glide: "#18.79/33.85199/132.78622/33t/28r/l=" },
		{ title: "Osaka Castle", jp: "大阪城", view: "#19.33/34.68836/135.52471/70t/-37r/l=" },
		{ title: "Nijo Castle, Kyoto", jp: "京都・二条城", view: "#17.95/35.01410/135.74622/67t/-99r" },
		{ title: "The Japanese Archipelago", jp: "日本列島", glide: "#7/35.01410/135.74622/67t/20r/l=" },
		{ title: "Earth & Celestial Sphere", jp: "地球と天体", pre: "#2/35.01410/135.74622/67t/20r/l=", glide: "#2/35.01410/135.74622/67t/20r/l=sky", hold:3.5 },
		{ title: "The Solar System", jp: "太陽系", glide: "#-17/35/135/67t/20r/l=" },
		{ via: "#2/35/135/67t/20r/l=",travel:4 },
		{ title: "Finale", jp: "最後に", view: "#6/37/137/l=/c=mono", hold: 1, slide: slideEnd },
	],
};
//#16.84/43.06595/141.35100/46t/132r/l=