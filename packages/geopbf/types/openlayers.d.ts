// "geopbf/openlayers"（§10）
import type { LoadOptions } from "./load.js";
export { sanitizeProperties, loadGeopbf } from "./load.js";
/** VectorSource の loader（format＝ol/format/GeoJSON のインスタンス） */
export function makeGeopbfLoader(url: string, format: any, options?: LoadOptions & { onMeta?: (meta: Record<string, any>) => void; [key: string]: any }): (...args: any[]) => Promise<void>;
