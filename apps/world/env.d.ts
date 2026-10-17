// 入口（src/main.ts）の型の補い。world.ts が読む common（packages/common）は src の .ts を直に束ねる＝common の型検査と同じ補い（File System Access API・*.scss）をここでも読む
/// <reference path="../../packages/common/src/ambient.d.ts" />
// ・window.__orthoEngine＝検定の注入口（偽エンジン・src/mappane.ts）／window.__worldPane＝dev の検分窓
interface Window { __orthoEngine?: typeof import("@ortho-earth/globe"); __worldPane?: unknown }
