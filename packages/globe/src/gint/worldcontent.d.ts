// gint/worldcontent.js（JS のまま）の型。globe.ts が読む分だけ（TS 化 段 4・batch 3）＝gint/worldcontent.js が TS になれば消える。
/** 世界帯の中身（opts.worldContent）の手綱 */
export interface WorldContent { update(): void; repaint(): Promise<void>; state(): Record<string, unknown> }
export function createWorldContent(env: {
	addGint: unknown; geopbf: unknown; symbols: unknown; addImage: unknown; getZoom: () => number; lang?: string; worldStyle: () => unknown; bandZ: number;
	lowMem?: boolean; requestDraw?: () => void; groups?: string[] | null;
}): WorldContent;
