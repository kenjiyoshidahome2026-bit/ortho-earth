// @ortho-earth/globe の型定義（公開面のみ・手書きの正典）。実装＝packages/globe/src/globe.js（createGlobe が返す map）。
// SDK（@ortho-earth/japan）の lib/ortho-japan.d.ts はこのファイル＋ SDK の入口（default orthoJapan）を build 時に継いだ物（sdk/japan/scripts/build-dts.mjs・2026-09-25）。
// 名前の OrthoJapan* は SDK 以来の型名＝互換のため残す（globe の名前は末尾の GlobeMap / GlobeOptions）。
// AIエージェント/エディタ補完のための共有語彙＝散文（README/llms.txt/start.md）とセットで配布する。
// gint は二系統：applyGintData 等＝v1 の単一スロット口（呼ぶたび置換）／map.addGint()＝多層（追加・層ごとのハンドル）。混ぜない。
// v1 口の消費側は必ず薄いモジュール1枚に封じること（gint draw spec §10.2）。
// 注記の「1.x.y〜」は SDK（@ortho-earth/japan）の版＝その版から使える（globe 単体の版とは別の番号・2026-09-26 時点で japan 1.2.3／globe 1.2.0）。

export type LonLat = [lon: number, lat: number];
export type Bbox = [w: number, s: number, e: number, n: number];
/** 画面の縁から中身を寄せる余白（CSS px）＝UI パネルに隠れる分（#35） */
export interface PaddingOptions { top: number; right: number; bottom: number; left: number }
/** 撮影（requestSnapshot）に写った同一フレームのオーバーレイ 1 枚＝RGBA の生画素（非乗算）。flip＝上下が逆（WebGL） */
export interface SnapshotOverlay { name: string; buf: ArrayBuffer; w: number; h: number; flip: boolean }
/** style の light（MapLibre 同名・1.16.0〜）。position＝[r, 方位（0＝anchor:"map" なら北・"viewport" なら画面の上・時計回り）, 天頂からの角]（度） */
export interface LightSpecification { anchor?: "map" | "viewport"; color?: string; intensity?: number; position?: [number, number, number] }
/** style の sky（MapLibre 同名・1.16.0〜）。色は文字列か ["zoom"] の式。blend は 0..1。空＝地平線の horizon-color から天頂の sky-color へ（sky-horizon-blend＝混ざる幅）・地平線の際に fog-color を horizon-fog-blend の分・atmosphere-blend＝従来のリム光を重ねる度合い・fog-ground-blend＝地面の霧の濃さ（0＝霧なし・0.5＝従来・1＝近くから） */
/** 光源の口（第 2 波 F1・2026-10-12）：map.setLights の 1 つ。type を省くと directional（setLight の形）。位置は [lon, lat, alt m]・向きは [east, north, up]・角は度・距離は m。
 *  描くのは directional だけ（setLight と同じ経路・1 つまで）。point/spot/ambient/hemisphere/ibl は**受けて保つだけ**（map.supports("light.point") は false・capabilities は "spec"）＝後の段か plugin（registry.lights）が描く */
export type LightSpec =
	| ({ id?: string; type?: "directional" } & LightSpecification)
	| { id?: string; type: "point"; position: [number, number, number?]; color?: string; intensity?: number; range?: number; decay?: number }
	| { id?: string; type: "spot"; position: [number, number, number?]; target?: [number, number, number?]; direction?: [number, number, number]; color?: string; intensity?: number; range?: number; decay?: number; angle?: number; penumbra?: number }
	| { id?: string; type: "ambient"; color?: string; intensity?: number }
	| { id?: string; type: "hemisphere"; skyColor?: string; groundColor?: string; intensity?: number }
	| { id?: string; type: "ibl"; url: string; intensity?: number; rotation?: number; background?: boolean }
	| { id?: string; type: string; [k: string]: unknown };
/** glTF の見出し（F4・2026-10-12・src/gltf-meta.js）＝模型に何が入っているか。animations＝名前・長さ（秒）・channel の数・target の path。textureFormats＝画像の形式（"ktx2" なら KHR_texture_basisu＝変換器が要る）。
 *  featureIds＝EXT_mesh_features か _FEATURE_ID_n／_BATCHID が在る（W7 から pick・queryRenderedFeatures・setFeatureState で当たる）。structuralMetadata＝EXT_structural_metadata が在る */
export interface GltfMeta { animations: GltfAnimationInfo[]; skins: number; morphTargets: boolean; extensionsUsed: string[]; extensionsRequired: string[]; textureFormats: string[]; featureIds: boolean; structuralMetadata: boolean }
export interface GltfAnimationInfo { index: number; name: string; duration: number; channels: number; paths: string[] }
/** 再生の spec（W4 から rigid アニメ＝ノードの translation/rotation/scale は描く・skin/morph は spec のまま）。name か index（省略＝最初）・time（秒）・loop（既定 true）・speed（既定 1）・playing */
export interface AnimationSpec { name?: string; index?: number; time?: number; loop?: boolean; speed?: number; playing?: boolean }
export interface AnimationState extends Required<Omit<AnimationSpec, "name" | "index">> { name: string | null; index: number | null; duration: number }
export interface ModelHandle {
	readonly stats: { vertices: number; triangles: number; instances: number; mode: "anchor" | "rtc" | "ecef"; bbox: [number, number, number, number]; materials: number; textures: number; blended: number; gltf: GltfMeta; /** KHR_texture_basisu の texture がある時だけ（W5）：数・変換器で素の RGBA になった数・できなかった数（変換器が無い／読めない／壊れている） */ ktx2?: { textures: number; transcoded: number; failed: number } } | null;
	readonly bbox: [number, number, number, number] | null; readonly name: string | null;
	/** 模型のアニメの見出し（無ければ []） */
	readonly animations: GltfAnimationInfo[];
	readonly gltf: GltfMeta | null;
	/** 再生の spec を受けて保つ（知らない name／index は投げる）。rigid アニメ（ノードの TRS）は builtin が描く（W4・時計は map.getNow＝setNow で止められる・loop 無しは端で止まり playing=false）。
	 *  skin／morph は描かない（plugin が onAnimation で合図を受けて自前で動かせる） */
	setAnimation(spec: AnimationSpec | string | number | true | null): ModelHandle;
	getAnimation(): AnimationState | null;
	play(nameOrSpec?: string | AnimationSpec): ModelHandle;
	stop(): ModelHandle;
	/** 再生の時刻での束（マテリアル×アニメするノード）ごとの剛体変換＝[Float32Array(12)（L 3x3 列優先＋原点相対の平行移動）| null]。time 省略＝今の時刻。アニメが無ければ null */
	pose(time?: number): (Float32Array | null)[] | null;
	/** 時計で進めている最中か */
	readonly animating: boolean;
	/** setAnimation のたびに呼ばれる（plugin が再生を担う口）。戻り値で解除 */
	onAnimation(f: (state: AnimationState | null, model: ModelHandle) => void): () => void;
	/** 画面の点（CSS px）に一番手前で重なる三角形と地物（第 3 波 W7）。featureId＝EXT_mesh_features（load の featureIdSet の組・attribute か implicit）か _BATCHID の番号・無ければ null（模型そのもの）。
	 *  properties＝EXT_structural_metadata の property table（b3dm は batch table）の行。load({ pickable: false }) では null。queryRenderedFeatures の層 "model" も同じ当たり */
	pick(x: number, y: number): MeshPick | null;
	/** 地物の見出し（番号を持つプリミティブの数・texture の番号の数・property table の名前・行数・列名） */
	readonly features: { primitives: number; texture: number; tables: Array<{ name: string | null; class: string | null; count: number; columns: string[] }> } | null;
	/** feature state（MapLibre の setFeatureState と同じ置き場）。{ color: CSS 色 } は描きに効く（その地物の頂点色を差し替え＝テクスチャに掛かる）。他の鍵は保つだけ（pick の state に出る）。null で外す */
	setFeatureState(featureId: number, state: Record<string, unknown> | null): ModelHandle;
	getFeatureState(featureId: number): Record<string, unknown>;
	removeFeatureState(featureId?: number): ModelHandle;
	clear(): void; destroy(): void;
}
/** 模型・3D Tiles の当たり（W7）。table＝property table の番号・名前・class（無ければ null）・distance＝奥行き（clip の w・小さいほど手前）・state＝feature state の写し */
export interface MeshPick { featureId: number | null; properties: Record<string, any>; table: { index: number; name: string | null; class: string | null } | null; distance: number; lngLat: [number, number]; state: Record<string, unknown>; batch?: number; tile?: string }
/** registry.textureTranscoders の契約（F4・W5 で結線）：url＝worker が import() する module（export transcode(bytes: Uint8Array, info: { mimeType: string }) → { width, height, rgba: Uint8Array } か その Promise）。
 *  模型・3D Tiles の glb の KHR_texture_basisu の画像がこれで素の RGBA になる。@ortho-earth/ktx2 の ktx2Plugin() が実装を持つ */
export interface TextureTranscoderImpl { url: string; formats?: string[] }
/** 太陽・月の向き（F2・2026-10-12）。azimuth＝北 0・東 90（度・時計回り）・altitude＝地平 0・天頂 90（大気差なし）・enu＝天体へ向く単位ベクトル [東, 北, 上]・subpoint＝直下点（度） */
export interface BodyPosition { time: number; subpoint: { lng: number; lat: number }; azimuth: number; altitude: number; enu: [number, number, number] }
/** map.setSun の引数。{ follow: "clock" }（既定・true も同じ）＝共通の時計の太陽の向きに directional の光を合わせる（時計の変化・静止・実時間なら 60 秒ごと）。{ azimuth, altitude }＝固定（度）。
 *  intensity（0〜1）・color を指定すれば高度からの自動（高い＝白く強く・地平＝橙に弱く・地平の下＝薄い青）を上書き。minAltitude＝光の向きの下限（既定 2°・陰影が消えないため） */
export interface SunSpec { follow?: "clock" | null; azimuth?: number; altitude?: number; intensity?: number; color?: string; minAltitude?: number }
/** map.setClouds の引数（F2・W6）。type "image"＝url の全球の雲量の画像（等経緯度・左上＝西経 180°／北緯 90°）を altitude（m）の殻として描く（builtin）：α は画像の α（色は画像×color）か、無ければ輝度（色は color）＝alphaFrom・opacity を掛ける・wind＝[東 m/s, 北 m/s] で殻が流れる（時計＝map.getNow）。
 *  coverage/density/thickness（手続きの雲）と precipitation は受けて保つだけ（spec）。plugin が registry.clouds に { apply(map, clouds) } を足せば代わりに描ける。
 *  coverage＝空を覆う割合 0〜1・altitude＝雲底 m・thickness＝厚み m・density＝濃さ 0〜1・wind＝[東 m/s, 北 m/s]・precipitation＝{ type: "rain"|"snow", intensity 0〜1 } */
export interface CloudsSpec { type?: "image" | null; url?: string | null; opacity?: number; alphaFrom?: "auto" | "alpha" | "luminance"; coverage?: number; altitude?: number; thickness?: number; density?: number; color?: string; wind?: [number, number]; precipitation?: { type: "rain" | "snow"; intensity?: number } | null }
/** registry.handlers の契約（F6）：create(map, opts) が { start, stop, active } を返す。"walk" は map.walk(opts) の中身 */
export interface HandlerImpl { create(map: OrthoJapanMap, opts: Record<string, unknown>): { start?(): void; stop?(): void; readonly active?: boolean } }
/** map.walk の引数（F6 の口・W3 で中身）。speed＝m/s（既定 1.4）・eyeHeight＝目の高さ m（既定 1.7）・collide＝基図の建物・押し出しに当たる（既定 true）・keys＝W/↑ 前・S/↓ 後・A/D 横・←/→ か Q/E 回る・R/F 見上げ/見下ろし・Shift で run 倍・Esc で止める（既定 true）・
 *  mouse＝ドラッグで見回す（既定 true）・lookDown＝見下ろし角°（既定 5）・turnSpeed °/s（既定 90）・lookSpeed °/s（既定 45）・lookDistance＝注視点までの水平 m（既定 30）・run＝Shift の倍率（既定 3） */
export interface WalkOptions { speed?: number; eyeHeight?: number; collide?: boolean; keys?: boolean; mouse?: boolean; lookDown?: number; turnSpeed?: number; lookSpeed?: number; lookDistance?: number; run?: number; [k: string]: unknown }
export interface WalkHandle {
	readonly opts: Required<Pick<WalkOptions, "speed" | "eyeHeight" | "collide" | "keys">> & WalkOptions; readonly active: boolean;
	/** 歩き始める（今の注視点が足元・maxPitch を 89° に上げ、地図の keyboard/dragPan/dragRotate/scrollZoom/doubleClickZoom を止める）。中身が無い時だけ false */
	start(): boolean;
	/** 止める（handler と maxPitch を元へ） */
	stop(): WalkHandle;
	/** 前・横に m 歩く（壁で止まる）。戻り＝動いた m。台本・検定から動かす口（builtin） */
	step(forwardM: number, strafeM?: number): number;
	/** 向きを deg 回す／見下ろし角を deg 足す（builtin） */
	turn(deg: number): WalkHandle; look(deg: number): WalkHandle;
	/** 足元と向き（builtin・plugin の中身が返さなければ null） */
	position(): { lng: number; lat: number; ground: number; eyeHeight: number; bearing: number; lookDown: number } | null;
}
export interface CloudsImpl { apply(map: OrthoJapanMap, clouds: Required<CloudsSpec> | null): void }
/** registry.lights に足す光源の type＝setLights のたびに、その type の光源の配列（無ければ []）で apply を呼ぶ（plugin が自前の overlay／three で描く約束） */
export interface LightTypeImpl { apply(map: OrthoJapanMap, lights: LightSpec[]): void }
export interface SkySpecification { "sky-color"?: string | unknown[]; "horizon-color"?: string | unknown[]; "fog-color"?: string | unknown[]; "fog-ground-blend"?: number | unknown[]; "horizon-fog-blend"?: number | unknown[]; "sky-horizon-blend"?: number | unknown[]; "atmosphere-blend"?: number | unknown[] }
/** MapLibre の CameraOptions と同じ意味（角は度）。padding＝中身の中心を寄せる（真俯瞰として解く近似） */
/** 手触りの handler の名前（A2・1.16.0〜） */
export type HandlerName = "scrollZoom" | "dragPan" | "dragRotate" | "keyboard" | "doubleClickZoom" | "boxZoom" | "touchZoomRotate" | "touchRotate" | "touchPitch" | "cooperativeGestures";
export interface CameraOptions { center?: LonLat | { lng: number; lat: number }; zoom?: number; pitch?: number; bearing?: number; /** 視線まわりの回転（度・MapLibre の roll・1.16.0〜）。正＝絵が時計回り */ roll?: number; padding?: Partial<PaddingOptions> | number }
/** 注視の的（A4・1.16.0〜）：[lon, lat, h?]・{lng|lon, lat, alt|height?}・関数（時計の ms → 点）・文字列＝読み込み中の CZML/GPX の軌跡の id か name（時計の時刻の位置） */
export type CameraTarget = LonLat | [lon: number, lat: number, heightM: number] | { lng?: number; lon?: number; lat: number; alt?: number; height?: number; elevation?: number } | string | ((timeMs: number) => CameraTarget | null | undefined);
export interface LookAtOptions { /** 注視点までの距離［m］（zoom と排他・camera.js の式＝view.eye.distM と一致） */ distance?: number; zoom?: number; bearing?: number; pitch?: number; roll?: number; /** >0 なら easeTo（ms）・既定は即時 */ duration?: number; animate?: boolean }
export interface FollowOptions extends Omit<LookAtOptions, "duration" | "animate"> { /** 的からのずらし［東 m, 北 m, 上 m］ */ offset?: [number, number, number]; /** 毎フレームの追いつき 0..1（1＝即・既定） */ lerp?: number; /** 操作で止める（既定 true） */ stopOnGesture?: boolean }
export interface FollowHandle { stop(): void; readonly active: boolean; readonly target: CameraTarget }
/** Navara の形のカメラ（A4）：lng/lat/height＝注視点・distance＝注視点までの m・heading＝bearing・pitch＝MapLibre の意味（0＝真下）。set では負の pitch を Cesium の意味（−90＝真下）と読む */
export interface NavaraCamera { lng: number; lat: number; height: number; distance: number; heading: number; pitch: number; roll: number }
export interface FitBoundsOptions { padding?: Partial<PaddingOptions> | number; maxZoom?: number; pitch?: number; bearing?: number; animate?: boolean; linear?: boolean; duration?: number; essential?: boolean }

/** UI 言語（26 言語・1.1.0〜。1.0.5 以前は ja/en のみ）。ar/fa/ur/he は右横書き（容れ物に dir=rtl）。"ja-JP" 等の地域付きは基底へ寄せる */
export type OrthoJapanLang = "ja" | "en" | "zh" | "ko" | "fr" | "de" | "es" | "pt" | "it" | "nl" | "pl" | "ru" | "uk" | "hu" | "sv" | "tr" | "el" | "id" | "vi" | "th" | "bn" | "hi" | "ar" | "fa" | "ur" | "he";

