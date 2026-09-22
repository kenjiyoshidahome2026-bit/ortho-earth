import { geoExec } from 'common/geoExec';
import { screenLogger } from 'common/screenLogger';
import { saveTo, openDirectory, comma } from 'common';
import { showToast } from './shared.js';
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
            p.append('button').text('🔄 再読み込み').on('click', () => renderExecView({ ...entry, nocache: true }, onBack, geopbfFn, ds));
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
                { name: 'GeoJSON',  fn: async () => pbf.geojsonFile({ gz: await logger.confirm('GeoJSON Gzipped', false) }) },
                { name: 'TopoJSON', fn: async () => pbf.topojsonFile({ gz: await logger.confirm('TopoJSON Gzipped', false) }) },
                { name: 'FGB',      fn: async () => pbf.fgbFile({ gz: await logger.confirm('FGB Gzipped', false) }) },
                { name: 'Shape',   fn: async () => pbf.shapeFile({ encoding: await logger.prompt('encoding (default: utf8)', 'utf8') }) },
                { name: 'KMZ',     fn: async () => pbf.kmzFile({ kmz: await logger.select('KMZ or KML', { KMZ: true, KML: false }) }) },
                { name: 'GML',     fn: async () => pbf.gmlFile({ gz: await logger.confirm('GML Gzipped', false) }) },
                { name: 'GPX',     fn: async () => pbf.gpxFile({ gz: await logger.confirm('GPX Gzipped', false) }) },
                { name: 'NDJSON',  fn: async () => ndjsonFile(pbf, await logger.confirm('NDJSON Gzipped', false)) },
                { name: 'CZML',    fn: async () => pbf.czmlFile({ gz: await logger.confirm('CZML Gzipped', false) }) },
                { name: 'GeoParquet', fn: async () => {
                    logger.log(`🔄 ${pbf.name()}: conversion from GeoPBF to GeoParquet …`);
                    pbf.propertiesTable;   // 遅延復号の属性を全部起こしてから（toGeoParquet は pbf.props を直に読む）
                    const { toGeoParquet } = await import('geopbf/geoparquet');
                    const { buffer } = await toGeoParquet(pbf);
                    return new File([buffer], `${pbf.name()}.parquet`, { type: 'application/vnd.apache.parquet' });
                } },
                { name: 'PMTiles', fn: async () => {
                    const z = Math.max(0, Math.min(16, parseInt(await logger.prompt('PMTiles max zoom (0-16)', '12'), 10) || 12));
                    logger.log(`🔄 ${pbf.name()}: conversion from GeoPBF to PMTiles (z0–${z}) …`);
                    pbf.propertiesTable;
                    const { toPMTiles } = await import('geopbf/pmtiles');
                    const { buffer } = await toPMTiles(pbf, { maxZoom: z });
                    return new File([buffer], `${pbf.name()}.pmtiles`, { type: 'application/vnd.pmtiles' });
                } },
                { name: 'CSV（形つき）',   fn: async () => new File(['\ufeff' + toCSV(geoRows(pbf, logger))], `${pbf.name()}.csv`, { type: 'text/csv' }) },
                { name: 'Excel（形つき）', fn: async () => {
                    const { encodeXLSX } = await import('geopbf/encodeXLSX');
                    return encodeXLSX(geoRows(pbf, logger, { excel: true }), `${pbf.name()}.xlsx`, { sheetName: pbf.name() });
                } },
            ];
            fmts.forEach(f => q.append('button')
                .classed('accent', f.name === 'GeoPBF')
                .text(f.name)
                .on('click', async () => {
                    active(false);
                    try { if (await openDirectory()) await save(await f.fn()); }
                    catch (e) { console.error(`[export ${f.name}]`, e); logger.error(`${f.name}: ${e.message || e}`); }
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
        saveProp(new File(['\ufeff' + pbf.getCSV()], (pbf._name || 'data') + '.csv', { type: 'text/csv' })));   // BOM＝Excel で開いても日本語が化けない
    btnRow.append('button').text('📥 Excel').on('click', async () => {
        // 依存ゼロの遅延チャンク（旧: xlsx@0.18.5＝225KB gz の読み書き一式・修正版が npm に無いCVE 2件を出荷。
        // ここは CSV→xlsx の一方向変換だけなので、encodeZIP と同じ CompressionStream 流儀で自前書き出し）
        try {
            const { encodeXLSX } = await import('geopbf/encodeXLSX');
            const nm = pbf._name || 'data';
            saveProp(await encodeXLSX(pbf.getCSV(), nm + '.xlsx', { sheetName: nm }));
        } catch (e) { console.error('[excel]', e); showToast('Excel 変換に失敗しました'); }
    });
    btnRow.append('button').text('✕ 閉じる').on('click', () => { tablesEl.hide().html(''); logEl.show(); actionEl.show(); });
}

// ---- 書き出しの追加形式（GeoPBF のデモと同じ作り） ----

// NDJSON（GeoJSON Lines）＝1 行 1 地物
async function ndjsonFile(pbf, gz) {
    const parts = [];
    for (let i = 0; i < pbf.length; i++) {
        let f; try { f = pbf.getFeature(i); } catch { continue; }
        parts.push(JSON.stringify({ type: 'Feature', geometry: f.geometry ?? null, properties: f.properties ?? {} }), '\n');
    }
    const file = new File(parts, `${pbf.name()}.ndjson`, { type: 'application/geo+json-seq' });
    return gz ? (await import('geopbf/gzip')).gzip(file) : file;
}

// 表＝属性＋形（読み戻せる形）：点だけなら lon / lat 列、それ以外は wkt 列（QGIS・geopbf の表リーダが列名で見つける）
const wktOf = g => {
    if (!g) return '';
    const xy = c => `${c[0]} ${c[1]}`, ring = r => `(${r.map(xy).join(',')})`, poly = p => `(${p.map(ring).join(',')})`;
    switch (g.type) {
        case 'Point': return `POINT (${xy(g.coordinates)})`;
        case 'MultiPoint': return `MULTIPOINT (${g.coordinates.map(c => `(${xy(c)})`).join(',')})`;
        case 'LineString': return `LINESTRING ${ring(g.coordinates)}`;
        case 'MultiLineString': return `MULTILINESTRING (${g.coordinates.map(ring).join(',')})`;
        case 'Polygon': return `POLYGON ${poly(g.coordinates)}`;
        case 'MultiPolygon': return `MULTIPOLYGON (${g.coordinates.map(poly).join(',')})`;
        case 'GeometryCollection': return `GEOMETRYCOLLECTION (${(g.geometries ?? []).map(wktOf).join(',')})`;
    }
    return '';
};
const cellOf = v => v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : v;
const EXCEL_CELL = 32767;   // Excel の 1 セルの上限（字）
function geoRows(pbf, logger, { excel = false } = {}) {
    const [keys, ...props] = pbf.propertiesTable;
    const points = pbf.getType().every(t => t === 'Point');
    let skipped = 0;
    const rows = [keys.concat(points ? ['lon', 'lat'] : ['wkt'])];
    for (let i = 0; i < pbf.length; i++) {
        const row = keys.map((_, k) => cellOf(props[i]?.[k]));
        let g = null; try { g = pbf.getGeometry(i); } catch {}
        if (points) row.push(g?.coordinates?.[0] ?? '', g?.coordinates?.[1] ?? '');
        else { const w = wktOf(g); if (excel && w.length > EXCEL_CELL) { skipped++; row.push(''); } else row.push(w); }
        rows.push(row);
    }
    if (skipped) logger.warn(`${comma(skipped)} 件の形が Excel の 1 セルの上限（${comma(EXCEL_CELL)} 字）を超えたので空にしました（形は CSV で）`);
    return rows;
}
const toCSV = rows => rows.map(r => r.map(v => { const t = String(v); return /[",\r\n]|^0\d/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(',')).join('\r\n');
