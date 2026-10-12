/** @ortho-earth/plugin-scene — instanced meshes, billboards and 3D text for @ortho-earth/globe (map.addData kinds on the dataKinds extension point) */
export const VERSION: string;

export type Color = [number, number, number, number?] | string;
export type Accessor<T, D = any> = T | ((d: D, i: number) => T);
export type Position = [number, number, number?];
export type Anchor = "center" | "top" | "bottom" | "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right" | [number, number];
export type Data<D = any> = D[] | { type: "FeatureCollection"; features: D[] } | Iterable<D>;

/** a mesh in local meters-per-unit space: x = east, y = north, z = up; base at z = 0 */
export interface Mesh { pos: Float32Array | number[]; idx: Uint32Array | Uint16Array | number[]; nrm?: Float32Array | number[]; col?: Uint8Array | Float32Array | number[] }
export type ShapeName = "box" | "cylinder" | "cone" | "sphere";

export interface CommonOptions<D = any> {
	id?: string;
	/** [lon, lat, h m]; default: the Point geometry of a GeoJSON feature */
	getPosition?: Accessor<Position | null, D>;
	/** "relative" (default): h above the ground; "absolute": h above the ellipsoid */
	altitude?: "relative" | "absolute";
	/** properties returned by pick / queryRenderedFeatures (default { index }) */
	getProperties?: (d: D, i: number) => any;
	/** hidden by terrain and buildings (default true) */
	depthTest?: boolean;
	/** draw above the labels (default false) */
	above?: boolean;
}
export interface InstancedOptions<D = any> extends CommonOptions<D> {
	kind?: "instanced";
	/** a built-in shape, a Mesh, a .glb URL or the bytes of an uncompressed .glb (no Draco / meshopt) */
	shape?: ShapeName | Mesh | string | URL | ArrayBuffer | ArrayBufferView;
	/** meters: one number or [east, north, up] */
	getScale?: Accessor<number | [number, number, number], D>;
	/** degrees: heading (clockwise from north), pitch, roll */
	getOrientation?: Accessor<number | [number, number?, number?], D>;
	getColor?: Accessor<Color, D>;
	sizeScale?: number;
	/** color when getColor is not given (multiplied with the mesh colors) */
	color?: Color;
}
export interface QuadOptions<D = any> extends CommonOptions<D> {
	/** "screen" (default): faces the camera; "flat": lies on the ground (east/north); "upright": stands and turns around the vertical */
	facing?: "screen" | "flat" | "upright";
	sizeUnits?: "pixels" | "meters";
	anchor?: Anchor;
	/** degrees, clockwise */
	getAngle?: Accessor<number, D>;
}
export interface BillboardOptions<D = any> extends QuadOptions<D> {
	kind?: "billboards";
	/** a key of icons, an image URL or an image (ImageBitmap / HTMLImageElement / canvas / ImageData) */
	getIcon: Accessor<string | CanvasImageSource | ImageData, D>;
	icons?: Record<string, string | CanvasImageSource | ImageData>;
	/** height in sizeUnits (default 32 px / 20 m); width follows the image */
	getSize?: Accessor<number, D>;
	getColor?: Accessor<Color, D>;
}
export interface Labels3dOptions<D = any> extends QuadOptions<D> {
	kind?: "labels3d";
	getText: Accessor<string, D>;
	/** font size in sizeUnits (default 16 px / 20 m) */
	getSize?: Accessor<number, D>;
	getColor?: Accessor<Color, D>;
	/** CSS font family (default system-ui) */
	font?: string;
	fontWeight?: number | string;
	haloColor?: Color;
	/** px (default 2) */
	haloWidth?: number;
}

export interface SceneHit { id: string; index: number; dataIndex: number | null; object: any; distance?: number; lngLat?: [number, number]; properties: any }
export interface SceneHandle<O = any> {
	id: string;
	kind: "instanced" | "billboards" | "labels3d";
	/** the overlay handle (map.overlay) */
	overlay: any;
	/** number of drawn items */
	n: number;
	ready: Promise<SceneHandle<O>>;
	setData(data: Data): Promise<SceneHandle<O>>;
	setProps(props: Partial<O>): Promise<SceneHandle<O>>;
	setVisible(on: boolean): SceneHandle<O>;
	pick(x: number, y: number, r?: number): Promise<SceneHit[]>;
	remove(): void;
}

export function createInstanced<D = any>(map: any, data: Data<D>, opts?: InstancedOptions<D>): SceneHandle<InstancedOptions<D>>;
export function createBillboards<D = any>(map: any, data: Data<D>, opts: BillboardOptions<D>): SceneHandle<BillboardOptions<D>>;
export function createLabels3d<D = any>(map: any, data: Data<D>, opts: Labels3dOptions<D>): SceneHandle<Labels3dOptions<D>>;

export interface ScenePlugin { name: "plugin-scene"; version: string; provides: string[]; install(map: any): () => void }
/** map.use(scenePlugin()) → map.addData(data, { kind: "instanced" | "billboards" | "labels3d", … }) */
export function scenePlugin(opts?: { kinds?: Array<"instanced" | "billboards" | "labels3d"> }): ScenePlugin;
export default scenePlugin;

// pure helpers
export function box(): Mesh;
export function cylinder(seg?: number, cone?: boolean): Mesh;
export function cone(seg?: number): Mesh;
export function sphere(seg?: number, rings?: number): Mesh;
export function normMesh(m: Mesh): Required<Pick<Mesh, "pos" | "idx" | "nrm">> & Pick<Mesh, "col">;
/** an uncompressed .glb → one Mesh in the local frame (glTF y-up → z-up, node transforms and baseColorFactor baked) */
export function parseGlb(bytes: ArrayBuffer | ArrayBufferView): Mesh;
export function packAtlas(sizes: Array<{ w: number; h: number }>, opts?: { max?: number; pad?: number }): { w: number; h: number; rects: Array<{ x: number; y: number; w: number; h: number }> };
export function items<D = any>(data: Data<D>): D[];
export function parseColor(c: Color | null | undefined, dflt?: [number, number, number, number]): [number, number, number, number];
export function anchorOf(a: Anchor | null | undefined, dflt: string): [number, number];
export function bakeInstances(data: Data, opts?: InstancedOptions): { n: number; ll: Float64Array; scl: Float32Array; ori: Float32Array; rgba: Uint8Array | null; color: number[]; keep: number[] };
export function measureLabel(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, text: string, opts: { fontPx: number; font: string; weight?: number | string; halo?: number }): { lines: string[]; lh: number; w: number; h: number };