/** 共通の時計（#42）。time＝ms（UTC エポック）・step＝速度段 −8〜+8（0＝停止・負＝逆行・1＝実時間の速さ）・範囲 1800〜2049（端で止まる） */
export interface OrthoClock {
	readonly time: number; readonly date: Date; readonly step: number;
	/** 実 1 秒あたりのシミュレート秒（符号つき） */
	readonly speed: number; readonly playing: boolean;
	/** 範囲があればその区間 [開始, 終了]（ms）・無ければ外の枠（1800-01-01〜2049-12-31） */
	readonly range: [number, number];
	/** 範囲の型（1.8.0〜・#124）："clamped"｜"loop"｜"unbounded"｜null（範囲なし） */
	readonly rangeMode: "clamped" | "loop" | "unbounded" | null;
	/** 範囲を写す（1.8.0〜・#124）。地図全体の時計に効く（夜の側・星・衛星も同じ範囲で動く）。mode は Cesium の ClockRange と同じ意味（CZML の名前も受ける）：
	 *  "clamped"（CLAMPED）＝両端で止まる／"loop"（LOOP_STOP）＝順行で終わりに着いたら始まりへ戻る・逆行は始まりで止まる／"unbounded"（UNBOUNDED）＝縛らない。
	 *  今の時刻が外なら近い端へ寄せる。URL には書かない */
	setRange(start: number, end: number, mode?: "clamped" | "loop" | "unbounded" | "CLAMPED" | "LOOP_STOP" | "UNBOUNDED"): OrthoClock;
	clearRange(): OrthoClock;
	isLive(): boolean;
	/** 速さの表示（英語の鍵を tr で訳す） */
	label(tr?: (s: string) => string): string;
	setTime(ms: number): OrthoClock; setStep(step: number): OrthoClock;
	slower(): OrthoClock; faster(): OrthoClock; toggle(): OrthoClock;
	/** 今へ戻る（実時間） */
	live(): OrthoClock;
	/** URL の t=/s= ⇄ 状態 */
	toParams(p?: URLSearchParams): URLSearchParams; fromParams(p: URLSearchParams | string): OrthoClock;
	on(ev: "change" | "tick", cb: (c: OrthoClock) => void): OrthoClock; off(ev: "change" | "tick", cb: (c: OrthoClock) => void): OrthoClock;
}
export interface OrthoJapanOptions {
	/** 埋め込み先（セレクタ or 要素）。省略時＝頁の #map（まだ地図が載っていない物）→ 無ければ body 直下に自作（頁に #map が無ければ id="map"）。
	 *  容れ物の id は付け替えない（#173〜＝旧は "map" へ改名）＝利用者の #id の寸法指定もそのまま効く。意匠の印として class "qm" を付け、destroy で外す。
	 *  同じ容れ物に地図が載っている間の二重起動は例外。2 枚目以降は別の容れ物を target で渡す */
	target?: string | HTMLElement;
	/** 初期視点 "#zoom/lat/lon/45t/30r/l=…/c=…"（t=チルト°・r=回転°） */
	view?: string;
	/** 配色の焼き付け（"mono"|"dark"|"gsi"|"sepia" または台帳と同形のカスタム）。**指定すると palette ガジェットは載らない**（固定＝切替不可）。
	 *  利用者が切り替えられる初期配色は view の "…/c=dark" で。theme をここで渡すと view.hash に c= は入らない＝view: map.view.hash で再生成する時は theme も渡し直す */
	theme?: string | object;
	/** 基図を外来の MapLibre style で描く（1.2.0〜・#33）。URL か style の object（?style=<URL> と同じ）。地域の基図・?pm= より優先。
	 *  基図に入るのは style の中のひとつのベクタ source（XYZ・TileJSON・pmtiles://）の fill / line / 点ラベル / background。旧式フィルタ・stops 関数・"{name}" 記法は読み替える。
	 *  style のズームは MapLibre の z（この地図の z−1 が同じ縮尺）として読む＝基図の層も geojson source の層も（1.3.0〜。以前は geojson の層だけエンジンの z で読んでいた）。
	 *  層の metadata["ortho:dz"]（0＝この地図の z・1＝MapLibre の z）の申告があればそれが勝つ（getStyle が付けて返す）。画像（raster source）の層は基図の塗りより上に書かれた物だけ重ねる・geojson source の層は map.addLayer と同じ口へ。
	 *  vector source の fill-extrusion（building-3d など）は 1.3.0〜 立てる（タイルごとに流す 3D 建物＝addLayer の vector source と同じ口）。
	 *  2 本目以降の vector source の fill / line / circle / symbol と基図の source の circle も 1.3.0〜 描く（addLayer の vector source と同じ口＝基図の塗りと線の上）。
	 *  描かない層（線に沿うラベル・模様・基図の塗りより下の画像）は console に数える。書体（glyphs / text-font）はこの地図の文字で描く */
	style?: string | Record<string, unknown>;
	/** 取得の前の手入れ（1.2.0〜・#37・MapLibre と同名）。基図タイル・3D Tiles・style/TileJSON・sprite は取得ごと、画像タイルはソースごと（型紙で一度）に呼ぶ。
	 *  headers は画像タイル・3D Tiles・基図タイル（PMTiles 以外）に効く */
	transformRequest?: TransformRequestFunction;
	/** 外来の標高タイル（1.2.0〜・#36・MapLibre の terrain と同じ形）。source＝raster-dem の spec。?dem=<型紙>&demenc=&demmax=&demdtm=1 と同じ。
	 *  false（1.5.0〜）＝MapLibre と同じ「setTerrain まで平ら」＝この地図の既定の標高を取らない・描かない。setTerrain の DEM で地形が立つ
	 *  （その後の setTerrain(null) は DEM を外すだけ＝既定の標高の地形に戻る）。?noterr=1 は従来どおり丸ごと停止 */
	terrain?: { source: RasterDemSource | QuantizedMeshSource; exaggeration?: number } | false;
	/** 低ズーム（z<5）の夜面（共通の時計の夜半球を 50% で減光）。false＝描かない（1.5.0〜・MapLibre の口の既定）。既定 true */
	night?: boolean;
	/** 宇宙（球の外側）の色（1.16.0〜・B5）：色の文字列か "transparent"。既定＝内製は紺・MapLibre の目盛り（zoomScale mercator／maplibre）は透明＝頁の色が見える（background 層の無い style の床も透明）。WebGPU は白に畳む */
	clearColor?: string;
	/** 表示の世界の形（1.6.0〜・#43）。"auto"（既定）＝通常・HI のデスクトップは WGS84 楕円体・低メモリ端末（LOW_MEM）と非力な機体（MID_TIER＝内蔵 GPU・4 コア以下・
	 *  RAM の多いスマホ/タブレット）は球（6371 km）。true／false で固定。URL の ?ell=1／?ell=0 が opts より強い。計測は常に WGS84（表示の形に依らない）。
	 *  同じ頁の 2 枚目以降の地図は最初の地図の形に従う（core の状態は頁に 1 つ＝違えば console に警告） */
	ellipsoid?: boolean | "auto";
	/** 世界の海岸線（Natural Earth admin0 の線・z<9・どの基図の上にも重ねる）。false＝持たない（1.5.0〜・MapLibre の口の既定）。既定 true */
	coastline?: boolean;
	/** 地域の申告（1.2.0〜）。省略時は入口で違う：**createGlobe() は申告なし**（globe は地域名を知らない）／
	 *  SDK の orthoJapan() は URL で決まる（既定＝日本・/nl/＝オランダ）。**[] や null＝申告なし**＝
	 *  基図・裸地標高・ラスタ台帳・出典・戻り先・地名検索・施設・鉄道が丸ごと来ない＝世界データだけで描く「globe 仕様」。
	 *  世界の陸の段彩（ハイプソ）・湖・罫線は zoomMax まで出たままになる（地域の基図が入場しないため）。 */
	region?: object | object[] | null;
	/** ズームの上限（既定 20）。データが在る所までしか寄らせない器のため（世界データだけ＝8 が目安）。
	 *  入力（ホイール/ピンチ）・飛行・共有 hash・fit の全経路がこの値に従う。 */
	zoomMax?: number;
	/** 表示項目の固定。true=常時表示・false=封印・未記述=チップで利用者が選ぶ */
	layers?: Partial<Record<"place" | "terrain" | "rail" | "road" | "facility", boolean>>;
	/** 右上チップ帯の表示（既定true） */
	chips?: boolean;
	/** 下部計器盤。true=全部／配列=選択（"attr"を消すならページ側で出典明記の義務） */
	instruments?: boolean | Array<"pos" | "scale" | "attr" | "log">;
	/** 建物3D（建物メッシュ・日本では PLATEAU）機能スイッチ。false=関連通信・workerごと停止（既定true・1.2.0〜）。
	 *  省メモリ端末で頁にもう 1 枚の地図が生きている時は既定 false（#173・2 枚目の常駐メモリを抑える）＝true で入れられる */
	mesh?: boolean;
	/** @deprecated 1.2.0〜 mesh を使う（同じ意味・両方あれば mesh が優先）。次の大版で撤去 */
	plateau?: boolean;
	/** UI言語（地図中の地名は対象外）。live 切替 API は無い＝変えるなら view: map.view.hash を持って destroy()→再生成 */
	lang?: OrthoJapanLang;
	/** チルト上限（1.3.0〜 **度**＝MapLibre と同じ。1.6 以下の値は従来のラジアンとして読む＝非推奨・console に 1 回警告）。0=俯瞰固定。共有URLのt=も同上限でクランプ（既定 75°） */
	maxPitch?: number;
	/** ズームの目盛り（1.3.0〜・MapLibre 互換）。既定 "ortho"＝この地図の z（256px 世界＝MapLibre の z＋1 が同じ縮尺）。
	 *  "maplibre"＝公開面の「数」の zoom を MapLibre の z で受け渡す（入力 +1・出力 −1・null はそのまま）：
	 *  カメラ（jumpTo/easeTo/flyTo（{} と位置引数）/fitBounds・cameraForBounds/getZoom/setZoom/set・getMin/MaxZoom/zoomMin・setZoomMin/fitZoomForBbox）・map.view.zoom・
	 *  on("move"|"settle") の e.zoom・addLayer/setLayerZoomRange の minzoom/maxzoom と式の ["zoom"]・queryRenderedFeatures の filter と expansionZoom・
	 *  ML 形 gadget（heatmap/cluster/symbols/extrude）と clusterMaxZoom・addGint/applyGintData と手綱の minZoom/maxZoom と式・map.raster の表示窓（opts）・
	 *  ガジェットの表示帯 zoom:[a,b] と zoomMin/zoomMax/maxZoom/minZoom/view の z・opts.zoomMax。
	 *  換算しない＝文字列（URL hash・view・view.hash）・source の tile z（raster/vector/raster-dem・map.raster.add の spec）・map.cam・overlay の cam・台本（.scenes/playScenes/sceneTimeline）。
	 *  緯度の差：MapLibre の globe はメルカトル等価（中心緯度の sec φ 込み）＝一律 ±1 は赤道でだけ正確（東京で約 0.3 段・北緯 60° で 1 段）。
	 *  "mercator"（1.5.0〜）＝その緯度の差まで合わせる：dz＝1＋log2(sec φ0)（φ0＝起動の視点の中心緯度・地図ごとに固定）。数の zoom は全部この dz で往復＝
	 *  style の式（線幅・出しズーム）は MapLibre の z で評価され、カメラだけ緯度の分だけ寄る・タイルの z も MapLibre と同じ（基図・vector・画像）＝同じ MapLibre のコードで同じ絵。
	 *  φ0 から南北に離れるほど MapLibre との差が戻る（MapLibre は中心の移動に連れて縮尺が変わる・こちらは変えない）。MapLibre の口（src/maplibre）の既定。
	 *  返る map は外側の顔（Proxy）＝素の map は map[RAW]（部品はエンジンの z で読む時にこちら） */
	zoomScale?: "ortho" | "maplibre" | "mercator";
	/** 恒星（stars.6）。false=恒星だけ描かない。惑星・月・星座・太陽系圏は従来どおり（既定true） */
	stars?: boolean;
	/** 星空劇場（恒星・惑星・月・星座）と太陽系圏。false＝丸ごと持たない（1.5.0〜・MapLibre の口の既定）。既定 true */
	sky?: boolean;
	/** 描画の質（1.2.0〜・#46）：大気散乱（atmosphere）・glTF の PBR と環境光（pbr）・AO（ao）。**既定は全部 off**（ell と同じ作法）。
	 *  true で点ける。URL の ?atmosphere=1／?pbr=1／?ao=1（0 で切る）が opts より優先。WebGPU だけ（WebGL2 は実装を持たない＝旗が立っても絵は変わらない） */
	render?: { atmosphere?: boolean; pbr?: boolean; ao?: boolean };
	/** このページは map.overlay(...) で WebGL2 のオーバーレイを重ねる、の宣言。WebKit（iPadOS/Safari）では
	 *  本体が WebGPU だとその 2 枚目が描かれないため、宣言したページだけ WebGL2 を既定にする（?gpu=1 で破れる） */
	glOverlay?: boolean;
	/** 世界ビュー（z<5.5）のホバー国名 tip。false=出さない（自前の tip と重ねないページ向け。既定true） */
	countryTip?: boolean | "shift";   // "shift"＝Shift を押している間だけ（地物の tip を持つ頁が国名を出し分ける・1.7.x〜）
	/** 世界帯（低ズーム・地域の基図より手前）に Equal Earth と同じ中身を描く（1.2.1〜）：州境（z≥4）・係争地の線・湖の岸線・
	 *  市街地（z≥4）・道路/鉄道（z≥5）・国名・首都/都市・空港 ✈（z≥5）。海岸線/国境は全ズーム・河川/海洋境界は z1.5 から。
	 *  名前は map の言語（26 言語）。データと規則は Equal Earth と共有（Natural Earth 10m・World DB）。既定 false */
	worldContent?: boolean;
	/** 世界帯（低ズーム）の河川・海洋境界線（Natural Earth 10m・z1.5 から）。false＝読まない／["rivers" | "maritime"]＝その種類だけ（既定 true＝全部）。
	 *  自前の川を描く頁が二重に描かない・読まない口（1.7.x〜） */
	worldLines?: boolean | Array<"rivers" | "maritime">;
	/** 実行時アセット（plateau-sets.json等）の配信ベースURL（既定 "./"＝ページと同じ階層） */
	assetBase?: string;
	/** ページ URL のハッシュに視点を書き続ける（history.replaceState）。埋め込み（target 指定）では既定 false（1.0.4〜）＝SPA のルータを汚さない。
	 *  頁の URL（hash の視点・hashchange・?r=）と前回ビュー（persistView）を扱う地図は頁に 1 枚＝起動順で最初の地図（#173）。
	 *  false＝この地図は URL の持ち主にならない（読まない・応じない・書かない）＝次に起動する地図が持ち主になれる */
	urlHash?: boolean;
	/** 矢印キーのカメラ操作（window で受ける）。false＝取らない／関数＝真を返す間だけ取る（背景に置く時にページのスクロールを奪わない。既定 true・1.1.0〜）。
	 *  頁に地図が複数ある時、キー（矢印とガジェットのショートカット）は最後に触った地図だけが拾う＝起動直後は最初の地図（#173） */
	keyboard?: boolean | (() => boolean);
	/** 手触りの handler の初期 on/off（1.16.0〜・A2・MapLibre 同名）。実行時は setHandler */
	handlers?: Partial<Record<HandlerName, boolean>>;
	/** false＝全 handler off（MapLibre の interactive:false） */
	interactive?: boolean;
	/** 協調モード（MapLibre 同名）＝修飾キー無しのホイール・1 本指は頁に譲り on("cooperativegestureprevented") を出す */
	cooperativeGestures?: boolean;
	/** ズームの目盛り（0＝無し）。ホイール・ダブルクリック・+/− の着地を吸着 */
	zoomSnap?: number;
	/** 動きを減らす（C10・2026-10-12・MapLibre の prefers-reduced-motion と同じ意味）＝easeTo／flyTo／fitBounds は essential:true でなければ jumpTo。無指定＝OS の設定を追う。実行時は setReduceMotion */
	reduceMotion?: boolean;
	/** 前回ビューの保存と復元（localStorage）。false＝読まない・書かない（同じオリジンの本体の「前回の続き」を上書きしない背景用途向け。既定 true・1.1.0〜）。
	 *  頁に地図が複数ある時は URL の持ち主（urlHash）だけが扱う */
	persistView?: boolean;
	/** 共通の時計の起動時刻（Date｜ISO 文字列｜ms・1.2.0〜・#42）。省略＝実時間。URL の t=/s= があればそちらが勝つ */
	time?: Date | string | number;
	/** window.__cam 等のデバッグ手を生やす（target 指定時は既定で生えない） */
	debugGlobals?: boolean;
	/** 基図の行政界（赤線）を常に隠す（派生アプリが自前の境界を描く時・外来 style では効かない） */
	hideAdminBoundary?: boolean;
	/** 起動時の後処理（map.setPostProcess と同じ形＝bloom／vignette・PR-8） */
	postProcess?: PostProcessOptions | PostPass[] | null;
	/** 小地域（町丁目）のホバー＝点 in 面で識別して名前の tip と境界の太線（census の e-Stat の口が使う・既定 false） */
	smallAreaHover?: boolean;
	/** addGint の paint/filter の表を GPU で組む（WebGPU の層だけ・2026-10-12〜・opt-in＝URL の ?gintexpr=1 と同じ）。式を WGSL に、属性を列にして一度だけ送り、
	 *  feature-state／zoom の差し替えは列の 1 セル書き＝CPU の全 fid 再評価が消える。載らない式（MapLibre 出自・文字列どうしの大小比較…）と WebGL2 は CPU の表へ自動で落ちる（見た目は不変） */
	gpuExpr?: boolean;
	/** 落とした／?g= の .geopbf をこのバイト数を超えたら列チャンク層（addColumnar・gint を通さない）で描く（1.4.0〜・#90）。以下は gint（位相・ドレープ・編集）。
	 *  既定 4e6。GeoParquet は大きさに依らず常に列チャンク層。URL の ?columnar=1|0 が勝つ */
	columnarBytes?: number;
	/** 大きさの門を越えた後の振り分け（#90）。true＝列チャンク層・false＝gint。省略＝「弧の共有が多い塗り分け（meta.share.ratio ≥ 0.3 かつ 1 地物 40 頂点以上・64MB 以下）は gint」
	 *  meta.share＝読み手が先頭チャンクを標本に測る { ratio（別の地物に既に出た頂点の割合）, meanVertices, features, vertices } */
	columnarRule?: (meta: ColumnarLayerHandle["meta"], bytes: number) => boolean;
	/** 起動時に map.use する plugin（PR-F0・2026-10-12）。[plugin] か [plugin, opts] の並び。地域パックの後・load の前に、素の map を渡して install */
	plugins?: (OrthoPlugin<any> | Readonly<OrthoPlugin<any>> | [OrthoPlugin<any> | Readonly<OrthoPlugin<any>>, unknown])[];
}

/** addColumnar の層オプション（1.4.0〜・#90） */
export interface ColumnarLayerOptions {
	/** 表示名（状況表示・console）。省略＝ファイル名／GeoPBF の name */
	name?: string;
	/** paint（gint と同じ語彙＝GintLayerHandle.setPaint と同じ・fill-color/fill-opacity/line-color/line-opacity/line-width/circle-color/circle-radius）。省略＝既定の見た目（面 #FF6B35・線 #00B4D8） */
	paint?: object | null;
	filter?: unknown[] | null;
	/** 数値列で 5 段の色分け（viridis の要約）。paint があればそちらが勝つ */
	color?: string | null;
	/** 常駐の予算（バイト・チャンクの圧縮／ワイヤのバイト数で数える・既定 64e6）。超えた分は「ズームインで残り N」 */
	budgetBytes?: number;
	/** データ全体へ寄る（既定 true） */
	fit?: boolean;
	/** 状況表示（読み込み状況＋色分けの select）を出す（map.addColumnar の既定 false・ドロップ／?g= は true） */
	status?: boolean;
	/** ホバー／クリック（tip・on('hover'|'click')）を取る（既定 true） */
	interactive?: boolean;
	/** ホバーの tip。false＝出さない・関数＝properties→行の配列 */
	tip?: boolean | ((properties: Record<string, any>) => string[] | null);
	/** 読み手の名指し（"geoparquet"|"geopbf"|登録した名）。省略＝拡張子と先頭バイトで選ぶ */
	source?: string;
	/** チャンクの切り方（GeoPBF）。既定 8192 feature／40 万頂点 */
	chunkFeatures?: number; chunkVertices?: number;
	/** LOD の段（zoom・既定 [12, 9, 6]） */
	lods?: number[];
	/** frame の CPU ms を stats.frameMs に（計測用） */
	perf?: boolean;
	/** 地形に沿わせる（頂点ごとの標高を地形から引いて持ち上げる・傾けた時だけ・既定 true） */
	drape?: boolean;
	/** シーンの深度（地形・建物・メッシュ）の陰を捨てる（#47・既定 true・LOW_MEM では本体が深度を作らない＝効かない） */
	depth?: boolean;
	/** 源を開いた直後の振り分け（false を返すと層を作らず null を返す＝globe の columnarRule の実体） */
	probe?: (meta: ColumnarLayerHandle["meta"]) => boolean;
}
/** addColumnar が返す層のハンドル＝GintLayerHandle の部分集合（同じ名前・同じ意味）。query は worker 往復＝Promise */
export interface ColumnarLayerHandle {
	readonly id: string;
	/** 最初の視野の読み込みが終わった（true） */
	readonly ready: Promise<boolean>;
	readonly meta: { name: string; rows: number; source: string; chunks: Array<{ bbox: Bbox | null; rows: number; bytes: number }>; columns: Array<{ name: string; numeric: boolean }>; bbox: Bbox | null; types: string[]; size?: number;
		/** 弧の共有の物差し（先頭チャンクの標本・点だけの源は null） */
		share: { ratio: number; meanVertices: number; features: number; vertices: number } | null };
	readonly rows: number; readonly loaded: number; readonly deferred: number; readonly cached: number; readonly pointOnly: boolean;
	/** 最初のチャンクがオーバーレイへ渡るまで（open からの ms） */
	readonly firstFrameMs: number;
	readonly stats: { frameMs: number | null; chunksDrawn: number };
	readonly visible: boolean;
	readonly color: string | null;
	setColor(column: string | null): Promise<void>;
	/** 式は worker で列のまま評価→fid 表だけ差し替え（幾何は作り直さない）。filter 省略＝今の filter のまま */
	setPaint(paint: object | null, filter?: unknown[] | null): Promise<void>;
	setFilter(filter: unknown[] | null): Promise<void>;
	setVisible(visible: boolean): void;
	/** 明示照会（worker）：50 m 以内の点 → 30 m 以内の線 → 含む面のうち最小。filter で隠した地物も返す（gint の layer.query と同じ）。row＝元の行（GeoPBF なら fid） */
	query(lngLat: LonLat): Promise<{ fid: number; row: number; properties: Record<string, any> } | null>;
	on(ev: "hover", cb: (f: { fid: number; properties: Record<string, any> } | null) => void): ColumnarLayerHandle;
	on(ev: "click", cb: (e: { fid: number; row: number; properties: Record<string, any>; lngLat: LonLat }) => void): ColumnarLayerHandle;
	on(ev: "mouseenter", cb: (f: { fid: number; properties: Record<string, any> }) => void): ColumnarLayerHandle;
	on(ev: "mouseleave", cb: (e: { fid: number }) => void): ColumnarLayerHandle;
	/** 視野の読み直し（settle で自動） */
	refresh(): Promise<void>;
	remove(): void;
}

/** map.on("mesh")（1.2.0〜・旧名 "plateau"）の合図。catalog＝一覧取得（count=収録自治体数）／start＝区の読込開始／done＝完了（描画済み）／cancelled＝視野離脱で中止／failed＝読めない */
export type MeshEvent =
	| { phase: "catalog"; count: number }
	| { phase: "start" | "done" | "cancelled" | "failed"; name: string; base: string };
/** @deprecated 1.2.0〜 MeshEvent を使う（同じ型）。次の大版で撤去 */
export type PlateauEvent = MeshEvent;

/** 右クリックメニュー項目（map.gadget.contextmenu({items})） */
export interface ContextMenuItem {
	name: string;
	/** 任意の HTML（アイコン） */
	icon?: string;
	onClick(c: { lng?: number; lat?: number; x: number; y: number; map: OrthoJapanMap }): void;
}

