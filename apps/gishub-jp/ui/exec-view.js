import { geoExec } from 'common/geoExec';
import { screenLogger } from 'common/screenLogger';
import { saveTo, openDirectory, comma } from 'common';
import { select as d3select } from 'd3';
import { geopbf } from './gpbf.js';
import { execGlobeView } from './globe.js';
import { ctx } from './ctx.js';

export function closeGeoPreview() {
    const panel = document.getElementById('geo-preview');
    panel.classList.remove('visible');
    panel.innerHTML = '';
}

export function renderExecView(entry, onBack = null, geopbfFn = null, ds = null) {
    closeGeoPreview();
    ctx.setDetailHtml(`
        <div class="detail-inner">
            <div id="exec-action"></div>
            <div id="exec-log"></div>
            <div id="exec-tables"></div>
        </div>
    `);

    const actionEl = d3select('#exec-action');
    const logEl    = d3select('#exec-log');
    const tablesEl = d3select('#exec-tables').hide();
    const logger   = new screenLogger(logEl);

    geoExec(entry, {
        geopbf: geopbfFn || geopbf,
        logger,
        async onSuccess(pbf) {
            actionEl.html('');
            const p = actionEl.append('div').classed('exec-action-row', true);
            p.append('button').classed('accent', true).text('🌍 地球に描画').on('click', () => execGlobeView(pbf, ds));
            p.append('button').text('🏷️ 属性の一覧').on('click', () => showPropTable(pbf, logEl, tablesEl, actionEl));
            p.append('button').text('🔄 再読み込み').on('click', () => renderExecView({ ...entry, nocache: true }, onBack));
            p.append('button').text('← 一覧に戻る').on('click', () => { onBack?.(); });

            const q = logger.empty();
            q.append('span').text('📥 [DOWNLOAD]').classed('big', true);
            const save = async s => {
                if (!s) return;
                if (await saveTo(s)) logger.log(`📥 Saved: ${s.name} (${comma(s.size)} bytes)`);
            };
            const active = v => logEl.selectAll('button').attr('disabled', v ? null : true);
            const fmts = [
                { name: 'GeoPBF',  fn: () => pbf.geopbfFile() },
                { name: 'GeoJSON', fn: async () => pbf.geojsonFile({ gz: await logger.confirm('GeoJSON Gzipped', false) }) },
                { name: 'FGB',     fn: async () => pbf.fgbFile({ gz: await logger.confirm('FGB Gzipped', false) }) },
                { name: 'Shape',   fn: async () => pbf.shapeFile({ encoding: await logger.prompt('encoding (default: utf8)', 'utf8') }) },
                { name: 'KMZ',     fn: async () => pbf.kmzFile({ kmz: await logger.select('KMZ or KML', { KMZ: true, KML: false }) }) },
                { name: 'GML',     fn: async () => pbf.gmlFile({ gz: await logger.confirm('GML Gzipped', false) }) },
                { name: 'GPX',     fn: async () => pbf.gpxFile({ gz: await logger.confirm('GPX Gzipped', false) }) },
            ];
            fmts.forEach(f => q.append('button')
                .classed('accent', f.name === 'GeoPBF')
                .text(f.name)
                .on('click', async () => {
                    active(false);
                    if (await openDirectory()) await save(await f.fn());
                    active(true);
                }));
        },
        onError() {},
    });
}

export function showPropTable(pbf, logEl, tablesEl, actionEl) {
    const PAGE = 100;
    const data = pbf.getPropertyTable();
    if (!data?.length) return;
    const headers = data[0];
    const rows = data.slice(1);
    const pages = Math.ceil(rows.length / PAGE) || 1;
    let page = 0;
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const cut = s => { const t = String(s); return esc(t.length > 20 ? t.slice(0, 19) + ' …' : t); };

    logEl.hide();
    actionEl.hide();
    tablesEl.show().html(
        `<div class="exec-prop-header"><h2>${esc(pbf._name || '')}<span>${esc(pbf._description || '')}</span></h2><div class="exec-prop-btns"></div></div>` +
        `<div class="exec-prop-table"><table><thead><tr>${headers.map(h => `<th>${esc(String(h))}</th>`).join('')}</tr></thead><tbody></tbody></table></div>`
    );
    const tbody  = tablesEl.select('tbody');
    const btnRow = tablesEl.select('.exec-prop-btns');

    const renderPage = () => {
        tbody.html(rows.slice(page * PAGE, (page + 1) * PAGE)
            .map(row => `<tr>${row.map(c => `<td>${cut(c)}</td>`).join('')}</tr>`).join(''));
        tablesEl.select('.exec-prop-table').node().scrollTop = 0;
    };
    renderPage();

    if (pages > 1) {
        btnRow.append('button').text('◀').on('click', () => { if (page > 0) { page--; pageInfo.text(`${page+1} / ${pages}`); renderPage(); } });
        const pageInfo = btnRow.append('span').classed('exec-page-info', true).text(`1 / ${pages}`);
        btnRow.append('button').text('▶').on('click', () => { if (page < pages-1) { page++; pageInfo.text(`${page+1} / ${pages}`); renderPage(); } });
    }
    const saveProp = async s => { if (!s) return; await saveTo(s); };
    btnRow.append('button').text('📥 CSV').on('click', () =>
        saveProp(new File([pbf.getCSV()], (pbf._name || 'data') + '.csv', { type: 'text/csv' })));
    btnRow.append('button').text('📥 Excel').on('click', async () => {
        window.XLSX || await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
        const wb  = window.XLSX.read(pbf.getCSV(), { type: 'string', raw: true });
        const buf = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        saveProp(new File([buf], (pbf._name || 'data') + '.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    });
    btnRow.append('button').text('✕ 閉じる').on('click', () => { tablesEl.hide().html(''); logEl.show(); actionEl.show(); });
}
