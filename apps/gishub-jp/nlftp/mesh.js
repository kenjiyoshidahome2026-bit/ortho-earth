import { execGlobeView } from '../ui/globe.js';
import { ctx } from '../ui/ctx.js';

// メッシュデータセット一括DL + 地球儀ストリーミング
// entries は nlftp/ui.js の _fileEntry() で作成済みの配列を受け取る
export function meshBulkDownload(entries, label) {
    ctx.bulkDownload(entries, label, null, 4, pbf => execGlobeView(pbf));
}
