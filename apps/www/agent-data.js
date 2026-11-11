// AI エージェントの道具（MCP サーバー @ortho-earth/mcp）が読む機械可読の資料（2026-11-11）。手で書かない＝正本から組む：
//   /compat.json      ＝公式例ごとの採点（/maplibre/・/sandcastle/ のギャラリー頁の payload）と MapLibre style-spec の性質ごとの状態（packages/globe/maplibre-coverage.md の表）
//   /ref/globe.d.ts   ＝公開面の型（packages/globe/globe.d.ts）
//   /ref/maplibre.d.ts＝MapLibre の口の型（packages/globe/maplibre.d.ts）
//   /ref/globe-map.ts ＝createGlobe が返す map の口の型（packages/globe/src/types/map.ts）
// vite.config.js が facts.json と同じ所で出す。門＝tests/t-agent-data.mjs
import { readFileSync } from 'node:fs';

const here = (p) => new URL(p, import.meta.url);
const read = (p) => readFileSync(here(p), 'utf8');

const LEVELS = ['doesNotRun', 'runsPartly', 'sameAnswers', 'samePicture'];   // payload の l（0〜3）
const COVERAGE = { '読む': 'reads', '近似': 'approximate', '一部': 'partial', '未': 'notYet' };

const payloadOf = (html) => {
	const m = html.match(/<script type="application\/json" id="payload">([\s\S]*?)<\/script>/);
	if (!m) throw new Error('gallery: no <script id="payload">');
	return JSON.parse(m[1]);
};

const noteText = (n) => !n ? null : typeof n === 'string' ? n : (n.en ?? n.ja ?? null);

/** ギャラリーの payload → 例ごとの { id, title, level, picture, note, url } */
export const galleryExamples = (html, { base, original }) => Object.entries(payloadOf(html)).map(([id, p]) => ({
	id,
	title: p.title ?? p.t,
	level: p.l == null ? null : LEVELS[p.l],
	picture: p.pc ?? null,   // 絵の一致（%）
	note: noteText(p.note),
	...(p.cr?.length ? { imagery: p.cr } : {}),
	url: base + encodeURIComponent(id),
	original: original(id),
}));

/** maplibre-coverage.md の表（| 層 | 置き場 | `性質` | 状態 | 中身 |）→ { layer, kind, property, status, note } */
export const styleCoverage = (md) => {
	const out = [];
	for (const line of md.split('\n')) {
		const m = line.match(/^\| ([\w-]+) \| (\w+) \| `([^`]+)` \| (\S+) \| (.*?) ?\|$/);
		if (!m) continue;
		const status = COVERAGE[m[4]];
		if (!status) throw new Error(`maplibre-coverage.md: unknown status ${m[4]}`);
		out.push({ layer: m[1], kind: m[2], property: m[3], status, ...(m[5].trim() ? { note: m[5].trim() } : {}) });
	}
	return out;
};

export const buildCompat = () => {
	const maplibre = galleryExamples(read('./public/maplibre/index.html'), {
		base: 'https://www.ortho-earth.com/maplibre/#',
		original: (id) => `https://maplibre.org/maplibre-gl-js/docs/examples/${id}/`,
	});
	const cesium = galleryExamples(read('./public/sandcastle/index.html'), {
		base: 'https://www.ortho-earth.com/sandcastle/#',
		original: (id) => `https://sandcastle.cesium.com/?id=${encodeURIComponent(id)}`,
	});
	return {
		levels: {
			samePicture: 'runs unchanged and draws the same picture as the original',
			sameAnswers: 'runs unchanged and gives the same answers (features, entities, camera); the picture differs',
			runsPartly: 'runs, but some of it does not work',
			doesNotRun: 'does not run',
		},
		styleStatus: {
			reads: 'the engine reads this style property',
			approximate: 'read, drawn approximately',
			partial: 'read in some cases (see note, Japanese)',
			notYet: 'not read yet',
		},
		maplibre: { how: 'import * as maplibregl from "@ortho-earth/globe/maplibre"', examples: maplibre },
		cesium: { how: 'import * as Cesium from "@ortho-earth/cesium"', examples: cesium },
		styleSpec: styleCoverage(read('../../packages/globe/maplibre-coverage.md')),
	};
};

export const refFiles = () => ({
	'ref/globe.d.ts': read('../../packages/globe/globe.d.ts'),
	'ref/maplibre.d.ts': read('../../packages/globe/maplibre.d.ts'),
	'ref/globe-map.ts': read('../../packages/globe/src/types/map.ts'),   // createGlobe が返す map の口（globe.d.ts の GlobeMap の正本）
});