/** measure/profile の手綱（ガジェットは UI ボタン＝クリックで頂点・ダブルクリック確定・Esc 中断。プログラムからは start/stop） */
export interface PathGadget { (): void; start(): void; stop(): void; open(): void; close(): void; stats(): Record<string, number> }
/** anno ガジェットの手綱（gadgets/anno.js の createAnno の戻り） */
export interface AnnoHandle { set(pbf: GeoPBF | null): void; clear(): void; /** 描いた画素の検査窓（worker に問う） */ pixels(): Promise<unknown>; readonly pbf: GeoPBF | null; readonly count: number; readonly hits: unknown[] }
/** cog ガジェットの load のオプション＝fit／fetch 以外は geopbf/cog の openCog へそのまま（stretch・composite・colormap・cacheKey…＝見せ方はデータ側が決める） */
export interface CogOptions { fit?: boolean; fetch?: typeof fetch | null; [k: string]: unknown }
export interface CogHandle { load(src: string | File | Blob, opts?: CogOptions): Promise<unknown>; clear(): void; metrics(): Record<string, unknown> | null }
/** demo ガジェットの opts（台本の形＝demo/scene-format.md） */
export interface DemoOptions { scenes?: object[]; slide?: boolean; hold?: number; slideHold?: number; mobile?: number; lang?: string; preload?: string[]; btn?: HTMLElement | null; player?: boolean; zoom?: [number, number]; narrow?: boolean }
export interface DemoHandle { start(i?: number, fly?: boolean, opts?: { scenes?: object[]; bare?: boolean; onScene?: (i: number, scene: object) => void; onEnd?: (reason: "finished" | "stopped") => void; [k: string]: unknown }): unknown; next(): void; prev(): void; exit(): void; play(): void; pause(): void }
/** equal／equalHere／equalStart の opts。url＝Equal Earth の置き場・load＝部品の読み込み口（div 方式＝同じ頁に組む・省略＝iframe） */
export interface EqualOptions { url?: string; load?: (...args: any[]) => unknown }
export interface Gadgets {
	/** 地名検索の窓（#175）。問い合わせ先＝地域の宣言（日本＝地理院）→ world → localGeocoder → geocoderApi の順に候補を積む。
	 *  問い合わせ先が 1 つも無い（地域の宣言も world も geocoderApi も無い）＝窓を出さない（undefined）。二重搭載も undefined */
	search(opts?: SearchOptions): HTMLElement | undefined;
	zoom(): unknown;
	compass(): unknown;           // 3D（チルト中）のみ表示
	full(): unknown;              // 全画面（ショートカット=Z単キー）
	/** 画面保存（webp・出典焼き込み）。open()＝即保存、composite()＝Blob を返す（引数省略＝今の画面）。
	 *  戻り値は最初の呼び出しで受け取って保持する（二重搭載・モバイル(coarse pointer)では undefined） */
	shot(): { open(): void; composite(snap?: unknown): Promise<Blob> } | undefined;
	measure(): PathGadget;
	profile(): PathGadget;        // 断面図（経路指定→標高プロファイルのグラフ。stats()={points,total,sampled,min,max}）
	/** 右クリックメニュー。既定で「この地点へ寄る／座標をコピー」の 2 項目を持ち、items は**置換**（関数形＝クリック位置ごとに組める）。戻り値＝項目差し替え関数（再搭載時は {setItems}） */
	contextmenu(opts?: { items?: ContextMenuItem[] | ((c: { lng?: number; lat?: number; x: number; y: number; map: OrthoJapanMap }) => ContextMenuItem[]) }): ((items: ContextMenuItem[]) => void) | { setItems(items: ContextMenuItem[]): void };
	legend(): unknown;
	palette(): { open(): void; close(): void };
	hint(): unknown;
	/** 地域の全体へ戻るボタン（1.2.0〜・着地点/顔/札は地域宣言 home・宣言が無い地域＝載らない）。J キー */
	home(): unknown;
	/** @deprecated 1.2.0〜 home() を使う（同じもの）。次の大版で撤去 */
	japan(): unknown;
	qr(): { open(): void; close(): void };
	print(): { open(): void; close(): void };
	cpos(): unknown;
	/** 建物3D データ管理（先読み/削除）。mesh:false では載らない（1.2.0〜・アイコンは地域の宣言＝日本は PLATEAU 公式ロゴ） */
	mesh(): unknown;
	/** @deprecated 1.2.0〜 mesh() を使う（同じもの）。次の大版で撤去 */
	plateau(): unknown;
	/**
	 * GIS ファイルのドラッグ&ドロップ受け口（geopbf() が読める全形式）。受け口は mapEl のみ（ページ他所は自前）。既定＝geopbf(file)→applyGintData
	 * （単一スロット＝最後の 1 枚が勝つ）→カメラ寄せ。onLoad(pbf,file)＝読込成功の通知（1.0.5〜）。loadFile を渡すと既定ローダを置換
	 * （GeoPBF か .length を持つ物を返す・falsy=「読込失敗」表示）。戻り値＝{say,clear,destroy}（二重搭載時は no-op 関数）。mapEl に #dropzone/#drop-toast/#dropclear-btn を生やす。
	 * .czml／.gpx（1.8.0〜・#113）＝時刻付きの位置（CZML の sampled position・GPX の trk の time）は共通の時計（map.clock）で再生する＝Cesium と同じ補間（ECEF・線形／LAGRANGE・
	 * 慣性系は慣性系で補間）で、出ている区間（availability）だけ点・画像（billboard）・札（label）・尾（path）を描き、押すと名前と説明の吹き出し。
	 * CZML の document の clock（区間・今・速さ・範囲）を時計へ写す（clock が無い／GPX＝データの区間・LOOP_STOP・速さ＝区間÷120 秒）。起動時の URL の t=／s= があればそちらが勝つ。
	 * 時刻の無い地物は従来どおり gint。別のファイルに替えると再生は消え、写した範囲も外れる
	 */
	dropFile(opts?: { onLoad?(pbf: GeoPBF, file: File): void; loadFile?(file: File): Promise<GeoPBF | { length?: number } | null>; clearGint?(): void }): { say(text: string, sticky?: boolean): void; clear(): void; destroy(): void } | (() => void);
	/** glTF/GLB（3D 模型）を PLATEAU と同じ建物メッシュとして立てる（法線陰影・両面・地形に接地。マテリアル＝baseColor の factor×頂点色×テクスチャ・マテリアルごとに 1 バッチ）。at＝置き場所（省略＝画面中心）／glb に CESIUM_RTC・ECEF が埋まっていればそちらが勝つ。真俯瞰では建物ごと描かれない（fit はチルト付き） */
	model(src: File | string, opts?: { at?: [number, number]; heading?: number; scale?: number; name?: string; fit?: boolean; textures?: boolean; /** 当たりの写しを持つか（W7・既定 true） */ pickable?: boolean; /** EXT_mesh_features の何組目の番号で当てるか（W7・既定 0） */ featureIdSet?: number }): Promise<ModelHandle>;
	/** 任意ポリゴンの 3D 押し出し（MapLibre の fill-extrusion 相当）。src＝GeoJSON（Feature/FeatureCollection/features 配列）・GeoPBF・File・URL。
	 *  height＝列名 | 定数 | (props)=>メートル（省略＝height / building:height / measuredHeight / 高さ … を自動・階数だけなら ×3m）。
	 *  base＝下端（min_height 相当・省略＝min_height / base_height を自動）。color＝CSS 色 | (props, h)=>CSS 色（省略＝@fill → color → 高さの段彩）。
	 *  scale＝高さの倍率。mask＝足元の基図建物を伏せる（既定 "auto"＝面の中央値が 500m 未満の建物らしいデータの時だけ・市区町村のような広い面では伏せない）。fit＝寄る（既定 true・傾きは今のまま。真俯瞰では建物を描かない＝立体は傾けた時に見える）。
	 *  ⚠ 床（bottom）の既定は書き方と大きさで決まる：
	 *  ・ネイティブの書き方（height/color）＝面の外接矩形の対角の中央値が 500m 未満＝建物らしい＝接地／500m 以上＝統計の面と見なし 2,000m の平面に浮かせる
	 *  　（高さはその平面から測る＝height 400 なら屋根は 2,400m）。例：400×400m の箱（対角 約 570m）は 2,000m に立つ＝z16 級に寄った視点ではカメラより上で見えない
	 *  　（stats は返る）。地面に立てたい大きな面は bottom:"ground"（建物と同じ接地）・"drape"（全ズームで地形に沿わせる）・0（海抜 0m の平面）のどれかを渡す。mask はこの床に効かない。
	 *  ・MapLibre 形（paint つき・fill-extrusion の層・addLayer）＝大きさに関わらず接地（MapLibre と同じ＝常に地面から）。統計のように浮かせたい時は層に bottom:<m> を添える。
	 *  null を渡すと外す。戻り値＝stats、立つ面が無ければ null。ドロップ/?g= の図形に高さの列があれば自動で立つ（?extrude=0 で止める／?extrude=<列名>[,倍率]）。 */
	extrude(src: GeoJSONFeatureCollection | GeoJSONFeature | GeoJSONFeature[] | File | string | { geojson: GeoJSONFeatureCollection } | FillExtrusionLayer | null, opts?: ExtrudeOptions | FillExtrusionLayer): Promise<{ polygons: number; vertices: number; triangles: number; bbox: [number, number, number, number] } | null>;
	/** スポットライト＝「その国（その面）を指す」。周りを薄い黒で覆い、指した形だけ素の地図を残す。
	 *  src＝ISO 3166-1（"JP"/"JPN"）・国名・Wikidata の ID・それらを束ねた物（ortho-world の on("map") の合図がそのまま入る）、
	 *  または GeoJSON（Feature/FeatureCollection/Geometry）を直に。null で外す。国の形は世界の行政界（Natural Earth）から引く。
	 *  寄り先は一番大きい塊の外接矩形（飛び地は含めない＝本土が見える）。pad＝余白（既定 1.25）／maxZoom＝寄りの上限。 */
	spotlight(src: string | { iso2?: string; iso3?: string; key?: string; qid?: string; ioc?: string; name?: string } | GeoJSONFeatureCollection | GeoJSONFeature | { type: string; coordinates: unknown } | null,
		opts?: { opacity?: number; fit?: boolean; color?: [number, number, number, number]; pad?: number; maxZoom?: number }):
		Promise<{ bbox: [number, number, number, number] | null; clear(): void } | null>;   // 形が引けなければ null（旧記述の name/iso2 は返っていなかった）
	/** ホバー tip 箱。戻り値＝setter（rows=文字列の配列・null で消す）。orthoJapan() が自動搭載済み＝呼ぶと同じ setter が返る */
	/** ヒートマップ（MapLibre の heatmap 層相当・同一フレームのオーバーレイ＝WebGL2）。src＝点の GeoJSON/GeoPBF/File/URL か層を丸ごと（source つき）。
	 *  paint の意味と既定値は MapLibre どおり（radius 30・weight 1・intensity 1・opacity 1・color は ["heatmap-density"] 0..1 の既定の青→赤）。null で外す */
	heatmap(src: GeoJSONFeatureCollection | GeoJSONFeature[] | File | string | HeatmapLayer | null, layer?: Omit<HeatmapLayer, "type" | "source">): Promise<{ points: number } | null>;
	/** 点の集約（MapLibre の cluster 相当・canvas2D のオーバーレイ）。src＝点のデータか MapLibre の source（{ type:"geojson", data, cluster:true, clusterRadius, clusterMaxZoom }）。
	 *  集約の属性＝cluster / point_count / point_count_abbreviated。丸のクリック＝ばらけるズームへ寄る。queryRenderedFeatures の点の問い合わせに "clusters"/"unclustered-point" で出る */
	cluster(src: GeoJSONFeatureCollection | GeoJSONFeature[] | File | string | { type: "geojson"; data: GeoJSONFeatureCollection | string; cluster?: boolean; clusterRadius?: number; clusterMaxZoom?: number } | null, opts?: ClusterOptions): Promise<{ points: number; clusters: number[] } | null>;
	/** 日影のボタンとパネル（日影図／その時刻の影・測定面 1.5/4/6.5m／リアルタイムの影＝時刻スライダー・WebGPU のみ）＝map.sunShadow・map.setShadows の UI */
	sunshadow(opts?: { zoom?: [number, number]; narrow?: boolean }): void;
	/** オフラインパック（1.2.0〜・#40）：今の画面の範囲とズーム上限を決めて、基図タイル（Cache Storage "oj-pack"）・地形（IDB）・任意で建物と画像タイルを先に取る。
	 *  配るのは殻の Service Worker（japan の public/sw.js が "oj-pack" の URL を cache-first）＝SW の無い埋め込み先では先読みだけ（HTTP キャッシュ）。
	 *  戻り値＝{ open, close, estimate() → { tiles, bytes, free }, run(), list(), delete(id) } */
	offline(opts?: { zoom?: [number, number]; narrow?: boolean; zmaxDefault?: 12 | 14 | 15 | 16 }): { open(): void; close(): void; estimate(): Promise<{ tiles: number; bytes: number; free: number | null } | null>; run(): Promise<void>; list(): Promise<Array<{ id: string; name: string; bbox: Bbox; zmax: number; bytes: number; ts: number; done: boolean }>>; delete(id: string): Promise<void> };
	viewshed(opts?: { zoom?: [number, number]; narrow?: boolean }): void;
	/** 時計の操作盤（1.2.0〜・#42）＝◀◀ ▶/❚❚ ▶▶・速さ・日時・今。時計が実時間でない時は起動時に開く。
	 *  時計に範囲がある時（map.clock.setRange・CZML／GPX を読んだ時など）は下の段に区間の時間バー（開始・つまみ・終了）を出す＝つまみで区間の中を行き来・日時の入力も区間に限る（1.8.0〜・#124） */
	clock(opts?: { zoom?: [number, number]; narrow?: boolean }): void;
	/** 任意の 3D Tiles（map.add3DTiles と同じ）。null＝全部（opts.id＝その 1 つ）を外す */
	tiles3d(url: string | null, opts?: Tiles3DOptions): Promise<Tiles3DHandle | null>;
	/** 記号の層（MapLibre の symbol 層：icon-image/-size/-rotate/-anchor/-offset/-allow-overlap/-color（SDF）・text-field/-size/-anchor/-offset/-color/-halo・symbol-sort-key・symbol-z-order・icon-halo-*・format の image/vertical-align・symbol-height-offset/-anchor）。null＋{id} で外す */
	symbols(src: GeoJSONFeatureCollection | GeoJSONFeature[] | File | string | ({ type: "symbol" } & Omit<MapLibreLayer, "type">) | null, layer?: Partial<MapLibreLayer>): Promise<{ features: number } | null>;
	tip(opts?: object): (rows: string[] | null) => void;
	pop(opts?: object): unknown;
	/** 検査表示（MapLibre の maplibre-gl-inspect 相当・1.12.0〜・#174）。ボタン 1 つで、読み込んでいるベクタタイルの全 source-layer を層ごとの色で描き
	 *  （面＝薄い塗り＋縁・線・点）、ホバー／クリックでカーソルの下の地物の層名と属性（$id・$type・properties）を札に出す。もう一度押すと元の地図（焼き直さない）。
	 *  出す source＝ベクタタイル（外来 style の基図・addSource の vector・?pm= の PMTiles・地域の基図）と geojson。世界の帯（低ズームの Natural Earth）は出さない。
	 *  層の一覧＝TileJSON の vector_layers → PMTiles の metadata → どちらも無ければ画面の中心のタイルを解いて集める（style が使わない層も・視点が止まるたびに足す）。
	 *  検査の間は基図・利用者の層・画像タイル層・注記を伏せ、陸を backgroundColor に。検査の層の id は公式と同じ（source_sourceLayer_polygon|line|circle・geojson は source__kind）。
	 *  MapLibre の口では `map.addControl(new MaplibreInspect({...}))`（@ortho-earth/globe/maplibre）。二重搭載（ボタンつき）は null */
	inspect(opts?: InspectOptions): InspectHandle | null;
	// ---- 2.0.0 まで宣言が無かった（実行時にはあった）ガジェット＝TS 化 段 2「契約を正す」（2026-10-15）。opts の形は各ガジェットの源（src/gadgets/*.js・src/api/*.js）から ----
	/** 注釈レイヤ（geoedit の @スタイル付き GeoPBF を canvas2D で再生・単一スロット＝呼ぶたび置換・null で消す）。本体は遅延 chunk。戻り値＝手綱（set／clear・count＝描いた地物の数・pixels＝描いた画素の検査窓） */
	anno(pbf: GeoPBF | null): Promise<AnnoHandle>;
	/** 閉じる ×（埋め込み用・右上）。押す（or Esc）と mapEl から CustomEvent "ortho:close"（bubbles）を飛ばすだけ＝閉じる実務（モーダルを畳む・destroy）は埋め込み側。二重搭載は undefined */
	close(): HTMLButtonElement | undefined;
	/** COG（Cloud Optimized GeoTIFF）を球に貼る（geopbf/cog のリーダ・Range 直読み・単一スロット・本体は遅延 chunk）。src＝URL か File。fit＝範囲へ寄る（既定 true）・fetch＝読み口の差し替え・
	 *  残り（stretch／composite／colormap／cacheKey…）は geopbf/cog の openCog へそのまま。戻り値＝手綱（load／clear／metrics）。?cog=<URL> と同じ */
	cog(src: string | File | Blob, opts?: CogOptions): Promise<CogHandle>;
	/** デモ（発表の台本の上映＝demo/scene-format.md）。scenes＝台本（配列）・slide＝幕（字幕）を出す（既定 true）・hold＝自動上演の静止秒（既定 5.5）・slideHold＝幕の表示秒（既定 4）・
	 *  mobile＝縦長画面でシーンの z に足す Δz・lang＝台本の言語（省略＝画面の言語）・preload＝先読みの一覧・btn＝▶ を引き継ぐ要素・player＝素のプレーヤー（▶ 無し・start で台本を持ち込む）。
	 *  台本が空（player:false）は搭載しない＝undefined。戻り値＝{ start, next, prev, exit, play, pause }（map.playScenes／stopScenes はこの手綱を使う） */
	demo(opts?: DemoOptions): DemoHandle | undefined;
	/** 編集ボタン（左上スタック）。押すと map.gadget.geoedit() を部品として搭載／解除＝地図が持つ 1 つの図形（ドロップ／?g= で読んだ物）を編集し、× で結果を受け取って置き換える（次の起動へ持ち越す）。
	 *  戻り値＝{ toggle, editor }（二重搭載は undefined） */
	edit(opts?: { zoom?: [number, number]; narrow?: boolean }): { toggle(): Promise<unknown>; readonly editor: unknown } | undefined;
	/** Equal Earth（ortho-equal・平らな全球図）への口＝34px 規格のボタン。url＝equal の置き場（既定 /equal/・dev は :5198）・load＝部品の読み込み口（div 方式＝同じ頁に組む・省略＝iframe）。
	 *  equalHere／equalStart も同じ load で開く。二重搭載は undefined */
	equal(opts?: EqualOptions): HTMLButtonElement | undefined;
	/** 右クリックメニューの項目「ここを中心に Equal Earth」＝contextmenu の items へ渡す材料（搭載ではない） */
	equalHere(opts?: EqualOptions): ContextMenuItem;
	/** 入口＝Equal Earth を最初から上に載せる（?start=equal・変形なし）。球は裏で起動したまま＝戻ると同じ視点の球が続く。center＝全球図の中心（省略＝今の視点）・view＝全球図の視点・onFrame＝最初の 1 枚が重なった合図 */
	equalStart(opts?: EqualOptions & { center?: LonLat; view?: { zoom: number; lat: number; lon: number }; onFrame?: () => void }): Promise<void>;
	/** 上辺の説明パネル（主題の解説・お知らせ＝読み物の枠）。戻り値＝内容の setter：set(html) で表示・set(null) で消す・関数を渡すと器の要素を受け取って DOM を組める。permanent＝× を出さない・width＝最大幅 px */
	explain(opts?: { permanent?: boolean; width?: number }): (html: string | null | ((body: HTMLElement) => unknown)) => unknown;
	/** GeoPBF のトポロジカル編集（geoedit・npm・遅延 chunk）を部品として搭載＝公開面だけで動く。data＝編集する図形（GeoPBF の ArrayBuffer・null＝空）・adopt＝表示中のユーザーデータ（ドロップ／?g=）を取り込む（既定 true）・
	 *  persist＝自動保存（既定 true）・onClose＝ツールバー右端の ×（持ち主が editor.result() で結果を受け取る）。搭載中はドロップをエディタが所有（dropFile は譲る）。戻り値＝Promise<editor>（geoedit の initEditor の戻り） */
	geoedit(opts?: { data?: ArrayBuffer | null; adopt?: boolean; persist?: boolean; onClose?: () => void; [k: string]: unknown }): Promise<unknown>;
	/** ミニ地球儀（右下・視野の枠）＝z ≤ maxZoom（既定 8）で出る。size＝px（既定 125）・land／sea／line＝色（CSS）。追従は render のフック。二重搭載は undefined */
	globe(opts?: { size?: number; maxZoom?: number; land?: string; sea?: string; line?: string }): unknown;
	/** 計測器 HUD（メモリ・タイル・GPU・階層の状態表＝右下）。URL の ?hud=1|0 で起動した地図にだけ登録される（本体は遅延 chunk・起動時に自動で搭載＝1 は開いて・0 は畳んで）。それ以外の地図では undefined */
	hud?(opts?: { open?: boolean }): void;
	/** UI 言語の切替（34px 規格・透明な select・26 言語）。onChange(code)＝既定の「?lang= を書いて読み直す」を差し替える口。二重搭載は undefined */
	lang(opts?: { onChange?: (code: OrthoJapanLang) => unknown }): HTMLButtonElement | undefined;
	/** 輪郭＝「この形の線だけ」（ホバーの合図）。src は spotlight と同じ（GeoJSON か ISO 3166-1 の 2／3 字）・null で消す。マスク（spotlight）とは別スロット＝両立する。color＝[r,g,b,a]（0..1）・width＝px。形が引けなければ null */
	outline(src: string | GeoJSONFeatureCollection | GeoJSONFeature | { type: string; coordinates: unknown } | null, opts?: { color?: [number, number, number, number] | null; width?: number }): Promise<{ clear(): void } | null>;
	/** POI 台帳の手差分編集（作者用・§12）。URL の ?poiedit=1 の時だけ本体を読んで登録し自動で搭載する（一般のビルドには載らない）＝それ以外の地図では undefined。戻り値＝{ close } */
	poiedit?(opts?: Record<string, unknown>): { close(): void };
	/** 画像タイル（ラスタ）の切替パネル＝地域パックのカタログ（基図 1 枚＋重ね n 枚）と map.raster（select／toggle）。表示域は zoom で。二重搭載は undefined */
	raster(opts?: { zoom?: [number, number]; narrow?: boolean }): unknown;
	/** 太陽系（ortho-solar）への口＝34px 規格のアイコン。url＝行き先（既定 /solar/・dev は :5199）・共通の時計が実時間でなければその時刻を hash に添える。二重搭載は undefined */
	solar(opts?: { url?: string; zoom?: [number, number]; narrow?: boolean }): unknown;
	/** 衛星シーン検索（STAC＝Earth Search／Tellus→選んだシーンの COG を球へ＝cog ガジェット）。ボタンだけ常駐・本体は初回クリックで遅延 chunk。戻り値＝no-op */
	stac(opts?: { zoom?: [number, number]; narrow?: boolean }): () => void;
	/** 自作ガジェットの登録（this===map で呼ばれる） */
	(name: string, fn: (this: OrthoJapanMap, ...args: unknown[]) => unknown): void;
}

/** paint() の式（リテラルか Mapbox 風の配列式） */
export type GintExpr = string | number | boolean | unknown[];
/** paint() が受けるキー（fill-* は面、line-* は線/面の輪郭、circle-* は点） */
/** paint() のキー。表の色欄は fill と line/circle の 2 つ＝circle-color は点（Point/MultiPoint）に、line-color は線/面の輪郭に使われる
 *  （1.0.5〜ジオメトリで選ぶ。1.0.4 以前は line-color があると circle-color が無視された）。["geometry-type"] 式も 1.0.5〜有効 */
export interface GintPaint {
	"fill-color"?: GintExpr;
	"fill-opacity"?: GintExpr;
	"line-color"?: GintExpr;
	"line-opacity"?: GintExpr;
	"line-width"?: GintExpr;
	"circle-color"?: GintExpr;
	"circle-radius"?: GintExpr;
}

/** gint 層の描画スタイル（applyGintData opts.style。未指定＝既定色：面 #FF6B35 / 線 #00B4D8） */
export interface GintDrawStyle {
	/** 線幅 CSS px（既定 1） */
	lineWidth?: number;
	/** 塗り色 [r,g,b,a]（0..1） */
	fillColor?: [number, number, number, number];
	/** styleId(0..255)→色 [r,g,b,a] の平坦配列（256×4） */
	styleTable?: Float32Array | number[];
	/** styleId→[dash, gap] px の平坦配列（256×2・gap 0＝実線） */
	dashTable?: Float32Array | number[];
	/** 点の半径 CSS px（既定 1.5。fid 別は paintTable の radius が優先） */
	ptRadius?: number;
	/** 表示レンジの上書き（データ導出レンジとの積＝下限は max、上限は min） */
	minZoom?: number;
	maxZoom?: number;
	[k: string]: unknown;
}

/** addGint の層オプション */
export interface GintLayerOptions {
	/** 重ね順（小さいほど下・未指定＝追加順） */
	order?: number;
	/** 出しズームの範囲（層ごと） */
	minZoom?: number; maxZoom?: number;
	/** false＝カーソル（hover・tip・強調・layer.on('click')）を取らない＝足す前のアクティブ層がそのまま持つ。map.on('click') の hits と queryAll には入る */
	interactive?: boolean;
	/** 描画スタイル（applyGintData の style と同じ形） */
	style?: GintDrawStyle;
	/** ラベル（text-field 相当）＝基図の注記と同じ衝突・フェード */
	label?: { field: GintExpr | ((properties: Record<string, any>) => string); size?: number; color?: string; halo?: string; haloW?: number; sort?: number; minZoom?: number; maxZoom?: number } | null;
	/** ホバーの tip。true＝全属性を「キー: 値」で・関数＝properties→行の配列 */
	tip?: boolean | ((properties: Record<string, any>) => string[] | null);
	/** 塗りの辺数の上限（0＝塗らない＝輪郭だけ） */
	fillMaxEdges?: number;
	/** 低ズームの塗りを軽くする */
	lowFill?: boolean;
}
/** addGint が返す層のハンドル（MapLibre の層＋source の動詞と同名） */
export interface GintLayerHandle {
	readonly id: string;
	/** 焼き上がり（true）／失敗（false） */
	readonly ready: Promise<boolean>;
	order: number | null;
	on(ev: "hover", cb: (f: { fid: number; properties: Record<string, any> | null } | null) => void): GintLayerHandle;
	on(ev: "click", cb: (e: { fid: number; properties: Record<string, any> | null; lngLat: LonLat }) => void): GintLayerHandle;
	on(ev: "mouseenter", cb: (f: { fid: number; properties: Record<string, any> | null }) => void): GintLayerHandle;
	on(ev: "mouseleave", cb: (e: { fid: number }) => void): GintLayerHandle;
	/** 明示照会（同期）：この層の地物＝filter で隠した地物は返さない。interactive・setVisible・ズーム域には依らない。50 m 以内の点 → 30 m 以内の線 → 含む面のうち最小 */
	query(lngLat: LonLat): { fid: number; properties: Record<string, any> | null } | null;
	/** 式（MapLibre の paint と同じ語彙）を main で一度評価して fid 表に＝再構築なし。filter 省略＝今の filter のまま */
	setPaint(paint: object | null, filter?: unknown[] | null): Promise<void>;
	/** 表示の絞り込み（paint 未設定なら次の setPaint で効く） */
	setFilter(filter: unknown[] | null): Promise<void>;
	/** 一時状態（['feature-state', key] の実体）／消す（fid 省略＝全部） */
	setFeatureState(fid: number, state: Record<string, any>): void;
	removeFeatureState(fid?: number): void;
	/** データ差し替え（ハンドル・イベント・paint は生きたまま）。true＝焼き上がり */
	setData(pbf: GeoPBF, opts?: { minZoom?: number; maxZoom?: number }): Promise<boolean>;
	/** 重ね順を実行時に変える（moveLayer 相当） */
	setOrder(order: number): void;
	/** ラベルの付け替え（null＝消す） */
	setLabel(label: GintLayerOptions["label"]): Promise<unknown>;
	/** 描画スタイルの差し替え */
	style(style: GintDrawStyle): void;
	setVisible(visible: boolean): void;
	/** hover/click の対象をこの層へ */
	activate(): void;
	remove(): void;
}
/** gintユーザー層の搭載オプション（現行v1・単一スロット） */
export interface GintApplyOptions {
	style?: GintDrawStyle;
	/**
	 * この層を描く最小ズーム。未指定＝エンジンがデータ範囲から自動導出（狭域データは 13〜14 等・console に
	 * "[gint] minZoom auto-set" が出る）。**自動導出は線/面（arc）を含むデータのみ**＝点だけのデータは自動なし（ログも出ない）
	 * ＝全ズームで描く。指定すれば自動値を上書き（下げられる）。省メモリ端末（deviceMemory≤4 等）だけは z<minZoom（既定 7）で
	 * 層を眠らせる（通常の端末には効かない）
	 */
	minZoom?: number;
	/** ホバー/クリック識別を有効に（既定 true） */
	interactive?: boolean;
	/** ホバー処理（tip・ハイライト）。false＝オフ（クリックは interactive のまま生きる。既定 true） */
	hover?: boolean;
	/**
	 * 地形沿いの「線」を別描画（standupGint）で立てる＝細い固定幅・色は style.fillColor（paintTable/lineWidth は効かない）。moj 筆向け。
	 * ⚠ この層自体は海面高で描かれ、**チルト時（pitch>約1°）は非表示**＝スタイル付きの線/塗りをチルトでも出すなら drapeFill
	 */
	drape?: boolean;
	/** チルト時もこの層（線・塗り・paintTable のスタイル）を地形の上に描き続ける＝トレイル/区画をチルトで見せる時は true */
	drapeFill?: boolean;
	/** ホバー tip の整形：properties→行の配列。空配列/null＝tip を出さない。未指定＝全属性を "key: value" で列挙 */
	tip?: (props: Record<string, unknown>) => string[] | null | undefined;
	/** この層だけ塗りの辺数上限を上げる（既定 2M） */
	fillMaxEdges?: number;
	/** 低ズーム帯（z<outlineZoom）の単色ベタ塗りだけ生かす（大規模データの遠景用） */
	lowFill?: boolean;
	/** 焼きが表示束に着地した瞬間の通知（層差し替えで捨てられた場合は呼ばれない） */
	onReady?: () => void;
}

export type RasterSpec =
	| { url: string; tileSize?: number; minZoom?: number; maxZoom?: number; bbox?: Bbox; attribution?: string; subdomains?: string[]; tms?: boolean; headers?: Record<string, string>; name?: string;
		/** 色調整（1.2.0〜・#39・MapLibre の raster-hue-rotate / -saturation / -contrast / -brightness-min / -max と同じ意味）。addLayer の raster 層は paint から自動で作る */
		adjust?: { hueRotate?: number; saturation?: number; contrast?: number; brightnessMin?: number; brightnessMax?: number } }
	| { pmtiles: string; name?: string; attribution?: string }
	/** WMS（1.2.0〜・#45）＝GetMap を画面のタイルに割る（EPSG:3857）。url に {bbox-epsg-3857} を直に書いた XYZ 形でも可（MapLibre と同じ記法） */
	| { wms: { url: string; layers: string; styles?: string; format?: string; transparent?: boolean; version?: "1.3.0" | "1.1.1"; params?: Record<string, string> }; minZoom?: number; maxZoom?: number; bbox?: Bbox; attribution?: string; name?: string }
	/** WMTS（#45）＝capabilities（GetCapabilities の URL）を読むか、KVP を手で（url・layer・tileMatrixSet）。ウェブメルカトルの行列だけ描ける。REST の型紙は url に {TileMatrix}/{TileRow}/{TileCol} を書いて XYZ 形で渡してもよい */
	| { wmts: { capabilities: string; layer?: string; style?: string; format?: string } | { url: string; layer: string; tileMatrixSet: string; style?: string; format?: string; matrixIds?: string[] }; minZoom?: number; maxZoom?: number; attribution?: string; name?: string }
	| { file: File; table?: string; name?: string; attribution?: string }
	| { port: MessagePort; name?: string; attribution?: string }
	| { image: Blob | ImageBitmap; corners: [LonLat, LonLat, LonLat, LonLat]; name?: string }
	/** IIIF の古地図を基準点で歪みを直して地面に貼る（1.14.0〜・#177）。iiif＝Georeference Annotation（Allmaps の形・1 枚でもページでも）の URL か object。
	 *  変換＝注記の transformation（polynomial 1〜3 次・thinPlateSpline・projective・helmert・無ければ 1 次）。画像は IIIF Image API（v2/v3・level0 の静的タイルも）から要る段とタイルだけ。
	 *  枠（resourceMask）の外は透明。出典＝attribution → manifest の requiredStatement → info.json の attribution → 画像サーバーのホスト名。?iiif=<URL>・注記の JSON のドロップも同じ */
	| { iiif: string | object; name?: string; attribution?: string }
	/** 四隅で貼る動画（MapLibre の video source 相当・#49）。video＝動画要素（呼び手が持つ）か URL（の列）＝muted・loop・playsinline で自動再生。
	 *  地面に焼かず毎コマ覆う（基図と gint の上・注記の下）＝地形の遮蔽は無い。add の戻り値は VideoHandle */
	| { video: HTMLVideoElement | string | string[]; corners: [LonLat, LonLat, LonLat, LonLat] }
	/** 四隅の canvas（MapLibre の canvas source 相当・C3）。animate 既定 true＝毎フレーム写す・false＝1 枚。戻り＝CanvasHandle */
	| { canvas: HTMLCanvasElement | OffscreenCanvas; corners: [LonLat, LonLat, LonLat, LonLat]; animate?: boolean };
