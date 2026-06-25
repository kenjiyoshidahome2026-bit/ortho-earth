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
const W  = 230;

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
function appendDonut(parent, cx, cy, items, label, total) {
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
    gt.elem('text', { x: 0, y:  7, 'font-size': 5 }, '[人]');
}

// ── 水平バー ─────────────────────────────────────────────────────────────────
function appendHBar(parent, x, y, segments, total, labels) {
    const g = parent.elem('g', { transform: `translate(${x},${y})` });
    g.elem('rect', { x: 0, y: 0, width: 110, height: 14, fill: '#888' });
    let acc = 0;
    segments.forEach(([val, fill]) => {
        const w = total ? val * 110 / total : 0;
        g.elem('rect', { x: acc.toFixed(1), y: 0, width: w.toFixed(1), height: 14, fill });
        acc += w;
    });
    g.elem('rect', { x: 0, y: 0, width: 110, height: 14,
                                     fill: 'none', stroke: FG, 'stroke-width': 0.8 });
    const gt = g.elem('g', { 'text-anchor': 'middle', 'dominant-baseline': 'middle',
                                                        'font-size': 4.5, 'font-family': 'Verdana', fill: FG });
    labels.forEach(([lx, name, val]) => {
        gt.elem('text', { x: lx, y: 21 }, name);
        gt.elem('text', { x: lx, y: 28 }, total ? pct(val / total) : '-');
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
function appendStatus(parent, x0, y0, v, year) {
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
    appendHBar(parent, x0, y0 + 5, segs, v[0], labels);
    return 40;
}

// ── 世帯経済構成 ─────────────────────────────────────────────────────────────
function appendHousehold(parent, x0, y0, v) {
    if (!v || !v[0]) return 0;
    const segs = [
        [v[1], '#800'], [v[2], '#080'], [v[3], '#008'], [v[4], '#808'],
        [Math.max(0, v[0] - v[1] - v[2] - v[3] - v[4]), '#888'],
    ];
    const labels = [[12, '農林漁業', v[1]], [37, '混合', v[2]], [62, '非農林漁', v[3]], [87, '非就業', v[4]]];
    parent.elem('text', { x: x0, y: y0 - 2, 'font-size': 8, 'font-family': 'Verdana', fill: '#aaa' }, '世帯経済構成');
    appendHBar(parent, x0, y0 + 5, segs, v[0], labels);
    return 40;
}

// ── メイン：統計オブジェクト → SVG 文字列 ────────────────────────────────────
export function buildCensusChartSVG(stat, year = '2020') {
    const svg  = d3.SVG([0, 0, W, 10]);
    svg.elem('rect', { x: 0, y: 0, width: W, height: 9999, fill: BG });

    const x0  = 8;
    const PAD = 12;
    let y = 10;

    const sections = [];

    if (stat.ind) {
        const h = appendIndustry(svg, x0, y, stat.ind);
        if (h) { y += h + PAD; sections.push('ind'); }
    }
    if (stat.occ) {
        const h = appendOccupation(svg, x0, y, stat.occ);
        if (h) { y += h + PAD; sections.push('occ'); }
    }
    if (stat.ind) {
        const h = appendStatus(svg, x0, y, stat.ind, year);
        if (h) { y += h + PAD; sections.push('sta'); }
    }
    if (stat.eco) {
        const h = appendHousehold(svg, x0, y, stat.eco);
        if (h) { y += h + PAD; sections.push('eco'); }
    }

    if (!sections.length) return null;

    svg.a.viewBox       = `0 0 ${W} ${y}`;
    svg.children[0].a.height = y;

    return svg.outerHTML;
}
