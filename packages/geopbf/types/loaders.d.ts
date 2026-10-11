// "geopbf/loaders"（§11）＝loaders.gl の Loader オブジェクト
export { sanitizeProperties, loadGeopbf } from "./load.js";
export const GeoPBFLoader: { name: string; id: string; module: string; version: string; extensions: string[]; mimeTypes: string[]; parse: (data: ArrayBuffer, options?: any) => Promise<any>; [key: string]: any };
