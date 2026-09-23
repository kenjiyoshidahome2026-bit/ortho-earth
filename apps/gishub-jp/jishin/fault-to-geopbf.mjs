/**
 * 震源断層モデル（地震本部「全国地震動予測地図 2009年版 別冊2」）→ GeoJSON ＋ GeoPBF
 *
 *   https://www.jishin.go.jp/main/chousa/09_yosokuchizu/b2_parameter.csv （CP932・233 データ行）
 *
 * ■ これは活断層のトレース（実測の断層線）ではない。地震動を計算するために置いた
 *   「地中断層モデル」＝矩形断層面の上端辺で、原点・長さ・走向から直線で起こす。
 *   地表の断層形状を知りたいなら産総研の活断層データベースか J-SHIS の断層モデルが本命。
 *   地震本部サイトが自前で配っている唯一のジオメトリ源なのでここに置く（2026-09-23 調査）。
 *
 * ■ 区間行の連結：断層番号も原点も空の行＝直前の区間の終点から続く区間（地震本部の作法）。
 *   親行の「長期評価長さ」が子区間のモデル長さの和に一致することで裏を取った（177 本中 137 本・
 *   残りは子区間が独自の原点を持つ＝独立した区間）。連結で置いた線には chained を立てる。
 *
 * 出力:
 *   jishin/fault.geojson         … canonical
 *   public/jishin/fault.geopbf   … 描画用
 *
 * node jishin/fault-to-geopbf.mjs
 */
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { encodeGeoPBF } from '../scripts/geopbf-encode.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = 'https://www.jishin.go.jp/main/chousa/09_yosokuchizu/b2_parameter.csv';

// GRS80（測地成果 2011 と同じ楕円体）。Vincenty 順解法＝原点から方位角・距離で終点を出す。
// 球近似でも 100km なら誤差 0.5% 程度だが、測量のデータを扱う以上は楕円体で置く。
const A = 6378137.0, F = 1 / 298.257222101, B = A * (1 - F);
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
function vincentyDirect(lat1, lon1, azDeg, distM) {
    const a1 = azDeg * D2R, s = distM;
    const tanU1 = (1 - F) * Math.tan(lat1 * D2R);
    const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1), sinU1 = tanU1 * cosU1;
    const sinA1 = Math.sin(a1), cosA1 = Math.cos(a1);
    const s1 = Math.atan2(tanU1, cosA1);
    const sinA = cosU1 * sinA1, cosSqA = 1 - sinA * sinA;
    const uSq = cosSqA * (A * A - B * B) / (B * B);
    const AA = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
    const BB = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
    let sig = s / (B * AA), sigP, cos2sm = 0, sinSig = 0, cosSig = 0, dSig = 0, i = 0;
    do {
        cos2sm = Math.cos(2 * s1 + sig);
        sinSig = Math.sin(sig); cosSig = Math.cos(sig);
        dSig = BB * sinSig * (cos2sm + BB / 4 * (cosSig * (-1 + 2 * cos2sm * cos2sm)
             - BB / 6 * cos2sm * (-3 + 4 * sinSig * sinSig) * (-3 + 4 * cos2sm * cos2sm)));
        sigP = sig; sig = s / (B * AA) + dSig;
    } while (Math.abs(sig - sigP) > 1e-12 && ++i < 100);
    const tmp = sinU1 * sinSig - cosU1 * cosSig * cosA1;
    const lat2 = Math.atan2(sinU1 * cosSig + cosU1 * sinSig * cosA1, (1 - F) * Math.hypot(sinA, tmp));
    const lam = Math.atan2(sinSig * sinA1, cosU1 * cosSig - sinU1 * sinSig * cosA1);
    const C = F / 16 * cosSqA * (4 + F * (4 - 3 * cosSqA));
    const L = lam - (1 - C) * F * sinA * (sig + C * sinSig * (cos2sm + C * cosSig * (-1 + 2 * cos2sm * cos2sm)));
    return [lon1 + L * R2D, lat2 * R2D];
}

function parseLine(l) {
    const out = []; let cur = '', q = false;
    for (const ch of l) {
        if (ch === '"') q = !q;
        else if (ch === ',' && !q) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur); return out;
}
const txt = v => (v || '').trim() || null;
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

async function main() {
    const resp = await fetch(SRC, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) throw new Error(`b2_parameter.csv: HTTP ${resp.status}`);
    const text = new TextDecoder('shift-jis').decode(new Uint8Array(await resp.arrayBuffer()));
    const rows = text.split(/\r?\n/).filter(l => l.trim()).slice(1).map(parseLine);

    const features = [];
    let carry = null;                       // 直前の区間の終点（連結用）
    let no = null, band = null, fault = null;
    let chainedN = 0, skipped = 0;
    for (const c of rows) {
        // 断層番号・断層帯名・起震断層名は親行にだけ入る＝下の行へ引き継ぐ
        if (txt(c[0])) { no = txt(c[0]); band = txt(c[1]); fault = txt(c[2]); carry = null; }
        else { if (txt(c[1])) band = txt(c[1]); if (txt(c[2])) fault = txt(c[2]); }

        const len = num(c[13]), strike = num(c[19]);
        let lat = num(c[10]), lon = num(c[11]), chained = false;
        if (lat === null || lon === null) {   // モデル原点が無ければ長期評価原点、それも無ければ直前の終点から続く
            lat = num(c[4]); lon = num(c[5]);
            if (lat === null || lon === null) {
                if (!carry || len === null || strike === null) { skipped++; continue; }
                [lon, lat] = carry; chained = true; chainedN++;
            }
        }
        if (len === null || strike === null) { skipped++; continue; }

        const end = vincentyDirect(lat, lon, strike, len * 1000);
        carry = end;
        features.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: [[+lon.toFixed(7), +lat.toFixed(7)], [+end[0].toFixed(7), +end[1].toFixed(7)]] },
            properties: {
                no, band, fault, seg: txt(c[3]),
                mjma: num(c[7]) ?? num(c[16]), mw: num(c[9]),
                len, width: num(c[14]), area: num(c[15]), top: num(c[12]),
                strike, dip: num(c[20]), rake: num(c[21]),
                slip: num(c[23]), chained: chained || null,
            },
        });
    }

    const geojson = { type: 'FeatureCollection', features };
    writeFileSync(join(__dir, 'fault.geojson'), JSON.stringify(geojson));
    const raw = encodeGeoPBF(features, {
        name: 'fault',
        description: '震源断層モデル 上端トレース（全国地震動予測地図 2009年版 別冊2）',
        license: '地震調査研究推進本部',
        attribution: '地震調査研究推進本部（地震本部）',
    });
    mkdirSync(join(__dir, '../public/jishin'), { recursive: true });
    writeFileSync(join(__dir, '../public/jishin/fault.geopbf'), raw);

    const bands = new Set(features.map(f => f.properties.band).filter(Boolean));
    console.log(`区間: ${features.length}（うち直前から連結 ${chainedN} / 座標も走向も無く落とした行 ${skipped}）`);
    console.log(`断層帯: ${bands.size}`);
    console.log(`GeoPBF : public/jishin/fault.geopbf (${(raw.length/1024).toFixed(1)} KB)`);
}
main().catch(e => { console.error(e); process.exit(1); });
