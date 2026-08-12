/**
 * A31（洪水浸水想定区域・想定最大規模）全国焼きドライバ。1次メッシュ×河川区分[10,20] の zip を
 * 順に [probe → DL → a31-batch（クリップ+間引き・ローカル出力）→ zip削除] し、最後にメッシュ横断で
 * 市区町村ごとに連結して bucket へ一括上げ（メッシュ境界の市を上書きで壊さない＝連結が正）。
 * 全相 progress 持ち＝落ちても再走で続きから。
 *
 * 相: ①mesh probe（a31-meshes.json にキャッシュ） ②mesh 処理（out-a31-mesh/{mesh}/{city}.geojsonl）
 *     ③merge+upload（a31-up-progress.json）
 * 使い方: API_KEY=... node a31-all.mjs        （--probe-only / --upload-only で相の単独実行）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, appendFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Bucket } from 'native-bucket';
const __dir = dirname(fileURLToPath(import.meta.url));

const API_BASE = process.env.API_BASE ?? 'https://api.ortho-earth.com';
const API_KEY = process.env.API_KEY;
const PREF_BBOX = JSON.parse(readFileSync(join(__dir, 'pref-bbox.json')));
const YEARS = ['25', '24', '23', '22'];   // 新しい順（v4.0 系列）
const RC = ['10', '20'];                  // 河川区分: 10=洪水予報・水位周知河川 / 20=その他河川
const MESH_CACHE = join(__dir, 'a31-meshes.json');
const PROG_MESH = join(__dir, 'a31-mesh-progress.json');
const PROG_UP = join(__dir, 'a31-up-progress.json');
const MESH_OUT = join(__dir, 'out-a31-mesh');
const TMP = join(__dir, 'tmp-a31');
const UA = { 'User-Agent': 'Mozilla/5.0' };

const meshBbox = m => { const p = Math.floor(m / 100), q = m % 100; return [100 + q, p / 1.5, 100 + q + 1, p / 1.5 + 2 / 3]; };
const hit = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const prefsOfMesh = m => { const bb = meshBbox(m); return Object.keys(PREF_BBOX).filter(k => hit(bb, PREF_BBOX[k])); };

// ── ①probe：県 bbox 群を覆うメッシュ候補 × 年度降順 HEAD（先勝ち）──
async function probeMeshes() {
	if (existsSync(MESH_CACHE)) return JSON.parse(readFileSync(MESH_CACHE));
	const cand = new Set();
	for (const bb of Object.values(PREF_BBOX)) {
		for (let p = Math.floor(bb[1] * 1.5); p <= Math.floor(bb[3] * 1.5); p++)
			for (let q = Math.floor(bb[0]) - 100; q <= Math.floor(bb[2]) - 100; q++)
				if (p >= 30 && p <= 70 && q >= 22 && q <= 54) cand.add(p * 100 + q);
	}
	console.log(`メッシュ候補 ${cand.size}（probe 開始）`);
	const found = {};   // mesh → { rc: url }
	const list = [...cand].sort();
	let i = 0;
	const workers = Array.from({ length: 8 }, async () => {
		while (i < list.length) {
			const m = list[i++];
			for (const rc of RC) {
				for (const y of YEARS) {
					const u = `https://nlftp.mlit.go.jp/ksj/gml/data/A31/A31-${y}/A31-${y}_${rc}_${m}_SHP.zip`;
					try {
						const r = await fetch(u, { method: 'HEAD', headers: UA });
						if (r.ok) { (found[m] ??= {})[rc] = u; break; }
					} catch { /* 次へ */ }
				}
			}
			if (i % 50 === 0) console.log(`  probe ${i}/${list.length}（実在 ${Object.keys(found).length}）`);
		}
	});
	await Promise.all(workers);
	writeFileSync(MESH_CACHE, JSON.stringify(found, null, '\t'));
	console.log(`✅ probe: 実在メッシュ ${Object.keys(found).length} → ${MESH_CACHE}`);
	return found;
}