/** 四隅の canvas の手綱（MapLibre の CanvasSource と同じ名前・C3）。play＝毎フレームの写しを再開・pause＝止める（最後のコマが残る） */
export interface CanvasHandle { getCanvas(): HTMLCanvasElement | OffscreenCanvas; play(): void; pause(): void; readonly playing: boolean; setCoordinates(c: [LonLat, LonLat, LonLat, LonLat]): CanvasHandle; getCoordinates(): [LonLat, LonLat, LonLat, LonLat] }
/** 四隅の動画の手綱（MapLibre の VideoSource と同じ名前）。setCoordinates＝四隅を差し替え（止まっていても動く） */
export interface VideoHandle { getVideo(): HTMLVideoElement; play(): Promise<void>; pause(): void; seek(seconds: number): void; setCoordinates(corners: [LonLat, LonLat, LonLat, LonLat]): VideoHandle; getCoordinates(): [LonLat, LonLat, LonLat, LonLat] }
export interface RasterOptions { order?: "under" | "over"; opacity?: number; visible?: boolean; hideFills?: boolean; minZoom?: number; maxZoom?: number; /** 標本化（MapLibre の raster-resampling・既定 linear・C4） */ resampling?: "linear" | "nearest"; /** 到着フェード ms（MapLibre の raster-fade-duration・既定 300・0＝無し） */ fadeDuration?: number }
export interface RasterInfo { id: string; kind: string; tileSize: number; minZoom: number; maxZoom: number; bbox: Bbox | null; attribution: string | null; name: string | null; order: "under" | "over"; opacity: number; hideFills: boolean; resampling?: "linear" | "nearest"; fadeDuration?: number }
export interface RasterAPI {
	/** 足す（同じ id は置き換え）。戻り値＝ソースの自己申告（タイル寸・ズーム域・範囲・出典）。{ video } は VideoHandle */
	add(id: string, spec: Extract<RasterSpec, { video: unknown }>, opts?: RasterOptions): Promise<VideoHandle>;
	add(id: string, spec: Extract<RasterSpec, { canvas: unknown }>, opts?: RasterOptions): Promise<CanvasHandle>;
	add(id: string, spec: RasterSpec, opts?: RasterOptions): Promise<RasterInfo>;
	remove(id: string): boolean;
	/** 表示の変更（不透明度・重ね順・表示/非表示） */
	set(id: string, opts: RasterOptions): boolean;
	list(): Array<{ id: string; info: RasterInfo | null; spec: RasterSpec; opts: RasterOptions; error: string | null }>;
	info(id: string): RasterInfo | null;
	onChange(cb: () => void): () => void;
	/** 地域パックのカタログ（基図＝1 枚のラジオ・重ね＝トグル）。?r= と同期 */
	select(catalogId: string | null): Promise<RasterInfo | null>;
	toggle(catalogId: string, on?: boolean): Promise<boolean>;
	/** 地域パックが宣言したカタログ（region.rasters を束ねた物・地域の申告が無ければ []）＝raster ガジェットと ?r= の鍵 */
	readonly catalog: RasterCatalogEntry[];
	/** カタログの今の選択（base＝基図の catalogId・overs＝重ねの catalogId） */
	selected(): { base: string | null; overs: string[] };
	/** render worker の画像タイルの統計（在庫・読込中…・形は版で変わる）。5 秒で答えが無ければ null */
	stats(): Promise<Record<string, unknown> | null>;
}
/** 地域パックのカタログの 1 枚（region.rasters の要素）。key＝名前の訳の鍵（name の代わり）・order＝基図（under＝ラジオ）か重ね（over＝トグル） */
export interface RasterCatalogEntry { id: string; url: string; key?: string; name?: string; order: "under" | "over"; opacity?: number; tileSize?: number; minZoom?: number; maxZoom?: number; bbox?: Bbox | null; subdomains?: string[]; tms?: boolean; attribution?: { href?: string; key?: string; text?: string } | null; [k: string]: unknown }

/** 式（MapLibre style expression の部分集合：get has ! all any == != > >= < <= in match step case let var interpolate coalesce to-number to-string concat zoom geometry-type + - * / % ^ min max literal ほか。
 *  1.3.0〜 at・sin/cos/tan/asin/acos/atan・to-rgba・cubic-bezier 補間・index-of の開始位置・get/has の object 引数）。
 *  MapLibre の文書から来た式（style.json・addLayer・ML 形 gadget・queryRenderedFeatures の filter）は MapLibre の型の約束で評価する（1.3.0〜）：
 *  型の合わない大小比較・真偽でない条件（! all any case）・数でない interpolate/step の入力・外れた型の表明は評価エラー＝filter は偽・paint は既定値。
 *  get の欠損は null。to-number／number／string／boolean は予備の引数へ落ちる。map.paint・addGint のネイティブの式は従来の寛容な意味のまま。within/distance は未対応 */
export type StyleExpression = unknown[] | number | string | boolean;
export interface ExtrudeOptions { height?: string | number | ((props: Record<string, unknown>) => number); base?: string | number | ((props: Record<string, unknown>) => number); color?: string | ((props: Record<string, unknown>, height: number) => string); scale?: number; mask?: boolean | "auto"; fit?: boolean;
	/** 床の高さ[m]＝その高さの平面に浮かせる（1.2.0〜・高さはその平面から測る）。"drape"＝地形に沿わせる（全ズーム・頂点ごと）。
	 *  "ground"＝大きさに関わらず建物と同じ接地（標高の申告域の中で地表へ・外は海抜 0m。広い面は引いた視点で山に埋もれ得る）。
	 *  無指定＝ネイティブの書き方は面の外接矩形の対角の中央値で決まる：500m 以上（統計の面）は 2000m の平面・500m 未満（建物らしい面）は接地。
	 *  MapLibre 形（paint つき・fill-extrusion の層）の無指定は大きさに関わらず接地（MapLibre と同じ） */
	bottom?: number | "drape" | "ground" }
/** 同一フレームのオーバーレイ（map.overlay）の frame(cam, camState, size, api) の api（worker 内で渡る） */
export interface OverlayFrameApi {
	/** 経緯度 → [x, y（CSS px）, front（<0＝裏側）]（地形リフト込み） */
	project(lon: number, lat: number): [x: number, y: number, front: number];
	/** 地表から hM メートル持ち上げた点の投影 */
	projectH(lon: number, lat: number, hM?: number): [x: number, y: number, front: number];
	/** projectH と同じ点の clip 座標（camState.mvp・クランプなし）。w＝目からの奥行き＝シーンの深度と比べる尺度（1.2.0〜・#47） */
	clipH(lon: number, lat: number, hM?: number): [x: number, y: number, z: number, w: number];
	dpr: number; W: number; H: number;
	time: number; clock: { sim: number; wall: number; rate: number } | null;
	/** シーンの深度（1.2.0〜・#47）。申し出たオーバーレイがある時だけ・LOW_MEM では null */
	depth: OverlayDepth | null;
	/** 楕円体表示の b/a（#43）。球＝1・楕円体＝1−1/298.257223563。自前で経緯度から位置を組むオーバーレイは、測地緯度 φ を
	 *  β（tanβ＝rAx·tanφ）に直した単位球の点に置く（camState.mvp が S＝diag(1, rAx, 1) を畳む）。project／projectH を使う物は気にしなくてよい */
	rAx: number;
	/** 生の標高（m・地形から同期・地形が無ければ 0）。自前で頂点を組むオーバーレイ（plugin-scene・plugin-splat・列チャンク層のドレープ）が持ち上げに使う（src/renderworker.js） */
	elevM(lon: number, lat: number): number;
	/** 1m あたりの持ち上げ（pitch のフェード込み＝本体の lift と同式）。高さ r＝1＋elevM×liftScale＋hM×(1/R) */
	liftScale: number;
	/** 地形あり */
	terrainOn: boolean;
}
/** シーンの深度（1.2.0〜・#47）。本体が描き終えたフレームの深度（地形＝傾けた時・ビル・メッシュ・押し出し・gint の建物）を RGBA8 に詰めた物。
 *  海面の球は深度を書かない＝地平線の向こうは従来どおり front<0 で隠す。詰め方＝対数深度 d＝log2(1+w)·logCoef/2 を 24bit（R が上位）・d=1＝何も無い。
 *  行は下から（GL の窓座標と同じ）＝uv＝gl_FragCoord.xy / 自分の描画面の大きさ で引く。大きさ（w,h）は本体の描画解像度（動的解像度の縮小込み）。
 *  1 フレーム 1 回のコピー（GL2＝readPixels／WebGPU＝ImageBitmap）が要る＝GPU の完了を待つ。使うのは要る時だけ。 */
export interface OverlayDepth {
	w: number; h: number;
	/** 深度の尺度＝2/log2(far+1)（GLSL の u_sceneLogCoef） */
	logCoef: number;
	backend: "webgl2" | "webgpu";
	/** FS に貼る GLSL（#version・precision の後）。sceneDepthAt(uv)・depthOfW(w)・sceneOcclusion(uv, w)（1＝本体の物の陰・0＝見える）。捨てる（discard）か薄めるかはオーバーレイの自由 */
	glsl: string;
	/** このフレームの深度をその gl のテクスチャとして返す（同じフレームで二度上げない・gl の束縛と unpack の状態は戻す） */
	texture(gl: WebGL2RenderingContext): WebGLTexture;
	/** glsl の uniform を埋める（prog は useProgram 済み）。unit＝使うテクスチャユニット（既定 7）・eps＝許し（深度の単位・既定 2e-6） */
	bind(gl: WebGL2RenderingContext, prog: WebGLProgram, unit?: number, eps?: number): void;
}
/** MapLibre の fill-extrusion 層をそのまま（extrude の第 2 引数、または source つきで第 1 引数に）。意味・既定値は MapLibre の仕様どおり（height/base 0・color "#000000"・opacity 1）。
 *  床も MapLibre と同じ＝大きさに関わらず地面から（以前は対角の中央値が 500m 以上の面を 2000m の平面に浮かせた）。浮かせたい時は bottom:<m>・地形に沿わせるなら bottom:"drape" を層に添える（ExtrudeOptions.bottom）。
 *  式は呼んだ時に一度評価（["zoom"] はその時のズーム）。color の interpolate は色として補間。legacy filter（["==","key",v] の旧式）は非対応＝現代式で */
export interface FillExtrusionLayer extends Omit<ExtrudeOptions, "height" | "base" | "color"> {
	type: "fill-extrusion"; id?: string;
	source?: { type: "geojson"; data: GeoJSONFeatureCollection | string } | GeoJSONFeatureCollection;
	paint: { "fill-extrusion-height"?: StyleExpression; "fill-extrusion-base"?: StyleExpression; "fill-extrusion-color"?: StyleExpression; "fill-extrusion-opacity"?: number; "fill-extrusion-vertical-gradient"?: boolean | StyleExpression };   // vertical-gradient＝壁の縦の陰影（既定 true・C6）
	/** layout：`fill-extrusion-rounded-corner-distance`（m・既定 0・GL JS 6.2）＝足元の角を弧に（vector の押し出しも同じ）。ズームの式は止まった z で一度評価 */
	layout?: { "fill-extrusion-rounded-corner-distance"?: number | StyleExpression; visibility?: "visible" | "none" };
	filter?: StyleExpression;
}

export interface HeatmapLayer { type: "heatmap"; id?: string; source?: { type: "geojson"; data: GeoJSONFeatureCollection | string } | GeoJSONFeatureCollection | string; "source-layer"?: string;   // source が文字列＝addSource した source（vector なら "source-layer" が要る＝C1） minzoom?: number; maxzoom?: number;
	paint?: { "heatmap-radius"?: StyleExpression; "heatmap-weight"?: StyleExpression; "heatmap-intensity"?: StyleExpression; "heatmap-color"?: StyleExpression; "heatmap-opacity"?: number } }
export interface CirclePaint { "circle-color"?: StyleExpression; "circle-radius"?: StyleExpression; "circle-stroke-color"?: StyleExpression; "circle-stroke-width"?: StyleExpression; "circle-opacity"?: StyleExpression }
export interface ClusterOptions { clusterRadius?: number; clusterMaxZoom?: number; paint?: CirclePaint; unclustered?: { paint?: CirclePaint }; text?: { color?: string; size?: number } }
export type MapLibreSource =
	/** data の文字列＝URL（相対は頁から・1.3.0〜）。promoteId＝feature の id にする属性・clusterProperties（集約の属性・1.3.0〜）＝{ 名前: [畳み方, 写し方] }。
	 *  URL に鍵の問い合わせ（token・key・apikey…）が付いている時だけ、transformRequest を通して直に取る（型は "Source"・proxy を通らない・1.14.0〜）。
	 *  それ以外の URL は従来どおり。拡張子の無い鍵つき URL は中身の頭で GeoJSON か GeoPBF かを決める。
	 *  公開のフィーチャーサービス（…/FeatureServer/N・…/MapServer/N・…/collections/{id}）も data に渡せる（1.14.0〜・#176）：件数が 5 万以下は丸ごと・
	 *  超えたら fill/line/circle の層は視野の枡だけ読む（動いて止まったら足す・引きすぎの間は読まない）。サービスの取得は transformRequest を通る。
	 *  一度読んだ分は IndexedDB に GeoPBF で控える（30 日・2,000 件・256MB を超えた分は掃除・map.clearFeatureServiceCache()）。
	 *  出典はサービスの宣言（copyrightText・OGC の license）か attribution（#attr に出る）。
	 *  cacheKey（この地図の拡張・data が object の時だけ）＝fill/line/circle の層のために焼いた結果（GeoPBF＋GintBUF）を、この鍵で IndexedDB に控える。
	 *  次に同じ鍵の source を足すと焼かずに戻す（大きな data の焼きは秒の桁）。**中身は見比べない**＝data が変わったら鍵も変える（data の要約や版を鍵に入れる）。
	 *  控えるのは足した時の data だけ（setData／updateData で入れ替えると鍵は外れる）。30 日・200 件・256MB を超えた分は掃除 */
	| { type: "geojson"; data: GeoJSONFeatureCollection | string; cluster?: boolean; clusterRadius?: number; clusterMaxZoom?: number; clusterProperties?: Record<string, [unknown, unknown]>; promoteId?: string; generateId?: boolean; cacheKey?: string }
	| { type: "image"; url: string; coordinates: [LonLat, LonLat, LonLat, LonLat] }
	/** 四隅の動画（#49）＝raster の層で描く。getSource(id) は VideoHandle の口（getVideo/play/pause/seek/setCoordinates）も持つ */
	| { type: "video"; urls: string[]; coordinates: [LonLat, LonLat, LonLat, LonLat] }
	/** 四隅の canvas（MapLibre の canvas source・C3）＝raster の層で描く。canvas＝要素の id か要素。animate（既定 true）＝毎フレーム写す。getSource(id) は getCanvas/play/pause/setCoordinates も持つ */
	| { type: "canvas"; canvas: string | HTMLCanvasElement | OffscreenCanvas; coordinates: [LonLat, LonLat, LonLat, LonLat]; animate?: boolean }
	/** url＝TileJSON（1.3.0〜 取りに行く）。既定値は MapLibre どおり tileSize 512・maxzoom 22（1.3.0〜・以前は 256/18）。タイルの型紙は {quadkey} も可 */
	| { type: "raster"; tiles?: string[]; url?: string; tileSize?: number; minzoom?: number; maxzoom?: number; bounds?: Bbox; attribution?: string; scheme?: "xyz" | "tms" }
	/** ベクタタイル（MVT・1.3.0〜）＝今は fill-extrusion の層だけが読む（fill/line/circle/symbol は名前を挙げて投げる）。url＝TileJSON か pmtiles://・tiles＝型紙（{quadkey} 可・独自スキームは addProtocol）。
	 *  promoteId＝feature の id にする属性（文字列か source-layer ごとの object）。既定値は MapLibre どおり（minzoom 0・maxzoom 22）。
	 *  encoding＝タイルの形式（MapLibre と同じ "mvt"（既定）｜"mlt"＝MapLibre Tile・1.4.0〜）。"mlt" はプラグイン @ortho-earth/tile-formats を "#tile-formats" に alias したビルドで描ける（無ければ空＋警告 1 回）。PMTiles はヘッダの tileType が決める */
	| { type: "vector"; url?: string; tiles?: string[]; minzoom?: number; maxzoom?: number; bounds?: Bbox; attribution?: string; scheme?: "xyz" | "tms"; promoteId?: string | Record<string, string>; encoding?: "mvt" | "mlt" };
/** type "hillshade"（1.5.0〜）・"color-relief"（1.8.0〜・#114）＝raster-dem の source から画像タイルを作る層（基図の上・注記の下）。
 *  color-relief：paint "color-relief-color"＝["interpolate", …, ["elevation"], 標高, 色, …]（MapLibre と同じ意味＝段の標高で色を引き、段の間は事前乗算の線形・範囲の外は端の色・
 *  step／match／定数色は透明）・"color-relief-opacity"（既定 1・タイルを作り直さない）。resampling は読まない。組み込みの段彩の上に重なる */
export interface MapLibreLayer { id: string; type: "fill" | "line" | "circle" | "symbol" | "fill-extrusion" | "heatmap" | "raster" | "hillshade" | "color-relief"; source: string | MapLibreSource; "source-layer"?: string; filter?: StyleExpression; minzoom?: number; maxzoom?: number; layout?: Record<string, StyleExpression>; paint?: Record<string, StyleExpression> }
/** tolerance＝足す px（拡張・1.5.0〜既定 0＝MapLibre と同じ：線は線幅の半分・円は半径＋縁・面は内側。〜1.3 は 3） */
export interface QueryOptions { layers?: string[]; filter?: StyleExpression; tolerance?: number }
/** 外来の標高タイル（MapLibre の raster-dem 相当・#36）。encoding＝terrarium｜mapbox（MapLibre の既定）｜gsi（地理院 PNG 標高タイル）。
 *  地形の段 R01（1°）・R10（10°）のセルを、DEM が有効な画素だけ上書きする（アトラスは 1°あたり最大 1024 px＝見た目の細かさは約 100m 格子のまま）。
 *  1 点の標高（getHeight・断面図）は DEM の最大ズームを直に読む＝細かい DEM が効く。dtm:true＝裸地の申告＝地域の申告が無い所ではこの範囲で建物を地面へ持ち上げる */
/** 1.3.0〜 encoding "custom"（redFactor/greenFactor/blueFactor/baseShift）・既定値は MapLibre どおり tileSize 512・maxzoom 22（setTerrain・addSource・style の terrain。?dem= の URL は従来の 256） */
/** quantized-mesh（Cesium の地形＝layer.json＋.terrain・1.7.0〜・#110）。setTerrain・opts.terrain・style の terrain（sources の type "quantized-mesh"＝この地図の拡張）・?dem=<layer.json>。
 *  三角形は地形の標高の格子（R01・R10 のセル）へ焼いて描く（誇張しない）。1 点の標高（getHeight・建物の接地・断面図）は最大の段のタイルから。
 *  url＝layer.json（CORS が要る・相対は頁基準）か ion＝利用者の Cesium ion の鍵（{ assetId, accessToken }・Cesium World Terrain は assetId 1）。鍵は同梱しない。
 *  heights＝タイルの高さの基準：既定 "ellipsoidal"（仕様どおりの楕円体高＝Cesium World Terrain・PDOK）＝同梱の EGM96（30 分）のジオイド高を引いて標高へ直す（要る時だけ読む）／
 *  "orthometric"＝標高で配る配信（swisstopo）。heightOffset＝足す高さ（m）。高さ 0..0 の空のタイル（PDOK の粗い段）と 404/403 は無い所＝既定の標高が残る */
export interface QuantizedMeshSource { type: "quantized-mesh"; url?: string; ion?: { assetId: number | string; accessToken: string }; heights?: "ellipsoidal" | "orthometric"; heightOffset?: number;
	/** R01 のセルを焼く段（既定＝タイルの幅がセルの約 1/4＝z10）・maxzoom＝1 点の標本の上限の段（既定 16） */ cellZoom?: number; maxzoom?: number; bounds?: Bbox; dtm?: boolean; headers?: Record<string, string>; credentials?: RequestCredentials }
export interface RasterDemSource { tiles?: string[]; url?: string; encoding?: "terrarium" | "mapbox" | "gsi" | "custom"; tileSize?: number; minzoom?: number; maxzoom?: number; bounds?: Bbox; dtm?: boolean; cellZoom?: number; redFactor?: number; greenFactor?: number; blueFactor?: number; baseShift?: number }
export type ResourceType = "Style" | "Source" | "Tile" | "SpriteJSON" | "SpriteImage" | "Image" | "Unknown";
export type TransformRequestFunction = (url: string, resourceType: ResourceType) => { url?: string; headers?: Record<string, string>; credentials?: RequestCredentials } | undefined | null;
export type ProtocolLoader = (params: { url: string; type: "arrayBuffer" | "json" | "image" | "string"; headers?: Record<string, string> }, abortController: AbortController) => Promise<{ data: ArrayBuffer | ArrayBufferView | Blob | string | object | null }>;
/** 切る対象（map.setClipping の targets）：terrain＝地形・球の床・地形の蓋／buildings＝基図の押し出しと建物メッシュ／models＝模型・3D Tiles・I3S・押し出し／
 *  vector＝基図と利用者の塗り・線・gint・外部ベクタ・同一フレームのオーバーレイ（heatmap・模様・anno 等＝api.clip）・地面の識別と問い合わせ／
 *  labels＝注記（基図の注記と、symbol 層の記号・点の集約）。3D の塗りは地面に焼く＝terrain に従う */
export type ClipTarget = "terrain" | "buildings" | "models" | "vector" | "labels";
/** 断面の切り方（map.setClipping・1.7.0〜・#111） */
export interface ClipOptions {
	/** この群の面で切る対象（省略＝全部） */
	targets?: ClipTarget[];
	/** 鉛直面＝2 点 a→b を通る（a→b に向かって右側を残す） */
	vertical?: [LonLat, LonLat][];
	/** 水平面＝at の接平面を高さ h（m）に（keep "below"＝既定） */
	horizontal?: { at: LonLat; h: number; keep?: "below" | "above" }[];
	/** 箱の内側を残す（size＝[東西, 南北] m・h＝[底, 天] m・既定 [-500, 9000]・bearing＝度） */
	box?: { center: LonLat; size?: [number, number]; h?: [number, number]; bearing?: number };
	/** 単位球の平面 [nx, ny, nz, c]（n·X ≥ c を残す） */
	planes?: [number, number, number, number][];
	/** URL の ?clip= と同じ書き方の文字列 */
	param?: string;
	/** false＝蓋なし（地形の土の色の幕・板と建物の疑似の蓋）・色は { terrain: [r,g,b], building: [r,g,b] }（0..1） */
	cap?: false | { terrain?: [number, number, number]; building?: [number, number, number] };
	/** false＝縁の帯なし・{ width（CSS px・既定 2）, color（[r,g,b] 0..1・既定 橙） } */
	edge?: false | { width?: number; color?: [number, number, number] };
}
/** 3D Tiles の取得の前の手入れ（F5・2026-10-12）＝この tileset の全ての要求（tileset.json・外部 tileset＝type "Source"、タイルの本体＝"Tile"）に、地図の transformRequest の後で掛かる。
 *  戻り＝{ url?, headers?, credentials? }（null＝そのまま）。鍵・session の付与（Google Photorealistic 3D Tiles 等）や署名つき URL への差し替えは呼び手の closure で（鍵を repo に置かない） */
export type Tiles3DRequestTransform = (url: string, type: "Source" | "Tile") => { url?: string; headers?: Record<string, string>; credentials?: RequestCredentials } | null | undefined;
/** pickable（W7）＝当たりの写し（頂点・index）を main に持つか："auto"（既定）＝地物の番号（EXT_mesh_features／_BATCHID）を持つ束だけ・true＝全部・false＝持たない。featureIdSet＝何組目の番号で当てるか（既定 0） */
export interface Tiles3DOptions { id?: string; maxSSE?: number; heightOffset?: number; ground?: "absolute" | "terrain"; pointSize?: number; textures?: boolean; fit?: boolean; requestTransform?: Tiles3DRequestTransform; pickable?: boolean | "auto"; featureIdSet?: number;
	/** 出典（W8）＝文字列か、表示しているタイルの glTF asset.copyright の列（「;」で割り・多い順）→ 文字列 の関数。出典の欄（#attr）に出る（HTML は消毒される）。無ければ何も足さない */
	attribution?: string | ((copyrights: string[]) => string | null) }
