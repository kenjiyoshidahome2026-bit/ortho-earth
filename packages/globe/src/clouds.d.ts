// clouds.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝clouds.js が TS になれば消える。
import type { CloudsSpec } from "../globe.d.ts";
import type { GlobeMap } from "./types/map.ts";

/** 雲の殻のメッシュ（render worker の meshSet の中身） */
export interface CloudMesh { pos: Float32Array; nrm: Float32Array; idx: Uint32Array | Uint16Array; uv: Float32Array; col: Float32Array | Uint8Array; tex?: { rgba?: Uint8Array | Uint8ClampedArray } | null; [k: string]: unknown }
/** 全球の雲画像を高度の殻として描く（type "image"・W6） */
export interface CloudShell {
	set(spec: Required<CloudsSpec>): void; clear(): void; tick(): void; destroy(): void;
	readonly current: { name: string; tris: number; image: unknown } | null;
	angles(): [number, number];
}
export function createCloudShell(map: GlobeMap, deps: {
	setMesh(name: string, data: CloudMesh | null): void; setMeshXf?: ((name: string, data: unknown) => void) | null; requestDraw?(): void; earthM?: number; now?(): number;
	emit?(ev: { state: string; [k: string]: unknown }): void;
}): CloudShell;
