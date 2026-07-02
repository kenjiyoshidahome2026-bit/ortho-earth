import AdmZip from 'adm-zip';

const PROXY = 'https://api.ortho-earth.com/proxy/?url=';
const url = `${PROXY}${encodeURIComponent('https://nlftp.mlit.go.jp/ksj/gml/data/N03/N03-2026/N03-20260101_GML.zip')}`;

const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
if (!r.ok) { console.log('HTTP', r.status); process.exit(1); }
const buf = Buffer.from(await r.arrayBuffer());
console.log('size:', buf.length);
const zip = new AdmZip(buf);
for (const e of zip.getEntries()) {
    console.log(' ', e.entryName, e.header.size);
}
