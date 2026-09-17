// bin/messages.mjs ── CLI の表示文（英語が基軸・日本語は切替）。ライブラリ本体（src/）は英語固定でここは通さない。
//
// 言語の決め方: GEOPBF_LANG > LC_ALL > LC_MESSAGES > LANG の順に見て、先頭が "ja" なら日本語、それ以外は英語。
// 文中の {name} は t("key", { name }) で差し替える。文を増やすときは en/ja の両方に同じキーを足す（片方に無ければ en に落ちる）。

const pick = () => {
	for (const k of ["GEOPBF_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) {
		const v = process.env[k];
		if (v) return /^ja/i.test(v) ? "ja" : "en";
	}
	return "en";
};
export const LANG = pick();

const USAGE_EN = `geopbf <command>

  enc  <in.geojson|ndjson> <out.geopbf>   GeoJSON / NDJSON → GeoPBF (gzipped by default = the usual distribution form)
       .ndjson / .geojsonl / .jsonl (one feature per line; GeoJSON Text Sequence with RS separators too) is read line by line ([--name name])
       [--precision N]             decimal digits kept per coordinate (1-9, default 6 ≈ 0.1 m)
       [--no-gzip]                 write raw GeoPBF without gzip
  dec  <in.geopbf>  <out.geojson>  GeoPBF → GeoJSON
  info <in.geopbf>                 summary (features, vertices, precision, size)
  lod  <in.geopbf>                 rank vertices with gint and count what each zoom would draw
  cog  info <url|file.tif>         COG structure (size, tile grid, overviews, compression, CRS, bbox)
       [--bench]                   measured header read / render (range requests, coalescing, decode time)
  cog  png  <url|file.tif> <out.png>  render a COG to PNG (direct Range reads; coarsest overview by default)
       [--level N] [--width N]     overview level (default = coarsest) and output width (default 768)
  pmtiles <in.geopbf> <out.pmtiles>  GeoPBF → PMTiles (MVT, gzip), thinned per zoom from gint arcs/ranks
       [--minzoom N] [--maxzoom N]  zoom range (default 0-14)
       [--extent N] [--buffer N]    tile grid (default 4096) and buffer width (default 80)
       [--layer name]               layer name (default = header name)
       [--gint <in.gint>]           use a pre-baked GintBUF (otherwise baked on the fly with wasm)
       [--gpu | --no-gpu]           WebGPU (Node needs npm's webgpu = Dawn). Default = use it when available
       [--workers N]                workers for assemble/clip/MVT/gzip (default = CPU count, 0 = single thread)
       [--drop-rate R]              low-zoom point drop rate (like tippecanoe -r; default 2.5, 1 = keep all)
       [--tiny-polygon A]           drop polygon parts smaller than A tile units² (like tippecanoe -s; default 2, 0 = off)
       [--tiny-line L]              drop lines whose extent is under L (default 0 = off)
       [--simplification N|off]     DP tolerance in tile units (default 1 = tippecanoe -S 1; calibrates the rank threshold per arc; off = fixed rule)
       [--lod-bias N]               shift the calibrated threshold (positive = coarser; +3 ≈ one zoom level ≈ 2x coarser)
       [--include a,b] [--exclude a,b] [--exclude-all]  attribute selection (like tippecanoe -y / -x / -X)
  parquet <in.geopbf> <out.parquet>  GeoPBF → GeoParquet (WKB, bbox column, gzip)
       [--compression zstd|gzip|none] [--row-group N] [--gpu | --no-gpu]   (default zstd = Node 22.15+, under half the size of gzip)
       [--include a,b] [--exclude a,b] [--exclude-all]  column selection
  parquet2pbf <in.parquet> <out.geopbf>  GeoParquet (WKB, lon/lat) → GeoPBF = the reverse; output of geopandas / DuckDB / pyarrow works too
       [--precision N]              coordinate digits (default = geopbf:precision or 6)
       [--name name] [--geometry col] [--ignore-crs] [--no-gzip]
       [--include a,b] [--exclude a,b] [--exclude-all]  column selection
       [--order str|hilbert|morton|none]  spatial row order (default str = non-overlapping row-group bboxes; none = input order)
       [--no-bbox]                  skip the bbox covering column (half the size for points; loses predicate pushdown)
  gpkg2pbf <in.gpkg> [out.geopbf]   one GeoPackage layer → GeoPBF (own SQLite reader, no GDAL, read-only). Omit out to list layers (features/tiles)
       [--layer name]               layer (table name or identifier; default = first feature layer)
       [--tky2jgd <file|url>]       TKY2JGD grid for Tokyo Datum layers (Helmert ±10 m without it)
       [--patchjgd <file|url>]      PatchJGD grid for JGD2000 → JGD2011
       [--precision N] [--name name] [--ignore-crs] [--no-gzip]
       [--include a,b] [--exclude a,b] [--exclude-all]  column selection

  spatialite2pbf <in.sqlite> [out.geopbf]   one SpatiaLite layer → GeoPBF (own SQLite reader; compressed / TinyPoint geometry BLOBs too; no GDAL). Omit out to list layers
       [--layer name] [--precision N] [--name name] [--ignore-crs] [--no-gzip]
       [--tky2jgd <file|url>] [--patchjgd <file|url>]   grid transforms for Tokyo Datum layers (same as gpkg2pbf)
       [--include a,b] [--exclude a,b] [--exclude-all]  column selection
  gdb2pbf <in.gdb|in.zip> [out.geopbf]   one File Geodatabase feature class → GeoPBF (a directory, or a zip of it). Omit out to list
       [--layer name] [--precision N] [--name name] [--ignore-crs] [--no-gzip]
       [--tky2jgd <file|url>]       TKY2JGD grid for Tokyo Datum layers (output of scripts/bake-datum-grid.mjs). Helmert ±10 m without it
       [--patchjgd <file|url>]      PatchJGD grid for JGD2000 → JGD2011 (2011 Tohoku earthquake; no change outside its area)
       [--include a,b] [--exclude a,b] [--exclude-all]  column selection
  dxf2pbf <in.dxf> [out.geopbf]   DXF (ASCII) → GeoPBF. Omit out to list the header, layers and entity kinds
       [--crs 6677|WKT]             CRS (DXF has none) = EPSG code (lon/lat, 3857, JPR I–XIX, UTM) or WKT. Omitted = lon/lat if the coordinates are in range
       [--unit 0.001]               drawing unit → m factor (default = from $INSUNITS)  [--encoding sjis]  [--closed-lines] keep closed polylines as lines
       [--precision N] [--name name] [--ignore-crs] [--no-gzip] [--tky2jgd <file|url>] [--patchjgd <file|url>]
  csv2pbf <in.csv|tsv|xlsx> <out.geopbf>   table → GeoPBF (two lon/lat columns = points, or one WKT column = points/lines/polygons). Columns are auto-detected
       [--lon col] [--lat col] [--wkt col]  name the columns (overrides auto-detection)
       [--sheet name] [--encoding sjis] [--delimiter ,]   xlsx sheet; CSV text encoding (default = UTF-8, else the fallback); delimiter
       [--fallback-encoding enc]    encoding tried when strict UTF-8 fails (default shift_jis; e.g. windows-1252)
       [--precision N] [--name name] [--no-gzip]
       [--include a,b] [--exclude a,b] [--exclude-all]  column selection

  Gzipped input is detected by its signature (1f 8b), not by extension, and expanded transparently.
  Messages are in English; set GEOPBF_LANG=ja (or a Japanese LANG) for Japanese.
`;

const USAGE_JA = `geopbf <command>

  enc  <in.geojson|ndjson> <out.geopbf>   GeoJSON / NDJSON を GeoPBF へ（書き出しは gzip が既定＝配布形の通例）
       .ndjson / .geojsonl / .jsonl（1 行 1 地物・GeoJSON Text Sequence の RS 区切りも可）は行ごとに読む（[--name name]）
       [--precision N]             座標に残す小数桁（1-9・既定 6 ≒ 0.1m）
       [--no-gzip]                 gzip せず生の GeoPBF を書く
  dec  <in.geopbf>  <out.geojson>  GeoPBF を GeoJSON へ
  info <in.geopbf>                 中身の要約（地物数・頂点数・精度・大きさ）
  lod  <in.geopbf>                 gint のランクを付け、ズーム別に描かれる頂点数を出す
  cog  info <url|file.tif>         COG の構造（寸法・タイル格子・overview・圧縮・CRS・bbox）
       [--bench]                   ヘッダ読み/レンダの実測数字（range 本数・coalesce・デコード時間）
  cog  png  <url|file.tif> <out.png>  COG を PNG に描き出す（Range 直読み・低解像度全景が既定）
       [--level N] [--width N]     overview 段（既定=最粗）と出力幅（既定 768）
  pmtiles <in.geopbf> <out.pmtiles>  GeoPBF を PMTiles（MVT・gzip）へ＝gint の arc/rank でズーム別に間引く
       [--minzoom N] [--maxzoom N]  ズーム範囲（既定 0-14）
       [--extent N] [--buffer N]    タイル格子（既定 4096）とはみ出し幅（既定 80）
       [--layer name]               レイヤ名（既定＝ヘッダの name）
       [--gint <in.gint>]           焼き済み GintBUF を使う（無ければ wasm でその場で焼く）
       [--gpu | --no-gpu]           WebGPU（Node は npm の webgpu＝Dawn が要る）。既定＝あれば使う
       [--workers N]                組立/クリップ/MVT/gzip の worker 数（既定＝コア数・0＝単一スレッド）
       [--drop-rate R]              点の低ズーム間引き率（tippecanoe -r 相当・既定 2.5・1＝全点保持）
       [--tiny-polygon A]           タイル座標で面積 A 未満の面成分を落とす（tippecanoe -s 相当・既定 2・0＝無効）
       [--tiny-line L]              外接が L 未満の線を落とす（既定 0＝無効）
       [--simplification N|off]     DP 許容差（タイル単位・既定 1＝tippecanoe -S 1 相当・arc 毎にランク閾値を較正・off で固定則）
       [--lod-bias N]               較正後の閾値をずらす（正で粗く・+3 で 1 ズーム段＝約 2 倍粗い）
       [--include a,b] [--exclude a,b] [--exclude-all]  属性の選別（tippecanoe -y / -x / -X 相当）
  parquet <in.geopbf> <out.parquet>  GeoPBF を GeoParquet（WKB・bbox 列・gzip）へ
       [--compression zstd|gzip|none] [--row-group N] [--gpu | --no-gpu]   （既定 zstd＝Node 22.15+・gzip の半分以下）
       [--include a,b] [--exclude a,b] [--exclude-all]  列の選別
  parquet2pbf <in.parquet> <out.geopbf>  GeoParquet（WKB・経緯度）を GeoPBF へ＝逆変換。geopandas / DuckDB / pyarrow の出力も可
       [--precision N]              座標の小数桁（既定＝geopbf:precision か 6）
       [--name name] [--geometry col] [--ignore-crs] [--no-gzip]
       [--include a,b] [--exclude a,b] [--exclude-all]  列の選別
       [--order str|hilbert|morton|none]  行の空間整列（既定 str＝行グループ bbox が重ならない・none＝入力順）
       [--no-bbox]                  bbox 覆域列を書かない（点データで半分の大きさ・刈り込みは失う）
  gpkg2pbf <in.gpkg> [out.geopbf]   GeoPackage の 1 層を GeoPBF へ（自前 SQLite リーダ・GDAL 不要・読み専用）。out を省くと層（地物/タイル）の一覧
       [--layer name]               層（表名か identifier・既定＝最初の地物層）
       [--tky2jgd <file|url>]       日本測地系の層に使う TKY2JGD 格子（無ければ Helmert ±10 m）
       [--patchjgd <file|url>]      JGD2000→JGD2011 の PatchJGD 格子
       [--precision N] [--name name] [--ignore-crs] [--no-gzip]
       [--include a,b] [--exclude a,b] [--exclude-all]  列の選別

  spatialite2pbf <in.sqlite> [out.geopbf]   SpatiaLite の 1 層を GeoPBF へ（自前 SQLite リーダ・幾何 BLOB は圧縮/TinyPoint 込み・GDAL 不要）。out を省くと層の一覧
       [--layer name] [--precision N] [--name name] [--ignore-crs] [--no-gzip]
       [--tky2jgd <file|url>] [--patchjgd <file|url>]   日本測地系の層の格子変換（gpkg2pbf と同じ）
       [--include a,b] [--exclude a,b] [--exclude-all]  列の選別
  gdb2pbf <in.gdb|in.zip> [out.geopbf]   File Geodatabase の 1 フィーチャクラスを GeoPBF へ（ディレクトリか、それを zip したもの）。out を省くと一覧
       [--layer name] [--precision N] [--name name] [--ignore-crs] [--no-gzip]
       [--tky2jgd <file|url>]       日本測地系の層に使う TKY2JGD 格子（scripts/bake-datum-grid.mjs の出力）。無ければ Helmert ±10 m
       [--patchjgd <file|url>]      JGD2000→JGD2011 の PatchJGD 格子（2011 年東北地方太平洋沖地震・対象域外は無変換）
       [--include a,b] [--exclude a,b] [--exclude-all]  列の選別
  dxf2pbf <in.dxf> [out.geopbf]   DXF（ASCII）を GeoPBF へ。out を省くとヘッダ・レイヤ・エンティティ種別の一覧
       [--crs 6677|WKT]             座標系（DXF は持たない）＝EPSG 番号（経緯度・3857・平面直角 I〜XIX・UTM）か WKT。省略＝座標が経緯度の範囲なら経緯度とみなす
       [--unit 0.001]               図面単位→m の倍率（既定＝$INSUNITS から自動）  [--encoding sjis]  [--closed-lines] 閉じた折線を面にしない
       [--precision N] [--name name] [--ignore-crs] [--no-gzip] [--tky2jgd <file|url>] [--patchjgd <file|url>]
  csv2pbf <in.csv|tsv|xlsx> <out.geopbf>   表を GeoPBF へ（経緯度の 2 列＝点、または WKT の 1 列＝点/線/面）。列名は自動検出
       [--lon col] [--lat col] [--wkt col]  列の名指し（自動検出より優先）
       [--sheet name] [--encoding sjis] [--delimiter ,]   xlsx のシート・CSV の文字コード（既定＝UTF-8 で読めなければ fallback）・区切り
       [--fallback-encoding enc]    UTF-8 で読めなかったときに試す文字コード（既定 shift_jis・例 windows-1252）
       [--precision N] [--name name] [--no-gzip]
       [--include a,b] [--exclude a,b] [--exclude-all]  列の選別

  入力の gzip は拡張子によらず署名（1f 8b）で判別して透過的に展開する。
  表示は英語が既定。GEOPBF_LANG=ja（か日本語の LANG）で日本語になる。
`;

const MSG = {
	en: {
		usage: USAGE_EN,
		unknownCommand: `geopbf: unknown command "{cmd}"\n`,
		precisionRange: "--precision must be an integer from 1 to 9",
		gpuMissing: "--gpu: WebGPU not found (on Node: `npm i webgpu`); continuing on the CPU path",
		zipOpenFailed: "cannot open zip",
		// enc / dec / info
		encDone: "{out}  {size}{gzip}  {ratio}x smaller  {ms} ms",
		ndjsonBadLines: "  ⚠ {n} unreadable lines (skipped)",
		decDone: "{out}  features {features}  vertices {vertices}",
		infoVertices: "vertices    {n}",
		infoPrecision: "precision   {p}  (≈ {m} m)",
		// lod
		lodEmpty: "no vertices",
		lodHead: "vertices {total} (L1 {l1})  ranking {ms} ms  gint {size} (8 bytes/vertex)\n",
		lodTable: "  z  threshold      drawn       kept",
		lodNote: "\nNo topology analysis here: only ring endpoints are L1; vertices on shared borders do not become L1.",
		// cog
		cogBench: "--bench     TTFH {ttfh} ms  overview {w}px {ms} ms  range {requests} requests / {coalesced} coalesced ({ratio}x)  received {bytes}  decoded {tiles} tiles {decode} ms",
		cogEmpty: "cog png: nothing to render (empty result)",
		cogUnknownSub: `cog: unknown subcommand "{sub}"`,
		// pmtiles / parquet
		gintLoaded: "loaded", gintBaked: "baked",
		pmIn: "{in}  features {features}  gint {how} {ms} ms (arcs {arcs}, vertices {vertices})",
		pmOut: "{out}  {size}  tiles {tiles} ({contents} distinct)  z{min}-{max}  {engine}  workers {workers}",
		pmTimes: "  project+LOD {project} ms  calibrate {calibrate} ms  write {write} ms  assemble/clip/MVT {assemble} ms  PMTiles {pmtiles} ms  total {total} ms  (kept vertices {kept}, all zooms)",
		pqIn: "{in}  features {features}  vertices {vertices}",
		pqTimes: "  decode {decode} ms  double/bbox {kernels} ms  WKB {wkb} ms  Parquet {parquet} ms  total {total} ms",
		pq2In: "{in}  features {features}{dropped}  vertices {vertices}  columns {columns}  CRS {crs}  writer {writer}",
		droppedRowsNoGeom: " (dropped {n} rows without geometry)",
		skippedColumns: "  skipped columns: {list}",
		pbfOut: "{out}  {size}{gzip}  precision {precision}  read {read} ms  GeoPBF {encode} ms",
		// gpkg2pbf
		gpkgList: "{in}  {encoding}  page {page}  feature layers {n}",
		notLonLat: " ⚠ not lon/lat",
		rows: "{n} rows",
		columns: "columns {list}",
		tilesCount: "{n} tiles",
		tableMissing: ", table missing",
		missingTable: "  {table}  ⚠ listed in geometry_columns but the table is missing",
		layerLine: "{in}  layer {layer}{others}  features {features}  vertices {vertices}  columns {columns}  CRS {crs}{reprojected}",
		others: " (others: {list})",
		toLonLat: " → lon/lat",
		gpkgDropped: "  dropped {n} features without geometry (NULL/empty {plain}, extended types {extended}){zm}{bigints}",
		zmDropped: "  Z/M dropped",
		bigintToString: "  bigint→string {n}",
		// csv2pbf
		wktColumn: "WKT column {col}",
		lonLatColumns: "lon {lon}  lat {lat}",
		sheet: "  sheet {name}{others}",
		csvIn: "{in}  {kind}{sheet}  rows {rows}  features {features}{dropped}  vertices {vertices}  {geom}  columns {columns}",
		droppedNoCoords: " (dropped {n} without coordinates)",
		// gdb2pbf
		gdbList: "{in}  feature classes {classes}  tables {tables}",
		cannotToLonLat: " ⚠ cannot convert to lon/lat",
		gdbLayerLine: "{in}  layer {layer}{others}  {type}  rows {rows}  features {features}  vertices {vertices}  columns {columns}  CRS {crs}{reprojected}",
		datumApprox: "  ⚠ Tokyo Datum converted with the Helmert approximation (±10 m); pass --tky2jgd <grid> for 0.2 m",
		tky2jgd: "  TKY2JGD: grid {grid} points, Helmert outside the grid {helmert} points",
		patchjgd: "  PatchJGD: grid {grid} points, outside the area {outside} points",
		gdbDropped: "  dropped {n} features (empty {empty}, multipatch {multipatch}){curves}{zm}{skipped}",
		curvesLinearized: "  curves→lines {n}",
		// dxf2pbf
		dxfList: "{in}  {ver}  INSUNITS {units}  extent {range}  entities {entities}  blocks {blocks}",
		dxfKinds: "  kinds: {list}",
		dxfLayers: "  layers: {list}",
		dxfNoLayerTable: "(no layer table)",
		dxfIn: "{in}  entities {entities} (INSERT expanded {inserts})  features {features}  vertices {vertices}  CRS {crs}{unit}",
		dxfUnit: "  unit ×{scale}",
		dxfSkipped: "  skipped: {list}",
	},
	ja: {
		usage: USAGE_JA,
		unknownCommand: `geopbf: 知らないコマンド "{cmd}"\n`,
		precisionRange: "--precision は 1 から 9 の整数",
		gpuMissing: "--gpu: WebGPU が見つからない（Node は `npm i webgpu`）＝CPU 経路で続行",
		zipOpenFailed: "zip を開けない",
		encDone: "{out}  {size}{gzip}  {ratio} 分の 1  {ms} ms",
		ndjsonBadLines: "  ⚠ 読めない行 {n}（飛ばした）",
		decDone: "{out}  features {features}  頂点 {vertices}",
		infoVertices: "頂点        {n}",
		infoPrecision: "precision   {p}  （{m} m 相当）",
		lodEmpty: "頂点がない",
		lodHead: "頂点 {total}（うち L1 {l1}）  ランク付け {ms} ms  gint {size}（8 byte/頂点）\n",
		lodTable: "  z  threshold      描画頂点   残存率",
		lodNote: "\n位相解析なし＝L1 はリングの端点のみ。共有境界の頂点は L1 に立たない。",
		cogBench: "--bench     TTFH {ttfh} ms・全景{w}px {ms} ms・range {requests} 本/要求 {coalesced}（coalesce {ratio}x）・受信 {bytes}・デコード {tiles} タイル {decode} ms",
		cogEmpty: "cog png: 範囲外（レンダ結果が空）",
		cogUnknownSub: `cog: 知らないサブコマンド "{sub}"`,
		gintLoaded: "読込", gintBaked: "焼き",
		pmIn: "{in}  features {features}  gint {how} {ms} ms（arc {arcs}・頂点 {vertices}）",
		pmOut: "{out}  {size}  タイル {tiles}（内容 {contents} 種）  z{min}-{max}  {engine}・worker {workers}",
		pmTimes: "  投影+LOD {project} ms・較正 {calibrate} ms・書き出し {write} ms・組立/クリップ/MVT {assemble} ms・PMTiles {pmtiles} ms・合計 {total} ms  （残存頂点 {kept}＝全ズーム合計）",
		pqIn: "{in}  features {features}  頂点 {vertices}",
		pqTimes: "  復号 {decode} ms・double/bbox {kernels} ms・WKB {wkb} ms・Parquet {parquet} ms・合計 {total} ms",
		pq2In: "{in}  features {features}{dropped}  頂点 {vertices}  列 {columns}  CRS {crs}  writer {writer}",
		droppedRowsNoGeom: "（幾何なしで落とした行 {n}）",
		skippedColumns: "  読まなかった列: {list}",
		pbfOut: "{out}  {size}{gzip}  precision {precision}  読込 {read} ms・GeoPBF {encode} ms",
		gpkgList: "{in}  {encoding}  page {page}  地物層 {n}",
		notLonLat: " ⚠経緯度でない",
		rows: "{n} 件",
		columns: "列 {list}",
		tilesCount: "{n} 枚",
		tableMissing: "・表が無い",
		missingTable: "  {table}  ⚠ geometry_columns にあるが表が無い",
		layerLine: "{in}  層 {layer}{others}  features {features}  頂点 {vertices}  列 {columns}  CRS {crs}{reprojected}",
		others: "（他 {list}）",
		toLonLat: "→経緯度",
		gpkgDropped: "  幾何なしで落とした地物 {n}（NULL/空 {plain}・拡張型 {extended}）{zm}{bigints}",
		zmDropped: "・Z/M は落とした",
		bigintToString: "・巨大整数→文字列 {n}",
		wktColumn: "WKT 列 {col}",
		lonLatColumns: "経度 {lon}・緯度 {lat}",
		sheet: "  シート {name}{others}",
		csvIn: "{in}  {kind}{sheet}  行 {rows}  features {features}{dropped}  頂点 {vertices}  {geom}  列 {columns}",
		droppedNoCoords: "（座標なし {n} を落とした）",
		gdbList: "{in}  フィーチャクラス {classes}・表 {tables}",
		cannotToLonLat: " ⚠経緯度へ戻せない",
		gdbLayerLine: "{in}  層 {layer}{others}  {type}  行 {rows}  features {features}  頂点 {vertices}  列 {columns}  CRS {crs}{reprojected}",
		datumApprox: "  ⚠ 日本測地系を Helmert 近似で変換（±10 m 級）。--tky2jgd <格子> で 0.2 m 級になる",
		tky2jgd: "  TKY2JGD: 格子 {grid} 点・格子外は Helmert {helmert} 点",
		patchjgd: "  PatchJGD: 格子 {grid} 点・対象域外 {outside} 点",
		gdbDropped: "  落とした地物 {n}（空 {empty}・多パッチ {multipatch}）{curves}{zm}{skipped}",
		curvesLinearized: "・曲線→直線 {n}",
		dxfList: "{in}  {ver}  INSUNITS {units}  範囲 {range}  エンティティ {entities}  ブロック {blocks}",
		dxfKinds: "  種別: {list}",
		dxfLayers: "  レイヤ: {list}",
		dxfNoLayerTable: "（表なし）",
		dxfIn: "{in}  エンティティ {entities}（INSERT 展開 {inserts}）  features {features}  頂点 {vertices}  CRS {crs}{unit}",
		dxfUnit: "  単位 ×{scale}",
		dxfSkipped: "  対象外: {list}",
	},
};

/** t("key", { name: value }) → 選んだ言語の文。{name} を差し替える（未定義の名前はそのまま残す＝書き損じが見える）。 */
export const t = (key, vars = {}) => (MSG[LANG][key] ?? MSG.en[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => k in vars ? String(vars[k]) : m);
