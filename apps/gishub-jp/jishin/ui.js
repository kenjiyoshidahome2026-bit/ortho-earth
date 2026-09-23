// 地震観測施設レイヤー（静的GeoPBF配信・独立モジュール）
// 出所は地震調査研究推進本部（地震本部）。11 観測網（地震計・GNSS・重力・電磁気・海底・歪・検潮・地下水）を統合し、
// 2013〜2026 年版を重ね合わせて「掲載初年／最終年」を持たせてある（最終年が最新でない点＝その後の版から消えた観測点）。
// public/jishin/seismic.geopbf を自前fetch → geopbf(buffer) デコード → execGlobeView 描画。
// 生成は jishin/seismic-to-geopbf.mjs。突合の正本は jishin/seismic.geojson（uid を持つ）。
import { geopbf } from '../ui/gpbf.js';
import { execGlobeView } from '../ui/globe.js';

// 観測網＝生成側 NETS の tag と対。GeoPBF は符号で持ち、名前はここで開く
const NET = {
    HS: '高感度地震計', BB: '広帯域地震計', SG: '強震計（地上）', SU: '強震計（地下）',
    GN: 'GNSS・SLR・VLBI', GV: '重力', MG: '地球電磁気', SF: '海底地殻変動',
    ST: '歪計・傾斜計等', TS: '検潮・津波', WA: '地下水観測井',
};

const SEISMIC_DS = {
    title: '地震観測施設',
    attributes: {
        net: '観測網', kind: '観測の種類', name: '観測点名', alias: '旧名称', romaji: 'ローマ字', code: 'コード',
        org: '保守管理機関', alt: '標高 (m)', depth: '観測の深さ (m)', equip: '観測機種',
        start: '観測開始年', first: '掲載初年', last: '掲載最終年',
    },
    codelist: { net: NET },
};


// 掲載最終年が最新版なら「現存」・それ以前なら「掲載終了」＝2 色に分ける（裁定 2026-09-23）。
// 14 年で増えたより減った方が多い（2013 年 7,837 → 2026 年 7,444）＝その事実が静止画で出る。
const LATEST = 2026;
const C_LIVE = '#FF6B35', C_GONE = '#5C7A99';
const SEISMIC_PAINT = {
    'circle-color':  ['case', ['==', ['get', 'last'], LATEST], C_LIVE, C_GONE],
    'circle-radius': ['case', ['==', ['get', 'last'], LATEST], 1.6, 1.1],
};
const _swatch = (c, label, r = 5) =>
    `<div style="display:flex;align-items:center;gap:6px;font-size:11px;line-height:1.7">` +
    `<span style="width:12px;height:12px;display:inline-flex;align-items:center;justify-content:center">` +
    `<span style="width:${r * 2}px;height:${r * 2}px;border-radius:50%;background:${c};display:inline-block"></span></span>` +
    `${label}</div>`;
const SEISMIC_LEGEND =
    `<div style="font-size:12px;font-weight:600;margin-bottom:4px">地震観測施設</div>` +
    _swatch(C_LIVE, `${LATEST}年版に現存 7,444`, 4) +
    _swatch(C_GONE, '掲載終了 1,832', 3) +
    `<div style="font-size:10px;opacity:.7;margin-top:4px;max-width:170px">「掲載」の有無であって設置・廃止ではない</div>`;

let _pbf = null;
export async function showSeismic() {
    if (!_pbf) {
        const res = await fetch(`${import.meta.env.BASE_URL}jishin/seismic.geopbf`);
        if (!res.ok) throw new Error(`seismic.geopbf HTTP ${res.status}`);
        _pbf = await geopbf(await res.arrayBuffer(), { name: 'seismic' });
    }
    execGlobeView(_pbf, SEISMIC_DS, { paint: SEISMIC_PAINT, legend: SEISMIC_LEGEND });
}

// ── 震源断層モデル 上端トレース（全国地震動予測地図 2009年版 別冊2）─────────────
// 活断層のトレース（実測の断層線）ではなく、地震動計算のために置いた矩形断層面の上端辺。
// 地震本部サイトが自前で配っている唯一のジオメトリ源。生成は jishin/fault-to-geopbf.mjs。
const FAULT_DS = {
    title: '震源断層モデル（2009年版）',
    attributes: {
        no: '断層番号', band: '断層帯名', fault: '起震断層名', seg: '区間名',
        mjma: '気象庁マグニチュード', mw: 'モーメントマグニチュード',
        len: 'モデル長さ (km)', width: 'モデル幅 (km)', area: 'モデル面積 (km²)', top: '上端深さ (km)',
        strike: '走向 (N°E)', dip: '傾斜 (°)', rake: 'すべり角 (°)', slip: '平均すべり量 (m)',
        chained: '直前の区間から連結',
    },
    codelist: {},
};


