/**
 * census-charts.mjs
 * 国勢調査統計データ → SVG チャート生成
 * Node.js・ブラウザ共用（DOM 不要、純粋文字列）
 */

// ── SVG ビルダー ─────────────────────────────────────────────────────────────
function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

class Elem {
    constructor(tag, a = {}, text = null) {
        this.tag = tag; this.a = a; this._text = text; this.children = [];
    }
    elem(tag, a = {}, text = null) {
        const c = new Elem(tag, a, text); this.children.push(c); return c;
    }
    get outerHTML() {
        const as = Object.entries(this.a)
            .filter(([, v]) => v != null)
            .map(([k, v]) => `${k}="${esc(String(v))}"`)
            .join(' ');
        const inner = this.children.map(c => c.outerHTML).join('') +
            (this._text != null ? esc(String(this._text)) : '');
        return `<${this.tag}${as ? ' ' + as : ''}>${inner}</${this.tag}>`;
    }
}

const d3 = {
    sum:   a => a.reduce((s, v) => s + (v || 0), 0),
    max:   a => Math.max(0, ...a.map(v => v || 0)),
    comma: n => Number(n).toLocaleString(),
    SVG([x, y, w, h], extra = {}) {
        return new Elem('svg', { viewBox: `${x} ${y} ${w} ${h}`, xmlns: 'http://www.w3.org/2000/svg', ...extra });
    },
};

// ── 数値ヘルパー ─────────────────────────────────────────────────────────────
const BG = '#111';
const FG = '#ccc';
const W  = 250;

function pct(n)   { return (n * 100).toFixed(1) + '%'; }
function ratio(a) { const s = d3.sum(a); return s ? a.map(t => t / s) : a.map(() => 0); }
function accum(a) { let n = 0; return a.map(t => { n += t || 0; return n; }); }

// ── 凡例（2列） ───────────────────────────────────────────────────────────────
function appendLegend(parent, items, x0, y0) {
    const visible = items.filter(([v]) => v > 0);
    const half    = Math.ceil(visible.length / 2);
    const g       = parent.elem('g', { 'font-size': 5, 'font-family': 'Verdana', fill: FG });
    visible.forEach(([, fill, name], i) => {
        const col = i < half ? 0 : 1;
        const row = col === 0 ? i : i - half;
        const x   = x0 + col * 60;
        const y   = y0 + row * 9;
        g.elem('rect', { x, y, width: 6, height: 6, fill });
        g.elem('text', { x: x + 8, y: y + 5.5 }, name.slice(0, 5));
    });
}

// ── ドーナツ円グラフ ──────────────────────────────────────────────────────────
function appendDonut(parent, cx, cy, items, label, total, unit = '人') {
    const R    = 29.9;
    const PERI = R * 2 * Math.PI;
    const a    = [...items].sort((a, b) => b[0] - a[0]);
    const p    = ratio(a.map(([v]) => v));
    const sum  = accum(p);

    const g  = parent.elem('g', { transform: `translate(${cx},${cy})` });
    const gc = g.elem('g', { fill: 'none', 'stroke-width': 20 });
    a.forEach(([, fill], n) => {
        gc.elem('circle', {
            r: R, stroke: fill,
            'stroke-dashoffset': ((0.25 - (sum[n] - p[n])) * PERI).toFixed(2),
            'stroke-dasharray':  `${(p[n] * PERI).toFixed(2)},${((1 - p[n]) * PERI).toFixed(2)}`,
        });
    });

    const gt = g.elem('g', { 'text-anchor': 'middle', 'dominant-baseline': 'middle',
                                                        'font-size': 5, 'font-family': 'Verdana', fill: FG });
    a.forEach(([, , short], n) => {
        if (p[n] <= 0.04) return;
        const angle = (0.5 - (sum[n] - p[n] / 2)) * Math.PI * 2;
        gt.elem('text', { x: (R * Math.sin(angle)).toFixed(1), y: (R * Math.cos(angle)).toFixed(1),
                                            fill: '#fff', 'font-size': 3.5 }, short);
    });
    gt.elem('text', { x: 0, y: -7, 'font-size': 5 }, label);
    gt.elem('text', { x: 0, y:  0, 'font-size': 6, 'font-weight': 700 }, d3.comma(total));
    gt.elem('text', { x: 0, y:  7, 'font-size': 5 }, `[${unit}]`);
}

