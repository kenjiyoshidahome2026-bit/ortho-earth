// 自作スタイル「Quiet Mono」── 地理院MVT(optimal_bvmap)を、紙地図の踏襲をやめた
// 静かなモノクロームのデータ土台に再解釈する。主題オーバーレイが主役として映えるよう基図は控えめに引く。
// std.json と同じ式言語/vt_code フィルタを使うので ortho-vt の評価器でそのまま描ける。
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

		// 注記：濃いグレー＋地色ハロー。読めるが主張しない。
		{
			id: "label", type: "symbol", "source-layer": "Anno",
			filter: ["has", "vt_text"],
			layout: {
				"symbol-placement": "point",
				"text-field": ["get", "vt_text"],
				"text-size": ["interpolate", ["linear"], ["zoom"], 10, 11, 14, 12.5, 16, 13.5],
				"symbol-sort-key": ["coalesce", ["get", "vt_arrng"], 0],
			},
			paint: { "text-color": "#86867f", "text-halo-color": "#f6f6f4", "text-halo-width": 1.1 },
		},
	],
};