// ── J-SHIS（防災科研）＝クリックした地点に効く震源を寄与順に引く ───────────────
// https://www.j-shis.bosai.go.jp/map/api/fltsearch … CORS 開放・APIキー不要・ブラウザ直読み。
//   mode=C（メッシュ）/ version=Y2024（Y2008〜Y2024）/ case=AVR（平均）/ period=P_T30（30年）
// 返る各件＝rank・score(寄与)・probability(その地震の30年確率)・magnitude・i55_ps(震度6弱以上の確率)・
//   eqgroup（A=震源断層を特定した地震＝活断層／C=海溝型など）・ltename（長期評価の名前）。
// ⚠ 名前で当たるのは全体の約 1/3。外れるのは (1) 海溝型＝2009年版の活断層パラメータ表に線が無い
//   (2) 2009年版に載っていない小さな活断層。当たらなかったものも一覧には必ず出して、
//   「線が無い」ことを画面で言う（光らないものを黙って消さない）。
const JSHIS = 'https://www.j-shis.bosai.go.jp/map/api/fltsearch'
            + '?format=json&mode=C&version=Y2024&case=AVR&period=P_T30&epsg=4612';

const C_FAULT = '#4FB3C4', C_HIT = '#FFC24B', C_DIM = '#2C4650';
const FAULT_PAINT = { 'line-color': C_FAULT, 'line-width': 1.1 };
const faultPaintFor = bands => bands.length
    ? { 'line-color': ['match', ['get', 'band'], bands, C_HIT, C_DIM],
        'line-width': ['match', ['get', 'band'], bands, 2.6, 0.7] }
    : { 'line-color': C_DIM, 'line-width': 0.7 };

const FAULT_LEGEND =
    `<div style="font-size:12px;font-weight:600;margin-bottom:4px">震源断層モデル</div>` +
    `<div style="font-size:11px;line-height:1.7">地図をクリック＝その地点に効く地震<br>` +
    `<span style="opacity:.7">（防災科研 J-SHIS・30年・平均ケース）</span></div>`;

// 断層帯名の突合＝括弧と中黒を落として部分一致（J-SHIS の長期評価名 ⇄ こちらの断層帯名）
const norm = v => String(v ?? '').replace(/[（(][^）)]*[）)]/g, '').replace(/[・\s\u3000]/g, '');
const esc = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = v => { const n = +v; return Number.isFinite(n) ? (n * 100).toFixed(n < 0.01 ? 2 : 1) + '%' : '—'; };
const mag = v => { const t = String(v ?? '').split(',').map(x => x.replace(/^-/, '')).filter(Boolean); return t.length ? 'M' + t.join('〜') : '—'; };

let _fault = null, _bands = null;

// 描画用 GeoPBF から断層帯名の一覧を一度だけ集める（突合の左辺）
function bandsOf(pbf) {
    if (_bands) return _bands;
    const set = new Set();
    for (let i = 0; i < pbf.length; i++) {
        try { const b = pbf.getFeature(i)?.properties?.band; if (b) set.add(b); } catch { /* 壊れfeature */ }
    }
    return (_bands = [...set]);
}

// 盤の体裁＝エンジンの .pop は max-width:280px（中身 ≈234px）＝表組みは入らない。
// 横に並べず 1 件 3 行の積み上げにする（名前／種別・規模／確率）。CSS はこちらに閉じる（エンジンは触らない）。
function popHtml(rows, lon, lat, shown, grabbed = null) {
    const seg = grabbed?.band
        ? `<div style="font-size:11px;margin:0 0 6px;line-height:1.4"><span style="color:${C_HIT}">━</span> `
          + `${esc([grabbed.band, grabbed.fault, grabbed.seg].filter(Boolean).join(' '))}</div>` : '';
    const head = `<div class="cat-pop-title">この地点に効く地震</div>`
        + `<div style="font-size:10px;opacity:.6;margin:-2px 0 6px;line-height:1.4">`
        + `${lat.toFixed(4)}, ${lon.toFixed(4)}<br>30年・平均ケース・J-SHIS Y2024／寄与の大きい順</div>` + seg;
    if (!rows.length) return head + `<div style="font-size:11px">該当なし（陸域のモデル外）</div>`;
    const row = r => `<div style="display:flex;gap:5px;padding:4px 0;border-top:1px solid rgba(255,255,255,.12)">`
        + `<span style="opacity:.45;font-size:10px;min-width:1.1em;text-align:right;padding-top:1px">${esc(r.rank)}</span>`
        + `<span style="padding-top:1px">${r.hit ? `<span style="color:${C_HIT}">●</span>` : `<span style="opacity:.35">○</span>`}</span>`
        + `<span style="flex:1;min-width:0">`
        + `<span style="display:block;line-height:1.35">${esc(r.name)}</span>`
        + `<span style="display:block;font-size:10px;opacity:.55;line-height:1.4">${esc(r.why)}・${esc(mag(r.m))}</span>`
        + `<span style="display:block;font-size:10px;line-height:1.5;font-variant-numeric:tabular-nums">`
        + `30年 <b>${pct(r.p)}</b>　震度6弱+ <b>${pct(r.i55)}</b></span></span></div>`;
    const more = rows.length > shown ? `<div style="font-size:10px;opacity:.55;margin-top:5px">ほか ${rows.length - shown} 件</div>` : '';
    return head + rows.slice(0, shown).map(row).join('') + more
        + `<div style="font-size:10px;opacity:.55;margin-top:6px;line-height:1.5;border-top:1px solid rgba(255,255,255,.12);padding-top:5px">`
        + `<span style="color:${C_HIT}">●</span> 球に線がある　<span style="opacity:.6">○</span> 線が無い<br>`
        + `2009年版の活断層モデルゆえ、海溝型と新しい断層には線がありません</div>`;
}

