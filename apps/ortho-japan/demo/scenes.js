// デモの台本（map.gadget.demo に渡す opts 丸ごと）。index.html はこのファイルを読むだけ＝台本編集はここ1枚。
// スライド画像は public/demo/ に置く（URLは "demo/〜" で参照）。※publicのJSはvite掟でimport不可＝台本はソース側のここ。
// ★台本の一行＝共有URLハッシュそのまま（アドレスバーからコピーして貼るだけでシーンになる）。フルスペック（l= 込み）推奨。
// ・slide="画像URL"（public/demo/ に置く）か "生テキスト"（紙のカードに一言・\n改行可）
// ・view+slide併記＝(地図)→›(幕)→›(地図)→›次 の三拍子／slideだけ＝入場で幕
// ・glide=近距離滑走（シーン内の動き）：起きずに 位置→方位→チルト の時分割で滑る（引き・回り込み・立ち上がり）
// ・c=付きシーン＝配色の幕替わり（暗転reload→自動再開）例: { title: "夜の部", view: "#4.86/37.783/137.628/l=place/c=dark" }
// ・シーン毎 hold: ms＝自動上演(▷)の滞在時間の上書き（既定は hold=7000。スライド後の三拍目だけは自動で短い＝最大1.5秒）
// ・公開チュートリアル（スライド抜き）にするなら export に slide: false を足す
export default {
	scenes: [
//		{ title: "地球は、球のまま", view: "#3.2/36/138" },
		{ title: "スタート", view: "#5/37/137/l=/c=mono", slide: "demo/slide-01.svg" },
		{ title: "地球は丸い", view: "#2/37/137/l=/c=mono" },
		{ title: "富士山", view: "#12/35.47124/138.72793/75t/-1r/l=place.terrain" },
		{ title: "八ヶ岳", glide: "#12.50/36.01337/138.35989/75t/-1r/l=place.terrain" },
		{ title: "北アルプス", glide: "#11.71/36.69051/137.57752/73t/145r/l=place.terrain" },
		
		{ title: "丸の内 — 3Dは黙って立ち上がる", view: "#15.5/35.681/139.765/60t" },
		{ title: "レインボーブリッジへ — 引きの画", glide: "#16.61/35.64161/139.76003/55t/160r/l=place.terrain" },
	],
};
