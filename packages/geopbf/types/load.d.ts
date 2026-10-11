// "geopbf/load"（src/modules/geojson-load.js）＝geopbf → GeoJSON の共通ローダ（§8〜§11 の共用部）
import type { FeatureCollection, HeaderMeta, Properties } from "./geopbf.js";
export interface LoadOptions { signal?: AbortSignal; fetch?: (url: string, init?: RequestInit) => Promise<Response>; /** 既定 true */ sanitize?: boolean }
export interface LoadedGeopbf extends HeaderMeta { geojson: FeatureCollection }
/** "geopbf://https://host/x.geopbf" → 内側の URL（相対はブラウザの location 基準） */
export function resolveInnerUrl(url: string): string;
/** JSON 経由の転送に耐える属性へ（Date → ISO・typed array → Array・Blob／ImageData → 削除） */
export function sanitizeProperties(properties: Properties): Record<string, any>;
export function decodeToGeojson(data: Blob | ArrayBuffer | ArrayBufferView, options?: { sanitize?: boolean }): Promise<{ geojson: FeatureCollection; meta: HeaderMeta }>;
export function fetchAndDecode(innerUrl: string, options?: LoadOptions): Promise<{ geojson: FeatureCollection; meta: HeaderMeta }>;
/** 最短経路（プロトコル登録なし）。{ geojson, name, description, license, attribution, minZoom, maxZoom } */
export function loadGeopbf(url: string, options?: LoadOptions): Promise<LoadedGeopbf>;
