import { execGlobeView } from '../ui/globe.ts';
import { ctx } from '../ui/ctx.ts';
import type { BulkEntry } from '../ui/bulk-download.ts';

// メッシュデータセット一括DL + 地球儀ストリーミング
// entries は nlftp/ui.ts の _fileEntry() で作成済みの配列を受け取る
export function meshBulkDownload(entries: BulkEntry[], label: string) {
    ctx.bulkDownload(entries, label, null, 4, pbf => execGlobeView(pbf));
}
