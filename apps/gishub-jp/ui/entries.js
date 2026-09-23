// サイドバーの静的エントリ定義（正本・1か所管理）
// 件数は ui/counts.json（scripts/gen-counts.mjs が manifest から焼き出す軽量メタ）。
// 省庁モジュール本体（moj/maff/estat/census の ui.js）は選択時に dynamic import されるため、
// ここに重いマニフェストを import してはならない（初期バンドルに 4MB 級 JSON が混入した前科）。
import COUNTS from './counts.json' with { type: 'json' };

export const mojSidebarEntry = () =>
    ({ dataset_code:'moj', title:'登記所備付地図（14条地図）', file_count:COUNTS.moj, license:'CC BY 4.0', _sourceId:'moj' });

export const maffSidebarEntry = () =>
    ({ dataset_code:'maff', title:'農地（筆ポリゴン）', file_count:COUNTS.maff, license:'CC BY 4.0', _sourceId:'maff' });

export const estatSidebarEntry = () =>
    ({ dataset_code:'estat', title:'統計GIS 小地域境界', file_count:COUNTS.estat, license:'CC BY', _sourceId:'estat' });

export const census2025SidebarEntry = () =>
    ({ dataset_code:'census2025', title:'国勢調査 2025 速報集計', file_count:1, license:'CC BY', _sourceId:'estat', attribution:'総務省統計局' });

export const censusSmall2020SidebarEntry = () =>
    ({ dataset_code:'census-small-2020', title:'国勢調査 2020 基本集計', file_count:1, license:'CC BY', _sourceId:'estat', attribution:'総務省統計局' });

export const census2015SidebarEntry = () =>
    ({ dataset_code:'census2015', title:'国勢調査 2015 基本集計', file_count:1, license:'CC BY', _sourceId:'estat', attribution:'総務省統計局' });

export const npsSidebarEntry = () =>
    ({ dataset_code:'nps', title:'国立公園（区域・地種区分）', file_count:35, license:'政府標準利用規約(CC BY互換)', _sourceId:'env', attribution:'環境省 環境ジオポータル' });

// 地震本部＝文部科学省ウェブサイト利用規約（CC BY 4.0 互換・商用可・出典「地震調査研究推進本部」）
// https://www.jishin.go.jp/agreement/ → https://www.mext.go.jp/b_menu/1351168.htm
export const jishinSeismicSidebarEntry = () =>
    ({ dataset_code:'seismic', title:'地震観測施設（11観測網）', file_count:9276,
       license:'文科省利用規約(CC BY互換)', _sourceId:'jishin', attribution:'地震調査研究推進本部',
       note:'地震計・GNSS・重力・電磁気・海底・歪・検潮・地下水／2013〜2026年版の重ね合わせ' });

export const jishinFaultSidebarEntry = () =>
    ({ dataset_code:'fault', title:'震源断層モデル（2009年版）', file_count:231,
       license:'文科省利用規約(CC BY互換)', _sourceId:'jishin', attribution:'地震調査研究推進本部',
       note:'全国地震動予測地図・93断層帯の上端トレース（活断層そのものではない）' });

export const municSidebarEntry = () =>
    ({ dataset_code:'munic', title:'市区町村のオープンデータ', file_count:COUNTS.municSets, license:'CC BY ほか（自治体ごと）', _sourceId:'munic',
       note:`${COUNTS.munic} 自治体・地番図・防災・施設など` });

export { COUNTS };