// ── 水平バー ─────────────────────────────────────────────────────────────────
function appendHBar(parent, x, y, segments, total, labels, bw = 110) {
    const g = parent.elem('g', { transform: `translate(${x},${y})` });
    g.elem('rect', { x: 0, y: 0, width: bw, height: 14, fill: '#888' });
    let acc = 0;
    segments.forEach(([val, fill]) => {
        const w = total ? val * bw / total : 0;
        g.elem('rect', { x: acc.toFixed(1), y: 0, width: w.toFixed(1), height: 14, fill });
        acc += w;
    });
    g.elem('rect', { x: 0, y: 0, width: bw, height: 14,
                     fill: 'none', stroke: FG, 'stroke-width': 0.8 });
    const scale = bw / 110;
    const gt = g.elem('g', { 'text-anchor': 'middle', 'dominant-baseline': 'middle',
                               'font-size': 4.5, 'font-family': 'Verdana', fill: FG });
    labels.forEach(([lx, name, val]) => {
        gt.elem('text', { x: (lx * scale).toFixed(1), y: 21 }, name);
        gt.elem('text', { x: (lx * scale).toFixed(1), y: 28 }, total ? pct(val / total) : '-');
    });
}

// ── 産業分類 ─────────────────────────────────────────────────────────────────
const IND_DEF = [
    ['農業',    '#0c0'], ['林業',    '#080'], ['漁業',    '#008'], ['鉱業',    '#444'],
    ['建設',    '#088'], ['製造',    '#0f8'], ['インフラ', '#c00'], ['情通',    '#0ff'],
    ['運輸',    '#880'], ['卸小売',  '#f80'], ['金融',    '#fc0'], ['不動産',  '#00c'],
    ['研究',    '#808'], ['宿泊飲食', '#800'], ['生活関連', '#8f0'], ['教育',    '#0f8'],
    ['医療福祉', '#08f'], ['複合',   '#f40'], ['サービス', '#c08'], ['公務',    '#f08'],
    ['その他',  '#888'],
];

function appendIndustry(parent, x0, y0, v) {
    if (!v || !d3.sum(v.slice(1, 22))) return 0;
    const vals  = [v[2], v[1] - v[2], ...v.slice(3, 22)];
    const items = vals.map((val, i) => [val, IND_DEF[i][1], IND_DEF[i][0]]);
    parent.elem('text', { x: x0, y: y0 - 2, 'font-size': 8, 'font-family': 'Verdana', fill: '#aaa' }, '産業別就業者');
    appendDonut(parent, x0 + 40, y0 + 40, items, '就業者', v[0]);
    appendLegend(parent, items, x0 + 88, y0 + 2);
    return 90;
}

// ── 職業分類 ─────────────────────────────────────────────────────────────────
const OCC_DEF = [
    ['管理職',   '#c00'], ['専門技術', '#f80'], ['事務',    '#c0c'], ['販売',    '#808'],
    ['サービス', '#880'], ['保安',    '#8ff'], ['農林漁業', '#088'], ['生産',    '#0ff'],
    ['輸送',    '#0f8'], ['建設',    '#08f'], ['運搬',    '#cc0'], ['その他',  '#888'],
];

function appendOccupation(parent, x0, y0, v) {
    if (!v || !d3.sum(v.slice(1, 13))) return 0;
    const items = v.slice(1, 13).map((val, i) => [val, OCC_DEF[i][1], OCC_DEF[i][0]]);
    parent.elem('text', { x: x0, y: y0 - 2, 'font-size': 8, 'font-family': 'Verdana', fill: '#aaa' }, '職業別就業者');
    appendDonut(parent, x0 + 40, y0 + 40, items, '就業者', v[0]);
    appendLegend(parent, items, x0 + 88, y0 + 2);
    return 90;
}

