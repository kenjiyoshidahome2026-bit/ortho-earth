/**
 * 法務省 登記所備付地図 ZIP/XML → GeoPBF バッチ変換・サーバーアップロード
 *
 * moj-manifest.json のうち moj-geojson.json に GeoJSON がない市区町村を対象に、
 * ZIP → XML 解析 → GeoPBF エンコード → native-bucket アップロード を行う。
 *
 * 使い方:
 *   node moj-xml-to-pbf.js             # 未処理の全件
 *   node moj-xml-to-pbf.js --dry-run   # ダウンロードせず対象一覧のみ表示
 *   node moj-xml-to-pbf.js --code 03305
 */
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { Bucket } from '../../packages/native-bucket/src/Bucket.js';
import Pbf from 'pbf';
import AdmZip from 'adm-zip';

const API_BASE    = 'https://api.ortho-earth.com';
const API_KEY     = 'my-lovely-dog-betty-was-born-on-2019-09-01';
const BUCKET_DIR  = 'moj';
const PROGRESS_FILE = 'moj-pbf-progress.json';
const MIN_SIZE    = 5000; // バイト未満は空データとみなしてスキップ

// ============================================================
// 座標変換 (公共座標系 → WGS84)
// ============================================================
const DEG = Math.PI / 180;
const a = 6378137.0, f = 1/298.257222101;
const e2 = 2*f - f*f, m0 = 0.9999;
const CS_ORIGINS = {
   1:[33,129.5],  2:[33,131],     3:[36,132+10/60], 4:[33,133.5],
   5:[36,134+20/60], 6:[36,136],  7:[36,137+10/60], 8:[36,138.5],
   9:[36,139+50/60], 10:[40,140+50/60],
  11:[44,140.25], 12:[44,142.25], 13:[44,144.25],
  14:[26,142],    15:[26,127.5],  16:[26,124],
  17:[26,131],    18:[20,136],    19:[26,154],
};
const PREF_SYS = {
  '01':12,'02':10,'03':10,'04':10,'05':10,'06':10,'07':9,'08':9,'09':9,'10':8,
  '11':9, '12':9, '13':9, '14':9, '15':8, '16':7, '17':7, '18':6, '19':8,
  '20':8, '21':7, '22':8, '23':7, '24':6, '25':6, '26':6, '27':6, '28':5,
  '29':6, '30':5, '31':4, '32':3, '33':4, '34':4, '35':2, '36':4, '37':4,
  '38':4, '39':5, '40':2, '41':1, '42':1, '43':2, '44':2, '45':2, '46':2, '47':15,
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
// XML → Feature[] (座標変換済み)
// ============================================================
function* xmlToFeatures(xml, defaultSysNum=9) {
  const sysTag=(xml.match(/<座標系>(.*?)<\/座標系>/)||[])[1]||'';
  const sysNum=/任意/.test(sysTag)?defaultSysNum:(parseSysNum(sysTag)||defaultSysNum);
  const cityCode=(xml.match(/<市区町村コード>(.*?)<\/市区町村コード>/)||[])[1]||'';
  const cityName=(xml.match(/<市区町村名>(.*?)<\/市区町村名>/)||[])[1]||'';
  const pointMap=new Map();
  const pr=/<zmn:GM_Point id="(P\d+)">\s*<zmn:GM_Point\.position>\s*<zmn:DirectPosition>\s*<zmn:X>([-\d.]+)<\/zmn:X>\s*<zmn:Y>([-\d.]+)<\/zmn:Y>/g;
  let m;
  while((m=pr.exec(xml))!==null) pointMap.set(m[1],{x:parseFloat(m[2]),y:parseFloat(m[3])});
  const curveMap=new Map();
  const cr=/<zmn:GM_Curve id="(C\d+)">([\s\S]*?)<\/zmn:GM_Curve>/g;
  while((m=cr.exec(xml))!==null){
    const id=m[1],body=m[2];
    const ori=(body.match(/<zmn:GM_OrientablePrimitive\.orientation>([+-])/)||[])[1]||'+';
    const pts=[];
    const dr=/<zmn:GM_Position\.direct>\s*<zmn:X>([-\d.]+)<\/zmn:X>\s*<zmn:Y>([-\d.]+)<\/zmn:Y>\s*<\/zmn:GM_Position\.direct>/g;
    let dm;
    while((dm=dr.exec(body))!==null) pts.push({x:parseFloat(dm[1]),y:parseFloat(dm[2])});
    if(!pts.length){const ir=/<zmn:GM_PointRef\.point idref="(P\d+)"\/>/g;let im;while((im=ir.exec(body))!==null){const p=pointMap.get(im[1]);if(p)pts.push(p);}}
    curveMap.set(id,{pts,ori});
  }
  pointMap.clear();
  const surfaceMap=new Map();
  const getCIds=str=>{const ids=[],g=/<zmn:GM_CompositeCurve\.generator idref="(C\d+)"\/>/g;let gm;while((gm=g.exec(str))!==null)ids.push(gm[1]);return ids;};
  const sr=/<zmn:GM_Surface id="(F\d+)">([\s\S]*?)<\/zmn:GM_Surface>/g;
  while((m=sr.exec(xml))!==null){
    const id=m[1],body=m[2];
    const extM=body.match(/<zmn:GM_SurfaceBoundary\.exterior>([\s\S]*?)<\/zmn:GM_SurfaceBoundary\.exterior>/);
    const ints=[],intR=/<zmn:GM_SurfaceBoundary\.interior>([\s\S]*?)<\/zmn:GM_SurfaceBoundary\.interior>/g;let im;
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
// 軽量 GeoPBF エンコーダー（Polygon + 文字列プロパティのみ）
// ============================================================
const GEOPBF_TAGS = { NAME:1, KEYS:2, PRECISION:3, FARRAY:5, FEATURE:6, GEOMETRY:7, GTYPE:8, LENGTH:9, COORDS:10, VALUE:11, INDEX:12, DESCRIPTION:14, LICENSE:15, ATTRIBUTION:16 };
const STR_TYPE = 4; // DATATYPE.STRING

function encodeToPbf(features, { name, description='', license='', attribution='', precision=7 }) {
  const KEYS = ['市区町村コード','市区町村名','大字コード','大字名','丁目コード','小字コード','地番','精度区分','座標値種別'];
  const fmap = {};
  KEYS.forEach((k, i) => fmap[k] = i);
  const e = Math.pow(10, precision);

  const pbf = new Pbf();

  // Header
  pbf.writeStringField(GEOPBF_TAGS.NAME, name || '');
  if (description) pbf.writeStringField(GEOPBF_TAGS.DESCRIPTION, description);
  if (license)     pbf.writeStringField(GEOPBF_TAGS.LICENSE, license);
  if (attribution) pbf.writeStringField(GEOPBF_TAGS.ATTRIBUTION, attribution);
  pbf.writeVarintField(GEOPBF_TAGS.PRECISION, precision);
  for (const k of KEYS) pbf.writeStringField(GEOPBF_TAGS.KEYS, k);

  // Body
  pbf.writeMessage(GEOPBF_TAGS.FARRAY, () => {
    for (const feat of features) {
      pbf.writeMessage(GEOPBF_TAGS.FEATURE, () => {
        // Geometry (Polygon = type 4)
        pbf.writeMessage(GEOPBF_TAGS.GEOMETRY, () => {
          const rings = feat.geometry.coordinates.map(ring => {
            const src = [];
            let lastX = null, lastY = null;
            for (let i = 0; i < ring.length - 1; i++) { // skip closing point
              const x = Math.round(ring[i][0] * e);
              const y = Math.round(ring[i][1] * e);
              if (x !== lastX || y !== lastY) { src.push([x, y]); lastX = x; lastY = y; }
            }
            // delta encoding
            const deltas = []; let sx = 0, sy = 0;
            for (const [x, y] of src) { deltas.push(x - sx, y - sy); sx = x; sy = y; }
            return { n: src.length, deltas };
          }).filter(r => r.n >= 3);

          if (!rings.length) return;
          pbf.writeVarintField(GEOPBF_TAGS.GTYPE, 4); // Polygon
          pbf.writePackedVarint(GEOPBF_TAGS.LENGTH, rings.map(r => r.n));
          pbf.writePackedSVarint(GEOPBF_TAGS.COORDS, rings.flatMap(r => r.deltas));
        });

        // Properties
        const index = [], props = feat.properties || {};
        for (const key of KEYS) {
          const v = props[key];
          if (v != null) {
            pbf.writeMessage(GEOPBF_TAGS.VALUE, () => pbf.writeStringField(STR_TYPE, String(v)));
            index.push(fmap[key]);
          }
        }
        pbf.writePackedVarint(GEOPBF_TAGS.INDEX, index);
      });
    }
  });

  const end = pbf.pos;
  pbf.finish();
  return Buffer.from(pbf.buf.buffer.slice(0, end));
}

// ============================================================
// 1市区町村処理: ZIP → features[] → GeoPBF Buffer
// ============================================================
async function processCity(entries) {
  const prefCode = entries[0].cityCode?.slice(0, 2) || '13';
  let defaultSys = PREF_SYS[prefCode] || 9;

  // ZIP ダウンロード
  const allFeatures = [];
  for (const entry of entries) {
    const res = await fetch(entry.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const outerZip = new AdmZip(buf);
    const innerZips = outerZip.getEntries().filter(e => e.entryName.endsWith('.zip'));

    // 座標系を先行スキャン（任意座標系対応）
    for (const iz of innerZips) {
      const iz2 = new AdmZip(iz.getData());
      const xe = iz2.getEntries().find(e => e.entryName.endsWith('.xml'));
      if (!xe) continue;
      const tag = (xe.getData().toString('utf8').match(/<座標系>(.*?)<\/座標系>/) || [])[1] || '';
      if (!/任意/.test(tag)) { const n = parseSysNum(tag); if (n) { defaultSys = n; break; } }
    }

    for (const iz of innerZips) {
      const iz2 = new AdmZip(iz.getData());
      const xe = iz2.getEntries().find(e => e.entryName.endsWith('.xml'));
      if (!xe) continue;
      const xml = xe.getData().toString('utf-8');
      for (const feat of xmlToFeatures(xml, defaultSys)) allFeatures.push(feat);
    }
  }

  if (!allFeatures.length) return null;

  const e0 = entries[0];
  const cityName = e0.title?.replace(/（[^）]*）.*$/, '').replace(/\s*登記所備付地図.*$/, '').trim() || e0.cityCode;
  return encodeToPbf(allFeatures, {
    name:        e0.cityCode,
    description: cityName + ' 登記所備付地図 筆ポリゴン',
    attribution: '法務省 登記所備付地図',
    license:     'CC_BY_4.0',
    precision:   7,
  });
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const args    = process.argv.slice(2);
  const dryRun  = args.includes('--dry-run');
  const codeIdx = args.indexOf('--code');
  const onlyCode = codeIdx >= 0 ? args[codeIdx + 1] : null;

  const manifest = JSON.parse(readFileSync('moj-manifest.json', 'utf8'));
  const geojson  = JSON.parse(readFileSync('moj-geojson.json',  'utf8'));
  const gjCodes  = new Set(geojson.map(e => e.name.slice(0, 5)));

  // GeoJSON のない市区町村だけを対象
  const byCity = {};
  for (const e of manifest) {
    if (gjCodes.has(e.cityCode)) continue;
    if (onlyCode && e.cityCode !== onlyCode) continue;
    if (!byCity[e.cityCode]) byCity[e.cityCode] = [];
    byCity[e.cityCode].push(e);
  }
  const cityEntries = Object.values(byCity);

  // サイズ 0 or 極小はスキップ
  const targets = cityEntries.filter(entries =>
    entries.some(e => (e.size || 0) >= MIN_SIZE)
  );
  const skipped = cityEntries.length - targets.length;

  console.log(`\n法務省 ZIP/XML → GeoPBF バッチ変換`);
  console.log(`  対象: ${targets.length} 市区町村 (スキップ ${skipped} 件 < ${MIN_SIZE}B)`);
  if (dryRun) {
    for (const entries of targets) {
      const e0 = entries[0];
      const sz = entries.reduce((s,e)=>s+(e.size||0),0);
      const name = e0.title?.replace(/（[^）]*）.*$/,'').replace(/\s*登記所備付地図.*$/,'').trim();
      console.log(`  ${e0.cityCode} ${name} ${(sz/1024/1024).toFixed(1)}MB`);
    }
    return;
  }

  const progress = existsSync(PROGRESS_FILE)
    ? new Set(JSON.parse(readFileSync(PROGRESS_FILE, 'utf8')))
    : new Set();

  const remaining = targets.filter(entries => !progress.has(entries[0].cityCode));
  console.log(`  処理済みスキップ: ${targets.length - remaining.length}  残り: ${remaining.length}`);

  const bucket = await Bucket(BUCKET_DIR, { baseUrl:`${API_BASE}/bucket/`, apiKey:API_KEY, silent:true });
  if (!bucket) { console.error('バケット接続失敗'); process.exit(1); }

  let done = 0, errors = 0;
  const t0 = Date.now();

  for (const entries of remaining) {
    const cityCode = entries[0].cityCode;
    const name = entries[0].title?.replace(/（[^）]*）.*$/, '').replace(/\s*登記所備付地図.*$/, '').trim() || cityCode;
    try {
      const buf = await processCity(entries);
      if (buf) {
        await bucket.put(`${cityCode}.pbf`, new Blob([buf], { type: 'application/octet-stream' }));
        progress.add(cityCode);
        done++;
        const elapsed = ((Date.now()-t0)/1000).toFixed(0);
        process.stdout.write(`\r  [${done}/${remaining.length}] ${cityCode} ${name.slice(0,10).padEnd(10)} ${(buf.length/1024).toFixed(0)}KB | ${elapsed}s  `);
      } else {
        console.log(`\n  skip ${cityCode} (features=0)`);
        progress.add(cityCode);
      }
    } catch (err) {
      errors++;
      console.log(`\n  ⚠️  ${cityCode} ${err.message?.slice(0, 60)}`);
    }
    if ((done + errors) % 5 === 0) writeFileSync(PROGRESS_FILE, JSON.stringify([...progress]));
  }

  writeFileSync(PROGRESS_FILE, JSON.stringify([...progress]));
  console.log(`\n\n✅ 完了: ${done} 件アップロード  エラー: ${errors}`);

  genManifest(manifest, progress);
}

function genManifest(manifest, uploadedCodes) {
  const seen = new Set();
  const entries = [];
  for (const e of manifest) {
    if (!uploadedCodes.has(e.cityCode) || seen.has(e.cityCode)) continue;
    seen.add(e.cityCode);
    const name = e.title?.replace(/（[^）]*）.*$/, '').replace(/\s*登記所備付地図.*$/, '').trim() || e.cityCode;
    entries.push({
      cityCode:    e.cityCode,
      name:        `${e.cityCode}_${name}_登記所備付地図`,
      description: `${name} 登記所備付地図 筆ポリゴン`,
      target:      `${API_BASE}/bucket/${BUCKET_DIR}/${e.cityCode}.pbf`,
      attribution: '法務省 登記所備付地図',
      license:     'CC_BY_4.0',
    });
  }
  entries.sort((a, b) => a.cityCode.localeCompare(b.cityCode));
  writeFileSync('moj-pbf-manifest.json', JSON.stringify(entries, null, 2));
  console.log(`→ moj-pbf-manifest.json  ${entries.length} 件`);
}

main().catch(console.error);
