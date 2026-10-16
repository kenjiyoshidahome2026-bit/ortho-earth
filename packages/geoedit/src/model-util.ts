// 小規模／大規模モデルの合併型（types.ts の Model）を跨ぐ薄い口（TS 化 段 3・2026-10）。
// 実行時の分岐は元の JS と同じ（`m.large` で見る）＝型の都合で呼び分けを 1 か所に集める。
import type { EditModel, EditCmd } from "geopbf/edit/model";
import type { LargeCmd } from "geopbf/edit/large-model";
import type { TopoNode } from "geopbf/edit/topo-extract";
import type { Model, Cmd, Arc } from "./types.ts";

/** 小規模モデルだけの操作（resolveAddr・featureVerts・rotateFeature …）へ渡す＝呼び手が large でないことを保証している所で使う */
export const small = (m: Model): EditModel => m as EditModel;

export const applyCmd = (m: Model, cmd: Cmd): unknown => m.large ? m.applyCmd(cmd as LargeCmd) : m.applyCmd(cmd as EditCmd);
export const invertCmd = (m: Model, cmd: Cmd): Cmd => (m.large ? m.invertCmd(cmd as LargeCmd) : m.invertCmd(cmd as EditCmd)) as Cmd;

/** 端点ノード（小規模＝番号・大規模＝文字列の鍵）。ends の形は同じ */
export const nodeOf = (m: Model, nid: number | string | null | undefined): Pick<TopoNode, "ends"> | undefined =>
	nid == null ? undefined : m.large ? m.nodes.get(nid as string) : m.nodes.get(nid as number);

/** 共有 arc か（小規模＝refs は Set・大規模＝number[]） */
export const isShared = (arc: Arc): boolean => arc.refs instanceof Set ? arc.refs.size > 1 : false;
