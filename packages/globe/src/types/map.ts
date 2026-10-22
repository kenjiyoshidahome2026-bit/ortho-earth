// globe の公開の map の型（TS 化 段 4・batch 1・2026-10-16）＝installer ごとの型の合成。正本はここ＝globe.d.ts の OrthoJapanMap／GlobeMap はこれの別名。
// 叩き台（stage4/globe-map.d.ts・本人が 6 つの推奨を承認 2026-10-16）をそのまま型にした：メンバーは実体が map に付けている物だけ・各行の末尾＝付けている所（src/ の下の file:line・
// この版の行番号＝batch 1 の型づけの後）。散文（JSDoc）は globe.d.ts の OrthoJapanMap から移した。補助の型（CameraOptions・GintLayerHandle…）は globe.d.ts に置いたまま import する。
// 2 か所で付けていたメンバーは持ち主を 1 つに：on/off＝QueryApi（globe.js が先に素の on/off を付け、api/query.ts が層 id 付きに包む＝包む側が最終の値）・
// overlay＝OverlaysApi（関数だけ。globe.js が後から Object.assign で足す器のメソッドは公開の型に出さない＝GlobeInternals）・flyTo＝CameraApi（map の字面の内部の flyTo は外した）・
// queryRenderedFeatures＝QueryApi（api/query.ts の中で断面と統一 picking の包みを重ねる）。
// gadget の登録＝registerGadget(name, (map, ...args) => handle)（判断 2・batch 2）：本体は map を第 1 引数に受ける素の関数（this は使わない）。
// 呼ぶ口 map.gadget.<名前>(…) は今のまま＝名前ごとの引数と戻りは globe.d.ts の Gadgets（＋表示の門 GadgetGate）。

import type {
	Bbox, BodyPosition, COPCHandle, COPCOptions, CameraOptions, CameraPose,
	CameraTarget, Capability, CapabilityKey, CellsLayerHandle, CellsLayerOptions, ClipOptions,
	CloudsSpec, ColumnarLayerHandle, ColumnarLayerOptions,
	ContourLayerHandle, ContourLayerOptions, DataLayerHandle, DataLayerOptions,
	FitBoundsOptions, FollowHandle, GeoPBF,
	FollowOptions, Gadgets, GeoJSONFeatureCollection, GintApplyOptions, GintLayerHandle, GintLayerOptions,
	GintPaint, HandlerName, LayerMouseEvent,
	LayerPressEvent, LightSpec, LightSpecification, LonLat, LookAtOptions, MapLibreLayer,
	MapLibreSource, MapRegistry, Marker, MeshEvent, NavaraCamera,
	OrthoClock, OrthoPlugin, OverlayHandle, OverlayPick, PaddingOptions,
	Popup, PostPass, PostProcessOptions, ProtocolLoader, QuantizedMeshSource,
	QueryOptions, RasterAPI, RasterDemSource, RenderedFeature, ResourceType, ScreenGridHandle,
	ScreenGridOptions, SkySpecification, SnapshotOverlay, StyleExpression, SunSpec,
	TerrainSourceSpec, Tiles3DHandle, Tiles3DOptions, TransformRequestFunction, VideoHandle, WalkHandle, WalkOptions,
} from "../../globe.d.ts";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The map
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** createGlobe() が返す map。installer ごとに 1 つの interface＝メンバーを足せるのは、その interface を持つ installer だけ
 *  （installer の受ける map の型＝src/types/install.ts の Installing<XApi>）。 */
export type GlobeMap = GlobeCoreApi & CameraApi & OverlaysApi & TerrainApi & RasterApi & GadgetsApi & ShadowsApi
	& DataApi & IntakeApi & ImagesApi & StyleApi & QueryApi & ToolsApi;
/** @deprecated SDK 以来の名前＝2.0 の間は GlobeMap の別名として残す */
export type OrthoJapanMap = GlobeMap;

/** globe.js itself (map literal at globe.js:2355 and the `map.X =` lines after it).
 *  Registers gadgets: hud@2234 anno@2742 cog@2751 raster@2766 spotlight@2803 outline@2817 globe@2824 model@2850 extrude@2859 stac@2882 tiles3d@2966 */
