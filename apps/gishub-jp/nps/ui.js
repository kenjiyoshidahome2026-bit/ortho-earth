// 環境省 国立公園 区域・地種区分（bucket: GIS/pbf/nps_all・全35公園）
// データ生成は apps/uploader の nps()＝環境ジオポータル FeatureServer → GeoPBF。
// 全国版に無い日高山脈襟裳十勝（2024-06指定・35番目）は北海道事務所データ（nps_hokkaido）で補完済み。
import { ctx } from '../ui/ctx.js';

const NPS_ENTRY = {
    name:        'nps_all',
    target:      'nps_all',   // bucket(GIS/pbf) のバケット名＝bare指定で IDBキャッシュ込みロード
    description: '国立公園区域・地種区分 全35公園（特別保護地区／第1〜3種特別地域／海域公園地区／普通地域）',
    license:     '政府標準利用規約（CC BY 4.0互換）',
    attribution: '環境省 環境ジオポータル（国立公園区域等 nps_all／nps_hokkaido）',
    link:        'https://geo.env.go.jp/',
};

// 地球描画時の tip/pop 用ラベル辞書
const NPS_DS = {
    title: '環境省 国立公園（区域・地種区分）',
    attributes: { 名称: '公園名', 地域区: '地種区分' },
    codelist: {},
};

export function renderNpsView() {
    ctx.renderExecView(NPS_ENTRY, ctx.goHome, null, NPS_DS);
}