export interface Tiles3DHandle {
	id: string; readonly stats: { loaded: number; shown: number; failed: number; triangles: number; points: number; bytes: number; gpuMB: number; inflight: number }; readonly bbox: Bbox | null;
	/** root の tileset.json の見出し（F5）：asset（version・tilesetVersion・extras）・metadata（3D Tiles 1.1）・extras・拡張 */
	readonly asset: Record<string, unknown> | null; readonly metadata: Record<string, unknown> | null; readonly extras: Record<string, unknown> | null; readonly extensionsUsed: string[]; readonly extensionsRequired: string[];
	remove(): void; setVisible(v: boolean): void; setOptions(o: Partial<Tiles3DOptions>): void;
	/** 画面の点（CSS px）の当たり（W7）＝ModelHandle.pick と同じ形（tile＝当たったタイルの id）。queryRenderedFeatures の層＝この tileset の id（type "3d-tiles"） */
	pick(x: number, y: number): MeshPick | null;
	/** 表示しているタイルの出典（glTF asset.copyright を「;」で割り・多い順・W8） */
	readonly copyrights: string[];
	/** feature state（tileset ごと・タイルを跨いで同じ番号＝同じ地物）。{ color } は描きに効く・後から読んだタイルにも効く */
	setFeatureState(featureId: number, state: Record<string, unknown> | null): Tiles3DHandle;
	getFeatureState(featureId: number): Record<string, unknown>;
	removeFeatureState(featureId?: number): Tiles3DHandle;
}
export interface LayerMouseEvent { type: string; point: { x: number; y: number }; lngLat: { lng: number; lat: number } | null; features: RenderedFeature[]; originalEvent: PointerEvent | MouseEvent; target: OrthoJapanMap }
/** 層の押し系のイベント（C8・MapLibre 同名）。preventDefault()＝mousedown/touchstart で呼ぶと地図のドラッグを捨てる（例 create-a-draggable-point）。touch＝points/lngLats（指の列・今は 1 本） */
export interface LayerPressEvent extends LayerMouseEvent { defaultPrevented: boolean; preventDefault(): void; points?: Array<{ x: number; y: number }>; lngLats?: Array<{ lng: number; lat: number } | null> }
/** properties の値は any（MapLibre・GeoJSON の型と同じ＝JS のまま書いても型検査で咎めない・1.1.1〜。以前は unknown） */
export interface RenderedFeature { type: "Feature"; id?: number | string; properties: Record<string, any>; geometry: { type: string; coordinates: unknown } | null; layer: { id: string; type: string; "source-layer"?: string }; sourceLayer?: string; source: "basemap" | "user" | "extrude" | "image" | "cluster" | "symbols" | (string & {}); expansionZoom?: number }

// ---- plugin 契約・registry・capabilities（拡張点の整備・第 2 波 PR-F0・2026-10-12・src/plugin.js・台帳 maplibre-compat.md §9「拡張点の台帳」）----
/** 拡張の形は 1 つ：definePlugin({ name, install(map, opts), uninstall? })。install は**同期**（非同期の仕事は中で始める）・返した関数は撤去の時に呼ぶ（uninstall が無い時）。
 *  install が受ける map は**素の map**（zoomScale の旗つきでも外側の顔ではない＝地域パックと同じ・エンジンの z）。registry への登録は install 中にすると撤去で自動的に外れる */
export interface OrthoPlugin<O = Record<string, unknown>> {
	/** 一意の名前（英数・-・_・. ）。map.use は同名の二重搭載を投げる */
	name: string;
	version?: string | null;
	/** 担う能力の鍵（capabilities の鍵・申告だけ） */
	provides?: string[];
	install(map: OrthoJapanMap, opts: O): void | (() => void);
	uninstall?(map: OrthoJapanMap): void;
}
export function definePlugin<O = Record<string, unknown>>(spec: OrthoPlugin<O>): Readonly<OrthoPlugin<O>>;
/** 名前→実装の表。builtin（この版が持つ物）は上書き・撤去できない。wired=false の表は登録を受けて保つだけ＝絵はまだ変わらない（pending の PR で結線） */
export interface PluginRegistry<T> {
	readonly kind: string;
	/** true＝登録が効く。false＝受けて保つだけ（capabilities の答えは "spec"） */
	readonly wired: boolean;
	/** wired=false の時、結線する PR の名（"PR-F1" など） */
	readonly pending: string;
	add(name: string, impl: T): this;
	remove(name: string): boolean;
	get(name: string): T | undefined;
	has(name: string): boolean;
	isBuiltin(name: string): boolean;
	/** 登録した plugin の名（builtin・直接の add は null） */
	ownerOf(name: string): string | null;
	names(): string[];
}
/** Gaussian splat（F8・予約された kind "splat" の契約）：map.addData(data, { kind: "splat" }) の data。描く段は plugin（registry.dataKinds "splat"）。URL（.ply/.splat/.spz）も受ける＝読み手は plugin */
export interface SplatData {
	/** 個数（省略なら positions.length / 3） */ n?: number;
	/** 位置＝crs "lnglat"（既定）なら [lng, lat, alt(m)] の並び、"ecef" なら地心直交 m（n*3） */ positions: Float32Array;
	/** 楕円の各軸の尺（m・n*3） */ scales: Float32Array;
	/** 向き＝四元数 x,y,z,w（n*4） */ rotations: Float32Array;
	/** RGBA 0〜255（n*4） */ colors: Uint8Array;
	/** 球面調和の係数（任意・長さは n の倍数＝次数は plugin が決める） */ sh?: Float32Array;
	crs?: "lnglat" | "ecef";
}
/** map.addData の kind を足す実装＝create が手綱を返す（points/arcs/trips/polygons/paths/columns は builtin・"splat" は契約が予約済み＝data は検めた SplatData か URL） */
export interface DataKindImpl { create(map: OrthoJapanMap, data: unknown, opts: Record<string, unknown> & { kind: string; id: string }): unknown }
/** タイル形式（core の registerTileFormat と同じ形・process-wide＝撤去できない） */
export interface TileFormatImpl { pmtilesType?: number | null; decode?: (bytes: Uint8Array, need: unknown) => unknown; load?: () => Promise<(bytes: Uint8Array, need: unknown) => unknown> }
export interface MapRegistry {
	/** map.addData の kind（結線済み） */
	readonly dataKinds: PluginRegistry<DataKindImpl>;
	/** map.gadget と同じ（add＝map.gadget(name, fn)・結線済み・builtin の名は実行時の map.gadget の鍵） */
	readonly gadgets: PluginRegistry<(this: OrthoJapanMap, ...args: any[]) => unknown>;
	/** core の registerTileFormat（結線済み） */
	readonly tileFormats: PluginRegistry<TileFormatImpl>;
	/** 光源の type（F1 で結線）＝builtin は directional/point/spot/ambient/hemisphere/ibl。plugin の type は { apply(map, lights) } */
	readonly lights: PluginRegistry<LightTypeImpl>;
	/** 後処理の pass の type（F3 で結線）＝builtin は bloom/vignette/fxaa/smaa/tonemap/lut/dof/ssr。plugin の type は { apply(map, passes) } */
	readonly postEffects: PluginRegistry<PostEffectImpl>;
	/** テクスチャの変換器（KTX2 など）。契約は { url }（F4）・worker が import() して KHR_texture_basisu の画像を素の RGBA にする（W5）＝登録があれば capabilities "plugin" */
	readonly textureTranscoders: PluginRegistry<TextureTranscoderImpl>;
	/** 雲・降水の描き手（F2 で結線）＝setClouds のたびに apply(map, clouds|null) */
	readonly clouds: PluginRegistry<CloudsImpl>;
	/** 操作の手（F6 で結線）＝"walk" を map.walk が引く。他の名は plugin の自由（capabilities "handler.<名>"） */
	readonly handlers: PluginRegistry<HandlerImpl>;
}
/** "builtin"＝今の版で絵が出る・"plugin"＝搭載した plugin が担う・"spec"＝口は受けて保つが絵は変わらない・"no"＝口も無い（note に後の PR）・"never"＝作らない（Mercator） */
export type CapabilityStatus = "builtin" | "plugin" | "spec" | "no" | "never";
export interface Capability { status: CapabilityStatus; via?: string | null; note?: string }
/** 鍵の例："projection.globe"・"projection.mercator"（never）・"camera.roll"・"light.directional"・"light.point"・"sky"・"post.bloom"・"post.ssr"・"data.points"・"data.<plugin の kind>"・
 *  "gadget.<名>"・"tiles.<形式>"・"tiles3d.requestTransform"・"tiles3d.attribution"・"terrain.sample"・"camera.walk"・"gltf.animation"・"texture.ktx2"・"render.webgpu"・"pointcloud.laz"・"react"・"types.shim" */
export type CapabilityKey = string;
/** この版の静的な答え（map.capabilities() の土台＝dynamic な鍵 data.*／gadget.*／tiles.*／post.*／light.*／texture.*／render.webgpu／pointcloud.laz はそこで足す）。凍結済み */
export const STATIC_CAPABILITIES: Readonly<Record<CapabilityKey, Capability>>;

/** 後処理の鎖の 1 段（F3・2026-10-12）。bloom・vignette は描く（PR-8 と同じ）。fxaa/smaa/tonemap/lut/dof/ssr は**受けて保つだけ**（map.supports("post.fxaa") は false・capabilities "spec"）＝実 GPU の段か plugin（registry.postEffects）が描く。enabled:false＝鎖に残すが掛けない */
export type PostPass =
	| { id?: string; type: "bloom"; enabled?: boolean; threshold?: number; strength?: number; radius?: number }
	| { id?: string; type: "vignette"; enabled?: boolean; strength?: number; radius?: number; softness?: number }
	| { id?: string; type: "fxaa"; enabled?: boolean }
	| { id?: string; type: "smaa"; enabled?: boolean; preset?: "low" | "medium" | "high" | "ultra" }
	/** tone mapping＝本体の色（LDR）に exposure を掛けて曲線を通す（見え方の調整）。既定 aces・exposure 1 */
	| { id?: string; type: "tonemap"; enabled?: boolean; mode?: "linear" | "reinhard" | "aces" | "agx" | "filmic"; exposure?: number }
	/** 3D LUT＝url は .cube（LUT_3D_SIZE が勝つ）か、横に size 枚の板を並べた size²×size の画像（x＝B の板×size＋R・y＝G）。intensity＝混ぜる量 0〜1 */
	| { id?: string; type: "lut"; enabled?: boolean; url: string; size?: 16 | 32 | 64; intensity?: number }
	| { id?: string; type: "dof"; enabled?: boolean; focusDistance?: number; focalLength?: number; aperture?: number; maxBlur?: number }
	| { id?: string; type: "ssr"; enabled?: boolean; intensity?: number; maxDistance?: number; thickness?: number; steps?: number }
	| { id?: string; type: string; enabled?: boolean; [k: string]: unknown };
/** registry.postEffects に足す pass の type＝setPostChain のたびに、その type の pass の配列（無ければ []）で apply を呼ぶ（plugin が自前の overlay／CSS filter で描く約束） */
export interface PostEffectImpl { apply(map: OrthoJapanMap, passes: PostPass[]): void }
/** map.setPostProcess の引数。true＝既定値。bloom: threshold＝滲む輝度の下限（0〜1・既定 0.75）・strength＝足す量（既定 0.5）・radius＝ぼかし半径の倍率（既定 1）。vignette: strength＝四隅の暗さ（既定 0.5）・radius＝暗くなり始める距離（中心 0〜角 1・既定 0.8）・softness＝移り変わりの幅（既定 0.5）。 */
export interface PostProcessOptions {
	bloom?: true | { threshold?: number; strength?: number; radius?: number };
	vignette?: true | { strength?: number; radius?: number; softness?: number };
	/** W1（2026-10-12）：鎖でも旧形でも受ける。描く順は fxaa → bloom → tonemap → lut → vignette */
	fxaa?: true | { enabled?: boolean };
	tonemap?: true | { mode?: "linear" | "reinhard" | "aces" | "agx" | "filmic"; exposure?: number };
	lut?: { url: string; size?: 16 | 32 | 64; intensity?: number };
}

export interface OrthoJapanMap {
	// ---- 基本 ----
	/** 飛行（度）。戻り値＝着地または cancel で解決する Promise（1.0.5〜。以前は void＝on("move") の無音で判定していた）。静止の合図は on("settle") */
	flyTo(lon: number, lat: number, zoom: number, tiltDeg?: number, bearingDeg?: number): Promise<void>;
	/** MapLibre の形の飛行（1.2.0〜・#35）。省略した項目は今の値。animate:false＝jumpTo と同じ */
	flyTo(options: CameraOptions & { animate?: boolean; essential?: boolean }): Promise<void>;
	/** 即座に移る（MapLibre 同名・角は度） */
	jumpTo(options: CameraOptions): OrthoJapanMap;
	/** 全項目を一本の緩急で同時に動かす（MapLibre 同名）。duration 既定 500ms。着地（または中断）で解決 */
	easeTo(options: CameraOptions & { duration?: number; animate?: boolean; essential?: boolean }): Promise<void>;
	/** bbox が収まる所へ（MapLibre 同名）。west>east＝±180 跨ぎ。linear:true＝easeTo・既定＝flyTo・animate:false＝jumpTo */
	fitBounds(bounds: Bbox | [LonLat, LonLat], options?: FitBoundsOptions): Promise<void>;
	/** fitBounds が向かうカメラ（動かさない） */
	cameraForBounds(bounds: Bbox | [LonLat, LonLat], options?: FitBoundsOptions): (Required<Pick<CameraOptions, "center" | "zoom" | "pitch" | "bearing">> & { padding: PaddingOptions }) | null;
	/** 既定の padding（以後の jumpTo/easeTo/flyTo/fitBounds の中身の中心）。数値＝四辺同じ。1.16.0〜は MapLibre と同じく注視点（getCenter）を画面の中身の中心に写し消失点も動く（以前は経緯度の中心をずらしていた＝getCenter が頼んだ点と違った） */
	setPadding(padding: PaddingOptions | number): OrthoJapanMap;
	/** 画面の 2 点（CSS px）が収まる所へ（MapLibre 同名・1.16.0〜）。bearing＝着地の方位。どちらかが球の外なら何もしない */
	fitScreenCoordinates(p0: [number, number] | { x: number; y: number }, p1: [number, number] | { x: number; y: number }, bearing?: number, options?: FitBoundsOptions): Promise<void>;
	/** 注視点の高さの実行時変更（MapLibre 同名・1.16.0〜）。true＝地形の上の中心点（opts.centerElevation:"ground"）・false＝固定値（setCenterElevation／jumpTo({elevation})） */
	setCenterClampedToGround(clamped: boolean): OrthoJapanMap;
	getCenterClampedToGround(): boolean;
	setCenterElevation(meters: number): OrthoJapanMap;
	/** 今の注視点の高さ［m］（map.cam.centerAlt） */
	getCenterElevation(): number;
	getCameraTargetElevation(): number;
	/** 可動域の自作（MapLibre の setTransformConstrain 相当・1.16.0〜）。毎移動、締める前に fn を通し、返した center/zoom を採る（null＝そのまま）。角は度・zoom はこの地図の z（旗つきでも換算しない） */
	setConstrain(fn: ((v: { center: LonLat; zoom: number; pitch: number; bearing: number; roll: number }) => { center?: LonLat | { lng: number; lat: number }; zoom?: number } | null | undefined) | null): OrthoJapanMap;
	getPadding(): PaddingOptions;
	/** 中心の可動域。null で解除。west>east＝±180 跨ぎ。入力・飛行・URL 復元のどれで動いても締まる */
	setMaxBounds(bounds: Bbox | [LonLat, LonLat] | null): OrthoJapanMap;
	getMaxBounds(): Bbox | null;
	setMinZoom(zoom: number | null): OrthoJapanMap;
	/** ズーム床の実行時変更（setMinZoom の実体・null＝カメラの既定の床へ）。入力・飛行・共有 hash・ズームボタンが従う */
	setZoomMin(zoom: number | null): void;
	/** 現在のズーム床 */
	zoomMin(): number;
	/** チルト上限の実行時変更（1.3.0〜 **度**・1.6 以下は従来のラジアン＝非推奨・null＝起動時の値へ・0＝真俯瞰固定）。超えていれば即座に上限へ寄せる */
	setMaxPitch(deg: number | null): void;
	/** 現在のチルト上限（ラジアン・ortho の口） */
	maxPitch(): number;
	/** 現在のチルト上限（度・MapLibre 同名・1.3.0〜） */
	getMaxPitch(): number;
	/** 楕円体表示か（opts.ellipsoid・?ell=1／?ell=0・既定は通常・HI のデスクトップで true＝1.6.0〜・#43）。計測は常に WGS84（表示の形に依らない） */
	ellipsoidOn(): boolean;
	getMinZoom(): number;
	/** 寄りの上限（起動時の zoomMax を超えない）。null＝起動時の上限へ */
	setMaxZoom(zoom: number | null): OrthoJapanMap;
	getMaxZoom(): number;
	getCenter(): { lng: number; lat: number };
	/** 度（map.view.pitch はラジアン） */
	getPitch(): number;
	/** 度（map.view.bearing はラジアン） */
	getBearing(): number;
	/** 視線まわりの回転（度・MapLibre 同名・1.16.0〜）。共有 hash では "15roll"。easeTo は補間・flyTo は離陸で書く */
	getRoll(): number;
	setRoll(rollDeg: number): OrthoJapanMap;
	/** 縦の視野角（度・MapLibre 同名・1.16.0〜）。既定 50（MapLibre は 36.87）。同じ zoom で地表の縮尺は変わらずカメラの距離が変わる */
	getVerticalFieldOfView(): number;
	setVerticalFieldOfView(deg: number): OrthoJapanMap;
	/** style の light（MapLibre 同名・1.16.0〜）＝押し出し・glTF・LOD2 の陰影の向き・強さ・色（WebGL2・WebGPU とも。WebGPU の fx.pbr の経路は太陽＋環境光のまま）。null＝従来の固定光に戻す。style の根の light は起動と setStyle で読む */
	setLight(light: LightSpecification | null): OrthoJapanMap;
	/** 光源の口（F1・2026-10-12）。配列で受けて既定を補って保つ。directional は 1 つまで（setLight と同じ経路で描く）。point／spot／ambient／hemisphere は W2（2026-10-12）でメッシュ（模型・押し出し・LOD2）の陰影に足す（WebGL2・WebGPU・上限 8 灯・位置 [lon, lat, alt m]・range m（0＝減衰なし）・decay＝(1−d/range)^decay・spot は direction [東,北,上] か target）。ibl は保つだけ。知らない type は投げる（plugin は registry.lights に足す）。[] で全部外す */
	setLights(lights: LightSpec[] | LightSpec | null): OrthoJapanMap;
	/** 保っている光源（directional は setLight／style の根の light も映る・正規化済み） */
	getLights(): LightSpec[];
	/** 太陽の向き（F2・2026-10-12・ephem＝夜の側・日影と同じ出所・精度 約 0.05°）。ms 省略＝共通の時計の今・at 省略＝視点の中心 */
	getSunPosition(ms?: number, at?: LonLat | { lng?: number; lon?: number; lat: number }): BodyPosition;
	/** 月の向き（地心＝視差なし・精度 約 0.3°） */
	getMoonPosition(ms?: number, at?: LonLat | { lng?: number; lon?: number; lat: number }): BodyPosition;
	/** directional の光（setLight と同じ 1 本）を太陽に合わせる。null＝外す（setLight(null)＝従来の固定光） */
	setSun(sun: SunSpec | true | null): OrthoJapanMap;
	getSun(): (Required<Pick<SunSpec, "follow" | "minAltitude">> & SunSpec) | null;
	/** 雲の spec。type "image" は builtin が描く（W6・読めたら on("clouds") に { state:"ready", tris, image }・失敗は { state:"error" }）。手続きの雲・降水は受けて保つだけ（plugin の registry.clouds が描ける）。null で外す */
	setClouds(clouds: CloudsSpec | true | null): OrthoJapanMap;
	getClouds(): Required<CloudsSpec> | null;
	/** 地形の一括標本（F6・2026-10-12・実装つき）。出どころは描いている地形と同じ（setTerrain／style の terrain の DEM が先・無い所は既定の DTM＝getHeight）。到着を待つ。
	 *  positions＝[lng,lat][]・{lng|lon,lat}[]・GeoJSON（Point/MultiPoint/LineString…の座標）。負の標高はそのまま返す（描く側は 0 に切る） */
	sampleTerrain(positions: LonLat[] | { lng?: number; lon?: number; lat: number }[] | object, opts?: { concurrency?: number }): Promise<{ lng: number; lat: number; height: number }[]>;
	/** 一人称歩行（F6 の口・W3 で builtin の中身＝src/walk.js）。registry.handlers の "walk"（plugin）があればそれが勝つ。足元＝描いている地形・壁＝基図の建物の足跡と押し出し（簡易の衝突） */
	walk(opts?: WalkOptions): WalkHandle;
	/** 今の light（既定を補った物） */
	getLight(): Required<LightSpecification>;
	/** style の sky（MapLibre 同名・1.16.0〜）＝球に当たらない視線を horizon-color→sky-color の簡易の空で塗る（WebGL2・不透明＝星空は隠れる）。fog-color・fog-ground-blend は両レンダラの霧に効く。null＝従来（宇宙へ抜けるリム光・霧は紙色） */
	setSky(sky: SkySpecification | null): OrthoJapanMap;
	/** 今の sky（既定を補った物）。無指定なら undefined（MapLibre と同じ） */
	getSky(): Required<SkySpecification> | undefined;
	/** 宇宙（球の外側）の色（1.16.0〜・B5）。色の文字列・"transparent"・null＝起動時の既定 */
	setClearColor(color: string | null): OrthoJapanMap;
	/** ── MapLibre の小口（1.16.0〜・B6） ── */
	/** sprite の一覧（MapLibre の getSprite と同じ形）。setSprite＝全部入れ替え（null＝全部外す）・addSprite／removeSprite＝id ごと。default 以外の記号は "id:名前" */
	getSprite(): { id: string; url: string }[];
	setSprite(url: string | null): OrthoJapanMap;
	addSprite(id: string, url: string): OrthoJapanMap;
	removeSprite(id: string): OrthoJapanMap;
	/** 記号帳の 1 枚（MapLibre の StyleImage の形・RGBA の生画素）。無ければ undefined */
	getImage(name: string): { data: { width: number; height: number; data: Uint8ClampedArray }; pixelRatio: number; sdf: boolean; version: number; stretchX?: number[][]; stretchY?: number[][]; content?: number[] } | undefined;
	/** glyphs の URL＝記録だけ（文字は Canvas2D で描く）。getStyle に echo */
	getGlyphs(): string | undefined;
	setGlyphs(url: string | null): OrthoJapanMap;
	/** URL で起動した style の URL（object の style なら undefined） */
	getStyleUrl(): string | undefined;
	/** font-faces（[{ "font-family"|family, src（url(...) も可）, "font-weight"?, "font-style"?, "unicode-range"? }]）→ addFontFace。記録は getFontFaces に。署名は MapLibre 6.x の文書と未照合 */
	getFontFaces(): Record<string, unknown>[];
	setFontFaces(list: Record<string, unknown>[]): Promise<OrthoJapanMap>;
	/** タイルの取り直し＝基図の source（無指定も）は新 style で組み直し・利用者の source はその層を載せ直す（geojson の URL は取り直す） */
	refreshTiles(sourceId?: string): Promise<OrthoJapanMap>;
	/** 今の画面を覆うタイル（近似＝画面に散らした点の逆投影・z は MapLibre の規則）。MapLibre の OverscaledTileID に似た形 */
	coveringTiles(options?: { tileSize?: number; minzoom?: number; maxzoom?: number; roundZoom?: boolean }): { canonical: { x: number; y: number; z: number }; overscaledZ: number; wrap: number; key: string }[];
	/** タイルの z の規則の 2 定数（MapLibre 同名。内製の目盛りでは効かない） */
	setSourceTileLodParams(maxZoomLevelsOnScreen: number, tileCountMaxMinimum: number): OrthoJapanMap;
	/** 制約（setConstrain・限界）の後にカメラを書き換える口（MapLibre の setTransformCameraUpdate）。角は度・zoom はエンジンの z・elevation＝注視点の高さ m。null で外す */
	setCameraUpdate(fn: ((cam: { center: [number, number]; zoom: number; pitch: number; bearing: number; roll: number; elevation: number }) => Partial<{ center: LonLat | { lng: number; lat: number }; zoom: number; pitch: number; bearing: number; roll: number; elevation: number }> | null | undefined) | null): OrthoJapanMap;
	/** 最小チルト（度・MapLibre 同名） */
	setMinPitch(deg: number): OrthoJapanMap;
	getMinPitch(): number;
	/** 描く解像度（CSS px あたりの画素・0.5〜4）。星空劇場・overlay の内部は起動時の値のまま */
	setPixelRatio(ratio: number): OrthoJapanMap;
	getPixelRatio(): number;
	/** 連続描画（MapLibre の map.repaint・計測用） */
	setRepaint(on: boolean): OrthoJapanMap;
	getRepaint(): boolean;
	/** debug の表示（MapLibre の showTileBoundaries・showPadding）＝main の canvas2D 1 枚 */
	setDebug(o: { tileBoundaries?: boolean; padding?: boolean }): OrthoJapanMap;
	getDebug(): { tileBoundaries: boolean; padding: boolean };
	/** 的を注視点に（A4・1.16.0〜）。duration>0 なら easeTo。的が無い（軌跡の範囲外・不明な id）なら何もしない。高さのある的は注視点の高さを的に合わせる（centerClampedToGround が false になる） */
	lookAt(target: CameraTarget, options?: LookAtOptions): Promise<void>;
	/** 毎フレーム的を追う（衛星・車両・CZML の時刻つき点・1.16.0〜）。省いた角・zoom は今の値のまま＝追従中の setZoom や回転が効く。null で止める。flyTo 中は的を待つ */
	follow(target: CameraTarget | null, options?: FollowOptions): FollowHandle | null;
	isFollowing(): boolean;
	/** Navara の setCamera の形を 1 対 1 で受ける（即時・1.16.0〜）。省いた物は今の値。zoom を渡せば distance より優先 */
	setCamera(camera: Partial<NavaraCamera> & { lon?: number; alt?: number; bearing?: number; zoom?: number }): OrthoJapanMap;
	getCamera(): NavaraCamera;
	setCenter(center: LonLat | { lng: number; lat: number }): OrthoJapanMap;
	setZoom(zoom: number): OrthoJapanMap;
	setPitch(pitchDeg: number): OrthoJapanMap;
	setBearing(bearingDeg: number): OrthoJapanMap;
	/** 見えている範囲の概算 [w,s,e,n]（画面の四隅と辺の中点の逆投影）。球の縁が画面に入る時は null */
	getBounds(): Bbox | null;
	isMoving(): boolean;
	/** 飛行・easeTo・慣性・ズームの滑りを止める */
	stop(): OrthoJapanMap;
	/** handler の on/off（1.16.0〜・A2）。shift＋ドラッグ＝ボックスズーム（1.16.0〜。以前はチルト・右ボタン／Ctrl＋ドラッグは従来どおりチルト）・ダブルクリック／ダブルタップ＝z+1（shift で z−1）・+/−＝1 段・離した勢いの慣性（MapLibre の定数） */
	setHandler(name: HandlerName, on: boolean): OrthoJapanMap;
	handlerOn(name: HandlerName): boolean;
	setZoomSnap(v: number): OrthoJapanMap;
	/** 動きの時計（C10・2026-10-12）＝飛行・paint の transition・共通の時計の刻みが読む時計を ms に止める（続けて呼べば進む）＝決定論の撮影（同じ setNow の列は同じ絵）。restoreNow＝実時間へ。
	 *  画像タイルの到着フェード（raster-fade-duration）と注記のフェードは描く側の壁時計のまま（記録） */
	setNow(ms: number): OrthoJapanMap; restoreNow(): OrthoJapanMap; getNow(): number;
	/** 動きを減らす（C10）＝true/false・null＝OS の prefers-reduced-motion を追う */
	setReduceMotion(v: boolean | null): OrthoJapanMap; getReduceMotion(): boolean;
	getZoomSnap(): number;
	getZoom(): number;
	/** 現在の視点。pitch/bearing は**ラジアン**（flyTo の tiltDeg/bearingDeg は度）。theme＝現在の配色名。hash＝共有/再生成用の "#z/lat/lon/…" */
	readonly view: { center: LonLat; zoom: number; pitch: number; bearing: number; /** ラジアン（1.16.0〜） */ roll: number; /** 縦の視野角（ラジアン・1.16.0〜） */ fovy: number; theme?: string; hash: string;[k: string]: unknown };   // 未記載のキー（sky/eye 等）は内部用＝使わない
	/** UI 文言の訳（英語キー → 表示言語・$1… は args で埋める）。SDK が読んだ辞書で引く（1.2.0〜） */
	t(key: string, ...args: Array<string | number>): string;
	/** 表示言語コード（ja/en/…・1.2.0〜） */
	readonly lang: string;
	/** 描画バックエンド（初回フレーム前は null） */
	readonly backend: "webgpu" | "webgl2" | null;
	/** イベント購読（戻り値＝map・解除は map.off(ev, cb)）。load＝初回フレーム（登録時に済んでいれば即呼ぶ）／move＝カメラ更新／
	 *  mesh＝建物3D の読込合図（1.2.0〜・旧名 plateau も同じ合図を受ける）（catalog→start→done|cancelled|failed）／click＝gint 多層の照会（v2） */
	on(ev: "load", cb: (e: {}) => void): OrthoJapanMap;
	on(ev: "move", cb: (e: { center: LonLat; zoom: number; pitch: number; bearing: number }) => void): OrthoJapanMap;
	on(ev: "mesh", cb: (e: MeshEvent) => void): OrthoJapanMap;
	/** @deprecated 1.2.0〜 "mesh" を使う（同じ合図）。次の大版で撤去 */
	on(ev: "plateau", cb: (e: MeshEvent) => void): OrthoJapanMap;
	on(ev: "click", cb: (e: { lngLat: LonLat; hits: Array<{ layer: GintLayerHandle | null; fid: number; feature: { fid: number; properties: Record<string, any> | null } }> }) => void): OrthoJapanMap;
	/** 共通の時計（1.2.0〜・#42）。ticking＝再生中の刻み（最大フレームごと）／false＝段・日時・今・範囲の端など状態の変わり目 */
	on(ev: "time", cb: (e: { time: number; step: number; live: boolean; ticking: boolean }) => void): OrthoJapanMap;
	/** 層ごとのイベント（MapLibre 同名・1.2.0〜・#34）。layerId＝addLayer の層 id か基図の層 id（配列可）。click はドラッグを除く・mousemove は rAF に畳む */
	on(ev: "click" | "mousemove" | "mouseenter" | "mouseleave", layerId: string | string[], cb: (e: LayerMouseEvent) => void): OrthoJapanMap;
	/** 層の押し系（C8・MapLibre 同名）＝同期の当たり（利用者の層だけ・基図の層には当たらない）。mousedown/touchstart の e.preventDefault() で地図のドラッグを捨てる */
	on(ev: "mousedown" | "mouseup" | "touchstart" | "touchend" | "dblclick" | "contextmenu", layerId: string | string[], cb: (e: LayerPressEvent) => void): OrthoJapanMap;
	off(ev: "click" | "mousemove" | "mouseenter" | "mouseleave" | "mousedown" | "mouseup" | "touchstart" | "touchend" | "dblclick" | "contextmenu", layerId: string | string[], cb: (e: LayerMouseEvent) => void): OrthoJapanMap;
	/** 一度だけ。cb 省略＝Promise */
	once(ev: string, layerIdOrCb?: string | string[] | ((e: any) => void), cb?: (e: any) => void): OrthoJapanMap | Promise<any>;
	/** 描き終わり（MapLibre 同名・1.5.0〜）：動いていない・基図が視野を覆って載った・標高と建物と利用者の source の読み込みが無い、が続いた時に 1 回。
	 *  画像タイル層（raster/hillshade/color-relief/image/video・map.raster も）の未着も待つ（1.6.0〜・color-relief は 1.8.0〜。それまでは画像が降っている途中で来た）。
	 *  忙しくなったら次の静けさでまた 1 回。起動直後もカメラを動かさずに来る（settle は動いた後だけ） */
	on(ev: "idle", cb: (e: {}) => void): OrthoJapanMap;
	/** source の中身が載った（C8・MapLibre の sourcedata の骨）＝addLayer／setData の載せ直しが終わるたび { sourceId }。setData の連打は畳まれる（最後の中身で 1 回）。
	 *  isSourceLoaded(id) は載せ直しの間 false。MapLibre の口（通訳）は sourcedata と data（isSourceLoaded:true）に写す */
	on(ev: "sourcedata", cb: (e: { sourceId: string }) => void): OrthoJapanMap;
	/** カメラ静止（移動が 150ms 止まった時・1.0.5〜）。ツアー/オーバレイの「止まった」合図 */
	on(ev: "settle", cb: (e: { center: LonLat; zoom: number; pitch: number; bearing: number; hash: string }) => void): OrthoJapanMap;
	/** ボックスズーム（shift＋ドラッグ・1.16.0〜・MapLibre 同名）。end の bbox＝[w,s,e,n]（west>east＝±180 跨ぎ）・x0..y1＝画面の矩形（CSS px） */
	on(ev: "boxzoomstart" | "boxzoomcancel", cb: (e: {}) => void): OrthoJapanMap;
	on(ev: "boxzoomend", cb: (e: { bbox: Bbox; x0: number; y0: number; x1: number; y1: number }) => void): OrthoJapanMap;
	/** 協調モード（opts.cooperativeGestures）で止めた操作（1.16.0〜） */
	on(ev: "cooperativegestureprevented", cb: (e: { kind: "wheel" | "touch" }) => void): OrthoJapanMap;
	/** 購読解除（1.0.5〜） */
	off(ev: string, cb: (e: any) => void): OrthoJapanMap;
	destroy(): void;
	readonly mapEl: HTMLElement;
	readonly gadget: Gadgets;

