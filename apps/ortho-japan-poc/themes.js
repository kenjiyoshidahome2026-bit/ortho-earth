// テーマ分類：地理院 optimal_bvmap の注記カテゴリ(vt_code)を「どの主題チップに属すか」で仕分ける。
// allowlist＝ONのテーマのカテゴリだけ描く（紙地図の全部盛りをやめる）。分類は純関数＝layerState と zoom を
// 引数で受け、グローバルに触れない。UIトグル状態(layerState)自体は main が保持・変更する。

export const CHOME_MINZOOM = 14.5;   // 丁目は寄った時だけ
export const RAILTR_MINZOOM = 13.5;  // 駅の軌道は寄った時だけ（構内detail）
export const defaultLayerState = { chimei: true, chikei: false, river: false, rail: false, road: false, admin: false, shisetsu: false };

// 各テーマチップは「色」と「その名前」を一緒に点火する：道路→IC/JCT、鉄道→駅、行政区域→行政単位名。
const CHIMEI_CODES = new Set([140, 1401, 1402, 1403, 220, 110]);   // 地名(常時)：都道府県・主要都市・市・町村・地区・区
const CHOME_CODES = new Set([210]);                           // 丁目：粒度が一段細かい→寄った時(z14.5〜)だけ自動表示
// 地形は 3xx 帯が丸ごと自然地形（実測：山311/312/316・湖沼321・河川322・沢323・高原331・
// 峠火山332・山地333・岬崎343・海345・浜347・島352・礁353…）。範囲判定＝未見コードも取りこぼさない。
// （施設の大使館/郵便局等は 32xx＝番号帯が別なので誤爆しない）
const isChikei = c => c >= 300 && c <= 399;
const ROAD_CODES = new Set([2941, 2942, 2943, 2944, 2945, 412, 411, 2901, 2902, 2903, 2904]); // 道路ON：高速IC/JCT・SA/PA/SIC・都市高速JCT/路線名・国道/高速番号
const RAIL_CODES = new Set([422, 421, 431, 441]);             // 鉄道ON：駅名・鉄道路線名・港・空港/飛行場名（交通ハブを鉄道に集約）
const GYOSEI_CODES = new Set([130]);                          // 行政区域ON：郡（都道府県・区は地名側へ）
const SURVEY_NOISE = new Set([7101, 7102, 7103, 7201, 7711]); // 標高点・水準点・水深（施設には出さない）
// 陸の測量点（公式コード表 optbv_featurecodes）：7102三角点・7201標高点(測点)・7221標高(火山)だけ出す。
// 等高線ON時だけ、地物別の記号(shields.js)＋標高値で。水準点(7103)/電子基準点(7101)は低ランクまで膨大でクラッタ＝除外。
// 水系(7701水面標高/7711水深)も陸の等高線文脈外なので除外。地形図の"顔"になる三角点・標高点に絞る。
const SURVEY_LAND = new Set([7102, 7201, 7221]);
const isNum = t => /^\d+(\.\d+)?$/.test(t);                    // 純粋な数値（標高・水深等の計測値）は施設に出さない
// 施設＝他テーマに属さない残り全部（省庁・大学・神社・寺・大使館・郵便局・橋・トンネル…）。取りこぼし防止。
const CLAIMED = new Set([...CHIMEI_CODES, ...CHOME_CODES, ...ROAD_CODES, ...RAIL_CODES, ...GYOSEI_CODES]);

// style に依存するのは "点火"層のインデックスだけ。style を受けて分類関数を返す。
export function createThemes(style) {
	const liOf = id => style.layers.findIndex(L => L.id === id);
	const LI_RAILHI = liOf("rail-hi"), LI_RAILHITN = liOf("rail-hi-tn"), LI_RAILTR = liOf("railtr-hi"),
		LI_ROADHI = liOf("road-hi"), LI_ROADHITN = liOf("road-hi-tn"), LI_ADMINHI = liOf("admin-hi"),
		LI_KOURO = liOf("kouro"), LI_RIVER = liOf("river"), LI_WATERHI = liOf("water-hi");

	// "点火"層は既定で隠す（土台グレーが見えている）。ONで色が乗る。
	function hiddenLi(layerState, zoom) {
		const h = new Set();
		if (!layerState.rail) { h.add(LI_RAILHI); h.add(LI_RAILHITN); }
		if (!layerState.rail || zoom < RAILTR_MINZOOM) h.add(LI_RAILTR);   // 駅の軌道は鉄道ON＋寄った時だけ
		if (!layerState.road) { h.add(LI_ROADHI); h.add(LI_ROADHITN); }
		if (!layerState.road) h.add(LI_KOURO);   // 航路は道路チップに相乗り
		if (!layerState.admin) h.add(LI_ADMINHI);
		if (!layerState.river) { h.add(LI_RIVER); h.add(LI_WATERHI); }  // 水系＝河川中心線＋WA面の着色
		return h;
	}
	// ラベル集合を allowlist で間引く。ONのテーマのカテゴリだけ通す。
	function filterLabels(all, layerState, zoom, showNumbers) {
		return all.filter(L => {
			const c = L.code;
			if (showNumbers && SURVEY_LAND.has(c)) return true;   // 等高線ON＝陸の測量点(三角点/標高点/水準点/電子基準点/火山標高)だけ通す。記号はコード別(shields.js)
			return (layerState.chimei && CHIMEI_CODES.has(c))
				|| (layerState.chimei && zoom >= CHOME_MINZOOM && CHOME_CODES.has(c))   // 丁目は寄った時だけ
				|| (layerState.chikei && isChikei(c))         // 地形＝3xx帯（山/湖/川/岬/海/島…）
				|| (layerState.road && ROAD_CODES.has(c))     // 道路ON＝IC/JCT/路線番号も点火
				|| (layerState.rail && RAIL_CODES.has(c))     // 鉄道ON＝駅名/路線名も点火
				|| (layerState.admin && GYOSEI_CODES.has(c))  // 行政区域ON＝行政単位名も点火
				|| (layerState.shisetsu && !CLAIMED.has(c) && !isChikei(c) && !SURVEY_NOISE.has(c) && !isNum(L.text)); // 施設＝残り全部（数値は除く）
		});
	}
	return { hiddenLi, filterLabels };
}
