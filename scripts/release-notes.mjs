// GitHub Release の本文＝CHANGELOG.md のその版の節（2026-11-11）。release.yml が呼ぶ。
// 使い方：node scripts/release-notes.mjs [版]  … 版を省くと CHANGELOG の先頭のエンジンの版。標準出力に「版\n本文」を出す。
// 狙い：npm・GitHub Release・CHANGELOG・サイト（llms.txt・facts.json）が同じ版を言う（GitHub の Latest が古いと AI が古い版を答える）
import { readFileSync } from 'node:fs';

export const releaseNotes = (md, version) => {
	const heads = [...md.matchAll(/^## (\d+\.\d+\.\d+) — (\d{4}-\d\d-\d\d)$/gm)];
	const h = version ? heads.find(m => m[1] === version) : heads[0];
	if (!h) throw new Error(`CHANGELOG.md: no "## ${version ?? 'x.y.z'} — date" section`);
	const start = h.index + h[0].length;
	const next = md.slice(start).search(/^## /m);
	return { version: h[1], date: h[2], body: md.slice(start, next < 0 ? undefined : start + next).trim() };
};

if (import.meta.url === `file://${process.argv[1]}`) {
	const r = releaseNotes(readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8'), process.argv[2]);
	process.stdout.write(`${r.version}\n${r.body}\n`);
}
