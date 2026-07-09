// 自作スタイル「Quiet Mono」── 地理院MVT(optimal_bvmap)を、紙地図の踏襲をやめた
// 静かなモノクロームのデータ土台に再解釈する。主題オーバーレイが主役として映えるよう基図は控えめに引く。
// std.json と同じ式言語/vt_code フィルタを使うので ortho-japan の評価器でそのまま描ける。
export default {
	version: 8,
	name: "Quiet Mono",
	sources: { v: { type: "vector" } },
	layers: [
		{ id: "bg", type: "background", paint: { "background-color": "#f6f6f4" } },

		// 水域：全タイルで作る（minzoom無し・均一色）。描く/描かないは renderer が cam.zoom で"ビュー一律"に決める
		// （set("sea",{li,minzoom:13})）＝タイル毎の presence まだらが構造的に消える。z<13=紙の海／z13+=一律の青。
		{ id: "water", type: "fill", "source-layer": "WA", paint: { "fill-color": "#e2e6ea" } },

		// 水系 点火（面）：WA を水色に染める。水系ONで川面・湖・海が河川中心線（river）と地続きの色になる
		// （面なしだと線だけ浮いて分断された感じになる）。海の z8 ビュー一律ゲート（sea機構 li2）にも相乗り。
		{ id: "water-hi", type: "fill", "source-layer": "WA", paint: { "fill-color": "#aecbe6" } },

		// 海岸線（水涯線 WL）は撤去：水域は sea 塗り(z8+)のコントラスト（淡グレー水／白い陸）で境が見える／
		// z<8 は gint 世界海岸線が担当。WL の線は冗長で「水域の暗いボーダー」になるだけ＝描かない。
		// 復活するなら： { id:"coast", type:"line", "source-layer":"WL", paint:{ "line-color":"#6e747b", "line-width":0.8 } }

		// 水系 点火：河川中心線（RvrCL）。WA面は太い川だけ＝細流・上流はこれで初めて地図に現れる。
		// 水系チップでON/OFF（themes.js が hiddenLi で制御）。道路・鉄道より下＝橋の下を流れる。
		{
			id: "river", type: "line", "source-layer": "RvrCL",
			layout: { "line-cap": "round" },
			paint: { "line-color": "#aecbe6", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 14, 1.1, 16, 1.8], "line-opacity": 0.9 },   // 色は water-hi と統一
		},

		// 建築物：ほぼ気配だけ
		{ id: "building", type: "fill", "source-layer": "BldA", paint: { "fill-color": "#ececea" } },

		// 道路 面（z16タイルのみ）：中心線の代わりに紙色の帯を敷き、道路縁(RdEdg)がそれを縁取る＝道路が「白い面」になる。
		// 水面より上に描く＝橋・埋立の道路が水を白く抜く（地形図の作法）。幅は実幅 vt_width(cm)→px（z16≈1.94m/px）、無い道は格で近似。
		{
			id: "road-face", type: "line", "source-layer": "RdCL", minzoom: 16,
			filter: ["!=", ["get", "vt_code"], 2704],
			layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["coalesce", ["get", "vt_drworder"], 0] },
			paint: {
				"line-color": "#f6f6f4",
				"line-width": ["case", ["has", "vt_width"], ["/", ["to-number", ["get", "vt_width"]], 194],
					["match", ["get", "vt_rdctg"], "高速自動車国道等", 9, "国道", 7, "都道府県道", 5, 3]],
			},
		},

		// 鉄道：細い中間グレー。トンネル・地下（vt_railstate）は地形図の作法どおり破線＝別レイヤ。
		{
			id: "rail", type: "line", "source-layer": "RailCL",
			filter: ["match", ["get", "vt_railstate"], ["トンネル", "地下"], false, true],
			layout: { "line-cap": "round" },
			paint: { "line-color": "#c9c9c7", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.4, 16, 1.4] },
		},
		{
			id: "rail-tn", type: "line", "source-layer": "RailCL",
			filter: ["match", ["get", "vt_railstate"], ["トンネル", "地下"], true, false],
			paint: { "line-color": "#c9c9c7", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.4, 16, 1.4], "line-dasharray": [5, 4] },
		},

		// 道路：階層的なグレー。太さ・濃さで格を出すが全体は淡く。casing なし＝静か。トンネル(vt_code 2704)は破線＝別レイヤ。
		// maxzoom 16＝z16タイルでは中心線を作らない：道路縁(RdEdg)が面として道路を描くので、中心線は重ねない方が綺麗。
		// （トンネル破線 road-tn と点火 road-hi は情報なので z16 でも残す）
		{
			id: "road", type: "line", "source-layer": "RdCL", maxzoom: 16,
			filter: ["!=", ["get", "vt_code"], 2704],
			layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["coalesce", ["get", "vt_drworder"], 0] },
			paint: {
				"line-color": ["match", ["get", "vt_rdctg"],
					"高速自動車国道等", "#bdbdba", "国道", "#c6c6c3", "都道府県道", "#d2d2cf", "市区町村道等", "#e0e0dd", "#dcdcda"],
				"line-width": ["interpolate", ["linear"], ["zoom"],
					11, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 1.4, "国道", 1.1, "都道府県道", 0.7, 0.35],
					14, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 3.4, "国道", 2.6, "都道府県道", 1.6, 0.9],
					16, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 7, "国道", 5.5, "都道府県道", 3.2, 1.6]],
			},
		},
		{
			id: "road-tn", type: "line", "source-layer": "RdCL",
			filter: ["==", ["get", "vt_code"], 2704],
			layout: { "line-sort-key": ["coalesce", ["get", "vt_drworder"], 0] },
			paint: {
				"line-color": ["match", ["get", "vt_rdctg"],
					"高速自動車国道等", "#bdbdba", "国道", "#c6c6c3", "都道府県道", "#d2d2cf", "市区町村道等", "#e0e0dd", "#dcdcda"],
				"line-width": ["interpolate", ["linear"], ["zoom"],
					11, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 1.4, "国道", 1.1, "都道府県道", 0.7, 0.35],
					14, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 3.4, "国道", 2.6, "都道府県道", 1.6, 0.9],
					16, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 7, "国道", 5.5, "都道府県道", 3.2, 1.6]],
				"line-dasharray": [5, 4],
			},
		},
		// 道路縁（RdEdg・z16タイルのみに存在）：高ズームで道路が線から「面」になる＝街の見栄え。常時表示。
		{ id: "rdedg", type: "line", "source-layer": "RdEdg", paint: { "line-color": "#c6c6c3", "line-width": 0.7 } },

		// 行政界：淡いグレーの細線（破線は capsule 未対応のため実線）
		{ id: "admin", type: "line", "source-layer": "AdmBdry", paint: { "line-color": "#cececb", "line-width": 0.8, "line-opacity": 0.9 } },

		// --- "点火"レイヤー群 ---
		// 土台は常に白黒で全部見えている。各テーマは同じ形状に色を重ねるだけ＝普段は非表示、
		// チップONで buildScene に含める。再取得・再デコード不要で一瞬。色は後から自由に差し替え可。

		// 鉄道 点火：JR＝静かな緑／JR以外（私鉄・地下鉄・三セク等）＝黄緑で描き分け（vt_rtcode）。
		// トンネル・地下は破線＝別レイヤ（同色）。
		{
			id: "rail-hi", type: "line", "source-layer": "RailCL",
			filter: ["match", ["get", "vt_railstate"], ["トンネル", "地下"], false, true],
			layout: { "line-cap": "round" },
			paint: {
				"line-color": ["match", ["get", "vt_rtcode"], "JR", "#4b9e6a", "#8eb43e"],
				"line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 16, 1.9],
			},
		},
		{
			id: "rail-hi-tn", type: "line", "source-layer": "RailCL",
			filter: ["match", ["get", "vt_railstate"], ["トンネル", "地下"], true, false],
			paint: {
				"line-color": ["match", ["get", "vt_rtcode"], "JR", "#4b9e6a", "#8eb43e"],
				"line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 16, 1.9],
				"line-dasharray": [5, 4],
			},
		},
		// 駅の軌道（RailTrCL＝構内・側線含む全線路。z16タイルのみに存在）。鉄道ON＋寄った時に緑で。
		// 駅構内の扇形が浮かぶ。z16固定データなので幅はしっかりめに。
		{
			id: "railtr-hi", type: "line", "source-layer": "RailTrCL",
			layout: { "line-cap": "round" },
			paint: { "line-color": "#4b9e6a", "line-width": ["interpolate", ["linear"], ["zoom"], 16, 1.5, 19, 3.0] },
		},
		// 道路 点火：高速＝明快な青、国道＝淡い青（幹線だけ着色。都道府県道以下は土台グレーのまま）。トンネルは破線＝別レイヤ。
		{
			id: "road-hi", type: "line", "source-layer": "RdCL",
			filter: ["all", ["in", ["get", "vt_rdctg"], ["literal", ["高速自動車国道等", "国道"]]], ["!=", ["get", "vt_code"], 2704]],
			layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["coalesce", ["get", "vt_drworder"], 0] },
			paint: {
				"line-color": ["match", ["get", "vt_rdctg"], "高速自動車国道等", "#2f6cad", "#8fb2d6"],
				"line-width": ["interpolate", ["linear"], ["zoom"],
					11, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 1.8, 1.4],
					14, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 4.0, 2.8],
					16, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 8.0, 5.5]],
			},
		},
		{
			id: "road-hi-tn", type: "line", "source-layer": "RdCL",
			filter: ["all", ["in", ["get", "vt_rdctg"], ["literal", ["高速自動車国道等", "国道"]]], ["==", ["get", "vt_code"], 2704]],
			layout: { "line-sort-key": ["coalesce", ["get", "vt_drworder"], 0] },
			paint: {
				"line-color": ["match", ["get", "vt_rdctg"], "高速自動車国道等", "#2f6cad", "#8fb2d6"],
				"line-width": ["interpolate", ["linear"], ["zoom"],
					11, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 1.8, 1.4],
					14, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 4.0, 2.8],
					16, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 8.0, 5.5]],
				"line-dasharray": [5, 4],
			},
		},
		// 航路 点火：海の淡青（フェリー等の航路＝WRltLine vt_code 5902。z13以下のタイルにのみ存在＝俯瞰で見える線）。
		// themes.js が道路チップに相乗りさせる（hiddenLi）＝道路ONで一緒に点く。破線は capsule 未対応のため実線・細め。
		{
			id: "kouro", type: "line", "source-layer": "WRltLine",
			filter: ["==", ["get", "vt_code"], 5902],
			layout: { "line-cap": "round" },
			paint: { "line-color": "#7aa8cf", "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.8, 13, 1.6], "line-opacity": 0.85 },
		},
		// 行政区域 点火：暖かいオレンジ
		{
			id: "admin-hi", type: "line", "source-layer": "AdmBdry",
			paint: { "line-color": "#e2892f", "line-width": 1.1, "line-opacity": 0.95 },
		},

		// 注記：濃いグレー＋地色ハロー。読めるが主張しない。
		{
			id: "label", type: "symbol", "source-layer": "Anno",
			// 抽出は広めに（表示ON/OFFは main.js の allowlist が制御）。測量系の数値だけ抽出時に除外。
			filter: ["has", "vt_text"],   // 【切り分け中：崩れ容疑】測量数値も抽出（元は 7101等を除外してた）
			layout: {
				"symbol-placement": "point",
				"text-field": ["get", "vt_text"],
				// カテゴリで大小：主要都市>市>駅・施設>丁目・路線
				"text-size": ["interpolate", ["linear"], ["zoom"],
					10, ["match", ["get", "vt_code"], [1301, 1302, 1303, 1401], 13, 110, 12, 11],
					16, ["match", ["get", "vt_code"], [1301, 1302, 1303, 1401], 16, 110, 14.5, [210, 411, 421], 12, 13.5]],
				// 衝突優先度（小さいほど優先）：主要都市→市→駅→施設→丁目・路線
				"symbol-sort-key": ["match", ["get", "vt_code"],
					[1301, 1302, 1303, 1401], 0, 110, 1, 422, 2, [621, 631, 632, 673, 531, 532], 3, [210, 411, 421], 5, 4],
			},
			paint: { "text-color": "#86867f", "text-halo-color": "#f6f6f4", "text-halo-width": 1.1 },
		},
	],
};
