/**
 * 法務省 登記所備付地図データ (地図XML) → GeoJSON 変換スクリプト
 *
 * 入力: 市区町村単位の ZIP of ZIPs (G空間情報センターからDL)
 * 出力: {市区町村コード}.geojson (筆ポリゴン)
 *
 * 使い方:
 *   node moj-convert.js <zipfile> [outdir]
 *   node moj-convert.js 01694-4625-2025.zip ./out
 */
import { mkdirSync, createWriteStream, statSync } from 'fs';
import { join } from 'path';
import AdmZip from 'adm-zip';

// ============================================================
// 公共座標系 (JGD2011 平面直角座標系) → WGS84 変換
// ============================================================
const DEG = Math.PI / 180;
const a  = 6378137.0;           // GRS80 長半径
const f  = 1 / 298.257222101;   // GRS80 扁平率
const e2 = 2 * f - f * f;       // 第1離心率^2
const m0 = 0.9999;              // 縮尺係数

// 19系の原点 (緯度°, 経度°)
const CS_ORIGINS = {
   1: [33, 129.5],
   2: [33, 131],
   3: [36, 132 + 10/60],
   4: [33, 133.5],
   5: [36, 134 + 20/60],
   6: [36, 136],
   7: [36, 137 + 10/60],
   8: [36, 138.5],
   9: [36, 139 + 50/60],
  10: [40, 140 + 50/60],
  11: [44, 140.25],
  12: [44, 142.25],
  13: [44, 144.25],
  14: [26, 142],
  15: [26, 127.5],
  16: [26, 124],
  17: [26, 131],
  18: [20, 136],
  19: [26, 154],
};

// 子午線弧長 (赤道から緯度 phi まで)
function meridianArc(phi) {
  const e4 = e2*e2, e6 = e2*e4;
  return a * (
    (1 - e2/4 - 3*e4/64 - 5*e6/256) * phi
    - (3/8) * (e2 + e4/4 + 15*e6/128) * Math.sin(2*phi)
    + (15/256) * (e4 + 3*e6/4) * Math.sin(4*phi)
    - (35*e6/3072) * Math.sin(6*phi)
  );
}

// 横メルカトル逆変換: 平面直角 (x=北, y=東) → [lon, lat] (度)
function planeToLatLon(x, y, sysNum) {
  const [lat0d, lon0d] = CS_ORIGINS[sysNum] || CS_ORIGINS[9];
  const phi0 = lat0d * DEG;
  const lam0 = lon0d * DEG;

  const M0 = meridianArc(phi0);
  const M  = M0 + x / m0;

  // 等積緯度 mu
  const e4 = e2*e2, e6 = e2*e4;
  const mu = M / (a * (1 - e2/4 - 3*e4/64 - 5*e6/256));

  // 底辺緯度 phi1
  const e1  = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const e12 = e1*e1, e13 = e1*e12, e14 = e1*e13;
  const phi1 = mu
    + (3*e1/2 - 27*e13/32)   * Math.sin(2*mu)
    + (21*e12/16 - 55*e14/32) * Math.sin(4*mu)
    + (151*e13/96)             * Math.sin(6*mu)
    + (1097*e14/512)           * Math.sin(8*mu);

  const sinP = Math.sin(phi1), cosP = Math.cos(phi1), tanP = Math.tan(phi1);
  const ep2 = e2 / (1 - e2);
  const C1  = ep2 * cosP * cosP;
  const T1  = tanP * tanP;
  const N1  = a / Math.sqrt(1 - e2 * sinP * sinP);
  const R1  = a * (1 - e2) / Math.pow(1 - e2 * sinP * sinP, 1.5);
  const D   = y / (N1 * m0);
  const D2 = D*D, D3 = D*D2, D4 = D*D3, D5 = D*D4, D6 = D*D5;

  const phi = phi1 - (N1 * tanP / R1) * (
      D2/2
    - (5 + 3*T1 + 10*C1 - 4*C1*C1 - 9*ep2) * D4/24
    + (61 + 90*T1 + 298*C1 + 45*T1*T1 - 252*ep2 - 3*C1*C1) * D6/720
  );
  const lam = lam0 + (
      D
    - (1 + 2*T1 + C1) * D3/6
    + (5 - 2*C1 + 28*T1 - 3*C1*C1 + 8*ep2 + 24*T1*T1) * D5/120
  ) / cosP;

  return [parseFloat((lam / DEG).toFixed(8)), parseFloat((phi / DEG).toFixed(8))];
}

