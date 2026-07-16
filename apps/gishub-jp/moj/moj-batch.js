/**
 * 法務省 登記所備付地図 全国バッチ変換
 *
 * moj-manifest.json の各エントリを順次処理:
 *   G空間 → fetch (redirect自動追従) → ZIP展開 → XML変換 → GeoJSONL → native-bucket upload
 *
 * 使い方:
 *   node moj-batch.js              # 全件処理
 *   node moj-batch.js --dry-run    # ダウンロードせず manifest の確認のみ
 *   node moj-batch.js --start 100  # 100番目から再開
 *   node moj-batch.js --code 01694 # 特定市区町村コードのみ
 *
 * 出力先: native-bucket の "moj/" ディレクトリ
 *   moj/{cityCode}.geojsonl  (1行1筆 Feature JSON)
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Bucket } from 'native-bucket';   // workspace解決（アプリ移設で相対深度が壊れた轍・exports封印にも整合）
import AdmZip from 'adm-zip';
// 全XMLが任意座標系の場合の都道府県→系番号フォールバック（正本: jp/codes.js・1か所管理）
import { PREF_SYS } from '../jp/codes.js';
const __dir = dirname(fileURLToPath(import.meta.url));

// ============================================================
// 設定
// ============================================================
const API_BASE   = 'https://api.ortho-earth.com';
const API_KEY = process.env.API_KEY;
const BUCKET_DIR = 'moj';
const PROGRESS_FILE = join(__dir, 'progress.json');

// ============================================================
// 座標変換 (上流の moj-convert.js と共通)
// ============================================================
const DEG = Math.PI / 180;
const a   = 6378137.0;
const f   = 1 / 298.257222101;
const e2  = 2 * f - f * f;
const m0  = 0.9999;

const CS_ORIGINS = {
	 1:[33,129.5],  2:[33,131],     3:[36,132+10/60], 4:[33,133.5],
	 5:[36,134+20/60], 6:[36,136], 7:[36,137+10/60],  8:[36,138.5],
	 9:[36,139+50/60], 10:[40,140+50/60],
	11:[44,140.25], 12:[44,142.25], 13:[44,144.25],
	14:[26,142],    15:[26,127.5],  16:[26,124],
	17:[26,131],    18:[20,136],    19:[26,154],
};

function meridianArc(phi) {
	const e4=e2*e2, e6=e2*e4;
	return a*((1-e2/4-3*e4/64-5*e6/256)*phi
		-(3/8)*(e2+e4/4+15*e6/128)*Math.sin(2*phi)
		+(15/256)*(e4+3*e6/4)*Math.sin(4*phi)
		-(35*e6/3072)*Math.sin(6*phi));
}

function planeToLatLon(x, y, sysNum) {
	const [lat0d,lon0d] = CS_ORIGINS[sysNum] || CS_ORIGINS[9];
	const phi0=lat0d*DEG, lam0=lon0d*DEG;
	const e4=e2*e2, e6=e2*e4;
	const M0=meridianArc(phi0), M=M0+x/m0;
	const mu=M/(a*(1-e2/4-3*e4/64-5*e6/256));
	const e1=(1-Math.sqrt(1-e2))/(1+Math.sqrt(1-e2));
	const e12=e1*e1, e13=e1*e12, e14=e1*e13;
	const phi1=mu+(3*e1/2-27*e13/32)*Math.sin(2*mu)
		+(21*e12/16-55*e14/32)*Math.sin(4*mu)
		+(151*e13/96)*Math.sin(6*mu)+(1097*e14/512)*Math.sin(8*mu);
	const sinP=Math.sin(phi1),cosP=Math.cos(phi1),tanP=Math.tan(phi1);
	const ep2=e2/(1-e2),C1=ep2*cosP*cosP,T1=tanP*tanP;
	const N1=a/Math.sqrt(1-e2*sinP*sinP);
	const R1=a*(1-e2)/Math.pow(1-e2*sinP*sinP,1.5);
	const D=y/(N1*m0), D2=D*D,D3=D*D2,D4=D*D3,D5=D*D4,D6=D*D5;
	const phi=phi1-(N1*tanP/R1)*(D2/2
		-(5+3*T1+10*C1-4*C1*C1-9*ep2)*D4/24
		+(61+90*T1+298*C1+45*T1*T1-252*ep2-3*C1*C1)*D6/720);
	const lam=lam0+(D-(1+2*T1+C1)*D3/6
		+(5-2*C1+28*T1-3*C1*C1+8*ep2+24*T1*T1)*D5/120)/cosP;
	return [parseFloat((lam/DEG).toFixed(8)),parseFloat((phi/DEG).toFixed(8))];
}

function parseSysNum(txt) {
	const m=txt?.match(/(\d+)系/); return m?parseInt(m[1]):0;
}

// ============================================================
// XML → GeoJSONL ジェネレーター (moj-convert.js と同一ロジック)
// ============================================================
function* xmlToFeatures(xml, defaultSysNum = 9) {
	const sysTag = (xml.match(/<座標系>(.*?)<\/座標系>/) || [])[1] || '';
	const sysNum = /任意/.test(sysTag) ? defaultSysNum : (parseSysNum(sysTag) || defaultSysNum);
	const cityCode = (xml.match(/<市区町村コード>(.*?)<\/市区町村コード>/)||[])[1]||'';
	const cityName = (xml.match(/<市区町村名>(.*?)<\/市区町村名>/)||[])[1]||'';

	// GM_Point
	const pointMap=new Map();
	const pr=/<zmn:GM_Point id="(P\d+)">\s*<zmn:GM_Point\.position>\s*<zmn:DirectPosition>\s*<zmn:X>([-\d.]+)<\/zmn:X>\s*<zmn:Y>([-\d.]+)<\/zmn:Y>/g;
	let m;
	while((m=pr.exec(xml))!==null) pointMap.set(m[1],{x:parseFloat(m[2]),y:parseFloat(m[3])});

	// GM_Curve
	const curveMap=new Map();
	const cr=/<zmn:GM_Curve id="(C\d+)">([\s\S]*?)<\/zmn:GM_Curve>/g;
	while((m=cr.exec(xml))!==null){
		const id=m[1],body=m[2];
		const ori=(body.match(/<zmn:GM_OrientablePrimitive\.orientation>([+-])/)||[])[1]||'+';
		const pts=[];
		const dr=/<zmn:GM_Position\.direct>\s*<zmn:X>([-\d.]+)<\/zmn:X>\s*<zmn:Y>([-\d.]+)<\/zmn:Y>\s*<\/zmn:GM_Position\.direct>/g;
		let dm;
		while((dm=dr.exec(body))!==null) pts.push({x:parseFloat(dm[1]),y:parseFloat(dm[2])});
		if(!pts.length){
			const ir=/<zmn:GM_PointRef\.point idref="(P\d+)"\/>/g;
			let im;
			while((im=ir.exec(body))!==null){const p=pointMap.get(im[1]);if(p)pts.push(p);}
		}
		curveMap.set(id,{pts,ori});
	}
	pointMap.clear();

	// GM_Surface
	const surfaceMap=new Map();
	const getCIds=str=>{const ids=[],g=/<zmn:GM_CompositeCurve\.generator idref="(C\d+)"\/>/g;let gm;while((gm=g.exec(str))!==null)ids.push(gm[1]);return ids;};
	const sr=/<zmn:GM_Surface id="(F\d+)">([\s\S]*?)<\/zmn:GM_Surface>/g;
	while((m=sr.exec(xml))!==null){
		const id=m[1],body=m[2];
		const extM=body.match(/<zmn:GM_SurfaceBoundary\.exterior>([\s\S]*?)<\/zmn:GM_SurfaceBoundary\.exterior>/);
		const ints=[],intR=/<zmn:GM_SurfaceBoundary\.interior>([\s\S]*?)<\/zmn:GM_SurfaceBoundary\.interior>/g;
		let im;
		while((im=intR.exec(body))!==null)ints.push(getCIds(im[1]));
		surfaceMap.set(id,{ext:extM?getCIds(extM[1]):[],ints});
	}

	const buildRing=cids=>{
		const pts=[];
		for(const cid of cids){
			const c=curveMap.get(cid);if(!c||!c.pts.length)continue;
			const cp=c.ori==='-'?[...c.pts].reverse():c.pts;
			pts.push(...(pts.length?cp.slice(1):cp));
		}
		if(pts.length>1){const f=pts[0],l=pts[pts.length-1];if(f.x!==l.x||f.y!==l.y)pts.push(f);}
		return pts.map(({x,y})=>planeToLatLon(x,y,sysNum));
	};

	// 筆
	const fr=/<筆 id="(H\d+)">([\s\S]*?)<\/筆>/g;
	while((m=fr.exec(xml))!==null){
		const body=m[2];
		const tag=t=>(body.match(new RegExp(`<${t}>(.*?)</${t}>`))||[])[1]||'';
		const fid=(body.match(/<形状 idref="(F\d+)"\/>/)||[])[1];
		if(!fid)continue;
		const s=surfaceMap.get(fid);if(!s)continue;
		const ext=buildRing(s.ext);if(ext.length<4)continue;
		yield {
			type:'Feature',
			geometry:{type:'Polygon',coordinates:[ext,...s.ints.map(buildRing)]},
			properties:{市区町村コード:cityCode,市区町村名:cityName,大字コード:tag('大字コード'),
				大字名:tag('大字名'),丁目コード:tag('丁目コード'),小字コード:tag('小字コード'),
				地番:tag('地番'),精度区分:tag('精度区分'),座標値種別:tag('座標値種別')},
		};
	}
}

// ============================================================
// 1エントリ処理: fetch → convert → GeoJSONL Buffer を返す
// ============================================================
async function processEntry(entry) {
	// fetch (redirect自動追従)
	const res = await fetch(entry.url, { redirect: 'follow' });
	if (!res.ok) throw new Error(`HTTP ${res.status} ${entry.url}`);
	const outerBuf = Buffer.from(await res.arrayBuffer());

	const outerZip  = new AdmZip(outerBuf);
	const innerZips = outerZip.getEntries().filter(e => e.entryName.endsWith('.zip'));

	// 先行スキャン: 番号付き公共座標系を探す (任意座標系のフォールバック用)
	const prefCode = entry.cityCode?.slice(0, 2) || '13';
	let knownSysNum = PREF_SYS[prefCode] || 9;
	for (const iz of innerZips) {
		const iz2 = new AdmZip(iz.getData());
		const xe = iz2.getEntries().find(e => e.entryName.endsWith('.xml'));
		if (!xe) continue;
		const tag = (xe.getData().toString('utf8').match(/<座標系>(.*?)<\/座標系>/) || [])[1] || '';
		if (!/任意/.test(tag)) { const n = parseSysNum(tag); if (n) { knownSysNum = n; break; } }
	}

	const lines = [];
	for (const iz of innerZips) {
		const innerZip = new AdmZip(iz.getData());
		const xmlEntry = innerZip.getEntries().find(e => e.entryName.endsWith('.xml'));
		if (!xmlEntry) continue;
		const xml = xmlEntry.getData().toString('utf-8');
		for (const feat of xmlToFeatures(xml, knownSysNum)) {
			lines.push(JSON.stringify(feat));
		}
	}
	return lines.join('\n');
}

// ============================================================
// メイン
// ============================================================
async function main() {
	const args     = process.argv.slice(2);
	const dryRun   = args.includes('--dry-run');
	const startIdx = args.indexOf('--start');
	const startAt  = startIdx >= 0 ? (parseInt(args[startIdx + 1]) || 0) : 0;
	const codeIdx  = args.indexOf('--code');
	const onlyCode = codeIdx >= 0 ? args[codeIdx + 1] : null;

	const manifest = JSON.parse(readFileSync(join(__dir, 'manifest.json'), 'utf8'));

	// 進捗ファイル (処理済みキーのセット)
	const progress = existsSync(PROGRESS_FILE)
		? new Set(JSON.parse(readFileSync(PROGRESS_FILE,'utf8')))
		: new Set();

	// 処理対象を絞り込み
	let targets = manifest;
	if (onlyCode) targets = targets.filter(e => e.cityCode === onlyCode);
	targets = targets.filter((e, i) => i >= startAt && !progress.has(e.resourceId));

	console.log(`\n法務省 登記所備付地図 全国バッチ変換`);
	console.log(`  対象エントリ: ${targets.length} / ${manifest.length}`);
	console.log(`  処理済みスキップ: ${progress.size}`);
	if (dryRun) { console.log('  [DRY RUN] 処理せず終了'); return; }

	// バケット接続
	const bucket = await Bucket(BUCKET_DIR, { baseUrl:`${API_BASE}/bucket/`, apiKey:API_KEY, silent:true });
	if (!bucket) { console.error('バケット接続失敗'); process.exit(1); }

	let done=0, errors=0;
	const t0=Date.now();

	// 市区町村コードごとにグループ化（複数ゾーンは追記マージ）
	const byCity = {};
	for (const e of targets) {
		if (!byCity[e.cityCode]) byCity[e.cityCode] = [];
		byCity[e.cityCode].push(e);
	}
	const cityEntries = Object.values(byCity);

	for (const entries of cityEntries) {
		const cityCode = entries[0].cityCode;
		const cityName = entries[0].title?.replace(/（[^）]*）.*$/, '').replace(/\s*登記所備付地図.*$/, '').trim() || cityCode;

		try {
			// 複数ゾーンは全部処理してから1ファイルにマージ (途中失敗は全体リトライ)
			const allLines = [];
			for (const entry of entries) {
				allLines.push(await processEntry(entry));
			}

			const content = allLines.filter(Boolean).join('\n');
			if (content) {
				const blob = new Blob([content], { type: 'application/geo+json-seq' });
				await bucket.put(`${cityCode}.geojsonl`, blob);
			}

			// アップロード成功後に進捗マーク
			for (const entry of entries) progress.add(entry.resourceId);
			done++;
			const elapsed = ((Date.now()-t0)/1000).toFixed(0);
			const remain  = done < cityEntries.length ? Math.round((Date.now()-t0)/done*(cityEntries.length-done)/1000) : 0;
			process.stdout.write(`\r  [${done}/${cityEntries.length}] ${cityCode} ${cityName.slice(0,10).padEnd(10)} | 経過:${elapsed}s 残:${remain}s  `);

		} catch (e) {
			errors++;
			process.stdout.write(`\n  ⚠️  ${cityCode} ${e.message.slice(0,60)}\n`);
		}

		// 10件ごとに進捗保存
		if (done % 10 === 0) writeFileSync(PROGRESS_FILE, JSON.stringify([...progress]));
	}

	writeFileSync(PROGRESS_FILE, JSON.stringify([...progress]));
	console.log(`\n\n✅ 完了: ${done}/${cityEntries.length} (エラー: ${errors})`);
	console.log(`   所要時間: ${((Date.now()-t0)/1000/60).toFixed(1)} 分`);
}

main().catch(console.error);