// ── 就業地位 ─────────────────────────────────────────────────────────────────
function appendStatus(parent, x0, y0, v, year, bw = 110) {
    if (!v || !v[0]) return 0;
    // 2015: ind[22]=雇用者, [23]=自営業主, [24]=家族従業者
    // 2020: ind[23]=雇用者, [24]=自営業主, [25]=家族従業者
    const ei = year === '2015' ? 22 : 23;
    const si = year === '2015' ? 23 : 24;
    const fi = year === '2015' ? 24 : 25;
    const segs = [
        [v[si], '#800'], [v[ei], '#008'], [v[fi], '#0f8'],
        [Math.max(0, v[0] - v[ei] - v[si] - v[fi]), '#888'],
    ];
    const labels = [[12, '自営業主', v[si]], [50, '雇用者', v[ei]], [87, '家族従業', v[fi]]];
    parent.elem('text', { x: x0, y: y0 - 2, 'font-size': 8, 'font-family': 'Verdana', fill: '#aaa' }, '就業地位');
    appendHBar(parent, x0, y0 + 5, segs, v[0], labels, bw);
    return 40;
}

// ── 世帯経済構成 ─────────────────────────────────────────────────────────────
function appendHousehold(parent, x0, y0, v, bw = 110) {
    if (!v || !v[0]) return 0;
    const segs = [
        [v[1], '#800'], [v[2], '#080'], [v[3], '#008'], [v[4], '#808'],
        [Math.max(0, v[0] - v[1] - v[2] - v[3] - v[4]), '#888'],
    ];
    const labels = [[12, '農林漁業', v[1]], [37, '混合', v[2]], [62, '非農林漁', v[3]], [87, '非就業', v[4]]];
    parent.elem('text', { x: x0, y: y0 - 2, 'font-size': 8, 'font-family': 'Verdana', fill: '#aaa' }, '世帯経済構成');
    appendHBar(parent, x0, y0 + 5, segs, v[0], labels, bw);
    return 40;
}

// ── 世帯の家族類型（T001084: [総数,親族のみ,核家族,夫婦のみ,夫婦と子,核家族以外,...]） ──
const FAM_DEF = [
    ['単独',       '#c0c'], ['夫婦のみ',   '#08f'], ['夫婦と子',   '#0c8'],
    ['ひとり親等', '#fa0'], ['その他親族', '#888'],
];
function appendFamilyType(parent, x0, y0, v) {
    if (!v || !v[0]) return 0;
    const vals = [
        Math.max(0, v[0] - v[1]),         // 単独＋非親族 ≈ 一般世帯総数 − 親族のみ世帯
        v[3],                             // 夫婦のみ
        v[4],                             // 夫婦と子供
        Math.max(0, v[2] - v[3] - v[4]),  // ひとり親等（核家族 − 夫婦のみ − 夫婦と子）
        v[5],                             // 核家族以外（その他親族）
    ];
    const items = vals.map((val, i) => [val, FAM_DEF[i][1], FAM_DEF[i][0]]);
    parent.elem('text', { x: x0, y: y0 - 2, 'font-size': 8, 'font-family': 'Verdana', fill: '#aaa' }, '世帯の家族類型');
    appendDonut(parent, x0 + 40, y0 + 40, items, '世帯', v[0], '世帯');
    appendLegend(parent, items, x0 + 88, y0 + 2);
    return 90;
}

// ── 住宅の建て方(T001086) ＋ 所有(T001085) ──
function appendHousing(parent, x0, y0, dwell, own, bw = 110) {
    if (!dwell || !dwell[0]) return 0;
    const segs = [
        [dwell[1], '#0a6'],  // 一戸建
        [dwell[2], '#8c0'],  // 長屋建
        [dwell[3], '#08c'],  // 共同住宅
        [Math.max(0, dwell[0] - dwell[1] - dwell[2] - dwell[3]), '#888'],
    ];
    const labels = [[12, '一戸建', dwell[1]], [42, '長屋', dwell[2]], [72, '共同住宅', dwell[3]]];
    parent.elem('text', { x: x0, y: y0 - 2, 'font-size': 8, 'font-family': 'Verdana', fill: '#aaa' }, '住宅の建て方');
    appendHBar(parent, x0, y0 + 5, segs, dwell[0], labels, bw);
    let h = 48;   // バー(14)+ラベル2行(21,28)＋次見出しのクリアランス
    if (own && own[0]) {
        const oy   = y0 + h;
        const rent = own[2] || 0;
        const oseg = [[own[1], '#c60'], [rent, '#68c'], [Math.max(0, own[0] - own[1] - rent), '#888']];
        const olab = [[12, '持ち家', own[1]], [60, '民営借家', rent]];
        parent.elem('text', { x: x0, y: oy - 2, 'font-size': 8, 'font-family': 'Verdana', fill: '#aaa' }, '住宅の所有');
        appendHBar(parent, x0, oy + 5, oseg, own[0], olab, bw);
        h += 40;
    }
    return h;
}