	// ---- 座標変換・フレーム ----
	/** 経緯度→mapEl（canvas）左上原点の CSS px（ページ座標ではない＝pointer を合成するなら getBoundingClientRect を足す）。unprojectXY と同じ座標系。
	 *  front<0＝**見えない**（裏半球ではなく「現在のカメラ高度の地平線より外」＝チルト時は数°先でも負）。見えない点の x,y は**地平線（可視キャップの縁）へ射影クランプした位置**
	 *  ＝塗りの経路はそのまま結んでよい（可視部＋地平線沿いで閉じる）。線は符号で切る。カメラ後方など写せない時だけ [0,0,-1]。
	 *  front の絶対値は未正規化＝符号だけ使う。**地形込み**＝チルト時は描いている地形の標高（setTerrain の DEM が先）だけ持ち上げる＝makeProjectorH()(lon, lat, 0) と同じ点。標高の初回は 0（海面）・届いた次フレームから乗る（makeProjectorH と同じメモ） */
	projectLL(lon: number, lat: number): [x: number, y: number, front: number];
	/** canvasローカルCSS座標→経緯度（球外はnull。onClick/setEditClickのx,yと同座標系） */
	unprojectXY(x: number, y: number): LonLat | null;
	/** 経緯度→画面の点（MapLibre と同名・1.1.1〜）。座標系は projectLL と同じ（地図の容れ物の左上原点の CSS px）。
	 *  見えない所（球の裏・地平線の外）も地平線へ寄せた位置を返す＝見えるかどうかは projectLL の front で */
	project(lngLat: LonLat | { lng: number; lat: number }): { x: number; y: number };
	/** 画面の点→経緯度（MapLibre と同名・1.1.1〜）。球の外（宇宙）は null */
	unproject(point: [x: number, y: number] | { x: number; y: number }): { lng: number; lat: number } | null;
	/** カメラ状態を1回束ねた投影関数（多点を1フレームで投影する時用・projectLL と同じく地形込み＝点ごとに標高のメモを引く。数百点以上は makeProjectorH({ terrain: false })） */
	makeProjector(): (lon: number, lat: number) => [x: number, y: number, front: number];
	/** 地形込みの投影。標高は描いている地形と同じ出どころ（setTerrain の DEM が先・無い所は既定の DTM・負は 0）を 100m 格子のメモから引く＝**その地点の初回は 0（海面）で、非同期に取得して次フレームから乗る**（毎フレーム呼ぶ
	 *  DOM マーカー用途向け。1 回きりの呼び出しには乗らない）。liftM＝地表からの追加持ち上げ m（0＝地表。標高を渡すと二重に浮く） */
	makeProjectorH(opts?: { terrain?: boolean }): (lon: number, lat: number, liftM?: number) => [x: number, y: number, front: number];   // liftM<0＝地中。terrain:false＝地形リフト無し（海面球＋liftM）＝**数百点以上を毎フレーム投影する overlay は必ずこちら**（既定の地形リフトは点ごとに標高照会を起こす）
	/** 描画フレーム毎フック（戻り値=解除関数）。**描画はオンデマンド＝静止中は呼ばれない**。オーバレイを載せた/更新した直後は requestDraw() で 1 フレーム点火する */
	onFrame(fn: () => void): () => void;
	/** 次フレームの描画を1回点火（オーバレイ更新後に） */
	requestDraw(): void;
	/** 同一フレームのオーバーレイ：レンダーワーカー内で地球・注記と同じフレーム・同じカメラで描く自前 canvas（main の onFrame は 1〜2 フレーム先行する）。
	 *  url＝worker が import() する依存ゼロのモジュール { init(canvas, opts), message(data), frame(cam, camState, {w,h}, api) → boolean, destroy() }。
	 *  api＝OverlayFrameApi＝{ project, projectH, clipH, dpr, W, H, time（共通の時計の時刻 ms・1.2.0〜・#42）, clock（{sim,wall,rate}｜null＝実時刻）, depth }。
	 *  シーンの深度（1.2.0〜・#47）：opts.depth:true か init の戻り値 { depth: true } で申し出たオーバーレイがある時だけ本体が作り、api.depth に載る（OverlayDepth）。
	 *  init の第 3 引数 host に depthGLSL（FS に貼る GLSL）。省メモリ端末（LOW_MEM）・作れない環境では api.depth＝null（従来どおり＝隠れ無し）。
	 *  戻り値の post(data, transfer) で状態やデータを渡す（描画要求を兼ねる）。remove() で外す */
	overlay(src: string | { builtin: string }, opts?: { name?: string; opts?: Record<string, unknown>; above?: boolean }): OverlayHandle;
	/** 統一 picking（deck.gl の onHover／onClick の object 相当・PR-1）＝同一フレームのオーバーレイのうち module が pick(x, y, r, ctx) を持つ物に当てる（手前から）。x／y／radius＝CSS px・names＝オーバーレイの名前か、その上の層の id（addLayerId）。
	 *  3 秒で答えが無ければ []。層イベント（map.on(ev, overlayName, cb)）と queryRenderedFeatures({ layers:[overlayName] }) にも同じ答えが Feature の形で混ざる */
	pickOverlays(x: number, y: number, opts?: { radius?: number; names?: string[] }): Promise<OverlayPick[]>;
	/** three.js を render worker の中で描く（PR-3・gadgets/three-draw.js）。three＝three.module.js の URL（利用者が持ち込む＝依存にしない）・module＝利用者のモジュールの URL（export setup(THREE, scene, h)／update?(dt, h)／onMessage?(d, h)／dispose?(h)）・
	 *  origin＝[lon, lat, hM]（シーンの ENU m の原点＝RTE・省略＝今の中心）・depth＝地形・建物に隠れる（既定 true）・params＝setup へ渡す物・name＝オーバーレイの名前（既定 "three"）・above＝注記の上。
	 *  戻り値＝オーバーレイの手綱＋ready（setup が済んだら解決・module の読み込み失敗は reject） */
	addThree(opts: { three: string; module?: string; origin?: [number, number, number]; depth?: boolean; params?: unknown; name?: string; above?: boolean }): OverlayHandle & { ready: Promise<OverlayHandle> };
	/** deck.gl の Layer（配列＋accessor）の相当（PR-4／PR-6・src/adddata.js）。kind "points"（getPosition／getColor [r,g,b,a 0〜255]／getRadius px）・"arcs"（getSourcePosition／getTargetPosition／getSourceColor／getTargetColor／getWidth／getHeight 弦長比）・
	 *  "trips"（getPath [[lon,lat,h?]…]／getTimestamps／currentTime／trailLength／fadeTrail／clock）は同一フレームの overlay（RTE・統一 picking）。"polygons"（getPolygon）・"paths"（getPath）・"columns"（getPosition＋getRadius m）＋ getFillColor／getLineColor／getLineWidth／getElevation m は
	 *  GeoJSON の addSource／addLayer（fill／line／fill-extrusion）。builtin 以外の kind は plugin（registry.dataKinds・"splat" は予約された契約＝SplatData）。data＝配列・GeoJSON FeatureCollection・iterable。setData は差分でなく全焼き（deck.gl と同じ） */
	addData(data: unknown, opts?: DataLayerOptions): DataLayerHandle;
	/** H3 のセル（@ortho-earth/h3・PR-2・本体は遅延 import）＝点をセルに集約（count／sum／mean／min／max）か、セル id の並びをそのまま面に。fill か fill-extrusion の層（既存の層経路＝描画・当たりは addLayer と同じ） */
	addH3(src: unknown, opts?: CellsLayerOptions): Promise<CellsLayerHandle>;
	/** セル（deck.gl の GridLayer／GeohashLayer／QuadkeyLayer／S2Layer 相当・PR-5・src/cells/）。kind＝"grid"（m）・"mesh"（地域メッシュの段）・"geohash"・"quadkey"・"s2"（id の意味は reference library と同じ）。res＝セルの大きさ／段（"auto" も）。H3 と同じ手綱 */
	addCells(src: unknown, opts?: CellsLayerOptions & { kind?: "grid" | "mesh" | "geohash" | "quadkey" | "s2" }): Promise<CellsLayerHandle>;
	/** 等値線／等値帯（ContourLayer 相当・PR-5）＝格子の場（cellSize m・weight・agg）→ thresholds（線・line の層）か bands（帯・fill の層）。smooth＝場のぼかしの回数 */
	addContour(src: unknown, opts?: ContourLayerOptions): Promise<ContourLayerHandle>;
	/** 画面に固定の格子（ScreenGridLayer 相当・PR-5）＝overlay（毎フレーム投影して数える・統一 picking で count）。cellPx＝格子の px・colorRange＝色の段・agg＝sum／count／mean／min／max */
	addScreenGrid(src: unknown, opts?: ScreenGridOptions): Promise<ScreenGridHandle>;
	/** 集約の振り分け（PR-5）＝kind "h3" → addH3・"screen" → addScreenGrid・"contour" → addContour・それ以外 → addCells */
	addAggregate(src: unknown, opts?: { kind?: "h3" | "screen" | "contour" | "grid" | "mesh" | "geohash" | "quadkey" | "s2"; [k: string]: unknown }): Promise<CellsLayerHandle | ContourLayerHandle | ScreenGridHandle>;
	/** 不透明度（0..1）。base＝紙と線（塗り/線）・globe＝球体（globe/terrain/海面下/湖/夜面）。表示パネル「基図」スライダーは両方を一緒に動かす。globe<1 で地中に置いた overlay（makeProjectorH の負の高さ）が透けて見える */
	/** 基図（紙・線）・球体（globe/terrain）・全球ハイプソ（低ズームの段彩＝0 で陸の地色だけ・1.7.x〜）の不透明度（0..1） */
	setOpacity(o: { base?: number; globe?: number; hypso?: number }): void;
	/** クリック横取りスロット（編集アプリ用。gint の onGintClick より優先）。null=解除。クリックvsドラッグ弁別はエンジン側が済ませる */
	setEditClick(fn: ((x: number, y: number) => void) | null): void;
	/** 標高 m（GSI DEM10B / AW3D30 のタイルを api.ortho-earth.com 経由で取得）。格子は今のズームで決まる＝z<7 は R90・z<12 は R10（約 460m＝鋭い山頂は低めに出る）・
	 *  z≥12 は R01（10m＝日本は DEM10B・海外は AW3D30）。2026-09-25 の修正より前の版は z≥12 でも R10 に落ちていた（富士山頂 3567m 等）。
	 *  1.0.4〜ローダ着荷（数秒）を待って返す（初期化失敗は reject）。1.0.3 以前は未着の間 0 を返す＝>0 になるまで再照会 */
	getHeight(lon: number, lat: number): Promise<number>;
	fitZoomForBbox(bbox: Bbox): number;
	/** 画像タイル層（ラスタ）。地形へドレープされる（地面の塗りと同じ合成）。order:"under"＝基図（塗りを伏せる）／"over"＝重ね（線と注記は上に残る）。
	 *  spec＝XYZ テンプレ｜ラスタ PMTiles｜ローカル容器（.gpkg/.mbtiles）｜外部プロバイダの MessagePort｜**四隅で貼る画像**（MapLibre の image source 相当・1.1〜）。
	 *  四隅の順＝左上→右上→右下→左下（[lon,lat]）＝射影変換で貼る（台形も歪まない）。geoedit の @image（4 頂点の面）と同じ表し方。戻り値＝ソースの自己申告 */
	raster: RasterAPI;
	/** 記号帳（MapLibre の addImage 相当）。img＝ImageBitmap/HTMLImageElement/Blob/URL/{width,height,data}。sdf＝icon-color で塗れる記号 */
	/** global-state（MapLibre v5 同名・1.7.0〜）：式の ["global-state", key] が読む地図全体の状態を変える。それを読む層（filter/layout/paint）だけ評価し直す。style の root の state（{ key: { default } }）が既定値 */
	setGlobalStateProperty(key: string, value: unknown): OrthoJapanMap;
	/** global-state の今の値（写し）。状態は地図ごと（#173＝頁に地図が複数あっても互いに効かない） */
	getGlobalState(): Record<string, unknown>;
	/** Web フォントを差す（1.6.0〜・段 2）：style の text-font の family（"Noto Sans Bold"→family "Noto Sans"・weight 700）がブラウザに無い時に持ち込む。
	 *  main（DOM）と描画 worker（注記・記号・集約の canvas）の両方に同じ FontFace を載せる。source＝URL か ArrayBuffer・descriptors＝weight/style 等。glyph PBF（style.glyphs）は読まない */
	addFontFace(family: string, source: string | ArrayBuffer, descriptors?: { weight?: string; style?: string; stretch?: string; unicodeRange?: string }): Promise<OrthoJapanMap>;
	addImage(name: string, img: ImageBitmap | HTMLImageElement | HTMLCanvasElement | Blob | string | { width: number; height: number; data: Uint8Array | Uint8ClampedArray }, opts?: { pixelRatio?: number; sdf?: boolean }): Promise<unknown>;
	removeImage(name: string): void;
	/** 画素だけ差し替える（MapLibre 同名・1.7.0〜）＝層を評価し直さない（動く記号を毎フレーム差し替える口）。無い名前は addImage と同じ */
	updateImage(name: string, image: ImageBitmap | HTMLImageElement | HTMLCanvasElement | ImageData | { width: number; height: number; data: Uint8Array | Uint8ClampedArray }): Promise<unknown>;
	hasImage(name: string): boolean;
	listImages(): string[];
	/** MapLibre の sprite を丸ごと記号帳へ（base.json＋base.png・高解像度画面は base@2x.*）。戻り値＝足した記号の数 */
	loadSprite(base: string): Promise<number>;
	/** フィーチャーサービスの控え（IndexedDB・鍵の接頭辞 FS1::）を消す（1.14.0〜・#176）。他の控え（地図データ・ファイル）は残る。
	 *  opts＝{ maxAge（ms）, maxEntries, maxBytes }＝超えた分だけ（省略＝全部）。戻り値＝{ removed, kept, bytes }（控えの棚が無ければ null） */
	clearFeatureServiceCache(opts?: { maxAge?: number; maxEntries?: number; maxBytes?: number }): Promise<{ removed: number; kept: number; bytes: number } | null>;
	/** MapLibre の addSource／addLayer をそのまま（source＝geojson（cluster 可）/image/video/raster・layer.type＝fill/line/circle/symbol/fill-extrusion/heatmap/raster。fill-pattern/line-pattern＝記号帳の画像を敷き詰め）。
	 *  line-gradient（["line-progress"] の式）・line-offset（画面 px・進行方向の右が正）の線は canvas2D の口で描く（#49・gint の線は一色・ずらしなし＝地形の遮蔽は無い）。
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
	addSource(id: string, source: MapLibreSource): OrthoJapanMap;
	getSource(id: string): (MapLibreSource & { setData(data: GeoJSONFeatureCollection | string): Promise<void>; getClusterExpansionZoom?(clusterId: number): Promise<number> } & Partial<VideoHandle>) | undefined;   // getClusterExpansionZoom＝cluster:true の source（1.3.0〜）
	removeSource(id: string): OrthoJapanMap;
	/** vector source（fill-extrusion・fill/line/circle/symbol）＝見えているタイルが今の式で組み上がって描画側に載るまで false（カメラが動いている間も false）。基図の source 名も受ける。
	 *  raster/raster-dem（hillshade・color-relief＝1.8.0〜）/image/video の source（1.6.0〜）＝その source を使う見えている層が開く途中か、見えているタイルに未着がある間は false */
	isSourceLoaded(id: string): boolean;
	addLayer(layer: MapLibreLayer, beforeId?: string): Promise<unknown>;
	getLayer(id: string): MapLibreLayer | undefined;
	/** 利用者の層（登録順＝下から） */
	getLayers(): MapLibreLayer[];
	removeLayer(id: string): OrthoJapanMap;
	/** 重ね順を変える（beforeId の下へ・省略＝一番上）。同じ描き方の中で効く */
	moveLayer(id: string, beforeId?: string): OrthoJapanMap;
	/** paint の性質を変える（gint の層は fid 表の書き換えだけ＝安い・raster-opacity は即時）。undefined＝既定へ */
	/** paint の変更。利用者の層は数・色・数の配列を transition で補間して描き直す（1.16.0〜・MapLibre の `<name>-transition`＝{duration, delay}・style の根の `transition`・既定 300ms。式は補間しない・基図の層は即時）。options.transition:false で即時 */
	setPaintProperty(id: string, name: string, value: StyleExpression | { duration?: number; delay?: number } | undefined, options?: { validate?: boolean; transition?: boolean }): OrthoJapanMap;
	getPaintProperty(id: string, name: string): StyleExpression | undefined;
	/** layout の性質を変える。visibility:"none"｜"visible" で出し入れ（層は残る） */
	setLayoutProperty(id: string, name: string, value: StyleExpression | undefined): OrthoJapanMap;
	getLayoutProperty(id: string, name: string): StyleExpression | undefined;
	setFilter(id: string, filter: StyleExpression | null): OrthoJapanMap;
	getFilter(id: string): StyleExpression | undefined;
	setLayerZoomRange(id: string, minzoom: number, maxzoom: number): OrthoJapanMap;
	/** feature-state（MapLibre 同名）。id＝MapLibre の id（1.3.0〜）＝GeoJSON の Feature.id → source の promoteId の属性 → どちらも無ければ並び順（generateId と同じ・以前の意味）。
	 *  queryRenderedFeatures の id も同じ。効くのは fill/line/circle の paint の ["feature-state", key]。基図の地物には効かない。属性がまったく同じ地物も別々に扱う（1.3.0〜） */
	/** vector source は sourceLayer が要る（MapLibre と同じ・fill-extrusion は 1.3.0〜・fill/line/circle/symbol は 1.9.0〜）＝状態が変わった地物を含むタイルだけ組み直す（paint の ["feature-state"]・filter は読まない） */
	setFeatureState(feature: { source: string; sourceLayer?: string; id: number | string }, state: Record<string, unknown>): OrthoJapanMap;
	removeFeatureState(feature: { source: string; sourceLayer?: string; id?: number | string }, key?: string): OrthoJapanMap;
	/** MapLibre 同名（1.3.0〜）：その地物の今の状態（無ければ {}） */
	getFeatureState(feature: { source: string; sourceLayer?: string; id: number | string }): Record<string, unknown>;
	/** MapLibre の style の形（version 8）。layers＝基図の層（外来 style ならその source 名・地域の基図は "basemap"）の上に利用者の層。
	 *  基図の層も 1.3.0〜 getLayer/setPaintProperty/setLayoutProperty/setFilter/setLayerZoomRange/removeLayer で触れる（visibility は結合で外すだけ＝軽い・色や filter は基図タイルの建て直し）。
	 *  基図の層の重ね順は固定（moveLayer は基図の層に効かない・beforeId に基図の層 id を渡してもよい＝利用者の層は描画の段で決まる）。上書きはテーマの切り替えを越えて残り、setStyle で消える。
	 *  ズームの目盛りを申告して返す（1.3.0〜）：各層の metadata["ortho:dz"]（基図＝0＝この地図の z に直した物）・root の metadata["ortho:sourceDz"]（source ごと）＝setStyle(getStyle()) で二重にずれない */
	getStyle(): { version: 8; sources: Record<string, unknown>; layers: Array<MapLibreLayer | Record<string, unknown>> };
	/** 任意の 3D Tiles を画面上の誤差で流す（1.2.0〜・#41）。url＝tileset.json（?tiles3d=<URL> と同じ）。
	 *  中身＝b3dm・i3dm・pnts（点群）・cmpt・glb/glTF（3D Tiles 1.1）・外部 tileset。refine REPLACE（子が揃うまで親）/ ADD。GPU 予算を超えたら使っていないタイルから捨てる。
	 *  高さ＝既定は tileset の高さのまま（写真測量・点群）。建物の tileset は ground:"terrain"＝1 棟ずつ地面へ接地。点群は同一フレームのオーバーレイ（深度は共有しない＝#47）。
	 *  未対応＝implicit tiling・メタデータとスタイル・API キーの要る配信 */
	add3DTiles(url: string, opts?: Tiles3DOptions): Promise<Tiles3DHandle>;
	/** I3S（ArcGIS の Indexed 3D Scene Layer・1.2.0〜・#48）を 3D Tiles と同じ選び・同じ GPU 経路で流す。url＝…/SceneServer か …/SceneServer/layers/N（?i3s=<URL> と同じ）。
	 *  nodepages 形式（I3S 1.6 以降）の 3D Object / IntegratedMesh。lodScale＞1 で粗く。点群と旧形式は未対応。解読は @loaders.gl/i3s（MIT） */
	/** COPC の点群（Cloud Optimized Point Cloud・.copc.laz・1.14.0〜・#178）を範囲読みで直に流す（maplibre-gl-lidar 相当・変換無し・サーバー無し）。
	 *  URL（HTTP Range・transformRequest の鍵）か File。節の点の間隔が画面で density px より粗ければ子へ降りる（足し算）。解読＝プラグイン（バンドラの alias で "#pointcloud-formats" → "@ortho-earth/tile-formats/pointcloud"＝laz-perf・WASM・遅延）＝差し込まないと reject。
	 *  座標＝WKT（TM/UTM・メルカトル・LCC・Albers・経緯度）→ 経緯度・高さ＝楕円体高なら EGM96 の N を引いて標高へ。?copc=<URL>・.copc.laz のドロップも同じ */
	addCOPC(src: string | File | Blob, opts?: COPCOptions): Promise<COPCHandle>;
	/** COPC を外す（id を省く＝全部） */
	removeCOPC(id?: string): Promise<boolean>;
	/** 点群（LAS／LAZ／COPC）を足す（addCOPC の新しい名）。COPC は節だけ範囲読み。普通の LAS/LAZ（1.0〜1.4・点の形式 0〜10）はファイルを丸ごと読み、その場で八分木を作る。
	 *  丸ごと読みの上限＝2,000 万点・URL は 500 MB（超えたら COPC への変換を案内して reject）。.las／.laz のドロップも同じ */
	addPointCloud(src: string | File | Blob, opts?: COPCOptions): Promise<COPCHandle>;
	/** 点群を外す（id を省く＝全部） */
	removePointCloud(id?: string): Promise<boolean>;
	addI3S(url: string, opts?: Tiles3DOptions & { lodScale?: number; token?: string }): Promise<{ id: string; name: string | null; copyright: string | null; readonly stats: Tiles3DHandle["stats"]; remove(): void; setVisible(v: boolean): void; setOptions(o: Partial<Tiles3DOptions> & { lodScale?: number }): void }>;
	/** 日影（1.2.0〜・#44）。建物（既定＝地域の建物台帳＝日本は PLATEAU・tilesets で任意の 3D Tiles）の影を測定面へ投影し、地面に画像として貼る（map.raster の "sunshadow"）。
	 *  mode "duration"＝日影図（既定＝冬至・真太陽時 8〜16 時・30 分刻みで日影になる時間の段彩と 2〜5 時間の境線）／"instant"＝date の時刻の影。範囲＝既定は画面に見えている所（一辺 3km まで）。
	 *  probe＝指定地点の日影時間（時・instant は 0|1）。ボタンとパネルは map.gadget.sunshadow() */
	sunShadow(opts?: { mode?: "duration" | "instant"; date?: Date | string; planeH?: number; hours?: [number, number]; step?: number; decl?: number; bbox?: Bbox; tilesets?: string[]; probe?: LonLat[] }): Promise<{ triangles: number; tiles: number; steps: number; maxHours: number; decl: number; planeH: number; mode: string; probes: number[] }>;
	/** リアルタイムの影（1.2.1〜・1.7.0 で範囲を広げた＝#112）。描画の中で太陽から深度を描き（shadow map）、影を落とす。
	 *  落とす物＝地形（1.7.0〜）・基図の押し出し・PLATEAU 等のメッシュ・glb の模型・3D Tiles・I3S・押し出し（map.gadget.extrude／fill-extrusion の層）。
	 *  模型の MASK（葉などの切り抜き）は α で抜いて落とす。半透明（BLEND）の模型と、統計の柱（市区町村のような広い面の押し出し）は落とさない。
	 *  受ける物＝地面（地形・球の床）・塗り・線・建物・メッシュ・模型・3D Tiles・I3S・押し出し（不透明と半透明）。gint の線・注記・オーバーレイは受けない。
	 *  影の間は地形の陰影の光も太陽の方位に合わせる（強さは従来と同じ）。影の窓は 1 枚＝画面の中心のまわり（半幅 120m〜6km）で、縁は丸く薄める
	 *  （傾けた遠景は影なし）。true／false／{ time（Date・ms・ISO＝その時刻の太陽・省略＝共通の時計）, darkness（影の明るさ 0..1・既定 0.66） }。
	 *  z13 以上・太陽が地平線の上（2° 以上）の時だけ。**WebGPU 専用**（WebGL2 フォールバックでは何もしない＝影をかけない仕様）。消している間は描画に一切関与しない（資源も持たない） */
	setShadows(opts?: boolean | { on?: boolean; time?: Date | number | string; darkness?: number }): void;
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
	setClipping(opts?: false | ClipOptions | ClipOptions[]): void;
	/** 今の切り方（setClipping に渡した物の写し）・切っていなければ null（1.7.0〜・#111） */
	getClipping(): ClipOptions | ClipOptions[] | null;
	/** 可視域（1.2.0〜・#44）。observer（既定＝画面の中心）に目の高さ eyeH（m・既定 1.6）で立ち、半径 radius（m・既定 1000・最大 5000）の中で高さ targetH（m）の点が見えるか。
	 *  地表＝地形（setTerrain の DEM があればそれ）＋建物（buildings:false で地形だけ・tilesets で任意の 3D Tiles）・地球の丸みと大気の屈折（k＝0.13）込み。
	 *  結果は地面に画像として貼る（map.raster の "viewshed"＝見える所が緑）。probe＝指定地点が見えるか（1|0）。ボタンとパネルは map.gadget.viewshed() */
	viewshed(opts?: { observer?: LonLat; eyeH?: number; targetH?: number; radius?: number; buildings?: boolean; tilesets?: string[]; cell?: number; probe?: LonLat[] }): Promise<{ cells: number; visibleRatio: number; triangles: number; eyeZ: number; cell: number; probes: number[] }>;
	/** 見通し線（1.2.0〜・#44）。a（視点・高さ eyeH）から b（目標・高さ targetH）が見えるか。遮る最初の点 blockAt・距離（m）・断面 profile（[距離, 地表, 視線] m）。
	 *  地図に線を引く（source/layer "los"＝見える区間が緑・遮られた先が赤） */
	lineOfSight(a: LonLat, b: LonLat, opts?: { eyeH?: number; targetH?: number; buildings?: boolean; tilesets?: string[]; cell?: number }): Promise<{ visible: boolean; blockAt: LonLat | null; distance: number; profile: [number, number, number][]; triangles: number }>;
	/** 可視域の画像と見通し線を消す */
	clearViewshed(): Promise<void>;
	/** 共通の時計（1.2.0〜・#42・ephem/clock＝ortho-solar と同じ部品）。夜の側・星空・惑星と月・太陽系圏・同一フレームのオーバーレイ（api.time＝衛星など）がこの時刻で描く。
	 *  既定＝実時間。URL（ビューの hash）に t=<UTC>/s=<段> を書く（実時間なら書かない）＝共有リンクで同じ時刻が開く。操作盤は map.gadget.clock()。
	 *  範囲と繰り返し（setRange・1.8.0〜・#124）＝CZML・GPX を読むとデータの区間が写る（#113） */
	readonly clock: OrthoClock;
	/** import しなくても使える Marker / Popup（new map.Marker().setLngLat(…).addTo(map)） */
	/** 標高を外来の DEM に（MapLibre 同名・#36）。source＝addSource した raster-dem の id か spec。null＝既定の標高へ。exaggeration は受け流す（地形は誇張しない） */
	setTerrain(terrain: { source: string | RasterDemSource | QuantizedMeshSource; exaggeration?: number } | null): Promise<OrthoJapanMap>;
	getTerrain(): { source: RasterDemSource | QuantizedMeshSource; exaggeration: 1 } | null;
	/** 地形の標高 m（MapLibre 同名・同期）＝地形（setTerrain／style の terrain）がある時だけ。手元に無ければ null（照会を起こす＝次の呼び出しで返る・MapLibre も未着は null）。待てる口は sampleTerrain・既定の DTM は getHeight */
	queryTerrainElevation(lon: number, lat: number): number | null;
	/** 以後の取得に効く transformRequest（MapLibre 同名）。null で外す */
	setTransformRequest(fn: TransformRequestFunction | null): OrthoJapanMap;
	/** 独自スキーム（"myscheme://…"）の取得を関数に任せる（大域・export の addProtocol と同じ） */
	addProtocol(scheme: string, loader: ProtocolLoader): void;
	removeProtocol(scheme: string): void;
	/** 同じ手入れ（transformRequest・addProtocol）で取る fetch（部品・アプリ用） */
	fetchResource(url: string, type?: ResourceType, init?: RequestInit): Promise<Response | { ok: boolean; status: number; json(): Promise<any>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; blob(): Promise<Blob> }>;
	readonly Marker: typeof Marker;
	readonly Popup: typeof Popup;
	/** 基図の style を生き替える（opts.style で起動した地図だけ・地域の基図で起動した地図では投げる）。解決＝新しい style の基図が描き始めた後 */
	/** 基図の style を生き替える（外来 style で起動した地図だけ）。1.16.0〜 options.diff（既定 true）＝畳める差（基図の層の paint/filter/順・style 由来の geojson 層や source の差）は建て直さず当てる。
	 *  畳めない差（基図の vector source・sprite・glyphs・terrain・画像の raster 層・vector の描く層が変わる）と diff:false は従来の建て直し。transformStyle＝当てる前に書き換える（MapLibre 同名） */
	setStyle(style: string | Record<string, unknown>, options?: { diff?: boolean; transformStyle?: (previous: Record<string, unknown> | undefined, next: Record<string, unknown>) => Record<string, unknown> | undefined }): Promise<OrthoJapanMap>;
	/** 描画結果への問い合わせ（MapLibre の queryRenderedFeatures 相当）。geometry＝省略（画面全体）｜[x,y]（CSS px）｜[[x0,y0],[x1,y1]]（箱）。
	 *  返り値は上に描かれたものから：canvas2D の線/模様（addLayer の層 id・1.3.0〜）→記号・集約→四隅の画像（layer.id "img:<n>"）→押し出し（addLayer の層 id・ガジェット直呼びは "extrude"）→addLayer の fill/line/circle（層ごとに 1 件・層 id・source＝source id）→利用者の図形（"user"）→基図（スタイルの層 id・属性つき）。
	 *  押し出しは MapLibre と同じく立体で当てる（屋根と壁・床は当てない＝傾けて屋根を押せば当たる・空を指しても高い屋根には当たる）。押し出しどうしは近い順（1.3.0〜・旧＝地面の足跡）。
	 *  layers に基図の層が無ければ基図のタイルは取り直さない（層ごとのイベントが軽い）。
	 *  MapLibre と違い**非同期**（描いている基図タイルを取り直して今のスタイルで当てる・キャッシュ命中で ~1ms）。箱は外接箱の重なりで判定 */
	queryRenderedFeatures(geometry?: [number, number] | [[number, number], [number, number]] | QueryOptions, opts?: QueryOptions): Promise<RenderedFeature[]>;
	/** source の地物（MapLibre 同名・同期・1.5.0〜）。集約（cluster）の source＝今の段の丸と単点で画面の内側（余白 1/4）に居る物（properties に cluster/cluster_id/point_count）／
	 *  geojson の source（data が object）＝全部の地物（MapLibre は読んだタイルの分＝こちらは上位互換）／vector の source（C7）＝出しているタイル（addLayer の層が取った写し）の sourceLayer の地物を全部（sourceLayer 必須・タイルをまたぐ地物は枚数ぶん・写しの予算 24MiB を超えた分は出ない） */
	querySourceFeatures(sourceId: string, opts?: { filter?: StyleExpression; sourceLayer?: string }): RenderedFeature[];
	/** MapLibre の custom 層（addLayer({ type:"custom", onAdd, render, renderingMode })・1.5.0〜）の onAdd/render に渡す map（既定＝この map・MapLibre の口が自分を差す）。
	 *  custom 層は main の透明な WebGL2 canvas（注記の下）に描く＝地図と深度を共有しない（模型は建物・地形に隠れない）。行列（args.defaultProjectionData.mainMatrix）は
	 *  中心で局所線形化したメルカトル→クリップ（Float64Array）＝狭い範囲（模型・3D Tiles）は画素の内で合う・大陸大の図形は球との差の分だけ違う。globe の variant は無い */
	setCustomLayerHost(host: object | null): OrthoJapanMap;
	/** custom 層の canvas（層が 1 つでも足された後・無ければ null） */
	getCustomLayerCanvas(): HTMLCanvasElement | null;
	/** worker 経路の custom 層（addLayer({ type:"custom", url })）のオーバーレイの手綱（post＝層の onMessage へ・onmessage・remove）。main の canvas の経路（url 無し）や無い id は null */
	getCustomLayerHandle(id: string): OverlayHandle | null;

