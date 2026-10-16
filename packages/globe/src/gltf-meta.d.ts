// gltf-meta.js（JS のまま）の型。gadgets の model が読む分だけ（TS 化 段 4・batch 2）＝gltf-meta.js が TS になれば消える。
import type { AnimationSpec, AnimationState, GltfAnimationInfo } from "../globe.d.ts";

/** 再生の spec を整える（name/index が無ければ最初のアニメ・知らない name／index は投げる）。null／false＝外す */
export function normAnimation(spec: AnimationSpec | string | number | boolean | null | undefined, animations?: GltfAnimationInfo[]): AnimationState | null;