export interface GlobeCoreApi {
	// ── map literal
	readonly cam: CameraPose;   // globe.js:2355
	readonly mapEl: HTMLElement;   // globe.js:2355
	destroy(): void;   // globe.js:2355
	/** 共通の時計（1.2.0〜・#42・ephem/clock＝ortho-solar と同じ部品）。夜の側・星空・惑星と月・太陽系圏・同一フレームのオーバーレイ（api.time＝衛星など）がこの時刻で描く。
	 *  既定＝実時間。URL（ビューの hash）に t=<UTC>/s=<段> を書く（実時間なら書かない）＝共有リンクで同じ時刻が開く。操作盤は map.gadget.clock()。
	 *  範囲と繰り返し（setRange・1.8.0〜・#124）＝CZML・GPX を読むとデータの区間が写る（#113） */
	readonly clock: OrthoClock;   // globe.js:2355
	// getter also returns layers/sky/eye (globe.js:2359) = only reachable via the index signature
	/** 現在の視点。pitch/bearing は**ラジアン**（flyTo の tiltDeg/bearingDeg は度）。theme＝現在の配色名。hash＝共有/再生成用の "#z/lat/lon/…" */
	readonly view: { center: LonLat; zoom: number; pitch: number; bearing: number; roll: number; fovy: number; theme?: string; hash: string;[k: string]: unknown };   // globe.js:2359
	/** 台本オブジェクトを直に上映（要 demo ガジェット・既に上映中なら false）。台本の形＝demo/scene-format.md。言語は台本の ja:/en:… を画面の言語で選ぶ */
	playScenes(scenes: object, opts?: { from?: number; quick?: boolean; lang?: string; onScene?: (i: number) => void; onEnd?: () => void }): boolean | void;   // globe.js:2362
	/** 上映を止める（準備中でも安全） */
	stopScenes(): void;   // globe.js:2362
	/** 台本のタイムライン（再生せずに任意の秒の絵を出す＝エディタ用）。読めなければ null */
	sceneTimeline(scenes: object): { dur: number; rows: unknown[]; at(t: number): unknown; seek(t: number): unknown; end(): void } | null;   // globe.js:2364
	pinRes(on: boolean): void;   // globe.js:2366
	// ── snapshot
	requestSnapshot(): Promise<{ W: number; H: number; render: { base: ArrayBuffer | null; w: number; h: number; labels: ArrayBuffer | null; lw: number; lh: number; flip: boolean; overlays: SnapshotOverlay[]; overlaysAbove: SnapshotOverlay[] } }>;   // globe.js:2425
	// ── gint (single slot + layers)
	/** ユーザー知性層の搭載（単一スロット＝呼ぶたび置換・null＝スロットを空に）。複数データは fid 空間で合成（各 .geojson.features に一意キーを足して 1 本に再エンコード）。pbf は gint ベイク済みであること */
	applyGintData(pbf: GeoPBF | null, label: string, moveCamera?: boolean, opts?: GintApplyOptions): GeoPBF | null;   // globe.js:2463
	/** v1 の単一スロット層を丸ごと撤去（applyGintData(null, …) と同じ・派生アプリのスロット調停用） */
	clearUserGint(): void;   // globe.js:2464
	/** gint 層を**追加**する（置換ではない＝applyGintData の単一スロットとは別系統）。pbf は geopbf(…, { gint: true }) 済み（unPackGint 必須・無ければ null）。
	 *  追加した層が既定でアクティブ（hover/click の対象）・interactive:false で既定層へ返す。重ね順は order（小さいほど下・未指定＝追加順） */
	addGint(pbf: GeoPBF, opts?: GintLayerOptions): GintLayerHandle | null;   // globe.js:2465
	/** 層をまたぐ照会（手前の層から）＝いま見えている層だけ（setVisible・ズーム域）× 各層の filter。地球儀が自分で足す層（国の輪郭など）は含まない・interactive:false の層は含む。
	 *  fid は層内の添字＝**必ず {layer, fid} の対で扱う**。layer:null＝単一スロットの層（applyGintData） */
	queryAll(lngLat: LonLat): Array<{ layer: GintLayerHandle | null; fid: number; feature: { fid: number; properties: Record<string, any> | null } }>;   // globe.js:2466
	/** 地形沿い線化（liftM=null で解除） */
	standupGint(liftM: number | null): Promise<void> | void;   // globe.js:2469
	/** fid整列のproperties配列（式評価・表直書きの入力。.geojsonは詰めズレするので使わない） */
	gintFeatures(): Array<{ properties: Record<string, any>; geometry: { type: string } | null }> | null;   // globe.js:2470
	/**
	 * Mapbox 風 paint 式で fid スタイル表を組む（null=解除）。評価は呼び出し時に一度だけ（zoom 追随は再呼び）。
	 * 式の演算子サブセット：get has ! all any == != > >= < <= in match step case let var interpolate coalesce
	 * to-number to-string concat zoom geometry-type feature-state + - * / % ^ min max literal。色は #hex / rgb() / rgba()
	 * （CSS の色名・hsl も可）。filter＝真偽式（偽の feature は非表示）。
	 * 例：{ "fill-color": ["step", ["get", "pop"], "#eff3ff", 1, "#bdd7e7", 4, "#3182bd"], "fill-opacity": 0.85,
	 *      "line-width": ["case", ["==", ["get", "id"], 13], 3.5, 0.9] }
	 */
	paint(paint: GintPaint | null, filter?: unknown[]): Promise<void>;   // globe.js:2471
	/**
	 * fid→スタイル表の直書き。u32レコード=4要素/fid:
	 * [0]=fill RGBA8(r<<24|g<<16|b<<8|a) [1]=line/circle色 [2]=(width*8)<<24|dash<<16|(radius*4)<<8|flags [3]=線：破線 (線px*8)<<16|(間px*8)／点：縁の色 RGBA8（1.3.0〜・0＝なし）。
	 * flags bit0=visible（フィーチャ単位の表示/非表示）・bit1=点の塗り無し（中空の円・1.3.0〜）。点では width の欄が縁の幅
	 * Point は [1]（circle 色・α=0 で既定色）と radius（1/4 CSS px・0=描かない）を使う。線は width（1/8px・0=描かない）。[3]＝予備（0）。
	 * count＝レコード数（fid 数＝gintFeatures().length）。applyGintData() 直後に同期で呼べる（onReady を待つ必要はない）
	 */
	paintTable(u32: Uint32Array, count: number): void;   // globe.js:2472
	fitZoomForBbox(bbox: Bbox): number;   // globe.js:2473
	// ── projection
	/** 経緯度→mapEl（canvas）左上原点の CSS px（ページ座標ではない＝pointer を合成するなら getBoundingClientRect を足す）。unprojectXY と同じ座標系。
	 *  front<0＝**見えない**（裏半球ではなく「現在のカメラ高度の地平線より外」＝チルト時は数°先でも負）。見えない点の x,y は**地平線（可視キャップの縁）へ射影クランプした位置**
	 *  ＝塗りの経路はそのまま結んでよい（可視部＋地平線沿いで閉じる）。線は符号で切る。カメラ後方など写せない時だけ [0,0,-1]。
	 *  front の絶対値は未正規化＝符号だけ使う。**地形込み**＝チルト時は描いている地形の標高（setTerrain の DEM が先）だけ持ち上げる＝makeProjectorH()(lon, lat, 0) と同じ点。標高の初回は 0（海面）・届いた次フレームから乗る（makeProjectorH と同じメモ） */
	projectLL(lon: number, lat: number): [x: number, y: number, front: number];   // globe.js:2474
	/** canvasローカルCSS座標→経緯度（球外はnull。onClick/setEditClickのx,yと同座標系） */
	unprojectXY(x: number, y: number): LonLat | null;   // globe.js:2475
	/** 経緯度→画面の点（MapLibre と同名・1.1.1〜）。座標系は projectLL と同じ（地図の容れ物の左上原点の CSS px）。
	 *  見えない所（球の裏・地平線の外）も地平線へ寄せた位置を返す＝見えるかどうかは projectLL の front で */
	project(lngLat: LonLat | { lng: number; lat: number }): { x: number; y: number };   // globe.js:2479
	/** 画面の点→経緯度（MapLibre と同名・1.1.1〜）。球の外（宇宙）は null */
	unproject(point: [x: number, y: number] | { x: number; y: number }): { lng: number; lat: number } | null;   // globe.js:2480
	/** カメラ状態を1回束ねた投影関数（多点を1フレームで投影する時用・projectLL と同じく地形込み＝点ごとに標高のメモを引く。数百点以上は makeProjectorH({ terrain: false })） */
	makeProjector(): (lon: number, lat: number) => [x: number, y: number, front: number];   // globe.js:2481
	/** 楕円体表示か（opts.ellipsoid・?ell=1／?ell=0・既定は通常・HI のデスクトップで true＝1.6.0〜・#43）。計測は常に WGS84（表示の形に依らない） */
	ellipsoidOn(): boolean;   // globe.js:2482
	/** 地形込みの投影。標高は描いている地形と同じ出どころ（setTerrain の DEM が先・無い所は既定の DTM・負は 0）を 100m 格子のメモから引く＝**その地点の初回は 0（海面）で、非同期に取得して次フレームから乗る**（毎フレーム呼ぶ
	 *  DOM マーカー用途向け。1 回きりの呼び出しには乗らない）。liftM＝地表からの追加持ち上げ m（0＝地表。標高を渡すと二重に浮く） */
	makeProjectorH(opts?: { terrain?: boolean }): (lon: number, lat: number, liftM?: number) => [x: number, y: number, front: number];   // globe.js:2483
	// ── host hooks / i18n
	/** クリック横取りスロット（編集アプリ用。gint の onGintClick より優先）。null=解除。クリックvsドラッグ弁別はエンジン側が済ませる */
	setEditClick(fn: ((x: number, y: number) => void) | null): void;   // globe.js:2484
	/** UI 文言の訳（英語キー → 表示言語・$1… は args で埋める）。SDK が読んだ辞書で引く（1.2.0〜） */
	t(key: string, ...args: Array<string | number>): string;   // globe.js:2485
	/** 表示言語コード（ja/en/…・1.2.0〜） */
	readonly lang: string;   // globe.js:2486
	/** 次フレームの描画を1回点火（オーバレイ更新後に） */
	requestDraw(): void;   // globe.js:2487
	// ── post-processing
	/** 後処理の鎖（F3・2026-10-12）＝順番つきの pass。描くのは bloom・vignette・fxaa・tonemap・lut（W1・掛ける順は固定＝fxaa → bloom → tonemap → lut → vignette）。smaa/dof/ssr は保つだけ。知らない type は投げる（plugin は registry.postEffects に足す）。null＝全部外す */
	setPostChain(chain: PostPass[] | PostPass | PostProcessOptions | null): this;   // globe.js:2501
	/** 保っている鎖（正規化済み・順番どおり） */
	getPostChain(): PostPass[];   // globe.js:2502
	/** 後処理（bloom・vignette）。本体の絵（基図・地形・建物・gint）に掛かる。注記と同一フレームのオーバーレイは別 canvas＝掛からない。null で外す。 */
	setPostProcess(p: PostProcessOptions | PostPass[] | null): this;   // globe.js:2503
	/** 正規化済みの後処理の設定（off なら null）。fxaa／tonemap／lut の鍵は on の時だけ生える（W1） */
	getPostProcess(): { bloom: { threshold: number; strength: number; radius: number } | null; vignette: { strength: number; radius: number; softness: number } | null; fxaa?: true; tonemap?: { mode: "linear" | "reinhard" | "aces" | "agx" | "filmic"; exposure: number }; lut?: { url: string; size: 16 | 32 | 64; intensity: number } } | null;   // globe.js:2504
	// ── plugins
	/** plugin を搭載（同期）。同名は投げる。install が投げたら、その install 中の registry への登録は巻き戻す。opts.plugins で起動時にも */
	use<O>(plugin: OrthoPlugin<O> | Readonly<OrthoPlugin<O>>, opts?: O): this;   // globe.js:2517
	/** 撤去（uninstall か install の返した関数を呼び、その plugin の registry の登録を外す）。無ければ false */
	unuse(name: string | OrthoPlugin): boolean;   // globe.js:2518
	/** 搭載中の plugin */
	plugins(): { name: string; version: string | null; provides: string[] }[];   // globe.js:2519
	readonly registry: MapRegistry;   // globe.js:2520
	/** 鍵の能力が**今この地図で絵になる**か（"builtin" か "plugin" の時だけ true。"spec"・"no"・"never" は false） */
	supports(key: CapabilityKey): boolean;   // globe.js:2521
	/** 鍵ごとの正直な答え（台帳 §9「拡張点の台帳」の実行時の写し）。render.webgpu は実際のバックエンド・data.*／gadget.*／tiles.* は registry の今 */
	capabilities(): Record<CapabilityKey, Capability>;   // globe.js:2522
	// ── sprites, glyphs, fonts
	/** sprite の一覧（MapLibre の getSprite と同じ形）。setSprite＝全部入れ替え（null＝全部外す）・addSprite／removeSprite＝id ごと。default 以外の記号は "id:名前" */
	getSprite(): { id: string; url: string }[];   // globe.js:2553
	addSprite(id: string, url: string): GlobeMap;   // globe.js:2554
	removeSprite(id: string): GlobeMap;   // globe.js:2555
	setSprite(url: string | null): GlobeMap;   // globe.js:2556
	/** 記号帳の 1 枚（MapLibre の StyleImage の形・RGBA の生画素）。無ければ undefined */
	getImage(name: string): { data: { width: number; height: number; data: Uint8ClampedArray }; pixelRatio: number; sdf: boolean; version: number; stretchX?: number[][]; stretchY?: number[][]; content?: number[] } | undefined;   // globe.js:2557
	/** glyphs の URL＝記録だけ（文字は Canvas2D で描く）。getStyle に echo */
	getGlyphs(): string | undefined;   // globe.js:2560
	setGlyphs(url: string | null): GlobeMap;   // globe.js:2561
	/** URL で起動した style の URL（object の style なら undefined） */
	getStyleUrl(): string | undefined;   // globe.js:2562
	/** font-faces（[{ "font-family"|family, src（url(...) も可）, "font-weight"?, "font-style"?, "unicode-range"? }]）→ addFontFace。記録は getFontFaces に。署名は MapLibre 6.x の文書と未照合 */
	getFontFaces(): Record<string, unknown>[];   // globe.js:2563
	setFontFaces(list: Record<string, unknown>[]): Promise<GlobeMap>;   // globe.js:2564
	// ── tiles
	/** タイルの取り直し＝基図の source（無指定も）は新 style で組み直し・利用者の source はその層を載せ直す（geojson の URL は取り直す） */
	refreshTiles(sourceId?: string): Promise<GlobeMap>;   // globe.js:2570
	/** 今の画面を覆うタイル（近似＝画面に散らした点の逆投影・z は MapLibre の規則）。MapLibre の OverscaledTileID に似た形 */
	coveringTiles(options?: { tileSize?: number; minzoom?: number; maxzoom?: number; roundZoom?: boolean }): { canonical: { x: number; y: number; z: number }; overscaledZ: number; wrap: number; key: string }[];   // globe.js:2578
	/** タイルの z の規則の 2 定数（MapLibre 同名。内製の目盛りでは効かない） */
	setSourceTileLodParams(maxZoomLevelsOnScreen: number, tileCountMaxMinimum: number): GlobeMap;   // globe.js:2586
	// ── camera limits and MapLibre odds and ends (candidate: move into CameraApi)
	/** 制約（setConstrain・限界）の後にカメラを書き換える口（MapLibre の setTransformCameraUpdate）。角は度・zoom はエンジンの z・elevation＝注視点の高さ m。null で外す */
	setCameraUpdate(fn: ((cam: { center: [number, number]; zoom: number; pitch: number; bearing: number; roll: number; elevation: number }) => Partial<{ center: LonLat | { lng: number; lat: number }; zoom: number; pitch: number; bearing: number; roll: number; elevation: number }> | null | undefined) | null): GlobeMap;   // globe.js:2590
	/** 最小チルト（度・MapLibre 同名） */
	setMinPitch(deg: number): GlobeMap;   // globe.js:2591
	getMinPitch(): number;   // globe.js:2592
	/** 描く解像度（CSS px あたりの画素・0.5〜4）。星空劇場・overlay の内部は起動時の値のまま */
	setPixelRatio(ratio: number): GlobeMap;   // globe.js:2593
	getPixelRatio(): number;   // globe.js:2594
	/** 連続描画（MapLibre の map.repaint・計測用） */
	setRepaint(on: boolean): GlobeMap;   // globe.js:2595
	getRepaint(): boolean;   // globe.js:2596
	/** debug の表示（MapLibre の showTileBoundaries・showPadding）＝main の canvas2D 1 枚 */
	setDebug(o: { tileBoundaries?: boolean; padding?: boolean }): GlobeMap;   // globe.js:2615
	getDebug(): { tileBoundaries: boolean; padding: boolean };   // globe.js:2616
	/** 宇宙（球の外側）の色（1.16.0〜・B5）。色の文字列・"transparent"・null＝起動時の既定 */
	setClearColor(color: string | null): GlobeMap;   // globe.js:2617
	/** 中心の可動域。null で解除。west>east＝±180 跨ぎ。入力・飛行・URL 復元のどれで動いても締まる */
	setMaxBounds(bounds: Bbox | [LonLat, LonLat] | null): GlobeMap;   // globe.js:2618
	getMaxBounds(): Bbox | null;   // globe.js:2623
	// delegates to setZoomMin (CameraApi) = cross-installer call
	setMinZoom(zoom: number | null): GlobeMap;   // globe.js:2624
	getMinZoom(): number;   // globe.js:2625
	/** 寄りの上限（起動時の zoomMax を超えない）。null＝起動時の上限へ */
	setMaxZoom(zoom: number | null): GlobeMap;   // globe.js:2626
	getMaxZoom(): number;   // globe.js:2627
	getCenter(): { lng: number; lat: number };   // globe.js:2628
	/** 度（map.view.pitch はラジアン） */
	getPitch(): number;   // globe.js:2629
	/** 度（map.view.bearing はラジアン） */
	getBearing(): number;   // globe.js:2630
	/** 視線まわりの回転（度・MapLibre 同名・1.16.0〜）。共有 hash では "15roll"。easeTo は補間・flyTo は離陸で書く */
	getRoll(): number;   // globe.js:2632
	setRoll(rollDeg: number): GlobeMap;   // globe.js:2633
	/** 縦の視野角（度・MapLibre 同名・1.16.0〜）。既定 50（MapLibre は 36.87）。同じ zoom で地表の縮尺は変わらずカメラの距離が変わる */
	getVerticalFieldOfView(): number;   // globe.js:2634
	setVerticalFieldOfView(deg: number): GlobeMap;   // globe.js:2635
	setCenter(center: LonLat | { lng: number; lat: number }): GlobeMap;   // globe.js:2636
	setZoom(zoom: number): GlobeMap;   // globe.js:2637
	setPitch(pitchDeg: number): GlobeMap;   // globe.js:2638
	setBearing(bearingDeg: number): GlobeMap;   // globe.js:2639
	isMoving(): boolean;   // globe.js:2640
	/** 飛行・easeTo・慣性・ズームの滑りを止める */
	stop(): GlobeMap;   // globe.js:2641
	/** handler の on/off（1.16.0〜・A2）。shift＋ドラッグ＝ボックスズーム（1.16.0〜。以前はチルト・右ボタン／Ctrl＋ドラッグは従来どおりチルト）・ダブルクリック／ダブルタップ＝z+1（shift で z−1）・+/−＝1 段・離した勢いの慣性（MapLibre の定数） */
	setHandler(name: HandlerName, on: boolean): GlobeMap;   // globe.js:2643
	handlerOn(name: HandlerName): boolean;   // globe.js:2644
	setZoomSnap(v: number): GlobeMap;   // globe.js:2645
	getZoomSnap(): number;   // globe.js:2646
	/** 動きの時計（C10・2026-10-12）＝飛行・paint の transition・共通の時計の刻みが読む時計を ms に止める（続けて呼べば進む）＝決定論の撮影（同じ setNow の列は同じ絵）。restoreNow＝実時間へ。
	 *  画像タイルの到着フェード（raster-fade-duration）と注記のフェードは描く側の壁時計のまま（記録） */
	setNow(ms: number): GlobeMap;   // globe.js:2649
	restoreNow(): GlobeMap;   // globe.js:2650
	getNow(): number;   // globe.js:2651
	/** 動きを減らす（C10）＝true/false・null＝OS の prefers-reduced-motion を追う */
	setReduceMotion(v: boolean | null): GlobeMap;   // globe.js:2652
	getReduceMotion(): boolean;   // globe.js:2653
	/** 建物 3D（地域の建物メッシュ＝日本は PLATEAU LOD2）を出す／伏せる（2026-10-21）。伏せている間は描かず新しく読み込まない（読んだ物は保つ＝戻すと即）。opts.mesh=false の地図では効かない */
	setMeshVisible(on: boolean): GlobeMap;
	/** 建物 3D を出しているか（opts.mesh=false の地図は false） */
	getMeshVisible(): boolean;
	/** 基図の表示項目を点ける／消す（2026-10-21）。キーは opts.layers と同じ（place/terrain/rail/road/facility）。チップ・共有 URL も一緒に変わる。opts.layers で固定したキーは変わらない */
	setBaseLayers(layers: Partial<Record<"place" | "terrain" | "rail" | "road" | "facility", boolean>>): GlobeMap;
	/** 基図の表示項目の今の状態 */
	getBaseLayers(): Record<"place" | "terrain" | "rail" | "road" | "facility", boolean>;
	// ── bounds / frames / gint glue
	/** 見えている範囲の概算 [w,s,e,n]（画面の四隅と辺の中点の逆投影）。球の縁が画面に入る時は null */
	getBounds(): Bbox | null;   // globe.js:2655
	/** 表示中の v1 ユーザー層（ドロップ/?g=）の GeoPBF（無ければ null）＝編集への受け渡し口 */
	userPbf(): GeoPBF | null;   // globe.js:2663
	/** 描画フレーム毎フック（戻り値=解除関数）。**描画はオンデマンド＝静止中は呼ばれない**。オーバレイを載せた/更新した直後は requestDraw() で 1 フレーム点火する */
	onFrame(fn: () => void): () => void;   // globe.js:2664
	/**
	 * クリック識別（fid・properties・経緯度）。lnglat＝ホバー pick が当たった**カーソル位置**の球面座標であって
	 * フィーチャの座標ではない（点をクリックしても同じ。座標が要るなら properties に持たせる）。クリックはホバーの識別結果に依存する。
	 * 識別（GPU pick）は**海面基準**＝チルトで地形に乗った線とは視差があり当たりにくい（代替＝setEditClick＋makeProjectorH の最近傍、または pbf.identifyAt）。
	 * **非ヒット（海など）では呼ばれない**＝選択解除は mapEl の click ＋ unprojectXY ＋ pbf.contain(ll)===null で組む
	 */
	onGintClick(fn: (fid: number, props: Record<string, unknown>, lnglat: LonLat) => void): void;   // globe.js:2671
	/** 描画バックエンド（初回フレーム前は null） */
	readonly backend: "webgpu" | "webgl2" | null;   // globe.js:2672
	// ── point clouds and 3D Tiles
	/** 点群（LAS／LAZ／COPC）を足す。COPC は節だけ範囲読み。普通の LAS/LAZ（1.0〜1.4・点の形式 0〜10）はファイルを丸ごと読み、その場で八分木を作る。
	 *  丸ごと読みの上限＝2,000 万点・URL は 500 MB（超えたら COPC への変換を案内して reject）。.las／.laz のドロップも同じ */
	addPointCloud(src: string | File | Blob, opts?: COPCOptions): Promise<COPCHandle>;   // globe.js:2921
	/** 点群を外す（id を省く＝全部） */
	removePointCloud(id?: string): Promise<boolean>;   // globe.js:2922
	// delegates to gadget.tiles3d (globe.js:2971) = typed from the same registry entry
	/** 任意の 3D Tiles を画面上の誤差で流す（1.2.0〜・#41）。url＝tileset.json（?tiles3d=<URL> と同じ）。
	 *  中身＝b3dm・i3dm・pnts（点群）・cmpt・glb/glTF（3D Tiles 1.1）・外部 tileset。refine REPLACE（子が揃うまで親）/ ADD。GPU 予算を超えたら使っていないタイルから捨てる。
	 *  高さ＝既定は tileset の高さのまま（写真測量・点群）。建物の tileset は ground:"terrain"＝1 棟ずつ地面へ接地。点群は同一フレームのオーバーレイ（深度は共有しない＝#47）。
	 *  未対応＝implicit tiling・メタデータとスタイル・API キーの要る配信 */
	// 実体は map.gadget.tiles3d を呼ぶだけ：url（文字列）＝足した手綱・null＝外す（null が返る）
	add3DTiles(url: string, opts?: Tiles3DOptions): Promise<Tiles3DHandle>;
	add3DTiles(url: null, opts?: Tiles3DOptions): Promise<null>;   // globe.js:2971
	addI3S(url: string, opts?: Tiles3DOptions & { lodScale?: number; token?: string }): Promise<{ id: string; name: string | null; copyright: string | null; readonly stats: Tiles3DHandle["stats"]; remove(): void; setVisible(v: boolean): void; setOptions(o: Partial<Tiles3DOptions> & { lodScale?: number }): void }>;   // globe.js:2973
}

