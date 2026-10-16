// mlsmall.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝mlsmall.js が TS になれば消える。

/** sprite の一覧の 1 件 */
export interface SpriteEntry { id: string; url: string }
/** style の sprite（文字列・配列）→ [{ id, url }] */
export function normSprite(spec: unknown): SpriteEntry[];
/** getStyle の形（default だけなら文字列）・無ければ undefined */
export function spriteEcho(list: SpriteEntry[] | null | undefined): string | SpriteEntry[] | undefined;
export function spritePrefix(id: string | null | undefined): string;
export function tileOf(lon: number, lat: number, z: number): [number, number];
export function tilesFromPoints(points: Array<ArrayLike<number> | null>, zOf: number | ((lon: number, lat: number) => number), o?: { minzoom?: number; maxzoom?: number }): Array<{ canonical: { x: number; y: number; z: number }; overscaledZ: number; wrap: number; key: string }>;
/** font-faces の 1 件 → addFontFace の引数（family が無い・src が無い＝null） */
export function fontFaceArgs(face: unknown): { family: string; src: string | ArrayBuffer; descriptors: { weight?: string; style?: string; unicodeRange?: string } } | null;
