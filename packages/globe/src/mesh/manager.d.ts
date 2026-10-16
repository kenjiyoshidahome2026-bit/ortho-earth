// mesh/manager.js（JS のまま）の型。globe.ts が読む分だけ（TS 化 段 4・batch 3）＝mesh/manager.js が TS になれば消える。
import type { MeshMgr } from "../types/scope.ts";

/** 区の読み込みの進捗の合図（name＝区の名・null＝消灯） */
export type MeshProgressTap = ((name: string | null, p?: unknown) => void) | null;
/** 常駐の実測（HUD の物差し） */
export interface MeshMemStats { bytes: number; regions: number; transient: { cache: number; live: number; bytes: number }; tier: { active: number; residentGB: number; workers: number } | null }
/** 建物メッシュの管理（createMeshManager の戻り） */
export interface MeshManager {
	update(settled?: boolean): void;
	standUp(set: unknown, tiles?: unknown): Promise<unknown>;
	prefetch: MeshMgr["prefetch"];
	trimForScript: MeshMgr["trimForScript"];
	firstRevealSets(views: unknown[]): unknown[];
	setExcludeMap(map: unknown): void;
	setProgressTap(fn: MeshProgressTap): void;
	terminate(): void;
	readonly sets: Array<MeshMgr["sets"][number] & { name: string }>;
	progress: MeshMgr["progress"];
	isActive(name: string): boolean;
	isDead(name: string): boolean;
	visibleLoading(): string[];
	memStats(): MeshMemStats;
	openDb(): Promise<unknown>;
}
export function createMeshManager(env: object): MeshManager;