	// ---- 台本の上映・撮影（scene エディタ・公開サムネの土台）----
	/** 台本オブジェクトを直に上映（要 demo ガジェット・既に上映中なら false）。台本の形＝demo/scene-format.md。言語は台本の ja:/en:… を画面の言語で選ぶ */
	playScenes(scenes: object, opts?: { from?: number; quick?: boolean; lang?: string; onScene?: (i: number) => void; onEnd?: () => void }): boolean | void;
	/** 上映を止める（準備中でも安全） */
	stopScenes(): void;
	/** 台本のタイムライン（再生せずに任意の秒の絵を出す＝エディタ用）。読めなければ null */
	sceneTimeline(scenes: object): { dur: number; rows: unknown[]; at(t: number): unknown; seek(t: number): unknown; end(): void } | null;
	/** 今の画面の生スナップショット（W×H・render＝基図＋知性層＋注記の画素）。合成は shot ガジェット／gadgets/compose.js */
	/** 後処理（bloom・vignette）。本体の絵（基図・地形・建物・gint）に掛かる。注記と同一フレームのオーバーレイは別 canvas＝掛からない。null で外す。 */
	setPostProcess(p: PostProcessOptions | PostPass[] | null): this;
	/** 後処理の鎖（F3・2026-10-12）＝順番つきの pass。描くのは bloom・vignette・fxaa・tonemap・lut（W1・掛ける順は固定＝fxaa → bloom → tonemap → lut → vignette）。smaa/dof/ssr は保つだけ。知らない type は投げる（plugin は registry.postEffects に足す）。null＝全部外す */
	setPostChain(chain: PostPass[] | PostPass | PostProcessOptions | null): this;
	/** 保っている鎖（正規化済み・順番どおり） */
	getPostChain(): PostPass[];
	/** 正規化済みの後処理の設定（off なら null）。fxaa／tonemap／lut の鍵は on の時だけ生える（W1） */
	getPostProcess(): { bloom: { threshold: number; strength: number; radius: number } | null; vignette: { strength: number; radius: number; softness: number } | null; fxaa?: true; tonemap?: { mode: "linear" | "reinhard" | "aces" | "agx" | "filmic"; exposure: number }; lut?: { url: string; size: 16 | 32 | 64; intensity: number } } | null;
	// ---- plugin 契約・registry・capabilities（第 2 波 PR-F0・2026-10-12）----
	/** plugin を搭載（同期）。同名は投げる。install が投げたら、その install 中の registry への登録は巻き戻す。opts.plugins で起動時にも */
	use<O>(plugin: OrthoPlugin<O> | Readonly<OrthoPlugin<O>>, opts?: O): this;
	/** 撤去（uninstall か install の返した関数を呼び、その plugin の registry の登録を外す）。無ければ false */
	unuse(name: string | OrthoPlugin): boolean;
	/** 搭載中の plugin */
	plugins(): { name: string; version: string | null; provides: string[] }[];
	readonly registry: MapRegistry;
	/** 鍵の能力が**今この地図で絵になる**か（"builtin" か "plugin" の時だけ true。"spec"・"no"・"never" は false） */
	supports(key: CapabilityKey): boolean;
	/** 鍵ごとの正直な答え（台帳 §9「拡張点の台帳」の実行時の写し）。render.webgpu は実際のバックエンド・data.*／gadget.*／tiles.* は registry の今 */
	capabilities(): Record<CapabilityKey, Capability>;
	requestSnapshot(): Promise<{ W: number; H: number; render: { base: ArrayBuffer | null; w: number; h: number; labels: ArrayBuffer | null; lw: number; lh: number; flip: boolean; overlays: SnapshotOverlay[]; overlaysAbove: SnapshotOverlay[] } }>;

	// ---- gint 多層（addGint＝追加・層ごとのハンドル・両バックエンド）----
	/** gint 層を**追加**する（置換ではない＝applyGintData の単一スロットとは別系統）。pbf は geopbf(…, { gint: true }) 済み（unPackGint 必須・無ければ null）。
	 *  追加した層が既定でアクティブ（hover/click の対象）・interactive:false で既定層へ返す。重ね順は order（小さいほど下・未指定＝追加順） */
	addGint(pbf: GeoPBF, opts?: GintLayerOptions): GintLayerHandle | null;
	/** 列チャンク層（1.4.0〜・#90）＝GeoPBF／GeoParquet を **gint を通さず** 描く（位相・Morton・VW を作らない＝最初の 1 枚が「読み＋詰め替え」だけ）。
	 *  src＝GeoParquet の URL（footer → 視野の row group だけ Range）／File・GeoPBF の File／ArrayBuffer／geopbf() の戻り。本体は動的 import＝使わない頁には 0 バイト。
	 *  失うもの＝共有境界は 2 回描く・重なった面は後勝ち・LOD は 2〜3 段・地形には沿わない（楕円体の上）。編集や位相が要る時は gint（addGint）へ */
	addColumnar(src: string | File | Blob | ArrayBuffer | GeoPBF, opts?: ColumnarLayerOptions): Promise<ColumnarLayerHandle | null>;   // null＝opts.probe が断った。⚠ zoomScale:"maplibre" でも paint の ["zoom"] はエンジン z（換算は未対応）
	/** 層をまたぐ照会（手前の層から）＝いま見えている層だけ（setVisible・ズーム域）× 各層の filter。地球儀が自分で足す層（国の輪郭など）は含まない・interactive:false の層は含む。
	 *  fid は層内の添字＝**必ず {layer, fid} の対で扱う**。layer:null＝単一スロットの層（applyGintData） */
	queryAll(lngLat: LonLat): Array<{ layer: GintLayerHandle | null; fid: number; feature: { fid: number; properties: Record<string, any> | null } }>;
	/** v1 の単一スロット層を丸ごと撤去（applyGintData(null, …) と同じ・派生アプリのスロット調停用） */
	clearUserGint(): void;
	/** 表示中の v1 ユーザー層（ドロップ/?g=）の GeoPBF（無ければ null）＝編集への受け渡し口 */
	userPbf(): GeoPBF | null;

	// ---- gint（現行v1の派生アプリ口＝単一スロット。薄い1モジュールに封じること）----
	/** ユーザー知性層の搭載（単一スロット＝呼ぶたび置換・null＝スロットを空に）。複数データは fid 空間で合成（各 .geojson.features に一意キーを足して 1 本に再エンコード）。pbf は gint ベイク済みであること */
	applyGintData(pbf: GeoPBF | null, label: string, moveCamera?: boolean, opts?: GintApplyOptions): GeoPBF | null;
	/**
	 * クリック識別（fid・properties・経緯度）。lnglat＝ホバー pick が当たった**カーソル位置**の球面座標であって
	 * フィーチャの座標ではない（点をクリックしても同じ。座標が要るなら properties に持たせる）。クリックはホバーの識別結果に依存する。
	 * 識別（GPU pick）は**海面基準**＝チルトで地形に乗った線とは視差があり当たりにくい（代替＝setEditClick＋makeProjectorH の最近傍、または pbf.identifyAt）。
	 * **非ヒット（海など）では呼ばれない**＝選択解除は mapEl の click ＋ unprojectXY ＋ pbf.contain(ll)===null で組む
	 */
	onGintClick(fn: (fid: number, props: Record<string, unknown>, lnglat: LonLat) => void): void;
	/** fid整列のproperties配列（式評価・表直書きの入力。.geojsonは詰めズレするので使わない） */
	gintFeatures(): Array<{ properties: Record<string, any>; geometry: { type: string } | null }> | null;   // geometry は type のみ（座標なし・1.0.5〜。以前は null）
	/**
	 * Mapbox 風 paint 式で fid スタイル表を組む（null=解除）。評価は呼び出し時に一度だけ（zoom 追随は再呼び）。
	 * 式の演算子サブセット：get has ! all any == != > >= < <= in match step case let var interpolate coalesce
	 * to-number to-string concat zoom geometry-type feature-state + - * / % ^ min max literal。色は #hex / rgb() / rgba()
	 * （CSS の色名・hsl も可）。filter＝真偽式（偽の feature は非表示）。
	 * 例：{ "fill-color": ["step", ["get", "pop"], "#eff3ff", 1, "#bdd7e7", 4, "#3182bd"], "fill-opacity": 0.85,
	 *      "line-width": ["case", ["==", ["get", "id"], 13], 3.5, 0.9] }
	 */
	paint(paint: GintPaint | null, filter?: unknown[]): Promise<void>;
	/**
	 * fid→スタイル表の直書き。u32レコード=4要素/fid:
	 * [0]=fill RGBA8(r<<24|g<<16|b<<8|a) [1]=line/circle色 [2]=(width*8)<<24|dash<<16|(radius*4)<<8|flags [3]=線：破線 (線px*8)<<16|(間px*8)／点：縁の色 RGBA8（1.3.0〜・0＝なし）。
	 * flags bit0=visible（フィーチャ単位の表示/非表示）・bit1=点の塗り無し（中空の円・1.3.0〜）。点では width の欄が縁の幅
	 * Point は [1]（circle 色・α=0 で既定色）と radius（1/4 CSS px・0=描かない）を使う。線は width（1/8px・0=描かない）。[3]＝予備（0）。
	 * count＝レコード数（fid 数＝gintFeatures().length）。applyGintData() 直後に同期で呼べる（onReady を待つ必要はない）
	 */
	paintTable(u32: Uint32Array, count: number): void;
	/** 地形沿い線化（liftM=null で解除） */
	standupGint(liftM: number | null): Promise<void> | void;
}

