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

export { COUNTS };