// 座標系テキスト → 系番号
function parseSysNum(txt) {
  const m = txt && txt.match(/(\d+)系/);
  return m ? parseInt(m[1]) : 9;
}

// ============================================================
// 地図XML パーサー（ジェネレーター — 筆を1件ずつ yield）
// ============================================================
function* parseChizuXmlGen(xml) {
  // --- ヘッダー情報 ---
  const sysNum  = parseSysNum((xml.match(/<座標系>(.*?)<\/座標系>/) || [])[1]);
  const cityCode = (xml.match(/<市区町村コード>(.*?)<\/市区町村コード>/) || [])[1] || '';
  const cityName = (xml.match(/<市区町村名>(.*?)<\/市区町村名>/)       || [])[1] || '';

  // yield メタ情報（最初に1回）
  yield { _meta: true, cityCode, cityName };

  // --- パス1: GM_Point マップ構築 ---
  const pointMap = new Map();
  const pointRe  = /<zmn:GM_Point id="(P\d+)">\s*<zmn:GM_Point\.position>\s*<zmn:DirectPosition>\s*<zmn:X>([-\d.]+)<\/zmn:X>\s*<zmn:Y>([-\d.]+)<\/zmn:Y>/g;
  let m;
  while ((m = pointRe.exec(xml)) !== null) {
    pointMap.set(m[1], { x: parseFloat(m[2]), y: parseFloat(m[3]) });
  }

  // --- パス2: GM_Curve マップ構築 ---
  const curveMap = new Map();
  const curveRe  = /<zmn:GM_Curve id="(C\d+)">([\s\S]*?)<\/zmn:GM_Curve>/g;
  while ((m = curveRe.exec(xml)) !== null) {
    const id = m[1], body = m[2];
    const oriM = body.match(/<zmn:GM_OrientablePrimitive\.orientation>([+-])<\/zmn:GM_OrientablePrimitive\.orientation>/);
    const orientation = oriM ? oriM[1] : '+';
    const pts = [];

    const directRe = /<zmn:GM_Position\.direct>\s*<zmn:X>([-\d.]+)<\/zmn:X>\s*<zmn:Y>([-\d.]+)<\/zmn:Y>\s*<\/zmn:GM_Position\.direct>/g;
    let dm;
    while ((dm = directRe.exec(body)) !== null) {
      pts.push({ x: parseFloat(dm[1]), y: parseFloat(dm[2]) });
    }
    if (pts.length === 0) {
      const indRe = /<zmn:GM_PointRef\.point idref="(P\d+)"\/>/g;
      let im;
      while ((im = indRe.exec(body)) !== null) {
        const p = pointMap.get(im[1]);
        if (p) pts.push(p);
      }
    }
    curveMap.set(id, { pts, orientation });
  }
  // pointMap はもう不要
  pointMap.clear();

  // --- パス3: GM_Surface マップ構築 ---
  const surfaceMap = new Map();
  const extractCurveIds = (str) => {
    const ids = [], gr = /<zmn:GM_CompositeCurve\.generator idref="(C\d+)"\/>/g;
    let gm;
    while ((gm = gr.exec(str)) !== null) ids.push(gm[1]);
    return ids;
  };
  const surfaceRe = /<zmn:GM_Surface id="(F\d+)">([\s\S]*?)<\/zmn:GM_Surface>/g;
  while ((m = surfaceRe.exec(xml)) !== null) {
    const id = m[1], body = m[2];
    const extM = body.match(/<zmn:GM_SurfaceBoundary\.exterior>([\s\S]*?)<\/zmn:GM_SurfaceBoundary\.exterior>/);
    const interior = [];
    const intRe = /<zmn:GM_SurfaceBoundary\.interior>([\s\S]*?)<\/zmn:GM_SurfaceBoundary\.interior>/g;
    let im;
    while ((im = intRe.exec(body)) !== null) interior.push(extractCurveIds(im[1]));
    surfaceMap.set(id, { exterior: extM ? extractCurveIds(extM[1]) : [], interior });
  }

  // --- カーブ列 → WGS84 リング ---
  const buildRing = (curveIds) => {
    const pts = [];
    for (const cid of curveIds) {
      const c = curveMap.get(cid);
      if (!c || !c.pts.length) continue;
      const cpts = c.orientation === '-' ? [...c.pts].reverse() : c.pts;
      pts.push(...(pts.length ? cpts.slice(1) : cpts));
    }
    if (pts.length > 1) {
      const f = pts[0], l = pts[pts.length - 1];
      if (f.x !== l.x || f.y !== l.y) pts.push(f);
    }
    return pts.map(({ x, y }) => planeToLatLon(x, y, sysNum));
  };

  // --- パス4: 筆ごとに yield ---
  const fudRe = /<筆 id="(H\d+)">([\s\S]*?)<\/筆>/g;
  while ((m = fudRe.exec(xml)) !== null) {
    const body = m[2];
    const tag  = (t) => (body.match(new RegExp(`<${t}>(.*?)</${t}>`)) || [])[1] || '';
    const fid  = (body.match(/<形状 idref="(F\d+)"\/>/)||[])[1];
    if (!fid) continue;
    const surface = surfaceMap.get(fid);
    if (!surface) continue;

    const exterior  = buildRing(surface.exterior);
    if (exterior.length < 4) continue;
    const interiors = surface.interior.map(buildRing);

    yield {
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [exterior, ...interiors] },
      properties: {
        市区町村コード: cityCode,
        市区町村名:    cityName,
        大字コード:    tag('大字コード'),
        大字名:        tag('大字名'),
        丁目コード:    tag('丁目コード'),
        小字コード:    tag('小字コード'),
        地番:          tag('地番'),
        精度区分:      tag('精度区分'),
        座標値種別:    tag('座標値種別'),
      },
    };
  }
  // curveMap / surfaceMap はここで GC 対象に
}

