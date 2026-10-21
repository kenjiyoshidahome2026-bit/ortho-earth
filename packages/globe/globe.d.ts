// @ortho-earth/globe の型定義（公開面のみ・手書きの正典）。実装＝packages/globe/src/globe.ts（createGlobe が返す map）。
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
export interface GltfMeta { animations: GltfAnimationInfo[]; skins: number; morphTargets: boolean; extensionsUsed: string[]; extensionsRequired: string[]; textureFormats: string[]; featureIds: boolean; structuralMetadata: boolean; /** asset.copyright（W8・空でない時だけ） */ copyright?: string }
export interface GltfAnimationInfo { index: number; name: string; duration: number; channels: number; paths: string[] }
/** 再生の spec（W4 から rigid アニメ＝ノードの translation/rotation/scale は描く・skin/morph は spec のまま）。name か index（省略＝最初）・time（秒）・loop（既定 true）・speed（既定 1）・playing */
export interface AnimationSpec { name?: string; index?: number; time?: number; loop?: boolean; speed?: number; playing?: boolean }
export interface AnimationState extends Required<Omit<AnimationSpec, "name" | "index">> { name: string | null; index: number | null; duration: number }
/** 模型の置き方（at＝錨の経緯度・heading＝北から時計回りの度・scale＝倍率・altitude＝地面からの高さ m）。CESIUM_RTC・ECEF 入りの模型は外接矩形の中心を錨に見立て heading 0・scale 1 から数える */
export interface ModelTransform { at: LonLat; heading: number; scale: number; altitude: number }
export interface ModelHandle {
	/** ドロップのトーストの文言（"$1 triangles"・模型が無ければ "?"） */
	toastLength(): string;
	/** 置き場（map.model の opts.slot・既定 "default"）。同じ slot に次を置くとこの模型は外れ、手綱は死ぶ（stats/bbox/name が null） */
	readonly slot: string;
	/** 置き方を変える（頂点は焼き直さない＝束の剛体変換で動かす・地形への接地は動かした先で引く）。渡した欄だけ変わる。戻り＝自分（連鎖） */
	setTransform(tf: Partial<ModelTransform>): ModelHandle;
	getTransform(): ModelTransform;
	setLngLat(ll: LonLat | { lng?: number; lon?: number; lat: number }): ModelHandle;
	getLngLat(): LonLat;
	/** 北から時計回りの度 */
	setHeading(deg: number): ModelHandle;
	getHeading(): number;
	/** 倍率（焼いた時の scale とは独立の「今の倍率」＝load の scale から数える） */
	setScale(k: number): ModelHandle;
	getScale(): number;
	/** 地面からの高さ（m） */
	setAltitude(m: number): ModelHandle;
	getAltitude(): number;
	/** 置き方が変わるたび（setTransform・ギズモのドラッグ）。戻り値で解除 */
	onTransform(f: (tf: ModelTransform, model: ModelHandle) => void): () => void;
	/** 置き方の取っ手（錨の丸＝移動・輪の丸＝回転・四角＝倍率）を出す／畳む（DOM・mapEl の上）。✓ で畳む。gizmo:"auto" で置いた模型はクリックで出し直せる */
	gizmo(on?: boolean): ModelHandle;
	readonly gizmoOn: boolean;
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
export interface MeshPick { featureId: number | null; properties: Record<string, any>; table: { index: number; name: string | null; class: string | null } | null; distance: number; lngLat: [number, number]; state: Record<string, unknown>; batch?: number; tile?: number;
	/** 3D Tiles 1.1 の metadata（3D Tiles の pick だけ）：当たったタイル・その content・content の group（schema で読んだ値・無ければ null） */
	tileMetadata?: Tiles3DMetadataEntity | null; contentMetadata?: Tiles3DMetadataEntity | null; groupMetadata?: Tiles3DMetadataEntity | null }
/** 3D Tiles 1.1 の metadata の実体＝class と値（class の default を補い・normalized・offset／scale を当てた物） */
export interface Tiles3DMetadataEntity { class: string | null; properties: Record<string, any> }
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
export interface HandlerImpl { create(map: GlobeMap, opts: Record<string, unknown>): { start?(): void; stop?(): void; readonly active?: boolean } }
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
export interface CloudsImpl { apply(map: GlobeMap, clouds: Required<CloudsSpec> | null): void }
/** registry.lights に足す光源の type＝setLights のたびに、その type の光源の配列（無ければ []）で apply を呼ぶ（plugin が自前の overlay／three で描く約束） */
export interface LightTypeImpl { apply(map: GlobeMap, lights: LightSpec[]): void }
export interface SkySpecification { "sky-color"?: string | unknown[]; "horizon-color"?: string | unknown[]; "fog-color"?: string | unknown[]; "fog-ground-blend"?: number | unknown[]; "horizon-fog-blend"?: number | unknown[]; "sky-horizon-blend"?: number | unknown[]; "atmosphere-blend"?: number | unknown[] }
/** MapLibre の CameraOptions と同じ意味（角は度）。padding＝中身の中心を寄せる（真俯瞰として解く近似） */
/** 手触りの handler の名前（A2・1.16.0〜） */
export type HandlerName = "scrollZoom" | "dragPan" | "dragRotate" | "keyboard" | "doubleClickZoom" | "boxZoom" | "touchZoomRotate" | "touchRotate" | "touchPitch" | "cooperativeGestures";
/** エンジンの生の視点（map.cam・書き換え可能＝公開の写しは map.view）。@ortho-earth/core の CameraPose と同じ形（globe.d.ts は自己完結＝core の .ts を読ませない・TS 化 段 4）。
 *  角は rad・zoom はエンジンの z（256px 世界） */
export interface CameraPose {
	center: LonLat;
	/** エンジンの z（256px 世界）。 */
	zoom: number;
	/** チルト［rad］。0＝真上。 */
	pitch?: number;
	/** 方位［rad］。0＝北が上。 */
	bearing?: number;
	/** 視線まわりの回転［rad］（MapLibre の roll・正＝絵が時計回り・無指定＝0）。 */
	roll?: number;
	/** 縦の視野角［rad］。既定 50°。 */
	fovy?: number;
	dpr?: number;
	/** 注視点の高さ［m］（MapLibre の centerClampedToGround 相当・無指定＝0）。 */
	centerAlt?: number;
	/** 注視点を画面の中心からずらす量［CSS px・右・下が正］＝MapLibre の centerOffset（padding の中身の中心）。消失点も動く。無指定＝[0,0]。 */
	offset?: [number, number];
}
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
	/** UI言語（地図中の地名は対象外）。live 切替 API は無い＝変えるなら view: map.view.hash を持って destroy()→再生成 */
	lang?: OrthoJapanLang;
	/** チルト上限（**度**＝MapLibre と同じ。2.0 で 1.6 以下の値をラジアンと読む 1.x の読み替えを外した）。0=俯瞰固定。共有URLのt=も同上限でクランプ（既定 75°） */
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
	 *  名前は map の言語（26 言語）。データと規則は Equal Earth と共有（Natural Earth 10m・World DB）。既定 false
	 *  { groups }＝読む群を限る（"base"＝州境・道路・都市など／"lakes"＝湖／"detail"＝寄った時の詳細・既定＝全部） */
	worldContent?: boolean | { groups?: Array<"base" | "lakes" | "detail"> | null };
	/** 世界帯（低ズーム）の河川・海洋境界線（Natural Earth 10m・z1.5 から）。false＝読まない／["rivers" | "maritime"]＝その種類だけ（既定 true＝全部）。
	 *  自前の川を描く頁が二重に描かない・読まない口（1.7.x〜） */
	worldLines?: boolean | Array<"rivers" | "maritime">;
	/** 世界帯（低ズーム）の湖（Natural Earth lakes）と海面下の陸（below_sea_land）の塗り。false＝読まない・描かない（既定 true）。
	 *  3D Tiles だけを描く頁や自前の基図を持つ頁が、見えない世界の塗りを取りに行かないための口（2.0.2〜） */
	worldFill?: boolean;
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

/** map.on("mesh")（1.2.0〜）の合図。catalog＝一覧取得（count=収録自治体数）／start＝区の読込開始／done＝完了（描画済み）／cancelled＝視野離脱で中止／failed＝読めない */
export type MeshEvent =
	| { phase: "catalog"; count: number }
	| { phase: "start" | "done" | "cancelled" | "failed"; name: string; base: string };

/** 右クリックメニュー項目（map.gadget.contextmenu({items})） */
export interface ContextMenuItem {
	name: string;
	/** 任意の HTML（アイコン） */
	icon?: string;
	onClick(c: { lng?: number; lat?: number; x: number; y: number; map: GlobeMap }): void;
}
/** 右クリックメニューの項目の並び：配列か、指した地点ごとに組む関数（(地点, 既定の項目) → 配列）。null＝既定の項目へ戻す（setter に渡す時） */
export type ContextMenuItems = ContextMenuItem[] | ((c: { lng?: number; lat?: number; x: number; y: number; map: GlobeMap }, dflt: ContextMenuItem[]) => ContextMenuItem[]) | null;

/** measure/profile の手綱（ガジェットは UI ボタン＝クリックで頂点・ダブルクリック確定・Esc 中断。プログラムからは start/stop） */
export interface PathGadget { (): void; start(): void; stop(): void; open(): void; close(): void; stats(): Record<string, number> }
/** 計測・断面図の入口の手綱（本体は初回に読む）＝no-op の関数＋open（本体を読んで開始・本体の手綱で解ける・読めなければ undefined）／close（本体が在れば畳む・無ければ null）。
 *  二重搭載は素の no-op（open／close 無し） */
export interface PathGadgetStub { (): void; open?(): Promise<PathGadget | undefined>; close?(): Promise<unknown> | null }
/** anno ガジェットの手綱（gadgets/anno.js の createAnno の戻り） */
export interface AnnoHandle { set(pbf: GeoPBF | null): void; clear(): void; /** 描いた画素の検査窓（worker に問う） */ pixels(): Promise<unknown>; readonly pbf: GeoPBF | null; readonly count: number; readonly hits: unknown[] }
/** cog ガジェットの load のオプション＝fit／fetch 以外は geopbf/cog の openCog へそのまま（stretch・composite・colormap・cacheKey…＝見せ方はデータ側が決める） */
export interface CogOptions { fit?: boolean; fetch?: typeof fetch | null; [k: string]: unknown }
export interface CogHandle {
	load(src: string | File | Blob, opts?: CogOptions): Promise<unknown>; clear(): void; metrics(): Record<string, unknown> | null;
	/** 読めた COG の全解像度の寸法（px）。読む前・clear の後は null */
	readonly width: number | null; readonly height: number | null;
}
/** demo ガジェットの opts（台本の形＝demo/scene-format.md） */
export interface DemoOptions { scenes?: object[]; slide?: boolean; hold?: number; slideHold?: number; mobile?: number; lang?: string; preload?: string[]; btn?: HTMLElement | null; player?: boolean; zoom?: [number, number]; narrow?: boolean; /** 台本（と設定）を返す関数＝▶だけ先に出し、本体と台本は押した時に読む */ lazy?: () => Promise<DemoOptions> }
export interface DemoHandle { start(i?: number, fly?: boolean, opts?: { scenes?: object[]; bare?: boolean; onScene?: (i: number, scene: object) => void; onEnd?: (reason: "finished" | "stopped") => void; [k: string]: unknown }): unknown; next(): void; prev(): void; exit(): void; play(): void; pause(): void }
/** equal／equalHere／equalStart の opts。url＝Equal Earth の置き場・load＝部品の読み込み口（div 方式＝同じ頁に組む・省略＝iframe） */
export interface EqualOptions { url?: string; load?: (...args: any[]) => unknown }
/** map.gadget.<名前> の名前 → 呼び方（引数と戻り）。登録は registerGadget(name, (map, ...args) => handle)（map は第 1 引数・this は使わない）。
 *  plugin が足す gadget はこの interface を拡張して型を付ける（declare module "@ortho-earth/globe" { interface Gadgets { … } }） */
export interface Gadgets {
	/** 地名検索の窓（#175）。問い合わせ先＝地域の宣言（日本＝地理院）→ world → localGeocoder → geocoderApi の順に候補を積む。
	 *  問い合わせ先が 1 つも無い（地域の宣言も world も geocoderApi も無い）＝窓を出さない（undefined）。二重搭載も undefined */
	search(opts?: SearchOptions): HTMLElement | undefined;
	zoom(): unknown;
	compass(): unknown;           // 3D（チルト中）のみ表示
	full(): unknown;              // 全画面（ショートカット=Z単キー）
	/** 画面保存（webp・出典焼き込み）。open()＝即保存、composite()＝Blob を返す（引数省略＝今の画面）。
	 *  戻り値は最初の呼び出しで受け取って保持する（二重搭載・モバイル(coarse pointer)では undefined） */
	shot(): { open(): Promise<unknown>; composite(snap?: unknown): Promise<Blob | undefined>; close(): void } | undefined;   // composite の undefined＝本体を読めなかった
	/** 距離・面積の計測。入口だけが常駐し本体は初回に読む＝戻りは入口の手綱（open() が本体の手綱 PathGadget で解ける） */
	measure(): PathGadgetStub;
	/** 断面図（経路指定→標高プロファイルのグラフ。本体の stats()={points,total,sampled,min,max}）。戻りは measure と同じ入口の手綱 */
	profile(): PathGadgetStub;
	/** 右クリックメニュー。既定で「この地点へ寄る／座標をコピー」の 2 項目を持ち、items は**置換**（関数形＝クリック位置ごとに組める）。戻り値＝項目差し替え関数（再搭載時は {setItems}） */
	contextmenu(opts?: { items?: ContextMenuItems }): ((items: ContextMenuItems) => void) | { setItems(items: ContextMenuItems): void };
	/** 左下の凡例パネル（permanent＝×を出さない常設・width＝最大幅 px）。戻り値＝内容の setter（explain と同じ形）。二重搭載は何もしない setter */
	legend(opts?: { permanent?: boolean; width?: number }): (html: string | null | ((body: HTMLElement) => unknown)) => unknown;
	/** 配色テーマの入口（本体はアイドルに先読み）。open()＝本体を読んで開く・close()＝本体が在れば畳む（無ければ null）。opts.theme で焼き付けた地図・二重搭載は undefined */
	palette(): { open(): Promise<unknown>; close(): Promise<unknown> | null } | undefined;
	hint(): unknown;
	/** 地域の全体へ戻るボタン（1.2.0〜・着地点/顔/札は地域宣言 home・宣言が無い地域＝載らない）。J キー */
	home(opts?: { view?: number[]; icon?: string; label?: string; id?: string }): unknown;
	/** 共有 QR（今の視点の URL）。二重搭載は undefined */
	qr(): { open(): unknown; close(): unknown } | undefined;
	/** 印刷（平面図・本体は初回に読む）。モバイル・二重搭載は undefined */
	print(): { open(): unknown; close(): unknown } | undefined;
	cpos(): unknown;
	/** 建物3D データ管理（先読み/削除）。mesh:false では載らない（1.2.0〜・アイコンは地域の宣言＝日本は PLATEAU 公式ロゴ） */
	mesh(): unknown;
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
	model(src: File | string, opts?: { at?: [number, number]; heading?: number; scale?: number; name?: string; fit?: boolean; textures?: boolean; /** 当たりの写しを持つか（W7・既定 true） */ pickable?: boolean; /** EXT_mesh_features の何組目の番号で当てるか（W7・既定 0） */ featureIdSet?: number;
		/** 置き場（既定 "default"）＝同じ slot は置き換え・別の slot は並ぶ（複数の模型） */ slot?: string; /** 地面からの高さ（m） */ altitude?: number; /** 置き方の取っ手を出す（"auto"＝錨で置いた模型だけ＝ドロップの既定） */ gizmo?: boolean | "auto" }): Promise<ModelHandle>;
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
	/** ヒートマップ（MapLibre の heatmap 層相当・同一フレームのオーバーレイ＝WebGL2）。src＝点の GeoJSON/GeoPBF/File/URL か層を丸ごと（source つき）。
	 *  paint の意味と既定値は MapLibre どおり（radius 30・weight 1・intensity 1・opacity 1・color は ["heatmap-density"] 0..1 の既定の青→赤）。null で外す */
	heatmap(src: GeoJSONFeatureCollection | GeoJSONFeature[] | File | string | HeatmapLayer | null, layer?: Omit<HeatmapLayer, "type" | "source">): Promise<{ points: number } | null>;
	/** 点の集約（MapLibre の cluster 相当・canvas2D のオーバーレイ）。src＝点のデータか MapLibre の source（{ type:"geojson", data, cluster:true, clusterRadius, clusterMaxZoom }）。
	 *  集約の属性＝cluster / point_count / point_count_abbreviated。丸のクリック＝ばらけるズームへ寄る。queryRenderedFeatures の点の問い合わせに "clusters"/"unclustered-point" で出る */
	cluster(src: GeoJSONFeatureCollection | GeoJSONFeature[] | File | string | { type: "geojson"; data: GeoJSONFeatureCollection | string; cluster?: boolean; clusterRadius?: number; clusterMaxZoom?: number } | null, opts?: ClusterOptions): Promise<{ points: number; clusters: number[] } | null>;
	/** 日影のボタンとパネル（日影図／その時刻の影・測定面 1.5/4/6.5m／リアルタイムの影＝時刻スライダー・WebGPU のみ）＝map.sunShadow・map.setShadows の UI */
	sunshadow(opts?: { zoom?: [number, number]; narrow?: boolean }): (() => void) & { open?(): HTMLElement; close?(): void };
	/** オフラインパック（1.2.0〜・#40）：今の画面の範囲とズーム上限を決めて、基図タイル（Cache Storage "oj-pack"）・地形（IDB）・任意で建物と画像タイルを先に取る。
	 *  配るのは殻の Service Worker（japan の public/sw.js が "oj-pack" の URL を cache-first）＝SW の無い埋め込み先では先読みだけ（HTTP キャッシュ）。
	 *  戻り値＝{ open, close, estimate() → { tiles, bytes, free }, run(), list(), delete(id) }。載せない時（二重搭載・XYZ の基図が無い）は素の no-op の関数 */
	offline(opts?: { zoom?: [number, number]; narrow?: boolean; zmaxDefault?: 12 | 14 | 15 | 16 }): { open(): void; close(): void; estimate(): Promise<{ tiles: number; bytes: number; free: number | null } | null>; run(): Promise<void>; list(): Promise<Array<{ id: string; name: string; bbox: Bbox; zmax: number; bytes: number; ts: number; done: boolean }>>; delete(id: string): Promise<void> } | (() => void);
	viewshed(opts?: { zoom?: [number, number]; narrow?: boolean }): (() => void) & { open?(): HTMLElement; close?(): void };
	/** 時計の操作盤（1.2.0〜・#42）＝◀◀ ▶/❚❚ ▶▶・速さ・日時・今。時計が実時間でない時は起動時に開く。
	 *  時計に範囲がある時（map.clock.setRange・CZML／GPX を読んだ時など）は下の段に区間の時間バー（開始・つまみ・終了）を出す＝つまみで区間の中を行き来・日時の入力も区間に限る（1.8.0〜・#124） */
	clock(opts?: { zoom?: [number, number]; narrow?: boolean }): void;
	/** 任意の 3D Tiles（map.add3DTiles と同じ）。null＝全部（opts.id＝その 1 つ）を外す */
	tiles3d(url: string | null, opts?: Tiles3DOptions): Promise<Tiles3DHandle | null>;
	/** 記号の層（MapLibre の symbol 層：icon-image/-size/-rotate/-anchor/-offset/-allow-overlap/-color（SDF）・text-field/-size/-anchor/-offset/-color/-halo・symbol-sort-key・symbol-z-order・icon-halo-*・format の image/vertical-align・symbol-height-offset/-anchor）。null＋{id} で外す */
	symbols(src: GeoJSONFeatureCollection | GeoJSONFeature[] | File | string | ({ type: "symbol" } & Omit<MapLibreLayer, "type">) | null, layer?: Partial<MapLibreLayer>): Promise<{ features: number } | null>;
	/** ホバー tip 箱。戻り値＝setter（rows＝行の配列・改行つきの文字列・HTML の文字列（setSafeHTML で入れる）・null／undefined で消す）。orthoJapan() が自動搭載済み＝呼ぶと同じ setter が返る */
	tip(opts?: object): (rows: string | string[] | null | undefined) => void;
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
	/** ミニ地球儀（右下・視野の枠）＝z ≤ maxZoom（既定 8）で出る（全球が画面に収まる時は隠す）。size＝px（既定 125）・land／sea／line＝色（CSS）。追従は render のフック。二重搭載は undefined */
	globe(opts?: { size?: number; maxZoom?: number; land?: string; sea?: string; line?: string }): unknown;
	/** 計測器 HUD（メモリ・タイル・GPU・階層の状態表＝右下）。URL の ?hud=1|0 で起動した地図にだけ登録される（本体は遅延 chunk・起動時に自動で搭載＝1 は開いて・0 は畳んで）。それ以外の地図では undefined */
	hud?(opts?: { open?: boolean }): void;
	/** UI 言語の切替（34px 規格・透明な select・26 言語）。onChange(code)＝既定の「?lang= を書いて読み直す」を差し替える口。二重搭載は undefined */
	lang(opts?: { onChange?: (code: OrthoJapanLang) => unknown }): HTMLButtonElement | undefined;
	/** 輪郭＝「この形の線だけ」（ホバーの合図）。src は spotlight と同じ（GeoJSON か ISO 3166-1 の 2／3 字）・null で消す。マスク（spotlight）とは別スロット＝両立する。color＝[r,g,b,a]（0..1）・width＝px。形が引けなければ null */
	outline(src: string | GeoJSONFeatureCollection | GeoJSONFeature | { type: string; coordinates: unknown } | null, opts?: { color?: [number, number, number, number] | null; width?: number }): Promise<{ clear(): void } | null>;
	/** POI 台帳の手差分編集（作者用・§12）。URL の ?poiedit=1 の時だけ本体を読んで登録し自動で搭載する（一般のビルドには載らない）＝それ以外の地図では undefined。戻り値＝{ close } */
	poiedit?(opts?: Record<string, unknown>): { close(): void } | undefined;
	/** 画像タイル（ラスタ）の切替パネル＝地域パックのカタログ（基図 1 枚＋重ね n 枚）と map.raster（select／toggle）。表示域は zoom で。二重搭載は undefined */
	raster(opts?: { zoom?: [number, number]; narrow?: boolean }): unknown;
	/** 太陽系（ortho-solar）への口＝34px 規格のアイコン。url＝行き先（既定 /solar/・dev は :5199）・共通の時計が実時間でなければその時刻を hash に添える。二重搭載は undefined */
	solar(opts?: { url?: string; zoom?: [number, number]; narrow?: boolean }): unknown;
	/** 衛星シーン検索（STAC＝Earth Search／Tellus→選んだシーンの COG を球へ＝cog ガジェット）。ボタンだけ常駐・本体は初回クリックで遅延 chunk。戻り値＝no-op */
	stac(opts?: { zoom?: [number, number]; narrow?: boolean }): () => void;
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
	| { url: string; tileSize?: number; minZoom?: number; maxZoom?: number; bbox?: Bbox | null; attribution?: string | null; subdomains?: string[] | string; tms?: boolean; headers?: Record<string, string>; name?: string;
		/** 色調整（1.2.0〜・#39・MapLibre の raster-hue-rotate / -saturation / -contrast / -brightness-min / -max と同じ意味）。addLayer の raster 層は paint から自動で作る */
		adjust?: { hueRotate?: number; saturation?: number; contrast?: number; brightnessMin?: number; brightnessMax?: number } | null }
	| { pmtiles: string; name?: string; attribution?: string }
	/** WMS（1.2.0〜・#45）＝GetMap を画面のタイルに割る（EPSG:3857）。url に {bbox-epsg-3857} を直に書いた XYZ 形でも可（MapLibre と同じ記法） */
	| { wms: { url: string; layers: string; styles?: string; format?: string; transparent?: boolean; version?: "1.3.0" | "1.1.1"; params?: Record<string, string> }; minZoom?: number; maxZoom?: number; bbox?: Bbox; attribution?: string; name?: string }
	/** WMTS（#45）＝capabilities（GetCapabilities の URL）を読むか、KVP を手で（url・layer・tileMatrixSet）。ウェブメルカトルの行列だけ描ける。REST の型紙は url に {TileMatrix}/{TileRow}/{TileCol} を書いて XYZ 形で渡してもよい */
	| { wmts: { capabilities: string; layer?: string; style?: string; format?: string } | { url: string; layer: string; tileMatrixSet: string; style?: string; format?: string; matrixIds?: string[] }; minZoom?: number; maxZoom?: number; attribution?: string; name?: string }
	| { file: File; table?: string; name?: string; attribution?: string }
	| { port: MessagePort; name?: string; attribution?: string | null }
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
export interface RasterOptions { order?: "under" | "over"; opacity?: number; visible?: boolean; hideFills?: boolean; minZoom?: number; maxZoom?: number; /** カタログの id（select／toggle が付ける・selected() の答え） */ catalogId?: string; /** 標本化（MapLibre の raster-resampling・既定 linear・C4） */ resampling?: "linear" | "nearest"; /** 到着フェード ms（MapLibre の raster-fade-duration・既定 300・0＝無し） */ fadeDuration?: number }
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
/** WebGPU の GPUDevice / GPUTexture。lib.dom に WebGPU の型は無い＝@webgpu/types を入れた環境ではその型、無い環境では object で受ける（利用者の tsc を落とさない） */
export type OverlayGPUDevice = typeof globalThis extends { GPUDevice: { prototype: infer D } } ? D : object;
export type OverlayGPUTexture = typeof globalThis extends { GPUTexture: { prototype: infer T } } ? T : object;
export interface OverlayDepth {
	w: number; h: number;
	/** 深度の尺度＝2/log2(far+1)（GLSL の u_sceneLogCoef） */
	logCoef: number;
	backend: "webgl2" | "webgpu";
	/** FS に貼る GLSL（#version・precision の後）。sceneDepthAt(uv)・depthOfW(w)・sceneOcclusion(uv, w)（1＝本体の物の陰・0＝見える）。捨てる（discard）か薄めるかはオーバーレイの自由 */
	glsl: string;
	/** このフレームの深度をその gl のテクスチャとして返す（同じフレームで二度上げない・gl の束縛と unpack の状態は戻す） */
	texture(gl: WebGL2RenderingContext): WebGLTexture;
	/** このフレームの深度を GPUDevice で読めるテクスチャとして返す（rgba8unorm・行は下から）。本体と同じ device なら本体のテクスチャそのもの（コピーなし） */
	gpuTexture(device: OverlayGPUDevice): OverlayGPUTexture;
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
/** 標高の source を整えた後の spec（map.getTerrain の source）＝raster-dem は tiles を頁基準の絶対・encoding 既定 mapbox・tileSize 512・maxzoom 22（TileJSON の申告の encoding・bounds はそのまま）／
 *  quantized-mesh は url を頁基準の絶対にしただけ（ion・heights などもそのまま） */
export type TerrainSourceSpec = { type?: string; url?: string; tiles?: string[]; encoding?: string; tileSize?: number; minzoom?: number; maxzoom?: number; bounds?: number[] | null; dtm?: boolean; cellZoom?: number | null; redFactor?: number; greenFactor?: number; blueFactor?: number; baseShift?: number };
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
	/** false＝切らない（setClipping(false) と同じ） */
	on?: boolean;
	/** false＝蓋なし（地形の土の色の幕・板と建物の疑似の蓋）・色は { terrain: [r,g,b], building: [r,g,b] }（0..1） */
	cap?: false | { terrain?: [number, number, number]; building?: [number, number, number] };
	/** false＝縁の帯なし・{ width（CSS px・既定 2）, color（[r,g,b] 0..1・既定 橙） } */
	edge?: false | { width?: number; color?: [number, number, number] };
}
/** 3D Tiles の取得の前の手入れ（F5・2026-10-12）＝この tileset の全ての要求（tileset.json・外部 tileset＝type "Source"、タイルの本体＝"Tile"）に、地図の transformRequest の後で掛かる。
 *  戻り＝{ url?, headers?, credentials? }（null＝そのまま）。鍵・session の付与（Google Photorealistic 3D Tiles 等）や署名つき URL への差し替えは呼び手の closure で（鍵を repo に置かない） */
export type Tiles3DRequestTransform = (url: string, type: "Source" | "Tile") => { url?: string; headers?: Record<string, string>; credentials?: RequestCredentials } | null | undefined;
/** pickable（W7）＝当たりの写し（頂点・index）を main に持つか："auto"（既定）＝地物の番号（EXT_mesh_features／_BATCHID）を持つ束だけ・true＝全部・false＝持たない。
 *  低メモリ端末（≤4GB・iOS/iPadOS はタッチで一律）の "auto" は頂点・index の写しを持たない（2026-10-20）＝pick と queryRenderedFeatures は当たらないが feature state の色とスタイルは効く。要るなら true で明示。
 *  写しの量は stats.mainMB に出て、gpuMB との和が予算（低メモリ 160 MB・他 512 MB）に数えられる。featureIdSet＝何組目の番号で当てるか（既定 0） */
export interface Tiles3DOptions { id?: string; /** 画面上の誤差の上限（px・既定 16・低メモリ端末 24）。予算（gpuMB + mainMB）を越えると stats.sseScale 倍に引き上げられる */ maxSSE?: number;
	/** 同時に投げるタイル要求の上限（1〜32）。既定＝低メモリ端末（≤4GB・iOS/iPadOS はタッチで一律）3、他 6。複数の tileset で共通の枠で、指定の最大が効く */
	maxInflight?: number; heightOffset?: number; ground?: "absolute" | "terrain"; pointSize?: number; textures?: boolean; fit?: boolean; requestTransform?: Tiles3DRequestTransform; pickable?: boolean | "auto"; featureIdSet?: number;
	/** Gaussian splat のタイル（glTF の KHR_gaussian_splatting・2026-10-18）＝タイルごとに map.addData(…, { kind: "splat" }) の層にする時の opts（lod・shDegree・opacity・depthTest など・@ortho-earth/plugin-splat の SplatOptions）。
	 *  描き手＝plugin-splat（map.use(splatPlugin())）。無ければ仕様の fallback どおり点として描く（tileset ごとに一度 warn） */
	splat?: Record<string, unknown> | null;
	/** 出典（W8）＝文字列か、表示しているタイルの glTF asset.copyright の列（「;」で割り・多い順）→ 文字列 の関数。出典の欄（#attr）に出る（HTML は消毒される）。無ければ何も足さない */
	attribution?: string | ((copyrights: string[]) => string | null);
	/** スタイル（3D Tiles 1.1・地物ごとの color と show）。setStyle と同じ */
	style?: Tiles3DStyle | null }
/** 3D Tiles のスタイル。color・show＝MapLibre の式（["get", 名] は 地物の属性 ＞ content ＞ tile ＞ group ＞ tileset の metadata の順に引く・["id"]＝地物の番号・["feature-state", 名]）。
 *  color の結果＝CSS 色か [r,g,b,a]（0..1）・show の結果＝真偽（false で抜く）。feature state の color はスタイルの色より勝つ。点群（pnts）には効かない。
 *  Cesium の 3D Tiles Styling（"${height} > 50 ? color('red') : color('white')"・{ conditions: [[条件, 色], …] }・defines）もそのまま渡せる（MapLibre の式に訳す・訳せない式は例外） */
export interface Tiles3DStyle { color?: unknown; show?: unknown; defines?: Record<string, string> }
export interface Tiles3DHandle {
	id: string; readonly stats: { loaded: number; shown: number; failed: number; triangles: number; points: number; /** Gaussian splat の個数（KHR_gaussian_splatting・plugin-splat が描く物） */ splats: number; bytes: number; gpuMB: number; /** main のヒープに残る写し（当たりの頂点・index・元の頂点色・地物の番号）の MB。gpuMB との和が予算に数えられる */ mainMB: number; inflight: number; /** 予算を越えた時の maxSSE の倍率（1＝そのまま・最大 16）。gpuMB + mainMB が予算を越えると 1.25 倍ずつ上がって粗い段で止め、動いた時に 1 s に 1 段ずつ 0.9 倍で戻る（2026-10-21） */ sseScale: number; /** 読んで持っている subtree の数（implicit tiling・3D Tiles 1.1） */ subtrees: number }; readonly bbox: Bbox | null;
	/** root の tileset.json の見出し（F5）：asset（version・tilesetVersion・extras）・metadata（3D Tiles 1.1）・extras・拡張 */
	readonly asset: Record<string, unknown> | null; readonly metadata: Record<string, unknown> | null; readonly extras: Record<string, unknown> | null; readonly extensionsUsed: string[]; readonly extensionsRequired: string[];
	/** 3D Tiles 1.1 の metadata：schema（直書きか schemaUri を読んだ物）・tileset の metadata を schema で読んだ物・groups（content の group の実体） */
	readonly schema: Record<string, unknown> | null; readonly tilesetMetadata: Tiles3DMetadataEntity | null; readonly groups: Array<Tiles3DMetadataEntity | null>;
	remove(): void; setVisible(v: boolean): void; setOptions(o: Partial<Tiles3DOptions>): void;
	/** 画面の点（CSS px）の当たり（W7）＝ModelHandle.pick と同じ形（tile＝当たったタイルの id）。queryRenderedFeatures の層＝この tileset の id（type "3d-tiles"） */
	pick(x: number, y: number): MeshPick | null;
	/** 表示しているタイルの出典（glTF asset.copyright を「;」で割り・多い順・W8） */
	readonly copyrights: string[];
	/** feature state（tileset ごと・タイルを跨いで同じ番号＝同じ地物）。{ color } は描きに効く・後から読んだタイルにも効く */
	setFeatureState(featureId: number, state: Record<string, unknown> | null): Tiles3DHandle;
	getFeatureState(featureId: number): Record<string, unknown>;
	removeFeatureState(featureId?: number): Tiles3DHandle;
	/** スタイル（Tiles3DStyle）を差し替える。null で外す（元の色・全部見せる） */
	setStyle(style: Tiles3DStyle | null): Tiles3DHandle;
	readonly style: Tiles3DStyle | null;
}
export interface LayerMouseEvent { type: string; point: { x: number; y: number }; lngLat: { lng: number; lat: number } | null; features: RenderedFeature[]; originalEvent: PointerEvent | MouseEvent; target: GlobeMap }
/** 層の押し系のイベント（C8・MapLibre 同名）。preventDefault()＝mousedown/touchstart で呼ぶと地図のドラッグを捨てる（例 create-a-draggable-point）。touch＝points/lngLats（指の列・今は 1 本） */
export interface LayerPressEvent extends LayerMouseEvent { defaultPrevented: boolean; preventDefault(): void; points?: Array<{ x: number; y: number }>; lngLats?: Array<{ lng: number; lat: number } | null> }
/** properties の値は any（MapLibre・GeoJSON の型と同じ＝JS のまま書いても型検査で咎めない・1.1.1〜。以前は unknown） */
export interface RenderedFeature { type: "Feature"; id?: number | string | null; properties: Record<string, any>; geometry: { type: string; coordinates?: unknown; geometries?: Array<{ type: string; coordinates?: unknown }> } | null; layer: { id: string; type: string; "source-layer"?: string }; sourceLayer?: string; source: "basemap" | "user" | "extrude" | "image" | "cluster" | "symbols" | (string & {}); expansionZoom?: number }

// ---- plugin 契約・registry・capabilities（拡張点の整備・第 2 波 PR-F0・2026-10-12・src/plugin.js・台帳 maplibre-compat.md §9「拡張点の台帳」）----
/** 拡張の形は 1 つ：definePlugin({ name, install(map, opts), uninstall? })。install は**同期**（非同期の仕事は中で始める）・返した関数は撤去の時に呼ぶ（uninstall が無い時）。
 *  install が受ける map は**素の map**（zoomScale の旗つきでも外側の顔ではない＝地域パックと同じ・エンジンの z）。registry への登録は install 中にすると撤去で自動的に外れる */
export interface OrthoPlugin<O = Record<string, unknown>> {
	/** 一意の名前（英数・-・_・. ）。map.use は同名の二重搭載を投げる */
	name: string;
	version?: string | null;
	/** 担う能力の鍵（capabilities の鍵・申告だけ） */
	provides?: string[];
	install(map: GlobeMap, opts: O): void | (() => void);
	uninstall?(map: GlobeMap): void;
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
	/** builtin の名は null（実装は本体の中）・無い名は undefined */
	get(name: string): T | null | undefined;
	has(name: string): boolean;
	isBuiltin(name: string): boolean;
	/** 登録した plugin の名（builtin・直接の add は null） */
	ownerOf(name: string): string | null;
	names(): string[];
}
/** Gaussian splat（F8・予約された kind "splat" の契約）：map.addData(data, { kind: "splat" }) の data。描く段は plugin（registry.dataKinds "splat"）。URL（.ply/.splat/.spz）も受ける＝読み手は plugin */
export interface SplatData {
	/** 個数（省略なら positions.length / 3） */ n?: number;
	/** 位置＝crs "lnglat"（既定）なら [lng, lat, alt(m)] の並び、"ecef" なら地心直交 m、"local" なら transform で ECEF へ写す座標 m（n*3） */ positions: Float32Array;
	/** 楕円の各軸の尺（m・n*3） */ scales: Float32Array;
	/** 向き＝四元数 x,y,z,w（n*4） */ rotations: Float32Array;
	/** RGBA 0〜255（n*4） */ colors: Uint8Array;
	/** 球面調和の係数（任意・長さは n の倍数＝次数は plugin が決める） */ sh?: Float32Array;
	crs?: "lnglat" | "ecef" | "local";
	/** crs "local" に必須＝列優先 4×4（local m → ECEF m）。3D Tiles の glTF の splat（KHR_gaussian_splatting）＝タイル変換 × ノード変換 */ transform?: ArrayLike<number>;
}
/** map.addData の kind を足す実装＝create が手綱を返す（points/arcs/trips/polygons/paths/columns は builtin・"splat" は契約が予約済み＝data は検めた SplatData か URL） */
export interface DataKindImpl { create(map: GlobeMap, data: unknown, opts: Record<string, unknown> & { kind: string; id: string }): unknown }
/** タイル形式（core の registerTileFormat と同じ形・process-wide＝撤去できない） */
export interface TileFormatImpl { pmtilesType?: number | null; decode?: (bytes: Uint8Array, need: unknown) => unknown; load?: () => Promise<(bytes: Uint8Array, need: unknown) => unknown> }
export interface MapRegistry {
	/** map.addData の kind（結線済み） */
	readonly dataKinds: PluginRegistry<DataKindImpl>;
	/** gadget（add(name, (map, ...args) => handle)＝registerGadget と同じ登録口・map は第 1 引数（this は使わない）・結線済み・builtin の名は実行時の map.gadget の鍵）。
	 *  plugin の gadget の型は Gadgets を拡張して足す（declare module "@ortho-earth/globe" { interface Gadgets { … } }） */
	readonly gadgets: PluginRegistry<(map: GlobeMap, ...args: any[]) => unknown>;
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
export interface PostEffectImpl { apply(map: GlobeMap, passes: PostPass[]): void }
/** map.setPostProcess の引数。true＝既定値。bloom: threshold＝滲む輝度の下限（0〜1・既定 0.75）・strength＝足す量（既定 0.5）・radius＝ぼかし半径の倍率（既定 1）。vignette: strength＝四隅の暗さ（既定 0.5）・radius＝暗くなり始める距離（中心 0〜角 1・既定 0.8）・softness＝移り変わりの幅（既定 0.5）。 */
export interface PostProcessOptions {
	bloom?: true | { threshold?: number; strength?: number; radius?: number };
	vignette?: true | { strength?: number; radius?: number; softness?: number };
	/** W1（2026-10-12）：鎖でも旧形でも受ける。描く順は fxaa → bloom → tonemap → lut → vignette */
	fxaa?: true | { enabled?: boolean };
	tonemap?: true | { mode?: "linear" | "reinhard" | "aces" | "agx" | "filmic"; exposure?: number };
	lut?: { url: string; size?: 16 | 32 | 64; intensity?: number };
}

// 公開の map の型（OrthoJapanMap／GlobeMap）は installer ごとの型の合成＝正本は src/types/map.ts（TS 化 段 4・batch 1・2026-10-16）。
// ここは名前を通すだけ（OrthoJapanMap は 2.0 まで GlobeMap の別名）。各 *Api は installer（src/api/*.ts）が付ける口の束
import type { GlobeMap } from "./src/types/map.ts";
export type {
	GlobeMap, OrthoJapanMap, GlobeCoreApi, CameraApi, OverlaysApi, TerrainApi, RasterApi, GadgetsApi, ShadowsApi,
	DataApi, IntakeApi, ImagesApi, StyleApi, QueryApi, ToolsApi,
} from "./src/types/map.ts";

/** 地球儀のホスト＝地域の申告なしで起動（世界データだけ・日本固有ゼロ）。region を渡せば地域を足せる。await 必須。
 *  SDK の orthoJapan は「globe＋日本の申告」の薄い包み（LAYERS.md・2026-09-23） */
export function createGlobe(opts?: OrthoJapanOptions): Promise<GlobeMap>;
/** 旗 zoomScale:"maplibre" の地図（外側の顔）から素の map（エンジンの z）へ戻る鍵（1.3.0〜）。値は Symbol.for("ortho-earth.map.raw")＝import しなくても同じ鍵。
 *  旗なしの地図では未定義＝部品は `map[RAW] ?? map` で読む */
export const RAW: unique symbol;
export type GlobeOptions = OrthoJapanOptions;
/** DOM の Marker（MapLibre と同名・1.2.0〜・#38）。描くたびに地形の高さへ投影し直す・球の裏では隠す。map.Marker でも同じ */
/** 独自スキームの取得を関数に任せる（MapLibre の addProtocol と同じ形・大域）。基図タイル・画像タイル・3D Tiles・style・sprite に効く */
export function addProtocol(scheme: string, loader: ProtocolLoader): void;
export function removeProtocol(scheme: string): void;
export interface MarkerOptions { element?: HTMLElement; color?: string; scale?: number; anchor?: "center" | "top" | "bottom" | "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right"; offset?: [number, number]; draggable?: boolean; altitude?: number }
export class Marker {
	constructor(opts?: MarkerOptions | HTMLElement);
	setLngLat(ll: LonLat | { lng: number; lat: number }): this; getLngLat(): { lng: number; lat: number } | null;
	addTo(map: GlobeMap): this; remove(): this; getElement(): HTMLElement;
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
	addTo(map: GlobeMap): this; remove(): this; isOpen(): boolean; getElement(): HTMLElement;
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
/** COPC の点群のオプション（map.addPointCloud） */
export interface COPCOptions {
	/** 手綱の id（既定＝自動） */ id?: string;
	/** 点の色（既定 "auto"＝RGB があれば rgb・無ければ elevation） */ color?: "auto" | "rgb" | "classification" | "intensity" | "elevation";
	/** 点の半径（CSS px・既定 2）／attenuation＝距離で縮む（既定 true＝節の点の間隔 × 焦点距離 / 距離・1〜size×4 px）・false＝画素固定 */ pointSize?: number; attenuation?: boolean;
	/** 細かさ（節の点の間隔の画面 px がこれより粗ければ子へ・既定 2・LOW_MEM 3） */ density?: number;
	/** 地形・建物の裏で隠れる（シーンの深度・既定 true） */ depth?: boolean;
	/** 高さの足し込み（m・setOptions で読み直さずに効く）。地形に合わせるなら手綱の fitTerrain() */ heightOffset?: number;
	/** 段彩の範囲（m・既定＝ファイルの z の範囲）・強度の範囲（既定 0〜65535） */ elevationRange?: [number, number]; intensityRange?: [number, number];
	opacity?: number;
	/** 読んだら範囲へ寄る（既定 true） */ fit?: boolean;
	/** 出典（HTML・消毒して地図の出典の欄に出す）。省略＝他所の URL ならホスト名 */ attribution?: string;
	/** 水平の座標系（"EPSG:6676" か WKT）＝ファイルの WKT・GeoTIFF キーより先。座標系の書かれていないファイルに要る */ crs?: string;
	/** 鉛直（ファイルに書かれていない時だけ効く）＝"orthometric"（標高）か "ellipsoidal"（楕円体高）。既定＝投影座標系なら標高 */ vertical?: "orthometric" | "ellipsoidal";
	/** ZIP（.zip の中の LAS/LAZ）を取る間の進み具合（取った生のバイト・その項の生の総長） */ onProgress?: (loaded: number, total: number) => void;
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
	/** 地形に合わせる＝読んだ節の地面の点（分類 2）と描いている地形の差の中央値（m）を heightOffset に（apply:false＝測るだけ）。見本が無ければ offset は null */
	fitTerrain(opts?: { apply?: boolean }): Promise<{ offset: number | null; samples: number }>;
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
	constructor(before: GlobeMap | { getContainer(): HTMLElement }, after: GlobeMap | { getContainer(): HTMLElement }, container: string | HTMLElement, options?: { orientation?: "vertical" | "horizontal"; mousemove?: boolean });
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
/** GeoPBF の地物（geopbf の Feature の写し・実体どおり＝properties は null あり・GeometryCollection は coordinates の代わりに geometries） */
export interface GeoPBFFeature {
	type: "Feature"; id?: string | number; properties: Record<string, any> | null;
	geometry: { type: string; coordinates?: unknown; geometries?: Array<{ type: string; coordinates?: unknown }> } | null; bbox?: number[];
}
/** GeoPBF＝geopbf() が返す。主要面のみ型付け（全面は https://www.npmjs.com/package/geopbf）。geopbf の GeoPBF の宣言の写し＝geopbf の GeoPBF はそのままこの型に入る
 *  （TS 化 段 4・batch 2：bbox は geopbf の BBox＝4 数の組か数の配列・書き出しは File か Blob か null・地物の properties は null あり。
 *  ここに無いメンバーは geopbf の型で＝import type { GeoPBF } from "geopbf"） */
export interface GeoPBF {
	readonly features: GeoPBFFeature[];
	readonly geojson: { type: "FeatureCollection"; features: GeoPBFFeature[]; bbox?: number[] };
	/** フィーチャ数 */
	readonly length: number;
	/** feature i（fid）の地物／属性（addGint の層はこれで当たりの properties を引く） */
	getFeature(i: number): GeoPBFFeature;
	getProperties(i: number): Record<string, any> | null;
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
	readonly bbox: Bbox | number[];
	/** フィーチャ別 bbox の配列 */
	readonly bboxes: Array<Bbox | number[]>;
	/** getBbox(i)＝feature i の bbox。引数なし＝全フィーチャの bbox 配列（全体は .bbox） */
	getBbox(i: number): Bbox | number[];
	getBbox(): Array<Bbox | number[]>;
	/** 書き出し（File 名＝opts.name 由来＝"myapp/data" のような階層名はダウンロード名にスラッシュが入る）。忠実度：geopbf/geojson＝完全、
	 *  kmz＝件数維持・属性は全て文字列化、gpx＝点と線のみ（面は落ちる）・属性は name/desc/type と各点の ele/time 配列、
	 *  czml＝静的パケットは等価（幾何にした部分以外は czml 属性に温存）・時刻付きの線は sampled position */
	geopbfFile(opts?: object): Promise<File | Blob | null>;
	geojsonFile(opts?: object): Promise<File | Blob | null>;
	topojsonFile(opts?: object): Promise<File | Blob | null>;
	fgbFile(opts?: object): Promise<File | Blob | null>;
	shapeFile(opts?: object): Promise<File | Blob | null>;
	kmzFile(opts?: object): Promise<File | Blob | null>;
	gmlFile(opts?: object): Promise<File | Blob | null>;
	gpxFile(opts?: object): Promise<File | Blob | null>;
	czmlFile(opts?: object): Promise<File | Blob | null>;
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
export interface CellsLayerHandle { readonly id: string; readonly cells: unknown; readonly geojson: GeoJSONFeatureCollection; readonly res: number | { dLon: number; dLat: number; lon0: number; lat0: number }; setData(src: unknown): Promise<CellsLayerHandle>; setPaint(paint: Record<string, StyleExpression>): CellsLayerHandle; setRes(res: number | "auto"): Promise<CellsLayerHandle>; remove(): void }
export interface ContourLayerOptions { id?: string; cellSize?: number; thresholds?: number[] | null; bands?: Array<[number, number]> | null; weight?: string | ((d: any) => number) | null; agg?: "count" | "sum" | "mean" | "min" | "max"; smooth?: number; paint?: Record<string, StyleExpression> | null; linePaint?: Record<string, StyleExpression> | null; props?: Record<string, unknown> | null; before?: string; bbox?: Bbox | null }
export interface ContourLayerHandle { readonly id: string; readonly field: unknown; readonly geojson: GeoJSONFeatureCollection; setData(src: unknown): Promise<ContourLayerHandle>; setThresholds(thresholds?: number[] | null, bands?: Array<[number, number]> | null): Promise<ContourLayerHandle>; remove(): void }
export interface ScreenGridOptions { id?: string; cellPx?: number; colorRange?: Array<[number, number, number, number?]> | string[]; weight?: string | ((d: any) => number) | null; agg?: "count" | "sum" | "mean" | "min" | "max"; opacity?: number; gap?: number; above?: boolean }
export interface ScreenGridHandle { readonly id: string; n?: number; setData(points: unknown): ScreenGridHandle; setStyle(style: Record<string, unknown>): ScreenGridHandle; pick(x: number, y: number, radius?: number): Promise<any[]>; remove(): void }