export async function showFault() {
    if (!_fault) {
        const res = await fetch(`${import.meta.env.BASE_URL}jishin/fault.geopbf`);
        if (!res.ok) throw new Error(`fault.geopbf HTTP ${res.status}`);
        _fault = await geopbf(await res.arrayBuffer(), { name: 'fault' });
    }
    execGlobeView(_fault, FAULT_DS, {
        paint: FAULT_PAINT,
        legend: FAULT_LEGEND,
        pop: false,          // この層のポップ＝J-SHIS の盤。地物の既定ポップと二重に出さない（属性はホバーの tip で読める）

        onReady: (map, layer, view) => {
            const bands = bandsOf(_fault);
            let seq = 0;
            // 線の上で止めない＝断層が密な所（関東など）で「何も起きない」を作らない。
            // 掴んだ区間があれば盤の見出しに出す（既定ポップを止めた分の埋め合わせ）。
            const onClick = async ({ lngLat, hits }) => {
                const my = ++seq, [lon, lat] = lngLat;
                const grabbed = hits?.length ? (hits[0].feature?.properties ?? hits[0].properties
                    ?? (hits[0].fid != null ? _fault.getFeature(hits[0].fid)?.properties : null)) : null;
                const [x, y] = map.projectLL(lon, lat);
                // pop は呼ぶたびに箱を積む＝出す前に畳む（clear() は 📌 で固定した箱を残す＝2地点の見比べが効く）
                view.pop.clear();
                view.pop(`<div class="cat-pop-title">問い合わせ中…</div>`, { x, y, lng: lon, lat });
                let data = null;
                try {
                    const r = await fetch(`${JSHIS}&position=${lon.toFixed(6)},${lat.toFixed(6)}`);
                    data = r.ok ? await r.json() : null;
                } catch { /* 圏外・遮断 */ }
                if (my !== seq) return;            // 次のクリックが追い越した
                if (!data?.Fault) {
                    view.pop.clear();
                    view.pop(`<div class="cat-pop-title">この地点に効く地震</div>`
                        + `<div style="font-size:10px;opacity:.65;margin:-2px 0 6px">${lat.toFixed(4)}, ${lon.toFixed(4)}</div>`
                        + `<div style="font-size:11px">J-SHIS から返りませんでした（陸域のモデル外か通信断）</div>`, { x, y, lng: lon, lat });
                    layer.setPaint(FAULT_PAINT);
                    return;
                }
                const rows = data.Fault.map(f => {
                    const name = f.ltename || f.ltecode || '';
                    const hitBands = bands.filter(b => norm(name).includes(norm(b)) || norm(b).includes(norm(name)));
                    return {
                        rank: f.rank, name, bands: hitBands, hit: hitBands.length > 0,
                        why: f.eqgroup === 'C' ? '海溝型・プレート間' : (hitBands.length ? '主要活断層' : '2009年版に線が無い断層'),
                        m: f.magnitude, p: f.probability, i55: f.i55_ps,
                        score: +f.score || 0,
                    };
                }).sort((a, b) => b.score - a.score);
                layer.setPaint(faultPaintFor([...new Set(rows.flatMap(r => r.bands))]));
                view.pop.clear();
                view.pop(popHtml(rows, lon, lat, 6, grabbed), { x, y, lng: lon, lat });
            };
            map.on('click', onClick);
            return () => { map.off('click', onClick); seq++; };   // 地図を出る時に外す
        },
    });
}
