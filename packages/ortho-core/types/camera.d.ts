// @ortho-earth/core/camera — 球面カメラ（単位球ワールド・正射↔透視の連続・楕円体は β 単位球への厳密分解）。
// この地図は常に地球儀＝平面メルカトルの変換は無い。z の目盛りは 256px 世界（WORLD_PX）＝MapLibre の z＋1。

/** 経緯度（度）。[lon, lat] */
export type LonLat = [number, number];
/** β 単位球（楕円体 off では単位球）上の 3D 点 */
export type Vec3 = [number, number, number] | number[];

/** カメラの生の状態（`map.cam`）。角はラジアン。 */
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

/** cameraState の戻り＝1 フレームの行列と派生量。mvp/invMvp は列優先 f64。 */
export interface CameraState {
	mvp: Float64Array;
	invMvp: Float64Array | null;
	/** カメラ位置（β 空間）。 */
	eye: number[];
	W: number;
	H: number;
	dpr: number;
	/** 注視点からカメラまでの距離（単位球のラジアン≈弧長）。 */
	camDist: number;
	/** 焦点距離（device px）。 */
	focal: number;
	/** 透視行列だけ（clip.x の反転込み）。MapLibre custom 層の projectionMatrix 相当。 */
	projection: Float64Array;
}

/** z の目盛り＝256px 世界（赤道一周 = 2^z × 256 CSS px）。 */
export const WORLD_PX: 256;

export function cameraState(cam: CameraPose, W: number, H: number): CameraState;
/** 経緯度 → 画面座標 [x, y]（CSS px）。裏側・画面外は null。radius＝1＋標高/半径。 */
export function project(state: CameraState, lon: number, lat: number, radius?: number): [number, number] | null;
export function projectClip(state: CameraState, lon: number, lat: number, radius?: number): number[];
export function projectInto(state: CameraState, lon: number, lat: number, radius: number, out: number[]): number[] | null;
/** 画面座標 → 経緯度（球と視線の交点）。球を外せば null。 */
export function unproject(state: CameraState, sx: number, sy: number, R?: number): LonLat | null;
export function lonlatTo3D(lon: number, lat: number): number[];
export function distTo(lon: number, lat: number, p: Vec3): number;
export function ellNormal3D(lon: number, lat: number): number[];
export function worldToLonLat(p: Vec3): LonLat;
export function betaToLonLat(p: Vec3): LonLat;
/** 視線の基底（f64・純関数）。 */
export function viewRays(mvp: Float64Array, invMvp: Float64Array): { F: number[]; X: number[]; Y: number[] };
export function sphereRayUniforms(st: CameraState, origin: Vec3): { F: number[]; X: number[]; E: number[]; Y: number[]; c: number };
export function anchorUV(origin: Vec3, win: number[]): number[];

/** WGS84 楕円体で立てる（全実行文脈で同値に呼ぶ）。 */
export function setEllipsoid(on: boolean): void;
export function ellipsoidOn(): boolean;
export function ellAxisRatio(): number;
export function worldRadiusM(): 6371000 | 6378137;
/** 測地緯度 → 更成緯度（度）。球では恒等。 */
export function betaOf(latDeg: number): number;
export function geodeticOf(betaDeg: number): number;
