// convert/* が共有する型（TS化 段 3）。入口（gpkg / fgb / filegdb / dxf / table / parquet …）の options と CRS 判定の形をここに一本化する。
import type { Geometry, Position } from "../pbf-base.js";
export type { Geometry, Position };

/** [lon, lat]（度） */
export type LonLat = [number, number];
/** 座標 1 点の変換（投影の逆変換・測地系変換・メルカトル→経緯度）。入力は GeoJSON の Position（number[]）を受ける */
export type XF = (p: readonly number[]) => LonLat;

/** GeoPBF のヘッダに載せるメタ（各入口の opts が共通で受ける） */
export interface MetaOptions {
	name?: string;
	/** 座標の桁（既定 6） */
	precision?: number;
	description?: string;
	license?: string;
	attribution?: string;
}
/** 属性の選別（tippecanoe の -y / -x / -X 相当・attrs.js） */
export interface AttrOptions {
	include?: readonly string[];
	exclude?: readonly string[];
	excludeAll?: boolean;
}
export type KeepFn = (key: string) => boolean;

/** 幾何の復号で数えるもの（parseWkb / parseSpatiaLiteBlob / parseShape …） */
export interface GeomCtx { vertices: number }

/** CRS の判定結果（proj.crsFromWKT・gpkg.classifyCrs・filegdb の classify が返す形） */
export type CrsKind = "lonlat" | "mercator" | "projected" | "datum" | "other";
export interface CrsInfo {
	kind: CrsKind;
	label: string;
	name?: string | null;
	/** 測地系変換が Helmert 近似（格子なし） */
	approx?: boolean;
	/** Esri の「不明な座標系」を範囲で推定した */
	unknown?: boolean;
	/** あれば変換が要る（projected＝投影の逆変換・datum＝測地系変換） */
	toLonLat?: XF;
	/** COG の warp（経緯度→源座標）が使う順変換（測地系変換がある時は付かない） */
	fromLonLat?: XF;
}

/** 計測（ms）の器＝入口ごとに段の名前が違うので open */
export type MsStats = Record<string, number>;