// ── 人口ピラミッド ────────────────────────────────────────────────────────────
// ages: [m0,m1,...,m15, f0,...,f15] (0-4, 5-9, ..., 70-74, 75+) × male+female
// refAges: same format for national reference (optional)
// 年齢区分の共通色定義（人口構成＝ピラミッド・人口推移で統一）
// ピラミッド描画順に対応: [老年男,老年女, 生産男,生産女, 年少男,年少女]
//   ＝ 老年=紫/赤紫, 生産=淡青/桃, 年少=緑/橙
const AGE_CL = ['#80f', '#804', '#88f', '#fcc', '#8f0', '#f80'];

function appendAgePyramid(parent, x0, y0, ages, refAges) {
    const mAges = ages.slice(0, 16);
    const fAges = ages.slice(16);
    const mSum  = d3.sum(mAges);
    const fSum  = d3.sum(fAges);
    const total = mSum + fSum;
    if (!total) return 0;

    const CL = AGE_CL;
    const os = 10;      // center gap half-width
    const cx = x0 + 125; // pyramid center x in parent coords

    const pAll = v => total ? v * 100 / total : 0;

    // bars drawn reversed (75+ at top row i=0, 0-4 at bottom row i=15)
    const d0 = [...mAges].reverse().map((v, i) =>
        `M-${os},${(i + 1) * 10}h-${(pAll(v) * 5).toFixed(2)}`);
    const d1 = [...fAges].reverse().map((v, i) =>
        `M${os},${(i + 1) * 10}h${(pAll(v) * 5).toFixed(2)}`);

    const g = parent.elem('g', { transform: `translate(${cx},${y0})` });

    // border & center lines
    g.elem('rect', { x: -110, y: 0, width: 220, height: 170,
        fill: 'none', stroke: FG, 'stroke-width': 1.5 });
    g.elem('path', { d: `M-${os},0v170M${os},0v170`,
        fill: 'none', stroke: FG, 'stroke-width': 0.7 });
    // grid lines at 1%,2%,3%,4% (=25 units each)
    g.elem('path', {
        d: 'M-85,0v170 M-60,0v170 M-35,0v170 M35,0v170 M60,0v170 M85,0v170',
        fill: 'none', stroke: FG, 'stroke-width': 0.4, 'stroke-dasharray': '4 1',
    });

    // age group labels
    const gt = g.elem('g', {
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': 7, 'font-family': 'Verdana', fill: FG,
    });
    for (let i = 0; i < 5; i++) {
        const x = os + i * 25;
        gt.elem('text', { x: -x, y: 178 }, `${i}%`);
        gt.elem('text', { x:  x, y: 178 }, `${i}%`);
    }
    for (let i = 0; i < 16; i++) {
        gt.elem('text', { x: 0, y: (i + 1) * 10 }, `${(15 - i) * 5}~`);
    }

    // male/female totals
    const gl = g.elem('g', {
        'font-size': 9, 'font-family': 'Verdana', 'dominant-baseline': 'middle',
    });
    gl.elem('text', { x: -100, y: 145, fill: CL[2], 'text-anchor': 'start', 'font-weight': 700 }, '男性');
    gl.elem('text', { x: -100, y: 157, fill: FG,    'text-anchor': 'start' }, d3.comma(mSum));
    gl.elem('text', { x:  100, y: 145, fill: CL[3], 'text-anchor': 'end',   'font-weight': 700 }, '女性');
    gl.elem('text', { x:  100, y: 157, fill: FG,    'text-anchor': 'end'   }, d3.comma(fSum));

    // bars (layered by age group category for color coding)
    const gb = g.elem('g', { 'stroke-width': 8 });
    // d0/d1 は reverse 済み（index0=75+が上）。slice(0,3)=老年, slice(13)=年少
    gb.elem('path', { d: d0.slice(0,  3).join(''), stroke: CL[0] }); // male   65+   (老年)
    gb.elem('path', { d: d1.slice(0,  3).join(''), stroke: CL[1] }); // female 65+
    gb.elem('path', { d: d0.slice(3, 13).join(''), stroke: CL[2] }); // male   15-64 (生産)
    gb.elem('path', { d: d1.slice(3, 13).join(''), stroke: CL[3] }); // female 15-64
    gb.elem('path', { d: d0.slice(13).join(''),    stroke: CL[4] }); // male   0-14  (年少)
    gb.elem('path', { d: d1.slice(13).join(''),    stroke: CL[5] }); // female 0-14

    // national reference polyline
    if (refAges) {
        const rm   = refAges.slice(0, 16);
        const rf   = refAges.slice(16);
        const rTot = d3.sum(rm) + d3.sum(rf);
        if (rTot) {
            const pR = v => v * 100 / rTot;
            const t0 = [...rm].reverse().map((v, i) =>
                (i ? 'L' : 'M') + `${-(pR(v) * 5 + os).toFixed(2)},${(i + 1) * 10}`);
            const t1 = [...rf].reverse().map((v, i) =>
                (i ? 'L' : 'M') + `${(pR(v) * 5 + os).toFixed(2)},${(i + 1) * 10}`);
            const gr = g.elem('g', { stroke: '#8f0', 'stroke-width': 1, fill: 'none' });
            gr.elem('text', { x: 80, y: 120, 'font-size': 8, 'font-family': 'Verdana',
                fill: '#8f0', 'dominant-baseline': 'middle', 'text-anchor': 'start' }, '全国平均');
            gr.elem('path', { d: 'M68,114h10' });
            gr.elem('path', { d: t0.join('') + t1.join('') });
        }
    }

    return 195; // height used (170 bars + 25 label area)
}

