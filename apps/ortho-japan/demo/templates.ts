// scenes エディタの雛形（第4便・2026-10-24・PLATEAU AWARD 向け）＝第1〜3便の道具（字幕の型・カード・出典・時刻と光・周回/チルト/寄り・溶け替え）を一通り使う見本。
// エディタの「雛形」から読む（読んだら普通の台本＝⌘Z で戻せる）。視点は目安＝実データの上で 📷 撮り直して詰める前提。
// 視点は 2026-10-24 に Mac の実データ（WebGPU）で撮り直した（横浜 2・東京 4・防災 3）。
// 時刻は "HH:MM"（その日の現地時刻・date の日）＝light:true で太陽と影が時刻に付いてくる（影は WebGPU）。
const CREDIT = { ja: "3D都市モデル：国土交通省 Project PLATEAU（CC BY 4.0）", en: "3D city model: MLIT Project PLATEAU (CC BY 4.0)" };
const BY = { ja: "ortho-earth ― ブラウザだけで動く 3D 地球儀エンジン", en: "ortho-earth ― a 3D globe engine that runs in the browser" };

export interface SceneTemplate { id: string; name: Record<string, string>; doc: Record<string, unknown> }

export const TEMPLATES: SceneTemplate[] = [
	{
		id: "yokohama-day", name: { ja: "横浜 ― 港の一日（時刻と影）", en: "Yokohama ― a day at the port (time & shadows)" },
		doc: {
			type: "scenes", frame: "16:9", waitLoading: true, light: true, date: "2026-06-21", credit: CREDIT,
			title: "横浜 ― 港の一日",
			opening: { title: { ja: "横浜 ― 港の一日", en: "Yokohama ― A Day at the Port" }, sub: { ja: "3D 都市モデルで、朝から夜まで", en: "From dawn to night, in 3D city models" }, by: BY },
			ending: { title: "ortho-earth", sub: { ja: "サーバーなし・ブラウザだけで", en: "No server ― just the browser" } },
			scenes: [
				{ title: "横浜", en: "Yokohama", sub: { ja: "みなとみらい 21", en: "Minato Mirai 21" }, look: "center", view: "#15.2/35.4560/139.6330/60t/-30r/l=", time: "05:30", hold: 3.5, orbit: 12 },
				{ title: "ランドマークタワー", en: "Landmark Tower", look: "pin", glide: "#17.2/35.4547/139.6314/70t/40r/l=", travel: 6, time: "09:00", hold: 3, orbit: 30 },
				{ title: "赤レンガ倉庫", en: "Red Brick Warehouse", look: "pin", glide: "#17.4/35.4527/139.6425/65t/120r/l=", travel: 6, time: "12:00", hold: 3, orbit: -25 },
				{ title: "山下公園・氷川丸", en: "Yamashita Park & Hikawa Maru", look: "lower", glide: "#17.8/35.4470/139.6510/62t/-150r/l=", travel: 6, time: "15:30", hold: 3, rise: 8 },
				{ title: "横浜ベイブリッジ", en: "Yokohama Bay Bridge", sub: { ja: "夕暮れ", en: "Dusk" }, look: "lower", fade: "#15.8/35.4560/139.6700/70t/-100r/l=", dissolve: true, travel: 1.5, time: "18:45", hold: 4, push: 0.5 },
				{ title: "夜のみなとみらい", en: "Minato Mirai at night", look: "center", glide: "#16.6/35.4555/139.6345/65t/-80r/l=", travel: 7, time: "20:30", hold: 4, orbit: 20 },
			],
		},
	},
	{
		id: "tokyo-core", name: { ja: "東京 ― 都心を巡る（周回と溶け替え）", en: "Tokyo ― a tour of the centre (orbits & dissolves)" },
		doc: {
			type: "scenes", frame: "16:9", waitLoading: true, light: true, date: "2026-11-03", credit: CREDIT,
			title: "東京 ― 都心を巡る",
			opening: { title: { ja: "東京 ― 都心を巡る", en: "Tokyo ― Around the Centre" }, sub: { ja: "PLATEAU の 3D 都市モデル", en: "PLATEAU 3D city models" }, by: BY },
			ending: { title: "ortho-earth", sub: { ja: "サーバーなし・ブラウザだけで", en: "No server ― just the browser" } },
			scenes: [
				{ title: "東京駅・丸の内", en: "Tokyo Station & Marunouchi", look: "lower", view: "#17.4/35.6812/139.7668/45t/90r/l=", time: "08:30", hold: 3, orbit: 25 },
				{ title: "東京タワー", en: "Tokyo Tower", look: "pin", glide: "#17/35.6586/139.7454/68t/20r/l=", travel: 7, time: "11:00", hold: 3, orbit: 40 },
				{ title: "渋谷", en: "Shibuya", look: "lower", fade: "#17.0/35.6595/139.7005/65t/135r/l=", dissolve: true, travel: 1.2, time: "13:30", hold: 3, push: 0.4 },
				{ title: "新宿副都心", en: "Shinjuku", sub: { ja: "都庁と超高層ビル群", en: "Metropolitan Government & skyscrapers" }, look: "lower", glide: "#16.6/35.6896/139.6917/70t/-120r/l=", travel: 7, time: "16:00", hold: 3, orbit: -30 },
				{ title: "東京スカイツリー", en: "Tokyo Skytree", look: "pin", fade: "#16.4/35.7101/139.8107/66t/-160r/l=", dissolve: true, travel: 1.2, time: "17:00", hold: 4, rise: 10 },
				{ title: "東京", en: "Tokyo", look: "center", view: "#15.2/35.6800/139.7600/58t/-20r/l=", travel: 6, time: "18:00", hold: 4, orbit: 15 },
			],
		},
	},
	{
		id: "flood-east-tokyo", name: { ja: "防災 ― 東京の東、川にはさまれた街（洪水浸水想定）", en: "Disaster risk ― east Tokyo between two rivers (flood map)" },
		doc: {
			type: "scenes", frame: "16:9", waitLoading: true,
			credit: { ja: "3D都市モデル：国土交通省 Project PLATEAU（CC BY 4.0）／洪水浸水想定区域：ハザードマップポータルサイト（国土交通省）", en: "3D city model: MLIT Project PLATEAU (CC BY 4.0) / Flood inundation: Hazard Map Portal Site (MLIT)" },
			title: "防災 ― 川にはさまれた街",
			opening: { title: { ja: "川にはさまれた街", en: "A City Between Two Rivers" }, sub: { ja: "3D 都市モデルと洪水浸水想定で見る", en: "Seen through 3D city models and flood maps" }, by: BY },
			ending: { title: "ortho-earth", sub: { ja: "地図を、自分ごとに", en: "Make the map your own" } },
			scenes: [
				{ title: "東京の東", en: "East Tokyo", sub: { ja: "荒川と江戸川のあいだ", en: "Between the Arakawa and Edogawa rivers" }, look: "lower", view: "#14.6/35.695/139.855/50t/-15r/l=", hold: 3.5, raster: [], orbit: 10 },
				{ title: "低い土地に広がる住宅地", en: "Homes on low-lying land", look: "lower", glide: "#15.2/35.690/139.862/62t/30r/l=", travel: 6, hold: 3 },
				{ title: "想定最大規模の洪水", en: "The largest flood assumed", sub: { ja: "洪水浸水想定区域", en: "Flood inundation area" }, look: "lower", glide: "#15.2/35.690/139.862/62t/60r/l=", travel: 3, hold: 5, raster: ["flood-max"], orbit: 25 },
				{ title: "船堀駅のあたり", en: "Around Funabori Station", look: "pin", glide: "#15.8/35.6836/139.8643/64t/100r/l=", travel: 6, hold: 4, rise: 6 },
				{ title: "地図を、自分ごとに", en: "Make the map your own", look: "center", glide: "#14.6/35.700/139.840/48t/-20r/l=", travel: 7, hold: 4, raster: [] },
			],
		},
	},
];