/** installCamera (api/camera.ts:25), called at globe.js:2527. */
export interface CameraApi {
	/** 基図（紙・線）・球体（globe/terrain）・全球ハイプソ（低ズームの段彩＝0 で陸の地色だけ・1.7.x〜）の不透明度（0..1） */
	setOpacity(o: { base?: number; globe?: number; hypso?: number }): void;   // api/camera.ts:29
	/** チルト上限の実行時変更（**度**・null＝起動時の値へ・0＝真俯瞰固定）。超えていれば即座に上限へ寄せる */
	setMaxPitch(deg: number | null): void;   // api/camera.ts:31
	/** 現在のチルト上限（ラジアン・ortho の口） */
	maxPitch(): number;   // api/camera.ts:37
	/** 現在のチルト上限（度・MapLibre 同名・1.3.0〜） */
	getMaxPitch(): number;   // api/camera.ts:38
	/** ズーム床の実行時変更（setMinZoom の実体・null＝カメラの既定の床へ）。入力・飛行・共有 hash・ズームボタンが従う */
	setZoomMin(zoom: number | null): void;   // api/camera.ts:40
	/** 現在のズーム床 */
	zoomMin(): number;   // api/camera.ts:46
	/** 即座に移る（MapLibre 同名・角は度） */
	jumpTo(options: CameraOptions): GlobeMap;   // api/camera.ts:92
	/** 全項目を一本の緩急で同時に動かす（MapLibre 同名）。duration 既定 500ms。着地（または中断）で解決 */
	easeTo(options: CameraOptions & { duration?: number; animate?: boolean; essential?: boolean }): Promise<void>;   // api/camera.ts:94
	// 持ち主は 1 つ（ここ）：map の字面に置いていた内部の位置引数の flyTo は外した（installCamera の前に map.flyTo を読む所は無い）。位置引数の道は内部の flyTo（deps）をそのまま呼ぶ
	/** 飛行（度）。戻り値＝着地または cancel で解決する Promise（1.0.5〜。以前は void＝on("move") の無音で判定していた）。静止の合図は on("settle") */
	flyTo(lon: number, lat: number, zoom: number, tiltDeg?: number, bearingDeg?: number): Promise<void>;   // api/camera.ts:96
	/** MapLibre の形の飛行（1.2.0〜・#35）。省略した項目は今の値。animate:false＝jumpTo と同じ */
	flyTo(options: CameraOptions & { animate?: boolean; essential?: boolean }): Promise<void>;   // api/camera.ts:96
	/** fitBounds が向かうカメラ（動かさない） */
	cameraForBounds(bounds: Bbox | [LonLat, LonLat], options?: FitBoundsOptions): (Required<Pick<CameraOptions, "center" | "zoom" | "pitch" | "bearing">> & { padding: PaddingOptions }) | null;   // api/camera.ts:104
	/** bbox が収まる所へ（MapLibre 同名）。west>east＝±180 跨ぎ。linear:true＝easeTo・既定＝flyTo・animate:false＝jumpTo */
	fitBounds(bounds: Bbox | [LonLat, LonLat], options?: FitBoundsOptions): Promise<void>;   // api/camera.ts:116
	/** 既定の padding（以後の jumpTo/easeTo/flyTo/fitBounds の中身の中心）。数値＝四辺同じ。1.16.0〜は MapLibre と同じく注視点（getCenter）を画面の中身の中心に写し消失点も動く（以前は経緯度の中心をずらしていた＝getCenter が頼んだ点と違った） */
	setPadding(padding: PaddingOptions | number): GlobeMap;   // api/camera.ts:122
	getPadding(): PaddingOptions;   // api/camera.ts:123
	/** 画面の 2 点（CSS px）が収まる所へ（MapLibre 同名・1.16.0〜）。bearing＝着地の方位。どちらかが球の外なら何もしない */
	fitScreenCoordinates(p0: [number, number] | { x: number; y: number }, p1: [number, number] | { x: number; y: number }, bearing?: number, options?: FitBoundsOptions): Promise<void>;   // api/camera.ts:125
	/** 注視点の高さの実行時変更（MapLibre 同名・1.16.0〜）。true＝地形の上の中心点（opts.centerElevation:"ground"）・false＝固定値（setCenterElevation／jumpTo({elevation})） */
	setCenterClampedToGround(clamped: boolean): GlobeMap;   // api/camera.ts:132
	getCenterClampedToGround(): boolean;   // api/camera.ts:133
	setCenterElevation(meters: number): GlobeMap;   // api/camera.ts:134
	/** 今の注視点の高さ［m］（map.cam.centerAlt） */
	getCenterElevation(): number;   // api/camera.ts:135
	getCameraTargetElevation(): number;   // api/camera.ts:136
	/** 可動域の自作（MapLibre の setTransformConstrain 相当・1.16.0〜）。毎移動、締める前に fn を通し、返した center/zoom を採る（null＝そのまま）。角は度・zoom はこの地図の z（旗つきでも換算しない） */
	setConstrain(fn: ((v: { center: LonLat; zoom: number; pitch: number; bearing: number; roll: number }) => { center?: LonLat | { lng: number; lat: number }; zoom?: number } | null | undefined) | null): GlobeMap;   // api/camera.ts:139
	/** 的を注視点に（A4・1.16.0〜）。duration>0 なら easeTo。的が無い（軌跡の範囲外・不明な id）なら何もしない。高さのある的は注視点の高さを的に合わせる（centerClampedToGround が false になる） */
	lookAt(target: CameraTarget, options?: LookAtOptions): Promise<void>;   // api/camera.ts:161
	/** 毎フレーム的を追う（衛星・車両・CZML の時刻つき点・1.16.0〜）。省いた角・zoom は今の値のまま＝追従中の setZoom や回転が効く。null で止める。flyTo 中は的を待つ */
	follow(target: CameraTarget | null, options?: FollowOptions): FollowHandle | null;   // api/camera.ts:172
	isFollowing(): boolean;   // api/camera.ts:179
	/** Navara の setCamera の形を 1 対 1 で受ける（即時・1.16.0〜）。省いた物は今の値。zoom を渡せば distance より優先 */
	setCamera(camera: Partial<NavaraCamera> & { lon?: number; alt?: number; bearing?: number; zoom?: number }): GlobeMap;   // api/camera.ts:196
	getCamera(): NavaraCamera;   // api/camera.ts:204
	/** style の light（MapLibre 同名・1.16.0〜）＝押し出し・glTF・LOD2 の陰影の向き・強さ・色（WebGL2・WebGPU とも。WebGPU の fx.pbr の経路は太陽＋環境光のまま）。null＝従来の固定光に戻す。style の根の light は起動と setStyle で読む */
	setLight(light: LightSpecification | null): GlobeMap;   // api/camera.ts:206
	/** 今の light（既定を補った物） */
	getLight(): Required<LightSpecification>;   // api/camera.ts:207
	/** 光源の口（F1・2026-10-12）。配列で受けて既定を補って保つ。directional は 1 つまで（setLight と同じ経路で描く）。point／spot／ambient／hemisphere は W2（2026-10-12）でメッシュ（模型・押し出し・LOD2）の陰影に足す（WebGL2・WebGPU・上限 8 灯・位置 [lon, lat, alt m]・range m（0＝減衰なし）・decay＝(1−d/range)^decay・spot は direction [東,北,上] か target）。ibl は保つだけ。知らない type は投げる（plugin は registry.lights に足す）。[] で全部外す */
	setLights(lights: LightSpec[] | LightSpec | null): GlobeMap;   // api/camera.ts:212
	/** 保っている光源（directional は setLight／style の根の light も映る・正規化済み） */
	getLights(): LightSpec[];   // api/camera.ts:222
	/** style の sky（MapLibre 同名・1.16.0〜）＝球に当たらない視線を horizon-color→sky-color の簡易の空で塗る（WebGL2・不透明＝星空は隠れる）。fog-color・fog-ground-blend は両レンダラの霧に効く。null＝従来（宇宙へ抜けるリム光・霧は紙色） */
	setSky(sky: SkySpecification | null): GlobeMap;   // api/camera.ts:225
	/** 今の sky（既定を補った物）。無指定なら undefined（MapLibre と同じ） */
	getSky(): Required<SkySpecification> | undefined;   // api/camera.ts:226
	/** 太陽の向き（F2・2026-10-12・ephem＝夜の側・日影と同じ出所・精度 約 0.05°）。ms 省略＝共通の時計の今・at 省略＝視点の中心 */
	getSunPosition(ms?: number, at?: LonLat | { lng?: number; lon?: number; lat: number }): BodyPosition;   // api/camera.ts:237
	/** 月の向き（地心＝視差なし・精度 約 0.3°） */
	getMoonPosition(ms?: number, at?: LonLat | { lng?: number; lon?: number; lat: number }): BodyPosition;   // api/camera.ts:238
	/** directional の光（setLight と同じ 1 本）を太陽に合わせる。null＝外す（setLight(null)＝従来の固定光） */
	setSun(sun: SunSpec | true | false | null): GlobeMap;   // api/camera.ts:241
	getSun(): (Required<Pick<SunSpec, "follow" | "minAltitude">> & SunSpec) | null;   // api/camera.ts:247
	/** 雲の spec。type "image" は builtin が描く（W6・読めたら on("clouds") に { state:"ready", tris, image }・失敗は { state:"error" }）。手続きの雲・降水は受けて保つだけ（plugin の registry.clouds が描ける）。null で外す */
	setClouds(clouds: CloudsSpec | true | null): GlobeMap;   // api/camera.ts:253
	getClouds(): Required<CloudsSpec> | null;   // api/camera.ts:268
}