// ── ②mesh 処理：DL → a31-batch（ローカル出力・メッシュ別 dir）→ zip 削除 ──
async function processMeshes(meshes) {
	const done = new Set(existsSync(PROG_MESH) ? JSON.parse(readFileSync(PROG_MESH)) : []);
	const keys = Object.keys(meshes).sort();
	for (const m of keys) {
		if (done.has(m)) { continue; }
		const prefs = prefsOfMesh(+m);
		if (!prefs.length) { done.add(m); writeFileSync(PROG_MESH, JSON.stringify([...done].sort())); continue; }
		console.log(`\n===== メッシュ ${m}（県 ${prefs.join(',')}・${Object.keys(meshes[m]).length}区分）=====`);
		rmSync(TMP, { recursive: true, force: true }); mkdirSync(TMP, { recursive: true });
		let ok = true;
		for (const rc of Object.keys(meshes[m])) {
			const u = meshes[m][rc];
			try {
				const r = await fetch(u, { headers: UA });
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				writeFileSync(join(TMP, u.split('/').pop()), Buffer.from(await r.arrayBuffer()));
			} catch (e) { console.error(`✗ DL失敗 ${u}: ${e.message}`); ok = false; }
		}
		if (ok) {
			try {
				const outDir = join(MESH_OUT, String(m));
				rmSync(outDir, { recursive: true, force: true });
				execFileSync('node', [join(__dir, 'a31-batch.mjs'), '--src', TMP, '--prefs', prefs.join(','), '--dry-run', '--out', outDir],
					{ stdio: 'inherit', env: { ...process.env, API_KEY: '' } });
				done.add(m);
				writeFileSync(PROG_MESH, JSON.stringify([...done].sort()));
			} catch (e) { console.error(`✗ 変換失敗 mesh ${m}: ${e.message}`); }
		}
		rmSync(TMP, { recursive: true, force: true });
	}
	console.log(`\n✅ mesh 処理: ${done.size}/${keys.length}`);
}

// ── ③merge+upload：市区町村ごとにメッシュ横断で連結 → bucket（連結＝境界市を壊さない） ──
async function mergeUpload() {
	if (!API_KEY) { console.error('upload には API_KEY が必要'); process.exit(1); }
	const upDone = new Set(existsSync(PROG_UP) ? JSON.parse(readFileSync(PROG_UP)) : []);
	const perCity = new Map();   // code → [meshDir/file, ...]
	for (const m of readdirSync(MESH_OUT)) {
		const dir = join(MESH_OUT, m);
		for (const f of readdirSync(dir)) {
			const code = f.replace('.geojsonl', '');
			if (!perCity.has(code)) perCity.set(code, []);
			perCity.get(code).push(join(dir, f));
		}
	}
	console.log(`upload 対象: ${perCity.size} 市区町村`);
	const bucket = await Bucket('bousai/a31', { baseUrl: `${API_BASE}/bucket/`, apiKey: API_KEY, silent: true });
	let n = 0;
	for (const [code, files] of [...perCity].sort()) {
		n++;
		if (upDone.has(code)) continue;
		const body = files.map(f => readFileSync(f, 'utf8')).join('\n');
		await bucket.put(`${code}.geojsonl`, new File([body], `${code}.geojsonl`, { type: 'application/geo+json' }));
		upDone.add(code);
		if (upDone.size % 25 === 0) { writeFileSync(PROG_UP, JSON.stringify([...upDone].sort())); console.log(`  ↑ ${n}/${perCity.size}`); }
	}
	writeFileSync(PROG_UP, JSON.stringify([...upDone].sort()));
	console.log(`✅ upload: ${upDone.size} 市区町村`);
}

const meshes = await probeMeshes();
if (process.argv.includes('--probe-only')) process.exit(0);
if (!process.argv.includes('--upload-only')) await processMeshes(meshes);
// 境界市はメッシュ横断の連結が正＝全メッシュ処理が揃うまで upload しない（部分 upload+PROG_UP は境界市を欠けさせる）
const doneN = new Set(existsSync(PROG_MESH) ? JSON.parse(readFileSync(PROG_MESH)) : []).size;
if (!process.argv.includes('--upload-only') && doneN < Object.keys(meshes).length) {
	console.warn(`⚠ 未処理メッシュあり（${doneN}/${Object.keys(meshes).length}）＝upload 保留。再走で続きから`);
	process.exit(1);
}
await mergeUpload();
console.log('✅ A31 全国 完了');