// ── 人口推移（3〜9時点対応） ─────────────────────────────────────────────────
// points: [{ year, male, female }, ...] (古い順)
// 人口推移: 年次ごとに男(左)・女(右)を年齢3区分（年少/生産/老年）で積み上げ表示。
// points: [{ year, m:[年少,生産,老年], f:[年少,生産,老年] }, ...]（1980〜2020の国勢調査）
//   後方互換: 旧 {year,male,female} は生産バンドのみの単色バーに正規化
// 人口構成（ピラミッド）のバーと同一色: 年少=緑/橙, 生産=淡青/桃, 老年=紫/赤紫
// m/f=[年少,生産,老年] → 男[AGE_CL4,2,0], 女[AGE_CL5,3,1]
const TREND_MC = [AGE_CL[4], AGE_CL[2], AGE_CL[0]];
const TREND_FC = [AGE_CL[5], AGE_CL[3], AGE_CL[1]];
function appendPopTrend(parent, x0, y0, points) {
    if (!points || !points.length) return 0;
    points = points.map(p => p.m ? p : { year: p.year, m: [0, p.male, 0], f: [0, p.female, 0] });

    const mt = p => p.m[0] + p.m[1] + p.m[2];
    const ft = p => p.f[0] + p.f[1] + p.f[2];
    const n    = points.length;
    const maxP = Math.max(...points.map(p => Math.max(mt(p), ft(p))));
    if (!maxP) return 0;

    const TW  = W - x0 - 8;
    const bsp = TW / n;
    const bw  = Math.max(2.5, Math.min(9, bsp * 0.32));
    const BH  = 88;   // 縦を伸ばして推移を見やすく
    const H   = BH / (maxP * 1.1);

    const g = parent.elem('g', { transform: `translate(${x0},${y0})` });

    // grid + Y軸（万単位）
    const ln = Math.log10(maxP * 1.1);
    let grid = Math.pow(10, Math.floor(ln));
    if ((maxP * 1.1) / grid < 2) grid /= 2;
    const ylabel = v => v >= 1e4 ? `${+(v / 1e4).toFixed(v % 1e4 ? 1 : 0)}万` : d3.comma(v);
    const grs = [];
    for (let gr = grid; gr < maxP * 1.1; gr += grid) {
        const gy = (BH - gr * H).toFixed(1);
        grs.push(`M0,${gy}h${TW}`);
        g.elem('text', { x: -2, y: gy, 'font-size': 4.5, 'font-family': 'Verdana', fill: FG, 'text-anchor': 'end', 'dominant-baseline': 'middle' }, ylabel(gr));
    }
    if (grs.length) g.elem('path', { d: grs.join(''), stroke: FG, 'stroke-width': 0.4 });

    // 積み上げバー（男=中心左, 女=中心右。年少を下に→老年を上に積む）
    points.forEach((p, i) => {
        const cx = i * bsp + bsp / 2;
        let by = BH;
        p.m.forEach((v, b) => { const h = v * H; if (h > 0) g.elem('rect', { x: (cx - bw).toFixed(1), y: (by - h).toFixed(1), width: (bw - 0.3).toFixed(1), height: h.toFixed(1), fill: TREND_MC[b] }); by -= h; });
        by = BH;
        p.f.forEach((v, b) => { const h = v * H; if (h > 0) g.elem('rect', { x: (cx + 0.3).toFixed(1), y: (by - h).toFixed(1), width: (bw - 0.3).toFixed(1), height: h.toFixed(1), fill: TREND_FC[b] }); by -= h; });
    });

    g.elem('rect', { x: 0, y: 0, width: TW, height: BH, fill: 'none', stroke: FG, 'stroke-width': 0.8 });

    // 年ラベル（縦回転で省スペース）
    const gt = g.elem('g', { 'font-size': 5, 'font-family': 'Verdana', fill: FG, 'text-anchor': 'end', 'dominant-baseline': 'middle' });
    points.forEach((p, i) => {
        const cx = i * bsp + bsp / 2;
        gt.elem('text', { x: cx, y: BH + 3, transform: `rotate(-90 ${cx} ${BH + 3})` }, String(p.year));
    });

    // 凡例はSVG外（HTML）に出す（棒と重ならないように）
    return BH + 26;
}

