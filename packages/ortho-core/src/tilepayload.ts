// デコード済みタイル 1 枚 → 描画の荷（描画 op 列・図郭外の水域・ラベル・建物）。tile worker と main の既定経路（tilemanager）の共通の組み立て。
// 旧＝同じ手順（境界→drawlist→emptySea→labels→buildings→実バイト）が tileworker.js と tilemanager.js に 2 通り書かれていた。
// worker からも読む＝index.js（pipeline＝worker 生成を含む）を引かない（tileworker のコメント参照）
import { buildTileDrawList, buildEmptySeaOps } from "./build.ts";
import { buildLabels } from "./labels.ts";
import { buildBuildings } from "./buildings.ts";
import { tileBounds } from "./tile.ts";
import { opBuffers } from "./scene.ts";
import type { DrawList, Style } from "./build.ts";
import type { Label } from "./labels.ts";
import type { BuildingsGeom } from "./scene.ts";
import type { TileData } from "./tileformat.ts";
import type { TileXYZ } from "./tile.ts";
export { opBuffers };

/** タイル 1 枚の荷＝描画 op 列・注記・建物・実バイト */
export interface TilePayload { origin: number[]; dl: DrawList; labels: Label[]; buildings: BuildingsGeom | null; z: number; bytes: number }

// layers＝decode の結果（{ __empty } を含む）・t＝{ z, x, y }。戻り＝{ origin, dl, labels, buildings, z, bytes }
export function buildTilePayload(layers: TileData, { z, x, y }: TileXYZ, style: Style): TilePayload {
	const [w, , , n] = tileBounds(x, y, z);
	const origin = [w, n];
	const dl = buildTileDrawList({ layers, z, x, y }, style, origin);
	// 図郭外（404/図郭縁の WA スライバ）＝標高ゲート付き全面水域を敷く（詳細は buildEmptySeaOps。style.emptySea 未設定なら不発）
	const seaOps = buildEmptySeaOps(layers, { z, x, y }, style, origin); if (seaOps) dl.ops.unshift(...seaOps);
	const { labels } = buildLabels({ layers, z, x, y }, style);
	const buildings = buildBuildings({ layers, z, x, y }, origin, style.schema);
	let bytes = 0; for (const b of opBuffers(dl.ops, buildings)) bytes += b.byteLength;   // geometry の実バイト＝main のメモリ予算/退避の基準
	return { origin, dl, labels, buildings, z, bytes };
}
