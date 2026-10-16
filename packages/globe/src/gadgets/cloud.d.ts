// gadgets/cloud.js（JS のまま＝gadget の batch）の型。src/api/*.ts が読む分だけ（TS 化 段 4・batch 1）＝cloud.js が TS になれば消える。
import type { initEditor } from "geoedit";

/** クラウド保存パネル（japan の共通の器）＝geoedit の SharedCloudPanel と同じ形 */
export const cloudPanel: NonNullable<NonNullable<Parameters<typeof initEditor>[1]>["cloudPanel"]>;
