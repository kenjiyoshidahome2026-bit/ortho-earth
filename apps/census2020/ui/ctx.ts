// shared runtime registry — call setup() once in main.js after all functions are defined
// main.ts の setup が登録する共有関数（census/ui.ts が参照）
export interface Ctx { setDetailHtml: (html: string) => void }
export const ctx = {} as Ctx;
export function setup(obj: Ctx): void { Object.assign(ctx, obj); }
