// ortho-japan SDK 型定義（公開面のみ・手書きの正典）。実装＝apps/ortho-japan/app.js。
// AIエージェント/エディタ補完のための共有語彙＝散文（README/llms.txt）とセットで配布する。
// gint系（applyGintData等）は現行v1の単一スロット口＝将来 map.addGint()（v2）で置換予定。
// 消費側は必ず薄いモジュール1枚に封じること（gint draw spec §10.2）。

export type LonLat = [lon: number, lat: number];
export type Bbox = [w: number, s: number, e: number, n: number];

export interface OrthoJapanOptions {
	/** 埋め込み先（セレクタ or 要素）。idは"map"へ正規化される＝サイズ指定は#idセレクタ禁止 */
	target?: string | HTMLElement;
	/** 初期視点 "#zoom/lat/lon/45t/30r/l=…/c=…"（t=チルト°・r=回転°） */
	view?: string;
	/** 配色の焼き付け（"mono"|"dark"|"gsi"|"sepia" または台帳と同形のカスタム） */
	theme?: string | object;
	/** 表示項目の固定。true=常時表示・false=封印・未記述=チップで利用者が選ぶ */
	layers?: Partial<Record<"place" | "terrain" | "rail" | "road" | "facility", boolean>>;
	/** 右上チップ帯の表示（既定true） */
	chips?: boolean;
	/** 下部計器盤。true=全部／配列=選択（"attr"を消すならページ側で出典明記の義務） */
	instruments?: boolean | Array<"pos" | "scale" | "attr" | "log">;
	/** 建物3D（PLATEAU）機能スイッチ。false=関連通信・workerごと停止（既定true） */
	plateau?: boolean;
	/** UI言語（地図中の地名は対象外） */
	lang?: "ja" | "en";
	/** チルト上限（**ラジアン**）。0=俯瞰固定。共有URLのt=も同上限でクランプ（既定 75°） */
	maxPitch?: number;
	/** 実行時アセット（plateau-sets.json等）の配信ベースURL */
	assetBase?: string;
}

/** 右クリックメニュー項目（map.gadget.contextmenu({items})） */
export interface ContextMenuItem {
	name: string;
	onClick(c: { lng?: number; lat?: number; x: number; y: number; map: OrthoJapanMap }): void;
}

export interface Gadgets {
	search(opts?: object): unknown;
	zoom(): unknown;
	compass(): unknown;
	full(): unknown;              // 全画面（ショートカット=Z単キー）
	shot(): unknown;              // 画面保存
	measure(): unknown;
	contextmenu(opts?: { items?: ContextMenuItem[] }): unknown;
	legend(): unknown;
	palette(): unknown;
	hint(): unknown;
	qr(): unknown;
	print(): unknown;
	cpos(): unknown;
	tip(opts?: object): unknown;
	pop(opts?: object): unknown;
	/** 自作ガジェットの登録（this===map で呼ばれる） */
	(name: string, fn: (this: OrthoJapanMap, ...args: unknown[]) => unknown): void;
	[name: string]: unknown;
}

/** gintユーザー層の搭載オプション（現行v1・単一スロット） */
export interface GintApplyOptions {
	style?: object;
	/** この層を出す最小ズーム（既定7＝それ未満は世界海岸線と交替） */
	minZoom?: number;
	interactive?: boolean;
	hover?: boolean;
	drape?: boolean;
	drapeFill?: boolean;
	tip?: unknown;
	fillMaxEdges?: number;
}

export interface OrthoJapanMap {
	// ---- 基本 ----
	flyTo(lon: number, lat: number, zoom: number, tiltDeg?: number, bearingDeg?: number): void;
	getZoom(): number;
	readonly view: { center: LonLat; zoom: number; pitch: number; bearing: number; hash: string;[k: string]: unknown };
	destroy(): void;
	readonly mapEl: HTMLElement;
	readonly gadget: Gadgets;

	// ---- 座標変換・フレーム ----
	/** 経緯度→画面CSS座標。front<0=裏半球 */
	projectLL(lon: number, lat: number): [x: number, y: number, front: number];
	/** canvasローカルCSS座標→経緯度（球外はnull。onClick/setEditClickのx,yと同座標系） */
	unprojectXY(x: number, y: number): LonLat | null;
	/** カメラ状態を1回束ねた投影関数（多点を1フレームで投影する時用） */
	makeProjector(): (lon: number, lat: number) => [x: number, y: number, front: number];
	/** 描画フレーム毎フック。戻り値=解除関数 */
	onFrame(fn: () => void): () => void;
	/** 次フレームの描画を1回点火（オーバレイ更新後に） */
	requestDraw(): void;
	/** クリック横取りスロット（編集アプリ用）。null=解除。クリックvsドラッグ弁別はエンジン側が済ませる */
	setEditClick(fn: ((x: number, y: number) => void) | null): void;
	getHeight(lon: number, lat: number): Promise<number>;
	fitZoomForBbox(bbox: Bbox): number;

	// ---- gint（現行v1の派生アプリ口＝将来v2 addGint()で置換。薄い1モジュールに封じること）----
	/** ユーザー知性層の搭載（単一スロット＝呼ぶたび置換）。pbfは gint ベイク済みであること */
	applyGintData(pbf: unknown, label: string, moveCamera?: boolean, opts?: GintApplyOptions): unknown;
	/** クリック識別（fid・properties・経緯度） */
	onGintClick(fn: (fid: number, props: Record<string, unknown>, lnglat: LonLat) => void): void;
	/** fid整列のproperties配列（式評価・表直書きの入力。.geojsonは詰めズレするので使わない） */
	gintFeatures(): Array<{ properties: Record<string, unknown> }> | null;
	/** Mapbox風paint式（null=解除） */
	paint(expr: object | null): void;
	/**
	 * fid→スタイル表の直書き。u32レコード=4要素/fid:
	 * [0]=fill RGBA8(r<<24|g<<16|b<<8|a) [1]=line/circle色 [2]=(width*8)<<24|dash<<16|(radius*4)<<8|flags [3]=0。
	 * flags bit0=visible（フィーチャ単位の表示/非表示）
	 */
	paintTable(u32: Uint32Array, count: number): void;
	/** 地形沿い線化（liftM=null で解除） */
	standupGint(liftM: number | null): Promise<void> | void;
	/** e-Stat/geopbfオーバーレイの手綱 */
	readonly overlay: Record<string, unknown>;
}

/** 1行で地球儀が立ち上がる入口。await 必須 */
export default function orthoJapan(opts?: OrthoJapanOptions): Promise<OrthoJapanMap>;
