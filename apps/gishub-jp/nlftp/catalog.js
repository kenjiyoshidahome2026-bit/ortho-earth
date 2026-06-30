import { API_BASE } from '../ui/config.js';

export const NLFTP_SOURCE = {
    id:          'nlftp',
    title:       '国土交通省 国土数値情報',
    bucket:      'catalog',
    attribution: '国土交通省 国土数値情報',
};

const BUCKET_BASE = `${API_BASE}/bucket/${NLFTP_SOURCE.bucket}`;

async function fetchJson(url) {
    const res  = await fetch(url, { cache: 'no-store' });
    const buf  = await res.arrayBuffer();
    const head = new Uint8Array(buf, 0, 2);
    if (head[0] === 0x1f && head[1] === 0x8b) {
        const stream = new DecompressionStream('gzip');
        const text   = await new Response(new Blob([buf]).stream().pipeThrough(stream)).text();
        return JSON.parse(text);
    }
    return JSON.parse(new TextDecoder().decode(buf));
}

// サイドバー向けエントリ一覧
export async function loadCatalogEntries() {
    const datasets = await fetchJson(`${BUCKET_BASE}/index.json`);
    return datasets.map(ds => ({ ...ds, _sourceId: NLFTP_SOURCE.id, _source: NLFTP_SOURCE }));
}

// 個別データセット詳細
export async function fetchDataset(code) {
    const data = await fetchJson(`${BUCKET_BASE}/${code}.json`);
    data._source = NLFTP_SOURCE;
    return data;
}