// ============================================================
// メイン
// ============================================================
async function main() {
  const [,, zipPath, outDir = '.'] = process.argv;
  if (!zipPath) { console.error('Usage: node moj-convert.js <zipfile> [outdir]'); process.exit(1); }

  mkdirSync(outDir, { recursive: true });

  const outerZip    = new AdmZip(zipPath);
  const innerZips   = outerZip.getEntries().filter(e => e.entryName.endsWith('.zip'));
  const total       = innerZips.length;

  console.log(`ZIP: ${zipPath}`);
  console.log(`内側ZIP: ${total} 件`);

  let cityCode = '', cityName = '', outPath = '', count = 0;
  let stream = null;

  for (let i = 0; i < innerZips.length; i++) {
    process.stdout.write(`\r  [${i+1}/${total}] ${innerZips[i].entryName.padEnd(36)}`);

    const innerZip = new AdmZip(innerZips[i].getData());
    const xmlEntry = innerZip.getEntries().find(e => e.entryName.endsWith('.xml'));
    if (!xmlEntry) continue;

    const xml = xmlEntry.getData().toString('utf-8');

    for (const item of parseChizuXmlGen(xml)) {
      if (item._meta) {
        // 最初の XML からメタ情報を取得してファイルをオープン
        if (!stream) {
          cityCode = item.cityCode;
          cityName = item.cityName;
          outPath  = join(outDir, `${cityCode || 'unknown'}.geojson`);
          stream   = createWriteStream(outPath, { encoding: 'utf8' });
          stream.write('{"type":"FeatureCollection","features":[\n');
        }
        continue;
      }
      if (count > 0) stream.write(',\n');
      stream.write(JSON.stringify(item));
      count++;
    }
    // XML バッファと各マップは GC 対象に
  }

  if (stream) {
    stream.write('\n]}');
    await new Promise(r => stream.end(r));
  }

  const sizeMB = (statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`\n\n✅ ${cityName} (${cityCode})`);
  console.log(`   筆数: ${count.toLocaleString()}`);
  console.log(`   出力: ${outPath} (${sizeMB} MB)`);
}

main().catch(console.error);