// 人口推移の凡例HTML（年齢別人口構成の凡例と同一定義: 男(左)/女(右)の2色×3区分）
export function popTrendLegendHtml() {
    const sw = c => `<span class="cs-pl-sw" style="background:${c}"></span>`;
    return `<div class="cs-pyramid-legend cs-trend-legend">
        <span class="cs-pl-item">${sw(AGE_CL[4])}${sw(AGE_CL[5])}年少 0-14</span>
        <span class="cs-pl-item">${sw(AGE_CL[2])}${sw(AGE_CL[3])}生産 15-64</span>
        <span class="cs-pl-item">${sw(AGE_CL[0])}${sw(AGE_CL[1])}老年 65+</span>
        <span class="cs-pl-item" style="color:#999">左=男 右=女</span>
    </div>`;
}

// 人口推移SVG単体（ドリルダウン各レベルで pop-history から非同期描画）
export function buildPopTrendSVG(points) {
    return makeSvg((s, x0, y) => appendPopTrend(s, x0 + 16, y, points));
}

// ── メイン：統計オブジェクト → SVG 文字列 ────────────────────────────────────
// opts.ages     : 32-element array [m0..m15, f0..f15] from 2020-ages.json
// opts.refAges  : national reference (same format)
// opts.popTrend : [{ year, male, female }, ...] for population trend bars
// ── 個別SVG ──────────────────────────────────────────────────────────────────
function makeSvg(drawFn) {
    const svg = d3.SVG([0, 0, W, 10]);
    const x0 = 8;
    let y = 16;  // title text at y0-2=14 → ascent to y≈7, clear of viewBox top
    const h = drawFn(svg, x0, y);
    if (!h) return null;
    y += h;
    svg.a.viewBox = `0 0 ${W} ${y}`;
    return svg.outerHTML;
}

