// 入口（main.ts）の型の補い。
// ・common（packages/common）は src の .ts を直に束ねる＝common の型検査と同じ補い（File System Access API・*.scss）をここでも読む
// ・geopbf の convert/pool.ts は Node でも動く（typeof process で見分ける）＝その判定が読む欄だけ（@types/node は入れない＝setTimeout 等の型をブラウザのまま保つ）
// ・globalThis._execGlobeView＝将来の外部連携用の口
// ・__DATA_JAPAN__＝vite.config の define
// ・census/ui.ts が読む jp の国勢調査 JSON＝市区町村コードで引く表（JSON の推論型は 1,900 個の固定キー＝変数で引けない）
/// <reference path="../../packages/common/src/ambient.d.ts" />
declare var process: { versions?: { node?: string } } | undefined;
declare var _execGlobeView: unknown;
// vite.config の define（観測点の GeoPBF の置き場＝ortho-data/japan/）
declare const __DATA_JAPAN__: string;

// 国勢調査の表（packages/jp/census/*.json）。キー＝市区町村コード（ages は '_national' も）
type CensusCodeMap<T> = Record<string, T>;
declare module '@ortho-earth/jp/census/2020-pop.json' { const v: CensusCodeMap<number[]>; export default v; }   // [総数, 男, 女]
declare module '@ortho-earth/jp/census/2025-pop.json' { const v: CensusCodeMap<{ pop: number[]; pop2020: number; popChange: number; hh: number; hh2020: number }>; export default v; }
declare module '@ortho-earth/jp/census/2020-stats.json' { const v: CensusCodeMap<{ ind: number[]; occ: number[]; eco: number[] }>; export default v; }
declare module '@ortho-earth/jp/census/2015-stats.json' { const v: CensusCodeMap<{ pop: number[]; hh: number; ind: number[]; occ: number[]; eco: number[] }>; export default v; }
declare module '@ortho-earth/jp/census/2020-ages.json' { const v: CensusCodeMap<number[]>; export default v; }   // 32 要素（男16＋女16）
declare module '@ortho-earth/jp/census/2015-ages.json' { const v: CensusCodeMap<number[]>; export default v; }
declare module '@ortho-earth/jp/census/2020-household.json' { const v: CensusCodeMap<{ fam: number[]; own: number[]; dwell: number[] }>; export default v; }
declare module '@ortho-earth/jp/census/2015-household.json' { const v: CensusCodeMap<{ fam: number[]; own: number[]; dwell: number[] }>; export default v; }
declare module '@ortho-earth/jp/census/small-area-diff.json' { const v: CensusCodeMap<[number, number]>; export default v; }   // [2015 の区域数, 2020 の区域数]
declare module '@ortho-earth/jp/census/kana.json' { const v: CensusCodeMap<string>; export default v; }
