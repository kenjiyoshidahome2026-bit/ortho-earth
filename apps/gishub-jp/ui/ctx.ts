// shared runtime registry — call setup() once in main.ts after all functions are defined
import type { renderExecView, closeGeoPreview } from './exec-view.ts';
import type { bulkDownload } from './bulk-download.ts';
// main.ts の ctxSetup が登録する共有関数（省庁モジュールが参照）
export interface Ctx {
    setDetailHtml: (html: string) => void;
    renderExecView: typeof renderExecView;
    bulkDownload: typeof bulkDownload;
    copyEntries: (entries: { name: string }[], feedbackEl?: HTMLElement | null) => Promise<void>;
    closeGeoPreview: typeof closeGeoPreview;
    goHome: () => void;
    renderMojList: () => Promise<void>;
}
export const ctx = {} as Ctx;
export function setup(obj: Ctx) { Object.assign(ctx, obj); }