// ── セクション配列で返す（タイトルはHTML側で付ける） ─────────────────────────
// returns [{ id, svg }, ...]
export function buildCensusChartSections(stat, year = '2020', opts = {}) {
    const { ages, refAges, popTrend } = opts;
    const out = [];

    if (ages && ages.length === 32) {
        const svg = makeSvg((s, x0, y) => appendAgePyramid(s, x0, y, ages, refAges || null));
        if (svg) out.push({ id: 'pyramid', svg });
    }

    if (popTrend && popTrend.length) {
        const svg = makeSvg((s, x0, y) => appendPopTrend(s, x0 + 16, y, popTrend));
        if (svg) out.push({ id: 'trend', svg });
    }

    if (stat) {
        const statSvg = makeSvg((s, x0, y) => {
            // donutX0=38: centers donut(~80px)+legend in W=250
            // barX0=38: same start as donut; BAR_W fills same total width (W - 2*38 = 174)
            const X0 = 38, BAR_W = W - 2 * 38;
            const PAD = 12;
            let cur = y, used = 0;
            const run = fn => {
                const h = fn(s, x0, cur);
                if (h) { cur += h + PAD; used += h + PAD; }
            };
            if (stat.ind) run((s,x,y) => appendIndustry(s, X0, y, stat.ind));
            if (stat.occ) run((s,x,y) => appendOccupation(s, X0, y, stat.occ));
            if (stat.ind) run((s,x,y) => appendStatus(s, X0, y, stat.ind, year, BAR_W));
            if (stat.eco) run((s,x,y) => appendHousehold(s, X0, y, stat.eco, BAR_W));
            return used ? cur - y : 0;
        });
        if (statSvg) out.push({ id: 'stats', svg: statSvg });
    }

    if (stat && (stat.fam || stat.dwell)) {
        const hhSvg = makeSvg((s, x0, y) => {
            const X0 = 38, BAR_W = W - 2 * 38;
            const PAD = 12;
            let cur = y, used = 0;
            const run = fn => { const h = fn(s, x0, cur); if (h) { cur += h + PAD; used += h + PAD; } };
            if (stat.fam)   run((s,x,y) => appendFamilyType(s, X0, y, stat.fam));
            if (stat.dwell) run((s,x,y) => appendHousing(s, X0, y, stat.dwell, stat.own, BAR_W));
            return used ? cur - y : 0;
        });
        if (hhSvg) out.push({ id: 'household', svg: hhSvg });
    }

    return out;
}

// backward compat
export function buildCensusChartSVG(stat, year = '2020', opts = {}) {
    const { ages, refAges, popTrend } = opts;
    const svg = d3.SVG([0, 0, W, 10]);
    svg.elem('rect', { x: 0, y: 0, width: W, height: 9999, fill: BG });
    const x0 = 8, PAD = 12;
    let y = 10;
    const used = [];

    if (popTrend?.length) {
        const h = appendPopTrend(svg, x0 + 12, y, popTrend);
        if (h) { y += h + PAD; used.push('trend'); }
    }
    if (ages?.length === 32) {
        const h = appendAgePyramid(svg, x0, y, ages, refAges || null);
        if (h) { y += h + PAD; used.push('pyramid'); }
    }
    if (stat) {
        if (stat.ind) { const h = appendIndustry(svg, x0, y, stat.ind);    if (h) { y += h + PAD; used.push('ind'); } }
        if (stat.occ) { const h = appendOccupation(svg, x0, y, stat.occ);  if (h) { y += h + PAD; used.push('occ'); } }
        if (stat.ind) { const h = appendStatus(svg, x0, y, stat.ind, year);if (h) { y += h + PAD; used.push('sta'); } }
        if (stat.eco) { const h = appendHousehold(svg, x0, y, stat.eco);   if (h) { y += h + PAD; used.push('eco'); } }
    }
    if (!used.length) return null;
    svg.a.viewBox = `0 0 ${W} ${y}`;
    svg.children[0].a.height = y;
    return svg.outerHTML;
}