/** installOverlays (api/overlays.ts:8), called at globe.js:2665. */
export interface OverlaysApi {
	// 持ち主は 1 つ（ここ）＝関数だけ。globe.js は先に器（createOverlay）を map.overlay に置き、installOverlays の後で器のメソッド（setSelectionMask・setHoverOutline・loadOverlay・clearOverlay…）を
	// この関数へ Object.assign する（census2020 の旧い呼び方の互換）＝実行時には在るが公開の型には出さない（GlobeInternals.overlay）。地域パックは hostEnv の器を使う
	/** 同一フレームのオーバーレイ：レンダーワーカー内で地球・注記と同じフレーム・同じカメラで描く自前 canvas（main の onFrame は 1〜2 フレーム先行する）。
	 *  url＝worker が import() する依存ゼロのモジュール { init(canvas, opts), message(data), frame(cam, camState, {w,h}, api) → boolean, destroy() }。
	 *  api＝OverlayFrameApi＝{ project, projectH, clipH, dpr, W, H, time（共通の時計の時刻 ms・1.2.0〜・#42）, clock（{sim,wall,rate}｜null＝実時刻）, depth }。
	 *  シーンの深度（1.2.0〜・#47）：opts.depth:true か init の戻り値 { depth: true } で申し出たオーバーレイがある時だけ本体が作り、api.depth に載る（OverlayDepth）。
	 *  init の第 3 引数 host に depthGLSL（FS に貼る GLSL）。省メモリ端末（LOW_MEM）・作れない環境では api.depth＝null（従来どおり＝隠れ無し）。
	 *  戻り値の post(data, transfer) で状態やデータを渡す（描画要求を兼ねる）。remove() で外す */
	overlay(src: string | { builtin: string }, opts?: { name?: string; opts?: Record<string, unknown>; above?: boolean }): OverlayHandle;   // api/overlays.ts:36
	/** 統一 picking（deck.gl の onHover／onClick の object 相当・PR-1）＝同一フレームのオーバーレイのうち module が pick(x, y, r, ctx) を持つ物に当てる（手前から）。x／y／radius＝CSS px・names＝オーバーレイの名前か、その上の層の id（addLayerId）。
	 *  3 秒で答えが無ければ []。層イベント（map.on(ev, overlayName, cb)）と queryRenderedFeatures({ layers:[overlayName] }) にも同じ答えが Feature の形で混ざる */
	pickOverlays(x: number, y: number, opts?: { radius?: number; names?: string[] }): Promise<OverlayPick[]>;   // api/overlays.ts:67
}

/** installTerrain (api/terrain.ts:19), called at globe.js:2675. */
export interface TerrainApi {
	/** 標高 m（GSI DEM10B / AW3D30 のタイルを api.ortho-earth.com 経由で取得）。格子は今のズームで決まる＝z<7 は R90・z<12 は R10（約 460m＝鋭い山頂は低めに出る）・
	 *  z≥12 は R01（10m＝日本は DEM10B・海外は AW3D30）。2026-09-25 の修正より前の版は z≥12 でも R10 に落ちていた（富士山頂 3567m 等）。
	 *  1.0.4〜ローダ着荷（数秒）を待って返す（初期化失敗は reject）。1.0.3 以前は未着の間 0 を返す＝>0 になるまで再照会 */
	getHeight(lon: number, lat: number): Promise<number>;   // api/terrain.ts:22
	/** 標高を外来の DEM に（MapLibre 同名・#36）。source＝addSource した raster-dem の id か spec。null＝既定の標高へ。exaggeration は受け流す（地形は誇張しない） */
	setTerrain(terrain: { source: string | RasterDemSource | QuantizedMeshSource; exaggeration?: number } | null): Promise<GlobeMap>;   // api/terrain.ts:25
	// source は整えた後の spec（実体）＝叩き台の RasterDemSource | QuantizedMeshSource から実体に合わせた（TileJSON の申告の encoding・bounds は型の外の値も通る）
	getTerrain(): { source: TerrainSourceSpec; exaggeration: 1 } | null;   // api/terrain.ts:47
	/** 地形の標高 m（MapLibre 同名・同期）＝地形（setTerrain／style の terrain）がある時だけ。手元に無ければ null（照会を起こす＝次の呼び出しで返る・MapLibre も未着は null）。待てる口は sampleTerrain・既定の DTM は getHeight */
	queryTerrainElevation(lon: number, lat: number): number | null;   // api/terrain.ts:48
	/** 地形の一括標本（F6・2026-10-12・実装つき）。出どころは描いている地形と同じ（setTerrain／style の terrain の DEM が先・無い所は既定の DTM＝getHeight）。到着を待つ。
	 *  positions＝[lng,lat][]・{lng|lon,lat}[]・GeoJSON（Point/MultiPoint/LineString…の座標）。負の標高はそのまま返す（描く側は 0 に切る） */
	sampleTerrain(positions: LonLat[] | { lng?: number; lon?: number; lat: number }[] | object, opts?: { concurrency?: number }): Promise<{ lng: number; lat: number; height: number }[]>;   // api/terrain.ts:52
	/** 一人称歩行（F6 の口・W3 で builtin の中身＝src/walk.js）。registry.handlers の "walk"（plugin）があればそれが勝つ。足元＝描いている地形・壁＝基図の建物の足跡と押し出し（簡易の衝突） */
	walk(opts?: WalkOptions): WalkHandle;   // api/terrain.ts:77
	// camera member living in installTerrain (terrain.js:77); the facade converts it (mlfacade.js FACADE_CONV). Move to CameraApi in the port
	getZoom(): number;   // api/terrain.ts:89
}

