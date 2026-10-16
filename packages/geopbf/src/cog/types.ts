// cog/* が共有する型（TS化 段 3）。tiff.js の IFD 表・geo（フルアフィン）・目標グリッド・stretch の形をここに一本化する。

/** ジオリファレンス＝フルアフィン: X = ox + ax·px + ay·py / Y = oy + bx·px + by·py（軸平行は ay=bx=0） */
export interface Geo {
	ox: number; oy: number;
	ax: number; ay: number;
	bx: number; by: number;
	/** 回転付き（ay/bx が 0 でない）か */
	rotated?: boolean;
}
/** overview 段に合わせて縮尺補正した geo＋逆アフィン係数（warp.geoAtLevel） */
export interface GeoLevel extends Geo {
	ix: number; iy: number;
	jx: number; jy: number;
}
/** IFD 1 段（tiff.parseTiff の戻り・width 降順＝level 0 がフル解像度） */
export interface Ifd {
	width: number; height: number;
	tileW: number; tileH: number;
	tilesX: number; tilesY: number;
	/** タイル i のファイル内オフセット（0＝sparse） */
	offsets: number[];
	/** タイル i のバイト長（0＝sparse） */
	counts: number[];
	compression: number;
	predictor: number;
	photometric: number;
	samples: number;
	bits: number[];
	/** 1=uint 2=int 3=float */
	sampleFormat: number;
	extraSamples: number[];
	/** JPEGTables(347)＝compression=7 のときだけ */
	jpegTables: Uint8Array | null;
	/** ColorMap を RGBA256 に縮約したもの */
	palette: Uint8Array | null;
	isOverview: boolean;
}
/** worker へ運ぶ lean IFD（offsets/counts の大配列を除いたもの） */
export type LeanIfd = Omit<Ifd, "offsets" | "counts">;
/** 源 CRS の [xmin, ymin, xmax, ymax] ／経緯度の [w, s, e, n] */
export type BBox = [number, number, number, number];
/** parseTiff の戻り */
export interface TiffInfo {
	ifds: Ifd[];
	epsg: number | null;
	geo: Geo;
	bbox: BBox;
	nodata: number | null;
	citation: string | null;
	bigtiff: boolean;
	littleEndian: boolean;
}
/** decodeTile が返す型付き配列（プラットフォーム endian） */
export type RasterData = Uint8Array | Int8Array | Uint16Array | Int16Array | Float32Array;
/** decodeTile の戻り: raster＝そのまま RGBA 化・image＝ブラウザの createImageBitmap へ */
export type DecodedTile =
	| { kind: "raster"; data: RasterData }
	| { kind: "image"; bytes: Uint8Array; mime: string };
/** [lo, hi]（単バンド）。dualpol は 3 本ぶん [[lo,hi]×3] */
export type StretchRange = [number, number];
export type Stretch = StretchRange | StretchRange[];
/** 描画 LUT（256×3 バイト） */
export type Lut = Uint8Array | Uint8ClampedArray;
/** makeLut の入力: 内蔵名（"thermal"/"gray"）・256×3 バイト・停留色の配列 */
export type LutSpec = string | Lut | number[][] | null | undefined;
/** 偽色合成の種類（samples≥2 の 2 偏波 SAR 向け） */
export type Composite = "dualpol" | null;
/** 目標グリッド＝各ピクセル中心の経緯度を返す（warp.xyzTarget / lonlatTarget） */
export interface Target {
	w: number;
	h: number;
	mapLL(i: number, j: number): [number, number];
}
/** 目標グリッドの記述（worker へそのまま運ぶ形） */
export type TargetDesc =
	| { kind: "xyz"; z: number; x: number; y: number; size: number }
	| { kind: "lonlat"; bbox: BBox; w: number; h: number };
/** [tx, ty] */
export type TileCoord = [number, number];
