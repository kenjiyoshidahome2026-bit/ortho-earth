// 「いまの事実」を一か所で組み立てる（2026-11-11・AI エージェント向け）。手で書かない＝正本から読む：
//   版＝packages/ortho-core・globe・sdk/cesium の package.json、公開日＝CHANGELOG.md の先頭の「## x.y.z — YYYY-MM-DD」、
//   互換の数＝/maplibre/ と /sandcastle/ のギャラリー頁が持つ採点（payload の "l"：3 同じ絵・2 同じ答え・1 動く・0 動かない）。
// vite.config.js がここから /facts.json・llms.txt の {{…}}・トップの JSON-LD の版と更新日を出す。門＝tests/t-facts.mjs（README の数と版のずれも止める）
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = (p) => new URL(p, import.meta.url);
const read = (p) => readFileSync(here(p), 'utf8');
const pkg = (p) => JSON.parse(read(p));

/** CHANGELOG.md の先頭のエンジンの版（「## 2.4.1 — 2026-11-11」）。geopbf などの見出しは飛ばす */
export const latestRelease = (md) => {
	const m = md.match(/^## (\d+\.\d+\.\d+) — (\d{4}-\d\d-\d\d)$/m);
	if (!m) throw new Error('CHANGELOG.md: no "## x.y.z — YYYY-MM-DD" heading');
	return { version: m[1], date: m[2] };
};

/** ギャラリー頁の採点を数える。l が null の例は採点外（数えない） */
export const gradeGallery = (html, { payloadId, refRe }) => {
	const m = html.match(new RegExp(`<script type="application/json" id="${payloadId}">([\\s\\S]*?)</script>`));
	if (!m) throw new Error(`gallery: no <script id="${payloadId}">`);
	const entries = Object.values(JSON.parse(m[1]));
	const n = (lv) => entries.filter(e => e.l === lv).length;
	const graded = entries.filter(e => e.l !== null && e.l !== undefined).length;
	return {
		examples: entries.length, graded,
		samePicture: n(3), sameAnswers: n(2), runsPartly: n(1), doesNotRun: n(0),
		referenceVersion: html.match(refRe)?.[1] ?? null,
	};
};

/** npm test が走らせる検査の数＝scripts/test-all.mjs --list の行数（手で書かない） */
export const countTests = () => execFileSync(process.execPath, ['scripts/test-all.mjs', '--list'], { cwd: fileURLToPath(here('../../')), encoding: 'utf8' })
	.split('\n').filter(Boolean).length;

export const buildFacts = () => {
	const TESTS = countTests();
	const rel = latestRelease(read('../../CHANGELOG.md'));
	const core = pkg('../../packages/ortho-core/package.json');
	const globe = pkg('../../packages/globe/package.json');
	const cesium = pkg('../../sdk/cesium/package.json');
	const maplibre = gradeGallery(read('./public/maplibre/index.html'), { payloadId: 'payload', refRe: /MapLibre GL JS (\d+\.\d+\.\d+)/ });
	const sandcastle = gradeGallery(read('./public/sandcastle/index.html'), { payloadId: 'payload', refRe: /CesiumJS (\d+\.\d+\.\d+)/ });
	return {
		name: 'Ortho Earth',
		url: 'https://www.ortho-earth.com/',
		tagline: 'One true-scale Earth, for people and their AI agents.',
		summary: 'An open-source 3D globe map engine for the browser. WebGPU with a WebGL2 fallback, always a round globe (no Mercator mode), terrain at true scale, MapLibre GL JS and CesiumJS code run on it unchanged. No server, no account.',
		release: { version: rel.version, date: rel.date, changelog: 'https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/CHANGELOG.md' },
		packages: {
			[globe.name]: { version: globe.version, license: globe.license, npm: `https://www.npmjs.com/package/${globe.name}` },
			[core.name]: { version: core.version, license: core.license, npm: `https://www.npmjs.com/package/${core.name}` },
			[cesium.name]: { version: cesium.version, license: cesium.license, npm: `https://www.npmjs.com/package/${cesium.name}` },
		},
		compatibility: {
			maplibre: {
				what: 'MapLibre GL JS official examples, each run unchanged on the globe (import * as maplibregl from "@ortho-earth/globe/maplibre")',
				...maplibre,
				gallery: 'https://www.ortho-earth.com/maplibre/',
			},
			cesium: {
				what: 'CesiumJS Sandcastle examples, each run unchanged on real CesiumJS and on the globe (import * as Cesium from "@ortho-earth/cesium") and compared side by side',
				...sandcastle,
				gallery: 'https://www.ortho-earth.com/sandcastle/',
			},
			levels: {
				samePicture: 'runs and draws the same picture as the original',
				sameAnswers: 'runs and gives the same answers (features, entities, camera), the picture differs',
				runsPartly: 'runs, but some of it does not work',
				doesNotRun: 'does not run',
			},
		},
		forAgents: {
			recipe: 'https://www.ortho-earth.com/start.md',
			recipeTested: 'every step is run by an automated test against the published npm packages',
			knownApis: ['MapLibre GL JS (import * as maplibregl from "@ortho-earth/globe/maplibre")', 'CesiumJS (import * as Cesium from "@ortho-earth/cesium")'],
			noKeys: 'no API key, account or tile server needed for the map',
			selfDescription: 'map.supports(key) and map.capabilities() report what the map can do',
			types: 'TypeScript types ship in the packages',
			healthCheck: 'a healthy start logs "[boot] frame1 received" in the browser console',
		},
		maintenance: {
			maintainers: 1,
			sla: 'none',
			tests: TESTS,
			security: 'private reports via GitHub Security Advisories; reply within 7 days; 90-day disclosure window; CodeQL on every pull request; monthly dependency updates with a 7-day cooldown',
			serverSide: 'none: no map server, no backend, no accounts; the map runs in the browser',
			continuity: 'GPL-3.0-or-later (formats MIT) so anyone may continue it; CLA for contributions; published packages keep working without project servers; open documented formats; MapLibre GL JS and CesiumJS APIs leave a way back to those engines',
			securityPolicy: 'https://github.com/kenjiyoshidahome2026-bit/ortho-earth/blob/main/SECURITY.md',
		},
		license: { engine: 'GPL-3.0-or-later (a commercial license is available)', formats: 'MIT (geopbf, altpbf, geoedit, glbconv, native-bucket)' },
		source: 'https://github.com/kenjiyoshidahome2026-bit/ortho-earth',
		llms: 'https://www.ortho-earth.com/llms.txt',
		llmsFull: 'https://www.ortho-earth.com/llms-full.txt',
	};
};

/** "{{compatibility.cesium.samePicture}}" を facts の値で埋める。無い鍵は投げる（黙って空にしない） */
export const fillFacts = (text, facts) => text.replace(/\{\{([\w.@/-]+)\}\}/g, (_, path) => {
	const v = path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), facts);
	if (v === undefined || v === null || typeof v === 'object') throw new Error(`facts: no value for {{${path}}}`);
	return String(v);
});
