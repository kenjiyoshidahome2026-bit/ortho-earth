// 自作スタイル「Quiet Mono」── 地理院MVT(optimal_bvmap)を、紙地図の踏襲をやめた
// 静かなモノクロームのデータ土台に再解釈する。主題オーバーレイが主役として映えるよう基図は控えめに引く。
// std.json と同じ式言語/vt_code フィルタを使うので ortho-japan の評価器でそのまま描ける。
export default {
	version: 8,
	name: "Quiet Mono",
	sources: { v: { type: "vector" } },
	layers: [
		{ id: "bg", type: "background", paint: { "background-color": "#f6f6f4" } },

		// 水域：地よりわずかに沈む・ほのかに寒色（判読性のため）
		{ id: "water", type: "fill", "source-layer": "WA", paint: { "fill-color": "#e2e6ea" } },

		// 建築物：ほぼ気配だけ
		{ id: "building", type: "fill", "source-layer": "BldA", paint: { "fill-color": "#ececea" } },

		// 鉄道：細い中間グレー
		{
			id: "rail", type: "line", "source-layer": "RailCL",
			layout: { "line-cap": "round" },
			paint: { "line-color": "#c9c9c7", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.4, 16, 1.4] },
		},

		// 道路：階層的なグレー。太さ・濃さで格を出すが全体は淡く。casing なし＝静か。
		{
			id: "road", type: "line", "source-layer": "RdCL",
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

		// 行政界：淡いグレーの細線（破線は capsule 未対応のため実線）
		{ id: "admin", type: "line", "source-layer": "AdmBdry", paint: { "line-color": "#cececb", "line-width": 0.8, "line-opacity": 0.9 } },

		// --- "点火"レイヤー群 ---
		// 土台は常に白黒で全部見えている。各テーマは同じ形状に色を重ねるだけ＝普段は非表示、
		// チップONで buildScene に含める。再取得・再デコード不要で一瞬。色は後から自由に差し替え可。

		// 鉄道 点火：静かな緑（路線中心線）
		{
			id: "rail-hi", type: "line", "source-layer": "RailCL",
			layout: { "line-cap": "round" },
			paint: { "line-color": "#4b9e6a", "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.6, 16, 1.9] },
		},
		// 駅の軌道（RailTrCL＝構内・側線含む全線路。z16タイルのみに存在）。鉄道ON＋寄った時に緑で。
		// 駅構内の扇形が浮かぶ。z16固定データなので幅はしっかりめに。
		{
			id: "railtr-hi", type: "line", "source-layer": "RailTrCL",
			layout: { "line-cap": "round" },
			paint: { "line-color": "#4b9e6a", "line-width": ["interpolate", ["linear"], ["zoom"], 16, 1.5, 19, 3.0] },
		},
		// 道路 点火：高速＝明快な青、国道＝淡い青（幹線だけ着色。都道府県道以下は土台グレーのまま）
		{
			id: "road-hi", type: "line", "source-layer": "RdCL",
			filter: ["in", ["get", "vt_rdctg"], ["literal", ["高速自動車国道等", "国道"]]],
			layout: { "line-cap": "round", "line-join": "round", "line-sort-key": ["coalesce", ["get", "vt_drworder"], 0] },
			paint: {
				"line-color": ["match", ["get", "vt_rdctg"], "高速自動車国道等", "#2f6cad", "#8fb2d6"],
				"line-width": ["interpolate", ["linear"], ["zoom"],
					11, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 1.8, 1.4],
					14, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 4.0, 2.8],
					16, ["match", ["get", "vt_rdctg"], "高速自動車国道等", 8.0, 5.5]],
			},
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
			filter: ["all", ["has", "vt_text"],
				["!", ["in", ["get", "vt_code"], ["literal", [7101, 7102, 7103, 7201, 7711]]]]],
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