/** 地球儀のホスト＝地域の申告なしで起動（世界データだけ・日本固有ゼロ）。region を渡せば地域を足せる。await 必須。
 *  SDK の orthoJapan は「globe＋日本の申告」の薄い包み（LAYERS.md・2026-09-23） */
export function createGlobe(opts?: OrthoJapanOptions): Promise<OrthoJapanMap>;
/** 旗 zoomScale:"maplibre" の地図（外側の顔）から素の map（エンジンの z）へ戻る鍵（1.3.0〜）。値は Symbol.for("ortho-earth.map.raw")＝import しなくても同じ鍵。
 *  旗なしの地図では未定義＝部品は `map[RAW] ?? map` で読む */
export const RAW: unique symbol;
/** globe の名前（中身は OrthoJapanMap / OrthoJapanOptions と同じ） */
export type GlobeMap = OrthoJapanMap;
export type GlobeOptions = OrthoJapanOptions;
/** DOM の Marker（MapLibre と同名・1.2.0〜・#38）。描くたびに地形の高さへ投影し直す・球の裏では隠す。map.Marker でも同じ */
/** 独自スキームの取得を関数に任せる（MapLibre の addProtocol と同じ形・大域）。基図タイル・画像タイル・3D Tiles・style・sprite に効く */
export function addProtocol(scheme: string, loader: ProtocolLoader): void;
export function removeProtocol(scheme: string): void;
export interface MarkerOptions { element?: HTMLElement; color?: string; scale?: number; anchor?: "center" | "top" | "bottom" | "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right"; offset?: [number, number]; draggable?: boolean; altitude?: number }
export class Marker {
	constructor(opts?: MarkerOptions | HTMLElement);
	setLngLat(ll: LonLat | { lng: number; lat: number }): this; getLngLat(): { lng: number; lat: number } | null;
	addTo(map: OrthoJapanMap): this; remove(): this; getElement(): HTMLElement;
	setOffset(o: [number, number]): this; setAltitude(m: number): this; setDraggable(on: boolean): this; isDraggable(): boolean;
	setPopup(p: Popup | null): this; getPopup(): Popup | null; togglePopup(): this;
	on(type: "dragstart" | "drag" | "dragend", cb: (e: { type: string; target: Marker }) => void): this; off(type: string, cb: Function): this; once(type: string, cb: Function): this;
}
/** DOM の吹き出し（MapLibre と同名・#38）。setHTML は呼び手の HTML をそのまま入れる＝外来の文字列は setText */
export interface PopupOptions { closeButton?: boolean; closeOnClick?: boolean; anchor?: "top" | "bottom" | "left" | "right"; offset?: number | [number, number]; maxWidth?: string; className?: string }
export class Popup {
	constructor(opts?: PopupOptions);
	setLngLat(ll: LonLat | { lng: number; lat: number }): this; getLngLat(): { lng: number; lat: number } | null;
	setHTML(html: string): this; setText(s: string): this; setDOMContent(node: Node): this; setMaxWidth(w: string): this;
	addTo(map: OrthoJapanMap): this; remove(): this; isOpen(): boolean; getElement(): HTMLElement;
	/** カーソルに付いて回る（MapLibre 同名・C8）＝pointer-events none・mapEl の pointermove で lngLat を置き直す（球の外＝隠す） */
	trackPointer(): this;
	on(type: "open" | "close", cb: (e: { type: string; target: Popup }) => void): this; off(type: string, cb: Function): this; once(type: string, cb: Function): this;
}
/** 検索の候補（#175）。着地＝zoom ＞ bbox（範囲に寄る）＞ 供給元の viewFor(title) ＞ z12 */
export interface SearchHit {
	title: string;
	/** 添え書き（都市＝州と国・州＝国・地形＝分類）。照合にも着地にも使わない表示専用 */ note?: string;
	lon: number; lat: number;
	/** 範囲 [west, south, east, north]（west>east＝±180 を跨ぐ）＝その範囲に寄る（国・州） */ bbox?: [number, number, number, number];
	/** 着地の倍率・チルト（度） */ zoom?: number; tilt?: number;
	/** 種別（世界＝"country"｜"state"｜"city"｜地形の分類・外の geocoder＝place_type の頭） */ kind?: string;
	/** 外から突き合わせる鍵（世界＝Wikidata の QID・外の geocoder＝feature.id） */ id?: string;
}
/** 検索の問い合わせ先（地域の宣言 region.search と同じ形）。今の形（{ title, note, lon, lat } と viewFor）は無改修で動く */
export interface SearchProvider {
	/** 検索履歴の localStorage の鍵（最初に鍵を持つ問い合わせ先の物を使う・既定 "ortho.searches"） */ histKey?: string;
	query(q: string, signal: AbortSignal): Promise<SearchHit[]>;
	/** 候補に zoom も bbox も無い時の着地（題名から） */ viewFor?(title: string): { zoom: number; tilt?: number };
}
/** Carmen GeoJSON の地物（maplibre-gl-geocoder の返り）。text＝名前・place_name＝住所まで・center＝[lon, lat] */
export interface CarmenFeature {
	id?: string | number; type?: "Feature"; text?: string; place_name?: string; place_type?: string[];
	center?: [number, number]; bbox?: [number, number, number, number];
	geometry?: { type: string; coordinates: any }; properties?: Record<string, any>;
}
/** 外の geocoder（maplibre-gl-geocoder の geocoderApi と同じ形）。forwardGeocode か getSuggestions＋searchByPlaceId のどちらか */
export interface GeocoderApi {
	forwardGeocode?(config: GeocoderConfig, abortController?: AbortController): Promise<{ features: CarmenFeature[] }>;
	/** 今の版では呼ばない（右クリックの「ここはどこ」は別 Issue） */ reverseGeocode?(config: GeocoderConfig & { query: [number, number] | string }): Promise<{ features: CarmenFeature[] }>;
	getSuggestions?(config: GeocoderConfig): Promise<{ suggestions: Array<{ text: string; placeId: string; place_name?: string }> }>;
	searchByPlaceId?(config: GeocoderConfig): Promise<{ place: CarmenFeature }>;
}
export interface GeocoderConfig { query: string; limit: number; language: string; countries?: string; bbox?: [number, number, number, number]; types?: string; proximity?: { longitude: number; latitude: number } | [number, number] }
/** 検索窓のオプション（map.gadget.search）。geocoderApi 以下の名前と意味は maplibre-gl-geocoder と同じ */
export interface SearchOptions {
	/** 問い合わせ先（1 つか配列・既定＝地域の宣言 region.search） */ provider?: SearchProvider | SearchProvider[];
	/** 世界の既定（国・州・都市・山川湖海・26 言語・サーバー無し）。true か { url（索引の置き場・末尾 /）, lang（名前の言語・既定＝UI の言語） }。既定 false */
	world?: boolean | { url?: string; lang?: string; limit?: number } | SearchProvider;
	/** 外の geocoder（既定では何も繋がない） */ geocoderApi?: GeocoderApi;
	/** 手元の地物を先に出す（query → Carmen 地物） */ localGeocoder?: (query: string) => CarmenFeature[] | Promise<CarmenFeature[]>;
	/** geocoderApi を呼ばない（localGeocoder だけ） */ localGeocoderOnly?: boolean;
	/** geocoder に渡す（公式と同じ） */ limit?: number; language?: string; countries?: string; bbox?: [number, number, number, number]; types?: string; proximity?: { longitude: number; latitude: number }; minLength?: number;
	/** geocoder の候補を選り分ける */ filter?: (feature: CarmenFeature) => boolean;
	/** 範囲の無い点の着地（geocoder の候補・既定 16）。配列はガジェットの表示域の宣言（[zmin, zmax)） */ zoom?: number | [number, number];
	/** 範囲に寄る時の上限（既定 12） */ maxZoom?: number;
	/** 入力欄の案内（既定＝「地名・住所を検索」・world だけ＝「地名を検索」） */ placeholder?: string;
	/** 履歴の鍵（既定＝最初に鍵を持つ問い合わせ先の物） */ histKey?: string;
	/** 候補を選んだ（公式の "result" 事象の中身） */ onResult?: (hit: SearchHit) => void;
	/** 飛び方の差し替え（既定＝map.flyTo） */ onGo?: (lon: number, lat: number, zoom: number, tilt?: number) => void;
	/** 範囲 → 着地（既定＝map.cameraForBounds） */ fit?: (bbox: [number, number, number, number]) => { lon: number; lat: number; zoom: number } | null;
	narrow?: boolean;
}
/** COPC の点群のオプション（map.addCOPC） */
export interface COPCOptions {
	/** 手綱の id（既定＝自動） */ id?: string;
	/** 点の色（既定 "auto"＝RGB があれば rgb・無ければ elevation） */ color?: "auto" | "rgb" | "classification" | "intensity" | "elevation";
	/** 点の半径（CSS px・既定 2）／attenuation＝距離で縮む（既定 true＝節の点の間隔 × 焦点距離 / 距離・1〜size×4 px）・false＝画素固定 */ pointSize?: number; attenuation?: boolean;
	/** 細かさ（節の点の間隔の画面 px がこれより粗ければ子へ・既定 2・LOW_MEM 3） */ density?: number;
	/** 地形・建物の裏で隠れる（シーンの深度・既定 true） */ depth?: boolean;
	/** 高さの足し込み（m） */ heightOffset?: number;
	/** 段彩の範囲（m・既定＝ファイルの z の範囲）・強度の範囲（既定 0〜65535） */ elevationRange?: [number, number]; intensityRange?: [number, number];
	opacity?: number;
	/** 読んだら範囲へ寄る（既定 true） */ fit?: boolean;
	/** 出典（HTML・消毒して地図の出典の欄に出す）。省略＝他所の URL ならホスト名 */ attribution?: string;
	/** 水平の座標系（"EPSG:6676" か WKT）＝ファイルの WKT・GeoTIFF キーより先。座標系の書かれていないファイルに要る */ crs?: string;
	/** 鉛直（ファイルに書かれていない時だけ効く）＝"orthometric"（標高）か "ellipsoidal"（楕円体高）。既定＝投影座標系なら標高 */ vertical?: "orthometric" | "ellipsoidal";
}
export interface COPCHandle {
	id: string;
	/** count＝点の総数・hasRgb・bbox・center・crs（座標系の名）・crsFrom（どこから決めたか）・vertical（"ellipsoidal" か鉛直の CRS の名）・spacing（根の点の間隔）・
	 *  copc（COPC か）・inMemory（丸ごと読み）・load（丸ごと読みの ms＝read・decode・build） */
	info: { count: number; format: number; hasRgb: boolean; bbox: Bbox; center: LonLat; zRange: [number, number]; crs: string; crsFrom?: "opts" | "wkt" | "geokeys"; vertical: string; spacing: number; size: number;
		version?: string; copc?: boolean; inMemory?: boolean; nodeCount?: number; load?: { read: number; decode: number; build: number } };
	readonly stats: { nodes: number; shown: number; points: number; shownPoints: number; failed: number; requests: number; inflight: number; budget: number };
	readonly bbox: Bbox;
	setOptions(o: Partial<COPCOptions>): COPCHandle;
	setVisible(v: boolean): COPCHandle;
	remove(): boolean;
}
/** 検査表示のオプション（map.gadget.inspect・名前と既定値は maplibre-gl-inspect と同じ） */
export interface InspectOptions {
	/** 起動時から検査表示（既定 false） */ showInspectMap?: boolean;
	/** 左上の道具の列にボタンを出す（既定 true） */ showInspectButton?: boolean;
	/** 検査表示で札を出す（既定 true）／ホバーで（既定 true・false＝クリックで） */ showInspectMapPopup?: boolean; showInspectMapPopupOnHover?: boolean;
	/** 通常の地図でも札を出す（既定 false＝公式と同じ）／ホバーで（既定 true） */ showMapPopup?: boolean; showMapPopupOnHover?: boolean;
	/** クリックで札を止める／動かす（ホバーの札の時・既定 false） */ blockHoverPopupOnClick?: boolean;
	/** 札を引く箱の半幅（px・既定 5） */ selectThreshold?: number;
	/** 検査表示の陸の色（既定 "#fff"） */ backgroundColor?: string;
	/** 層の色（層名・不透明度 → CSS 色）。既定＝層名を種にした明るい色（water＝青・road＝橙・building＝暗い灰…） */ assignLayerColor?: (layerId: string, alpha: number) => string;
	/** 札の中身（HTML の文字列か要素）。既定＝層名と $id・$type・属性の表（値は文字として入れる） */ renderPopup?: (features: RenderedFeature[]) => string | HTMLElement;
	/** 札の問い合わせの条件（queryRenderedFeatures の opts・検査中の既定＝検査の層だけ） */ queryParameters?: QueryOptions;
	/** 一覧に無い層を足す（{ source: [source-layer…] }） */ sources?: Record<string, string[]>;
	/** 札の器（既定＝new Popup({ closeButton:false, closeOnClick:false })） */ popup?: Popup;
	/** 切り替えの知らせ（true＝検査表示になった） */ toggleCallback?: (showInspectMap: boolean) => void;
}
/** 検査表示の層の台帳の 1 行（InspectHandle.sources）。from＝一覧の出所（tilejson｜pmtiles｜tiles＝タイルを解いて集めた｜null＝geojson） */
export interface InspectSource { id: string; type: "vector" | "geojson"; layers: Array<{ id: string; fields: Record<string, string>; minzoom?: number; maxzoom?: number; description?: string }> | null; from: "tilejson" | "pmtiles" | "tiles" | null }
export interface InspectHandle {
	open(): Promise<unknown>; close(): Promise<unknown>; toggle(): Promise<unknown>;
	/** maplibre-gl-inspect と同名（toggle と同じ） */ toggleInspector(): Promise<unknown>;
	/** 台帳を読み直して検査の層を足す（source を足した後など） */ render(): Promise<unknown>;
	isOpen(): boolean;
	/** 検査の層の id（下から） */ layers(): string[];
	/** 直近の層の台帳 */ sources(): InspectSource[];
	destroy(): void;
}
/** 2 枚の地図を左右（上下）スワイプで比べる（MapLibre 公式 maplibre-gl-compare と同じ形・#173）。before＝つまみの左（上）・after＝右（下）を見せる。
 *  2 枚の容れ物は同じ場所に重ねて置く（利用者の CSS）。カメラは連動する（どちらを動かしても追う）。container＝つまみを置く要素（セレクタ可）。
 *  1 頁に生きている地図は 2 枚まで。createGlobe の地図でも MapLibre 互換の Map（@ortho-earth/globe/maplibre）でもよい */
export class Compare {
	constructor(before: OrthoJapanMap | { getContainer(): HTMLElement }, after: OrthoJapanMap | { getContainer(): HTMLElement }, container: string | HTMLElement, options?: { orientation?: "vertical" | "horizontal"; mousemove?: boolean });
	/** つまみの位置（容れ物の左端／上端から px） */
	readonly currentPosition: number;
	setSlider(x: number): void;
	on(type: "slideend", fn: (e: { currentPosition: number }) => void): this;
	off(type: "slideend", fn: (e: { currentPosition: number }) => void): this;
	/** つまみを外し、切り抜きと連動を解く（地図は残る） */
	remove(): void;
}

// ---- geopbf（SDK 同梱・1.0.3〜 named export）----
export interface GeoJSONFeature { type: "Feature"; properties: Record<string, any>; geometry: { type: string; coordinates: unknown } | null;[k: string]: unknown }
export interface GeoJSONFeatureCollection { type: "FeatureCollection"; features: GeoJSONFeature[];[k: string]: unknown }
export type GeopbfInput = File | Blob | ArrayBuffer | string | GeoJSONFeatureCollection | GeoJSONFeature | object;
export interface GeopbfOptions {
	/** データ名（キャッシュ鍵・ファイル名の元） */
	name?: string;
	/** false＝gint（GPU 可読トポロジ）を焼かない。既定は焼く */
	gint?: boolean;
	/** 座標の小数桁（既定 6） */
	precision?: number;
	[k: string]: unknown;
}
/** GeoPBF＝geopbf() が返す。主要面のみ型付け（全面は https://www.npmjs.com/package/geopbf） */
export interface GeoPBF {
	readonly features: GeoJSONFeature[];
	readonly geojson: GeoJSONFeatureCollection;
	/** フィーチャ数 */
	readonly length: number;
	/** feature i のジオメトリ型（"Point"…"MultiPolygon"）。引数なし＝全件の配列 */
	getType(i: number): string;
	getType(): string[];
	/** GeoPBF バイナリ（保存・再読込用） */
	readonly arrayBuffer: ArrayBuffer;
	/** gint を焼く。geopbf() は既定で焼き済み＝再呼びは no-op（害なし） */
	gint(opts?: { gint?: boolean; clean?: boolean | object }): Promise<GeoPBF>;
	/** 描画レス識別：点→線→面の優先・面は smallest-wins。許容半径 m（既定 point 50 / polyline 30）。該当なし＝null */
	identifyAt(lng: number, lat: number, opts?: { point?: number; polyline?: number }): number | null;
	/** 点を含む面の fid（smallest-wins）。該当なし＝null */
	contain(lnglat: LonLat): number | null;
	/** 全体 bbox [w,s,e,n] */
	readonly bbox: Bbox;
	/** フィーチャ別 bbox の配列 */
	readonly bboxes: Bbox[];
	/** getBbox(i)＝feature i の bbox。引数なし＝全フィーチャの bbox 配列（全体は .bbox） */
	getBbox(i: number): Bbox;
	getBbox(): Bbox[];
	/** 書き出し（File 名＝opts.name 由来＝"myapp/data" のような階層名はダウンロード名にスラッシュが入る）。忠実度：geopbf/geojson＝完全、
	 *  kmz＝件数維持・属性は全て文字列化、gpx＝点と線のみ（面は落ちる）・属性は name/desc/type と各点の ele/time 配列、
	 *  czml＝静的パケットは等価（幾何にした部分以外は czml 属性に温存）・時刻付きの線は sampled position */
	geopbfFile(opts?: object): Promise<File>;
	geojsonFile(opts?: object): Promise<File>;
	topojsonFile(opts?: object): Promise<File>;
	fgbFile(opts?: object): Promise<File>;
	shapeFile(opts?: object): Promise<File>;
	kmzFile(opts?: object): Promise<File>;
	gmlFile(opts?: object): Promise<File>;
	gpxFile(opts?: object): Promise<File>;
	czmlFile(opts?: object): Promise<File>;
	[k: string]: unknown;
}
/**
 * SDK 同梱・初期化済みの geopbf ローダー。GeoJSON オブジェクト / File / URL / ArrayBuffer（geopbf/geojson/topojson/fgb/
 * shape(zip)/kmz/gpx/gml/moj(zip)/gz）→ GeoPBF。createGeopbf は不要（export していない）。opts を文字列で渡すと name 扱い
 */
export function geopbf(data: GeopbfInput, opts?: GeopbfOptions | string): Promise<GeoPBF>;

/** map.overlay(...) の手綱（同一フレームのオーバーレイ） */
export interface OverlayHandle {
	name: string;
	el: HTMLCanvasElement;
	onmessage: ((data: unknown) => void) | null;
	post(data: unknown, transfer?: Transferable[]): void;
	remove(): void;
	/** このオーバーレイだけに当てる（統一 picking） */
	pick(x: number, y: number, radius?: number): Promise<any[]>;
	/** W9：このオーバーレイが描く層の id を名乗る＝module の pick の答えに layer: id を入れると、map.on(ev, id)・queryRenderedFeatures({ layers: [id] })・pickOverlays({ names: [id] }) がその id で当たる。
	 *  一つの canvas（render worker の WebGL 文脈・Chrome で 4 つまで＝地球が 1 つ使う）に多くの層を載せる口 */
	addLayerId(id: string): OverlayHandle;
	removeLayerId(id: string): OverlayHandle;
}

/** map.pickOverlays の 1 件（module の pick の答え＝name はオーバーレイ・layer は addLayerId で名乗った層の id） */
export interface OverlayPick { name: string; layer?: string; id?: number | string | null; distance?: number; lngLat?: LonLat | null; properties?: Record<string, any>; [k: string]: unknown }
/** map.addData の opts＝kind と deck.gl 風の accessor（d => 値 か定数）。点・弧・軌跡の共通＝getFilterValue＋filterRange・brush／brushRadius・mask・points の transition */
export interface DataLayerOptions {
	kind?: "points" | "arcs" | "trips" | "polygons" | "paths" | "columns" | (string & {});
	id?: string; before?: string; above?: boolean; paint?: Record<string, StyleExpression>;
	[accessor: string]: unknown;
}
/** map.addData の手綱。points／arcs／trips＝同一フレームの overlay（setFilter／brush／setMask・trips は setCurrentTime／setTrail／animate／useClock）・polygons／paths／columns＝GeoJSON の層（pick は queryRenderedFeatures） */
export interface DataLayerHandle {
	readonly id: string; readonly kind: string; ready: Promise<unknown>; n?: number; timeRange?: [number, number]; overlay?: OverlayHandle;
	setData(data: unknown): Promise<unknown>; setProps(accessors: Record<string, unknown>): Promise<unknown>; setVisible(on: boolean): DataLayerHandle;
	pick(x: number, y: number, radius?: number): Promise<any[]>; remove(): void;
	setFilter?(range: [number, number] | null): DataLayerHandle; setBrush?(x: number | null, y?: number, r?: number): DataLayerHandle; brush?(on?: boolean, r?: number): DataLayerHandle; setMask?(polygon: unknown, opts?: Record<string, unknown>): Promise<DataLayerHandle>;
	setCurrentTime?(t: number): DataLayerHandle; setTrail?(len: number, fade?: boolean): DataLayerHandle; animate?(opts?: false | { on?: boolean; from?: number; to?: number; speed?: number; loop?: boolean }): DataLayerHandle; useClock?(on?: boolean): DataLayerHandle;
}
/** addH3／addCells の opts（src＝点の並び・GeoJSON・セル id の並び）。weight＝集約の値（列名か d => 数）・paint＝fill の paint（式は ["get","count"|"sum"|…]）・extrude＝fill-extrusion の高さ（paint の式）・outline＝縁の line の paint（null で無し） */
export interface CellsLayerOptions { id?: string; res?: number | "auto"; weight?: string | ((d: any) => number) | null; paint?: Record<string, StyleExpression> | null; extrude?: Record<string, StyleExpression> | StyleExpression | null; outline?: Record<string, StyleExpression> | null; props?: Record<string, unknown> | null; before?: string; minzoom?: number; maxzoom?: number }
export interface CellsLayerHandle { readonly id: string; readonly cells: unknown; readonly geojson: GeoJSONFeatureCollection; readonly res: number; setData(src: unknown): Promise<CellsLayerHandle>; setPaint(paint: Record<string, StyleExpression>): CellsLayerHandle; setRes(res: number | "auto"): Promise<CellsLayerHandle>; remove(): void }
export interface ContourLayerOptions { id?: string; cellSize?: number; thresholds?: number[] | null; bands?: number[] | null; weight?: string | ((d: any) => number) | null; agg?: "count" | "sum" | "mean" | "min" | "max"; smooth?: number; paint?: Record<string, StyleExpression> | null; linePaint?: Record<string, StyleExpression> | null; props?: Record<string, unknown> | null; before?: string; bbox?: Bbox | null }
export interface ContourLayerHandle { readonly id: string; readonly field: unknown; readonly geojson: GeoJSONFeatureCollection; setData(src: unknown): Promise<ContourLayerHandle>; setThresholds(thresholds?: number[] | null, bands?: number[] | null): Promise<ContourLayerHandle>; remove(): void }
export interface ScreenGridOptions { id?: string; cellPx?: number; colorRange?: Array<[number, number, number, number?]> | string[]; weight?: string | ((d: any) => number) | null; agg?: "count" | "sum" | "mean" | "min" | "max"; opacity?: number; gap?: number; above?: boolean }
export interface ScreenGridHandle { readonly id: string; n?: number; setData(points: unknown): ScreenGridHandle; setStyle(style: Record<string, unknown>): ScreenGridHandle; pick(x: number, y: number, radius?: number): Promise<any[]>; remove(): void }