/** installRaster (api/raster.ts:27), called at globe.js:2691. NB: name sits next to globe.d.ts `RasterAPI` (the type of map.raster). */
export interface RasterApi {
	/** 画像タイル層（ラスタ）。地形へドレープされる（地面の塗りと同じ合成）。order:"under"＝基図（塗りを伏せる）／"over"＝重ね（線と注記は上に残る）。
	 *  spec＝XYZ テンプレ｜ラスタ PMTiles｜ローカル容器（.gpkg/.mbtiles）｜外部プロバイダの MessagePort｜**四隅で貼る画像**（MapLibre の image source 相当・1.1〜）。
	 *  四隅の順＝左上→右上→右下→左下（[lon,lat]）＝射影変換で貼る（台形も歪まない）。geoedit の @image（4 頂点の面）と同じ表し方。戻り値＝ソースの自己申告 */
	raster: RasterAPI;   // api/raster.ts:101
}

/** installGadgets (api/gadgets.ts), called at globe.js:2698. registerGadget の持ち主（後の installer と globe.js は戻りの registerGadget で登録する）。
 *  Registers gadgets: search hint compass equal equalHere lang equalStart solar mesh palette zoom full cpos contextmenu tip pop explain legend measure profile */
export interface GadgetsApi {
	/** 登録された gadget を名前で呼ぶ（map.gadget.search() など）。登録した名前だけがあり、引数も名前ごとに検査される。
	 *  自作の gadget の登録は map.registry.gadgets.add(name, (map, ...args) => handle)（2.0 で旧来の map.gadget(name, func)＝this が map の登録を外した） */
	readonly gadget: GadgetCallers;   // api/gadgets.ts
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Gadgets：registerGadget(name, (map, ...args) => handle)（判断 2・batch 2）。1.x の map.gadget(name, func)（func.apply(map, arguments)・this＝map）は 2.0 で外した
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** 表示の門（どの gadget も第 1 引数の opts で受ける＝api/gadgets.ts の registerGadget が読む）。zoom＝この域 [min, max) だけ出す・narrow:false＝狭い画面（480px 以下）では出さない。
 *  門が効くのは、呼んだその場で左上のスタック（#gadgets）に要素を生やす gadget だけ */
export interface GadgetGate { zoom?: [min: number, max: number]; narrow?: boolean }
/** 第 1 引数が opts の gadget（門の鍵をそこで受ける）。残りはデータが先（src・pbf・url） */
export type GatedGadgetName = "search" | "zoom" | "compass" | "full" | "shot" | "measure" | "profile" | "contextmenu" | "legend" | "palette"
	| "hint" | "home" | "qr" | "print" | "cpos" | "mesh" | "dropFile" | "sunshadow" | "offline" | "viewshed" | "clock" | "tip" | "pop"
	| "inspect" | "close" | "demo" | "edit" | "equal" | "explain" | "geoedit" | "globe" | "hud" | "lang" | "poiedit" | "raster" | "solar" | "stac";
/** opts に門の鍵を足す（opts が同じ名の鍵を持つ時は opts の方＝search の zoom は数か門の配列） */
type WithGate<F> = F extends (opts?: infer O) => infer R ? (opts?: (unknown extends O ? {} : NonNullable<O>) & Omit<GadgetGate, keyof NonNullable<O>>) => R : F;
/** map.gadget：登録された名前だけ・名前ごとの引数（Gadgets）＋表示の門 */
export type GadgetCallers = { readonly [K in keyof Gadgets]: K extends GatedGadgetName ? WithGate<Gadgets[K]> : Gadgets[K] };
/** gadget の本体：map が第 1 引数（this は使わない）・その後ろに呼び手の引数 */
export type GadgetFactory<F> = F extends (...args: infer A) => infer R ? (map: GlobeMap, ...args: A) => R : never;
/** 登録口（api/gadgets.ts の installGadgets が返す・map ごと）。登録した名前は map.gadget.<名前> で呼べ、表示の門（GadgetGate）がかかる。
 *  名前と型は Gadgets（globe.d.ts）が持つ。plugin の gadget は map.registry.gadgets.add(name, (map, ...args) => handle)（同じ登録口に入る） */
export type RegisterGadget = <K extends keyof Gadgets>(name: K, factory: GadgetFactory<NonNullable<GadgetCallers[K]>>) => void;

/** installShadows (api/shadows.ts:36), called at globe.js:2710.
 *  Registers gadgets: offline@141 sunshadow@153 clock@159 viewshed@160 shot@165 qr@168 home@172 print@177 close@180 poiedit@188 */
export interface ShadowsApi {
	/** 日影（1.2.0〜・#44）。建物（既定＝地域の建物台帳＝日本は PLATEAU・tilesets で任意の 3D Tiles）の影を測定面へ投影し、地面に画像として貼る（map.raster の "sunshadow"）。
	 *  mode "duration"＝日影図（既定＝冬至・真太陽時 8〜16 時・30 分刻みで日影になる時間の段彩と 2〜5 時間の境線）／"instant"＝date の時刻の影。範囲＝既定は画面に見えている所（一辺 3km まで）。
	 *  probe＝指定地点の日影時間（時・instant は 0|1）。ボタンとパネルは map.gadget.sunshadow() */
	sunShadow(opts?: { mode?: "duration" | "instant"; date?: Date | string; planeH?: number; hours?: [number, number]; step?: number; decl?: number; bbox?: Bbox; tilesets?: string[]; probe?: LonLat[] }): Promise<{ triangles: number; tiles: number; steps: number; maxHours: number; decl: number; planeH: number; mode: string; probes: number[] }>;   // api/shadows.ts:47
	/** リアルタイムの影（1.2.1〜・1.7.0 で範囲を広げた＝#112）。描画の中で太陽から深度を描き（shadow map）、影を落とす。
	 *  落とす物＝地形（1.7.0〜）・基図の押し出し・PLATEAU 等のメッシュ・glb の模型・3D Tiles・I3S・押し出し（map.gadget.extrude／fill-extrusion の層）。
	 *  模型の MASK（葉などの切り抜き）は α で抜いて落とす。半透明（BLEND）の模型と、統計の柱（市区町村のような広い面の押し出し）は落とさない。
	 *  受ける物＝地面（地形・球の床）・塗り・線・建物・メッシュ・模型・3D Tiles・I3S・押し出し（不透明と半透明）。gint の線・注記・オーバーレイは受けない。
	 *  影の間は地形の陰影の光も太陽の方位に合わせる（強さは従来と同じ）。影の窓は 1 枚＝画面の中心のまわり（半幅 120m〜6km）で、縁は丸く薄める
	 *  （傾けた遠景は影なし）。true／false／{ time（Date・ms・ISO＝その時刻の太陽・省略＝共通の時計）, darkness（影の明るさ 0..1・既定 0.66） }。
	 *  z13 以上・太陽が地平線の上（2° 以上）の時だけ。**WebGPU 専用**（WebGL2 フォールバックでは何もしない＝影をかけない仕様）。消している間は描画に一切関与しない（資源も持たない） */
	setShadows(opts?: boolean | { on?: boolean; time?: Date | number | string; darkness?: number }): void;   // api/shadows.ts:64
	/** 断面とクリッピング平面（1.7.0〜・#111）。建物・地形・基図を平面で切って中を見る（Cesium の ClippingPlane に当たる）。面は全部の交わり（残るのは全部の面の内側）・6 枚まで。
	 *  vertical＝2 点 a→b（[lon, lat]）を通る鉛直面＝**a→b に向かって右側を残す**・horizontal＝高さ h（m）の水平面（その地点の接平面・keep "below"＝既定で下を残す／"above"）・
	 *  box＝箱の内側を残す（center・size＝[東西の幅, 南北の奥行き] m・h＝[底, 天] m・bearing＝奥行きの向き 度）・planes＝単位球の平面 [nx, ny, nz, c]（n·X ≥ c を残す・上級者向け）。
	 *  切れる物＝地形（切り口に土の色の蓋＝鉛直面は縦の幕・水平面は板）・球の床・基図の塗りと線と押し出し建物・建物メッシュ（閉じた建物は裏面を蓋の色で塗る疑似の蓋）・
	 *  模型／3D Tiles／I3S・gint の線と点と塗り・外部ベクタ（map.overlay の塗りと線）・注記・同一フレームのオーバーレイ（frame の api.clip＝面と距離の関数）。
	 *  切り口には縁の帯（既定 2px の橙・edge:false で消す／{ width, color }）。cap:false で蓋なし。影（setShadows）は切った形で落ちる。
	 *  識別・ホバー・queryRenderedFeatures も切られた側を返さない（押し出しは足元が全部切られた物だけ外す）。日影図・可視域・見通し線は切らない（実物で測る）。
	 *  対象ごとの面：配列で群を並べ、群ごとに targets（ClipTarget）を指定できる（例：[{ box, targets: ["terrain"] }, { horizontal, targets: ["buildings", "models"] }]＝地形は箱・建物は水平面）。
	 *  対象ごとに 6 枚まで・targets 省略＝全部・蓋と縁の帯は最初に cap／edge を書いた群の値。
	 *  false で消す（消している間は描画に一切関与しない）。**WebGPU 専用**（WebGL2 フォールバックでは何もしない＝影と同じ扱い）。URL の ?clip=（lon1,lat1,lon2,lat2／h:lon,lat,高さ[,above]／box:lon,lat,幅,奥行き[,底,天[,向き]]・; で重ねる） */
	setClipping(opts?: false | ClipOptions | ClipOptions[]): void;   // api/shadows.ts:78
	/** 今の切り方（setClipping に渡した物の写し）・切っていなければ null（1.7.0〜・#111） */
	getClipping(): ClipOptions | ClipOptions[] | null;   // api/shadows.ts:90
	/** 可視域（1.2.0〜・#44）。observer（既定＝画面の中心）に目の高さ eyeH（m・既定 1.6）で立ち、半径 radius（m・既定 1000・最大 5000）の中で高さ targetH（m）の点が見えるか。
	 *  地表＝地形（setTerrain の DEM があればそれ）＋建物（buildings:false で地形だけ・tilesets で任意の 3D Tiles）・地球の丸みと大気の屈折（k＝0.13）込み。
	 *  結果は地面に画像として貼る（map.raster の "viewshed"＝見える所が緑）。probe＝指定地点が見えるか（1|0）。ボタンとパネルは map.gadget.viewshed() */
	viewshed(opts?: { observer?: LonLat; eyeH?: number; targetH?: number; radius?: number; buildings?: boolean; tilesets?: string[]; cell?: number; probe?: LonLat[] }): Promise<{ cells: number; visibleRatio: number; triangles: number; eyeZ: number; cell: number; probes: number[] }>;   // api/shadows.ts:120
	/** 見通し線（1.2.0〜・#44）。a（視点・高さ eyeH）から b（目標・高さ targetH）が見えるか。遮る最初の点 blockAt・距離（m）・断面 profile（[距離, 地表, 視線] m）。
	 *  地図に線を引く（source/layer "los"＝見える区間が緑・遮られた先が赤） */
	lineOfSight(a: LonLat, b: LonLat, opts?: { eyeH?: number; targetH?: number; buildings?: boolean; tilesets?: string[]; cell?: number }): Promise<{ visible: boolean; blockAt: LonLat | null; distance: number; profile: [number, number, number][]; triangles: number }>;   // api/shadows.ts:128
	/** 可視域の画像と見通し線を消す */
	clearViewshed(): Promise<void>;   // api/shadows.ts:158
}

/** installData (api/data.ts:29), called at globe.js:2726. */
export interface DataApi {
	/** 列チャンク層（1.4.0〜・#90）＝GeoPBF／GeoParquet を **gint を通さず** 描く（位相・Morton・VW を作らない＝最初の 1 枚が「読み＋詰め替え」だけ）。
	 *  src＝GeoParquet の URL（footer → 視野の row group だけ Range）／File・GeoPBF の File／ArrayBuffer／geopbf() の戻り。本体は動的 import＝使わない頁には 0 バイト。
	 *  失うもの＝共有境界は 2 回描く・重なった面は後勝ち・LOD は 2〜3 段・地形には沿わない（楕円体の上）。編集や位相が要る時は gint（addGint）へ */
	addColumnar(src: string | File | Blob | ArrayBuffer | GeoPBF, opts?: ColumnarLayerOptions): Promise<ColumnarLayerHandle | null>;   // api/data.ts:259
	/** three.js を render worker の中で描く（PR-3・gadgets/three-draw.ts・手引き＝packages/globe/THREE.md）。three＝three.module.js の URL（利用者が持ち込む＝依存にしない・省略＝jsDelivr の three@0.186.1）・
	 *  addons＝three/examples/jsm/ の URL（省略＝three の URL から推す）・module＝利用者のモジュールの URL（export setup(THREE, scene, h)／update?(dt, h)／onMessage?(d, h)／dispose?(h)。中で `import * as THREE from "three"`・
	 *  `import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"` と書いてよい＝worker の中で解く）・origin＝[lon, lat, hM]（シーンの ENU m の原点＝RTE・省略＝今の中心）・
	 *  renderer＝"webgl"（既定・WebGLRenderer）か "webgpu"（three.webgpu.js の WebGPURenderer・three の既定もその build に。本体が WebGPU なら GPUDevice を共有し深度をコピーなしで使う）・
	 *  depth＝地形・建物に隠れる（既定 true・three r180 以上。古い three は深度なしで描いて警告）・params＝setup へ渡す物・name＝オーバーレイの名前（既定 "three"・2 つ目から "three2"…）・above＝注記の上。
	 *  モジュールは worker で動く＝DOM（document・window）は無い。1 つごとに WebGL 文脈が 1 つ増える（worker の文脈は Chrome で 4 つまで・地球が 1 つ）＝模型は 1 つの addThree にまとめる。
	 *  戻り値＝オーバーレイの手綱＋ready（setup が済んだら解決・読み込みや setup の失敗は reject） */
	addThree(opts?: { renderer?: "webgl" | "webgpu"; three?: string; addons?: string; module?: string; origin?: [number, number, number]; depth?: boolean; params?: unknown; name?: string; above?: boolean }): OverlayHandle & { ready: Promise<OverlayHandle> };   // api/data.ts:267
	/** H3 のセル（@ortho-earth/h3・PR-2・本体は遅延 import）＝点をセルに集約（count／sum／mean／min／max）か、セル id の並びをそのまま面に。fill か fill-extrusion の層（既存の層経路＝描画・当たりは addLayer と同じ） */
	addH3(src: unknown, opts?: CellsLayerOptions): Promise<CellsLayerHandle>;   // api/data.ts:281
	/** deck.gl の Layer（配列＋accessor）の相当（PR-4／PR-6・src/adddata.js）。kind "points"（getPosition／getColor [r,g,b,a 0〜255]／getRadius px）・"arcs"（getSourcePosition／getTargetPosition／getSourceColor／getTargetColor／getWidth／getHeight 弦長比）・
	 *  "trips"（getPath [[lon,lat,h?]…]／getTimestamps／currentTime／trailLength／fadeTrail／clock）は同一フレームの overlay（RTE・統一 picking）。"polygons"（getPolygon）・"paths"（getPath）・"columns"（getPosition＋getRadius m）＋ getFillColor／getLineColor／getLineWidth／getElevation m は
	 *  GeoJSON の addSource／addLayer（fill／line／fill-extrusion）。builtin 以外の kind は plugin（registry.dataKinds・"splat" は予約された契約＝SplatData）。data＝配列・GeoJSON FeatureCollection・iterable。setData は差分でなく全焼き（deck.gl と同じ） */
	addData(data: unknown, opts?: DataLayerOptions): DataLayerHandle;   // api/data.ts:294
	/** セル（deck.gl の GridLayer／GeohashLayer／QuadkeyLayer／S2Layer 相当・PR-5・src/cells/）。kind＝"grid"（m）・"mesh"（地域メッシュの段）・"geohash"・"quadkey"・"s2"（id の意味は reference library と同じ）。res＝セルの大きさ／段（"auto" も）。H3 と同じ手綱 */
	addCells(src: unknown, opts?: CellsLayerOptions & { kind?: "grid" | "mesh" | "geohash" | "quadkey" | "s2" }): Promise<CellsLayerHandle>;   // api/data.ts:383
	/** 等値線／等値帯（ContourLayer 相当・PR-5）＝格子の場（cellSize m・weight・agg）→ thresholds（線・line の層）か bands（帯・fill の層）。smooth＝場のぼかしの回数 */
	addContour(src: unknown, opts?: ContourLayerOptions): Promise<ContourLayerHandle>;   // api/data.ts:384
	/** 画面に固定の格子（ScreenGridLayer 相当・PR-5）＝overlay（毎フレーム投影して数える・統一 picking で count）。cellPx＝格子の px・colorRange＝色の段・agg＝sum／count／mean／min／max */
	addScreenGrid(src: unknown, opts?: ScreenGridOptions): Promise<ScreenGridHandle>;   // api/data.ts:385
	/** 集約の振り分け（PR-5）＝kind "h3" → addH3・"screen" → addScreenGrid・"contour" → addContour・それ以外 → addCells */
	addAggregate(src: unknown, opts?: { kind?: "h3" | "screen" | "contour" | "grid" | "mesh" | "geohash" | "quadkey" | "s2"; [k: string]: unknown }): Promise<CellsLayerHandle | ContourLayerHandle | ScreenGridHandle>;   // api/data.ts:386
}

/** installIntake (api/intake.ts:23), called at globe.js:2977. */
export interface IntakeApi {
	readonly Marker: typeof Marker;   // api/intake.ts:26
	readonly Popup: typeof Popup;   // api/intake.ts:26
	/** 以後の取得に効く transformRequest（MapLibre 同名）。null で外す */
	setTransformRequest(fn: TransformRequestFunction | null): GlobeMap;   // api/intake.ts:28
	/** 独自スキーム（"myscheme://…"）の取得を関数に任せる（大域・export の addProtocol と同じ） */
	addProtocol(scheme: string, loader: ProtocolLoader): void;   // api/intake.ts:29
	removeProtocol(scheme: string): void;   // api/intake.ts:29
	/** 同じ手入れ（transformRequest・addProtocol）で取る fetch（部品・アプリ用） */
	fetchResource(url: string, type?: ResourceType, init?: RequestInit): Promise<Response | { ok: boolean; status: number; json(): Promise<any>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; blob(): Promise<Blob> }>;   // api/intake.ts:30
	/** フィーチャーサービスの控え（IndexedDB・鍵の接頭辞 FS1::）を消す（1.14.0〜・#176）。他の控え（地図データ・ファイル）は残る。
	 *  opts＝{ maxAge（ms）, maxEntries, maxBytes }＝超えた分だけ（省略＝全部）。戻り値＝{ removed, kept, bytes }（控えの棚が無ければ null） */
	clearFeatureServiceCache(opts?: { maxAge?: number; maxEntries?: number; maxBytes?: number }): Promise<{ removed: number; kept: number; bytes: number } | null>;   // api/intake.ts:32
}

/** installImages (api/images.ts:24), called at globe.js:2993.
 *  Registers gadgets: heatmap@74 cluster@80 symbols@124 */
export interface ImagesApi {
	addImage(name: string, img: ImageBitmap | HTMLImageElement | HTMLCanvasElement | ImageData | Blob | string | { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, opts?: { pixelRatio?: number; sdf?: boolean }): Promise<unknown>;   // api/images.ts:105
	removeImage(name: string): void;   // api/images.ts:110
	/** 画素だけ差し替える（MapLibre 同名・1.7.0〜）＝層を評価し直さない（動く記号を毎フレーム差し替える口）。無い名前は addImage と同じ */
	updateImage(name: string, image: ImageBitmap | HTMLImageElement | HTMLCanvasElement | ImageData | { width: number; height: number; data: Uint8Array | Uint8ClampedArray }): Promise<unknown>;   // api/images.ts:111
	hasImage(name: string): boolean;   // api/images.ts:115
	listImages(): string[];   // api/images.ts:116
	/** MapLibre の sprite を丸ごと記号帳へ（base.json＋base.png・高解像度画面は base@2x.*）。戻り値＝足した記号の数 */
	loadSprite(base: string, prefix?: string): Promise<number>;   // api/images.ts:117
}

/** installStyle (api/style.ts:41), called at globe.js:3514. */
export interface StyleApi {
	/** MapLibre の custom 層（addLayer({ type:"custom", onAdd, render, renderingMode })・1.5.0〜）の onAdd/render に渡す map（既定＝この map・MapLibre の口が自分を差す）。
	 *  custom 層は main の透明な WebGL2 canvas（注記の下）に描く＝地図と深度を共有しない（模型は建物・地形に隠れない）。行列（args.defaultProjectionData.mainMatrix）は
	 *  中心で局所線形化したメルカトル→クリップ（Float64Array）＝狭い範囲（模型・3D Tiles）は画素の内で合う・大陸大の図形は球との差の分だけ違う。globe の variant は無い */
	setCustomLayerHost(host: object | null): GlobeMap;   // api/style.ts:50
	/** custom 層の canvas（層が 1 つでも足された後・無ければ null） */
	getCustomLayerCanvas(): HTMLCanvasElement | null;   // api/style.ts:51
	/** worker 経路の custom 層（addLayer({ type:"custom", url })）のオーバーレイの手綱（post＝層の onMessage へ・onmessage・remove）。main の canvas の経路（url 無し）や無い id は null */
	getCustomLayerHandle(id: string): OverlayHandle | null;   // api/style.ts:52
	/** MapLibre の addSource／addLayer をそのまま（source＝geojson（cluster 可）/image/video/raster・layer.type＝fill/line/circle/symbol/fill-extrusion/heatmap/raster。fill-pattern/line-pattern＝記号帳の画像を敷き詰め）。
	 *  line-gradient（["line-progress"] の式）・line-offset（画面 px・進行方向の右が正）・line-pattern（名前が層で一度の物）の線は geojson を切ったタイルで vtdraw の GPU の線として描く（2026-10-22〜・?gjvt=0 で canvas2D の口）。属性で模様を変える line-pattern は canvas2D の口。
	 *  外来 style の基図（ベクタタイル）の line-offset はエンジンの線（GPU）でずらす（角はマイターで継ぐ・90° より鋭い角は継ぎを諦める）。
	 *  どの種類も何枚でも持てる（1.2.0〜・#34）：fill/line/circle＝MapLibre の重ね順で連続する同じ source の層だけを 1 枚の gint 層へ詰める（1.3.0〜）・押し出し/ヒートマップ＝層ごと・集約＝source ごと。
	 *  fill/line/circle は MapLibre の意味（1.3.0〜）：層の型が描くジオメトリを選ぶ（fill＝面・line＝線と面の輪郭・circle＝点）・層ごとの filter と zoom 域・MapLibre の既定値（黒・線 1px・点 5px）・
	 *  fill に輪郭を付けない（fill-outline-color の時だけ 1px）・circle-opacity。同じ source のハイライト層・縁取りの線もそのまま描ける。line-dasharray（先頭の [線, 間] の対・線幅の倍数）・circle-stroke-color/-width/-opacity（中空の円も）も 1.3.0〜。線幅/半径の上限は約 32px/64px。
	 *  知らない演算子（within/distance など未対応も）を含む層は、その名を挙げて投げて足さない（1.3.0〜・MapLibre と同じ。setPaintProperty/setLayoutProperty/setFilter・ML 形 gadget も）。
	 *  層の minzoom/maxzoom（maxzoom 排他）はどの種類でも効く（1.3.0〜）：記号は止まるたびに当て直す・押し出しと canvas2D の線（line-gradient/line-offset/模様）は止まるたびに
	 *  ["zoom"] の式を評価し直す（0.25 刻み）・集約は丸と単点の層ごと・raster は表示窓。集約の地物の layer.id は MapLibre の層 id（以前は "clusters"/"unclustered-point"）。
	 *  重ね順（beforeId・moveLayer）は同じ描き方の中で効く。描き方の違う層の上下は描画の段で決まる（下から 基図→画像→gint→押し出し→ヒートマップ→集約→記号→模様）。
	 *  式は呼んだ時に評価（symbol の zoom 式は止まるたび）。removeSource は使われている間は投げる（MapLibre と同じ）。
	 *  旧式フィルタ（["==","k","v"] 等）・旧式の関数（{ stops }）・"{name}" 記法は style.json と同じく読み替える（1.3.0〜・ML 形 gadget の層 object も同じ）。
	 *  ズームの数（minzoom・maxzoom・["zoom"]）はこの地図の z（MapLibre の z＋1＝同じ縮尺）。層の metadata["ortho:dz"]:1 を付ければ MapLibre の z で書ける。
	 *  vector source の fill-extrusion（1.3.0〜・MVT の 3D 建物）：source は addSource の vector か基図の source 名（外来 style＝その名前・地域の基図＝"basemap"）。
	 *  タイルごとに流す（基図と同じ選び・MapLibre と同じ 512px の尺・子が揃うまで親を出す）・高さは実寸で地表から（どこでも地形に沿って立つ）・真上からも屋根が見える・半透明は裏面を除いて重ねる。
	 *  ["zoom"] を含む paint（伸び上がり）は止まった所で評価し直す（MapLibre はズーム中も連続）。filter の ["zoom"] はタイルの z（過拡大なら表示を丸めた z）。
	 *  queryRenderedFeatures は屋根と壁を画面へ投影して当てる（sourceLayer・id つき・タイルをまたぐ地物は複数返り得る）。feature-state（setFeatureState に sourceLayer＝状態が変わった地物を含むタイルだけ組み直す・問い合わせの地物に state）も 1.3.0〜。未対応：fill-extrusion-pattern/translate（警告して描く）・style の light。
	 *  source の出典（TileJSON の attribution・無ければホスト名）はその source を使う押し出しの層がある間、出典の欄に出る（MapLibre の AttributionControl と同じ・OSM 等は表示が利用の条件）。
	 *  vector source の fill / line / circle / symbol（1.3.0〜）：source は addSource の vector か基図の source 名（基図の source に線や塗りを足す＝道路の強調など）。
	 *  描く場所：beforeId・moveLayer が基図（style）の層を指せばその層の直前（1.9.0〜・MapLibre と同じ・style の 2 本目以降の source の層は style の順）・指さなければ基図の塗りと線の上。注記は常に一番上（注記は基図と同じ衝突の判定・利用者の注記が勝つ）。利用者の層どうしの順は source をまたいでも正確。
	 *  3D（地形あり）では塗りが地面へ焼かれる＝利用者の塗りは基図の塗りの間には入るが基図の線より常に下（基図自身と同じ）。1.8.0 までは基図の層を指す beforeId も「基図の上」。
	 *  3D（地形あり）では塗りは地面に焼く（基図の線の下・基図自身と同じ規則）。paint／layout の ["zoom"] は止まった所で評価し直す（0.25 刻み・MapLibre はズーム中も連続）。
	 *  circle＝画面に向いた円（circle-pitch-alignment "map"・blur・translate は未対応）・線と面の円は頂点ごと（MapLibre と同じ）・塗りの透ける円の縁は止まった所のズームで合わせた輪。
	 *  symbol＝点の注記（text-field）と面の注記（到達不能極）。symbol-placement line／line-center（C9・2026-10-12）＝線の地物を基図と同じ注記層で線に沿わせる（symbol-spacing・text-max-angle・keep-upright・点と面は置かない）。記号（icon-image＝style の sprite か addImage・icon-size/-anchor/-offset/-rotate/-padding/-allow-overlap/-ignore-placement/-optional・text-optional・icon-text-fit（＋padding）・icon-color（SDF）・icon-opacity）は基図の symbol 層と同じ注記層で文字と一緒に裁く（1.6.0〜）。線に沿う注記（symbol-placement "line"／"line-center"・symbol-spacing・text-max-angle・text-keep-upright・text-offset の直角成分）も 1.6.0〜（字を 1 字ずつ線に沿わせる・線の記号（icon-rotation-alignment map＝線の向き）も・面の輪郭は未対応）。向き＝text-rotate・text/icon-rotation-alignment（map＝地図の回転に追随・viewport-glyph）・text/icon-pitch-alignment（map＝傾けた地面に寝かせる・線の注記の既定）も 1.6.0〜。記号帳に無い名前は map.on("styleimagemissing", e => e.id) で名前ごとに 1 回知らせる（聞き手が addImage すれば出る・MapLibre 同名）。画素だけの差し替えは map.updateImage(name, img)（1.7.0〜・層を評価し直さない＝動く記号）。fill-outline-color は 1px の縁。fill-pattern・line-gradient・line-blur・line-gap-width は未対応（警告して描く）。
	 *  feature-state（1.9.0〜）＝paint の ["feature-state", key] が効く（fill・fill-outline・line・circle の色/半径/縁・symbol の text-color/halo/text-opacity/icon-color…・filter と layout は読まない＝MapLibre と同じ）。setFeatureState に sourceLayer＝その地物を含むタイルだけ組み直す（MapLibre のように即座ではない＝数十 ms）。1.8.0 までは状態を置くだけ（既定の見た目）。
	 *  問い合わせは基図と同じ当て方（面の中・線幅・円の半径・sourceLayer・id・source）・地物に state（1.9.0〜・無ければ {}）。
	 *  地域の基図（日本）の自動の 3D 建物は層 "building-extrusion"（type fill-extrusion・source "basemap"）＝getLayer/getStyle に出る・setLayoutProperty(…, "visibility", "none") か removeLayer で伏せる
	 *  （OSM などの押し出しへ差し替える時・伏せている間は足元の塗りがチルトでも出る・撮影/印刷も同じ・テーマを切り替えても残る）。色・filter・出しズームは変えられない（投げる） */
	addSource(id: string, source: MapLibreSource): GlobeMap;   // api/style.ts:61
	getSource(id: string): (MapLibreSource & { setData(data: GeoJSONFeatureCollection | string): Promise<void>; getClusterExpansionZoom?(clusterId: number): Promise<number> } & Partial<VideoHandle>) | undefined;   // api/style.ts:62
	removeSource(id: string): GlobeMap;   // api/style.ts:100
	/** global-state（MapLibre v5 同名・1.7.0〜）：式の ["global-state", key] が読む地図全体の状態を変える。それを読む層（filter/layout/paint）だけ評価し直す。style の root の state（{ key: { default } }）が既定値 */
	setGlobalStateProperty(key: string, value: unknown): GlobeMap;   // api/style.ts:106
	/** global-state の今の値（写し）。状態は地図ごと（#173＝頁に地図が複数あっても互いに効かない） */
	getGlobalState(): Record<string, unknown>;   // api/style.ts:120
	/** Web フォントを差す（1.6.0〜・段 2）：style の text-font の family（"Noto Sans Bold"→family "Noto Sans"・weight 700）がブラウザに無い時に持ち込む。
	 *  main（DOM）と描画 worker（注記・記号・集約の canvas）の両方に同じ FontFace を載せる。source＝URL か ArrayBuffer・descriptors＝weight/style 等。glyph PBF（style.glyphs）は読まない */
	addFontFace(family: string, source: string | ArrayBuffer, descriptors?: { weight?: string; style?: string; stretch?: string; unicodeRange?: string }): Promise<GlobeMap>;   // api/style.ts:123
	/** vector source（fill-extrusion・fill/line/circle/symbol）＝見えているタイルが今の式で組み上がって描画側に載るまで false（カメラが動いている間も false）。基図の source 名も受ける。
	 *  raster/raster-dem（hillshade・color-relief＝1.8.0〜）/image/video の source（1.6.0〜）＝その source を使う見えている層が開く途中か、見えているタイルに未着がある間は false */
	isSourceLoaded(id: string): boolean;   // api/style.ts:142
	getLayer(id: string): MapLibreLayer | undefined;   // api/style.ts:147
	addLayer(layer: MapLibreLayer, beforeId?: string): Promise<unknown>;   // api/style.ts:173
	removeLayer(id: string): GlobeMap;   // api/style.ts:174
	/** 重ね順を変える（beforeId の下へ・省略＝一番上）。同じ描き方の中で効く */
	moveLayer(id: string, beforeId?: string): GlobeMap;   // api/style.ts:188
	/** paint の変更。利用者の層は数・色・数の配列を transition で補間して描き直す（1.16.0〜・MapLibre の `<name>-transition`＝{duration, delay}・style の根の `transition`・既定 300ms。式は補間しない・基図の層は即時）。options.transition:false で即時 */
	setPaintProperty(id: string, name: string, value: StyleExpression | { duration?: number; delay?: number } | undefined, options?: { validate?: boolean; transition?: boolean }): GlobeMap;   // api/style.ts:209
	getPaintProperty(id: string, name: string): StyleExpression | undefined;   // api/style.ts:258
	/** layout の性質を変える。visibility:"none"｜"visible" で出し入れ（層は残る） */
	setLayoutProperty(id: string, name: string, value: StyleExpression | undefined): GlobeMap;   // api/style.ts:259
	getLayoutProperty(id: string, name: string): StyleExpression | undefined;   // api/style.ts:288
	setFilter(id: string, filter: StyleExpression | null): GlobeMap;   // api/style.ts:289
	getFilter(id: string): StyleExpression | undefined;   // api/style.ts:298
	setLayerZoomRange(id: string, minzoom: number, maxzoom: number): GlobeMap;   // api/style.ts:299
	/** vector source は sourceLayer が要る（MapLibre と同じ・fill-extrusion は 1.3.0〜・fill/line/circle/symbol は 1.9.0〜）＝状態が変わった地物を含むタイルだけ組み直す（paint の ["feature-state"]・filter は読まない） */
	setFeatureState(feature: { source: string; sourceLayer?: string; id: number | string }, state: Record<string, unknown>): GlobeMap;   // api/style.ts:305
	removeFeatureState(feature: { source: string; sourceLayer?: string; id?: number | string }, key?: string): GlobeMap;   // api/style.ts:320
	/** MapLibre 同名（1.3.0〜）：その地物の今の状態（無ければ {}） */
	getFeatureState(feature: { source: string; sourceLayer?: string; id: number | string }): Record<string, unknown>;   // api/style.ts:338
	/** 利用者の層（登録順＝下から） */
	getLayers(): MapLibreLayer[];   // api/style.ts:342
	/** MapLibre の style の形（version 8）。layers＝基図の層（外来 style ならその source 名・地域の基図は "basemap"）の上に利用者の層。
	 *  基図の層も 1.3.0〜 getLayer/setPaintProperty/setLayoutProperty/setFilter/setLayerZoomRange/removeLayer で触れる（visibility は結合で外すだけ＝軽い・色や filter は基図タイルの建て直し）。
	 *  基図の層も moveLayer で並べ替えられる（1.x〜・S-P2-2＝基図のタイルの建て直し・beforeId が利用者の層ならその層の差し込み先の基図の層の前）。beforeId に基図の層 id を渡してもよい（利用者の層は基図の層の間に差し込む）。上書きはテーマの切り替えを越えて残り、setStyle で消える。
	 *  ズームの目盛りを申告して返す（1.3.0〜）：各層の metadata["ortho:dz"]（基図＝0＝この地図の z に直した物）・root の metadata["ortho:sourceDz"]（source ごと）＝setStyle(getStyle()) で二重にずれない */
	getStyle(): { version: 8; sources: Record<string, unknown>; layers: Array<MapLibreLayer | Record<string, unknown>> };   // api/style.ts:377
	/** 基図の style を生き替える（外来 style で起動した地図だけ）。1.16.0〜 options.diff（既定 true）＝畳める差（基図の層の paint/filter/順・style 由来の geojson 層や source の差）は建て直さず当てる。
	 *  畳めない差（基図の vector source・sprite・glyphs・terrain・画像の raster 層・vector の描く層が変わる）と diff:false は従来の建て直し。transformStyle＝当てる前に書き換える（MapLibre 同名） */
	setStyle(style: string | Record<string, unknown>, options?: { diff?: boolean; transformStyle?: (previous: Record<string, unknown> | undefined, next: Record<string, unknown>) => Record<string, unknown> | undefined }): Promise<GlobeMap>;   // api/style.ts:543
	/** source の地物（MapLibre 同名・同期・1.5.0〜）。集約（cluster）の source＝今の段の丸と単点で画面の内側（余白 1/4）に居る物（properties に cluster/cluster_id/point_count）／
	 *  geojson の source（data が object）＝全部の地物（MapLibre は読んだタイルの分＝こちらは上位互換）／vector の source（C7）＝出しているタイル（addLayer の層が取った写し）の sourceLayer の地物を全部（sourceLayer 必須・タイルをまたぐ地物は枚数ぶん・写しの予算 24MiB を超えた分は出ない） */
	querySourceFeatures(sourceId: string, opts?: { filter?: StyleExpression; sourceLayer?: string }): RenderedFeature[];   // api/style.ts:580
}

/** installQuery (api/query.ts:30), called at globe.js:3542. */
export interface QueryApi {
	// set twice inside api/query.ts (263, then wrapped at 307 for overlays + clipping)
	/** 描画結果への問い合わせ（MapLibre の queryRenderedFeatures 相当）。geometry＝省略（画面全体）｜[x,y]（CSS px）｜[[x0,y0],[x1,y1]]（箱）。
	 *  返り値は上に描かれたものから：canvas2D の線/模様（addLayer の層 id・1.3.0〜）→記号・集約→四隅の画像（layer.id "img:<n>"）→押し出し（addLayer の層 id・ガジェット直呼びは "extrude"）→addLayer の fill/line/circle（層ごとに 1 件・層 id・source＝source id）→利用者の図形（"user"）→基図（スタイルの層 id・属性つき）。
	 *  押し出しは MapLibre と同じく立体で当てる（屋根と壁・床は当てない＝傾けて屋根を押せば当たる・空を指しても高い屋根には当たる）。押し出しどうしは近い順（1.3.0〜・旧＝地面の足跡）。
	 *  layers に基図の層が無ければ基図のタイルは取り直さない（層ごとのイベントが軽い）。
	 *  MapLibre と違い**非同期**（描いている基図タイルを取り直して今のスタイルで当てる・キャッシュ命中で ~1ms）。箱は外接箱の重なりで判定 */
	queryRenderedFeatures(geometry?: [number, number] | [[number, number], [number, number]] | QueryOptions, opts?: QueryOptions): Promise<RenderedFeature[]>;   // api/query.ts:307
	// 持ち主は 1 つ（ここ）：globe.js が先に素の on（load/move/click…＝installQuery より前の installer も使う）を付け、api/query.ts がそれを包んで層 id 付きを足す＝最終の値はこちら
	/** イベント購読（戻り値＝map・解除は map.off(ev, cb)）。load＝初回フレーム（登録時に済んでいれば即呼ぶ）／move＝カメラ更新／
	 *  mesh＝建物3D の読込合図（1.2.0〜）（catalog→start→done|cancelled|failed）／click＝gint 多層の照会（v2） */
	on(ev: "load", cb: (e: {}) => void): GlobeMap;   // api/query.ts:387
	on(ev: "move", cb: (e: { center: LonLat; zoom: number; pitch: number; bearing: number }) => void): GlobeMap;   // api/query.ts:387
	on(ev: "mesh", cb: (e: MeshEvent) => void): GlobeMap;   // api/query.ts:387
	on(ev: "click", cb: (e: { lngLat: LonLat; hits: Array<{ layer: GintLayerHandle | null; fid: number; feature: { fid: number; properties: Record<string, any> | null } }> }) => void): GlobeMap;   // api/query.ts:387
	/** 共通の時計（1.2.0〜・#42）。ticking＝再生中の刻み（最大フレームごと）／false＝段・日時・今・範囲の端など状態の変わり目 */
	on(ev: "time", cb: (e: { time: number; step: number; live: boolean; ticking: boolean }) => void): GlobeMap;   // api/query.ts:387
	/** 層ごとのイベント（MapLibre 同名・1.2.0〜・#34）。layerId＝addLayer の層 id か基図の層 id（配列可）。click はドラッグを除く・mousemove は rAF に畳む */
	on(ev: "click" | "mousemove" | "mouseenter" | "mouseleave", layerId: string | string[], cb: (e: LayerMouseEvent) => void): GlobeMap;   // api/query.ts:387
	/** 層の押し系（C8・MapLibre 同名）＝同期の当たり（利用者の層だけ・基図の層には当たらない）。mousedown/touchstart の e.preventDefault() で地図のドラッグを捨てる */
	on(ev: "mousedown" | "mouseup" | "touchstart" | "touchend" | "dblclick" | "contextmenu", layerId: string | string[], cb: (e: LayerPressEvent) => void): GlobeMap;   // api/query.ts:387
	/** 描き終わり（MapLibre 同名・1.5.0〜）：動いていない・基図が視野を覆って載った・標高と建物と利用者の source の読み込みが無い、が続いた時に 1 回。
	 *  画像タイル層（raster/hillshade/color-relief/image/video・map.raster も）の未着も待つ（1.6.0〜・color-relief は 1.8.0〜。それまでは画像が降っている途中で来た）。
	 *  忙しくなったら次の静けさでまた 1 回。起動直後もカメラを動かさずに来る（settle は動いた後だけ） */
	on(ev: "idle", cb: (e: {}) => void): GlobeMap;   // api/query.ts:387
	/** source の中身が載った（C8・MapLibre の sourcedata の骨）＝addLayer／setData の載せ直しが終わるたび { sourceId }。setData の連打は畳まれる（最後の中身で 1 回）。
	 *  isSourceLoaded(id) は載せ直しの間 false。MapLibre の口（通訳）は sourcedata と data（isSourceLoaded:true）に写す */
	on(ev: "sourcedata", cb: (e: { sourceId: string }) => void): GlobeMap;   // api/query.ts:387
	/** カメラ静止（移動が 150ms 止まった時・1.0.5〜）。ツアー/オーバレイの「止まった」合図 */
	on(ev: "settle", cb: (e: { center: LonLat; zoom: number; pitch: number; bearing: number; hash: string }) => void): GlobeMap;   // api/query.ts:387
	/** ボックスズーム（shift＋ドラッグ・1.16.0〜・MapLibre 同名）。end の bbox＝[w,s,e,n]（west>east＝±180 跨ぎ）・x0..y1＝画面の矩形（CSS px） */
	on(ev: "boxzoomstart" | "boxzoomcancel", cb: (e: {}) => void): GlobeMap;   // api/query.ts:387
	on(ev: "boxzoomend", cb: (e: { bbox: Bbox; x0: number; y0: number; x1: number; y1: number }) => void): GlobeMap;   // api/query.ts:387
	/** 協調モード（opts.cooperativeGestures）で止めた操作（1.16.0〜） */
	on(ev: "cooperativegestureprevented", cb: (e: { kind: "wheel" | "touch" }) => void): GlobeMap;   // api/query.ts:387
	// on と同じく api/query.ts が globe.js の素の off を包む
	off(ev: "click" | "mousemove" | "mouseenter" | "mouseleave" | "mousedown" | "mouseup" | "touchstart" | "touchend" | "dblclick" | "contextmenu", layerId: string | string[], cb: (e: LayerMouseEvent) => void): GlobeMap;   // api/query.ts:392
	/** 購読解除（1.0.5〜） */
	off(ev: string, cb: (e: any) => void): GlobeMap;   // api/query.ts:392
	// 実体は cb が無い時だけ Promise を返す（api/query.ts の once）＝重ね書きに分けた（旧 d.ts は 1 本で `OrthoJapanMap | Promise<any>`）
	/** 一度だけ。cb 省略＝Promise */
	once(ev: string): Promise<any>;   // api/query.ts:398
	once(ev: string, cb: (e: any) => void): GlobeMap;   // api/query.ts:398
	once(ev: string, layerId: string | string[]): Promise<any>;   // api/query.ts:398
	once(ev: string, layerId: string | string[], cb: (e: any) => void): GlobeMap;   // api/query.ts:398
}

/** installTools (api/tools.ts:21), called at globe.js:3559. Attaches no members.
 *  Registers gadgets: inspect@110 dropFile@126 geoedit@129 edit@137 demo@163 */
export interface ToolsApi {
}

/** 実行時には map に在るが、公開の型（GlobeMap）には出さないメンバー（判断 3・2026-10-16）。installer が書く物は Installing の第 2 引数で書けるようにする */
export interface GlobeInternals {
	// 内部：render worker の口（globe.js:663）。地域パックは hostEnv から使う
	readonly renderer: { set(cmd: string, data?: unknown, prop?: unknown, layer?: unknown): void; draw(cam: unknown, opts?: unknown): void };   // globe.js:2355
	// 内部：雲の殻（api/camera.ts が setClouds の中で生やす検証窓）
	readonly __clouds?: unknown;   // api/camera.ts:256
	// 内部：overlay の関数に globe.js が Object.assign した器（overlay.js の createOverlay）のメソッド＝census2020 の map.overlay.loadEstat 等の互換
	readonly overlay: OverlaysApi["overlay"] & { setSelectionMask(geom: unknown, opts?: unknown): void; setHoverOutline(geom: unknown, opts?: unknown): void; loadOverlay(name: string): unknown; clearOverlay(): void; [k: string]: unknown };   // globe.js:2670
}

// 地域パックは createGlobe の後に map へ足す（globe.js `r.install(map, hostEnv)`・例：packages/jp の map.estat）＝globe はその名を宣言しない。
