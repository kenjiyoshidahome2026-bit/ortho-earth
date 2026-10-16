// scenes/player.js（JS のまま）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝player.js が TS になれば消える。
import type { DemoHandle } from "../../globe.d.ts";
import type { GlobeCoreApi } from "../types/map.ts";
import type { GlobeScope } from "../types/scope.ts";

/** シーン台本の上映（map.playScenes・ドロップ・?scene= の共通の道） */
export interface ScenePlayer {
	playScenes: GlobeCoreApi["playScenes"];
	/** 旧名の薄い別名（既定の儀式フル） */
	playScene(obj: object): ReturnType<GlobeCoreApi["playScenes"]>;
	stopScenes(): void;
	sceneTimeline: GlobeCoreApi["sceneTimeline"];
	/** 上映中か（▶デモのバー点灯もシーン再生も） */
	playingNow(): boolean;
	/** 黒を挟む遷移 */
	fadeViewRun(hash: string, secs: number): Promise<unknown>;
	/** demo ガジェットの手綱（搭載時に預ける） */
	demoHandle: DemoHandle | null;
	readonly fadeBusy: boolean;
}
/** 配線（app の状態は getter・関数はラップ） */
export interface ScenePlayerEnv extends Pick<GlobeScope, "LOW_MEM" | "meshOn" | "meshMgr" | "flightCtl" | "CAM_ZOOM_MIN" | "flyView" | "applyCamView" | "applyViewLayers" | "switchTheme"> {
	mapEl: HTMLElement; gpuBackend: boolean; themeFixed: boolean; bldLabels?: Record<string, string>;
	readonly themeName: string; readonly elevBusy: boolean;
	onMove(): void; viewHash(): string; saveView(): void;
}
export function createScenePlayer(env: ScenePlayerEnv): ScenePlayer;
