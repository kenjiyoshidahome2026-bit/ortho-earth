import { select as d3select, geoContains } from 'd3';
import orthoMap from 'ortho-map';
import { API_BASE, TILER_BASE } from './config.js';

const _initialZoom = Math.log2(Math.min(window.innerWidth, window.innerHeight) / 2 * 0.5 / 256 * Math.PI * 2);
const _mapInst = await orthoMap({
    target:    d3select('#globe-bg'),
    center:    [135, 35],
    zoom:      _initialZoom,
    tilerBase: TILER_BASE,
    apiUrl:    API_BASE,
}).then(m => m.autoRotate(true));
const _closeBtn = _mapInst.gadget.close();
let _globeLayer = null;
let _tipFn = null;
let _popFn = null;

_mapInst.on('ortho:close', exitGlobeView);

// tip/pop は初回描画時に一度だけ生成
function _initGadgets() {
    if (_tipFn) return;
    _tipFn = _mapInst.gadget.tip();
    _popFn = _mapInst.gadget.pop();
}

const _esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function _resolveValue(k, v, ds) {
    const cl = ds?.codelist?.[k];
    if (!cl || cl === 'admin-boundary') return { label: ds?.attributes?.[k] || k, display: String(v), decoded: null };
    const decoded = typeof cl === 'object' ? cl[String(v)] : null;
    return { label: ds?.attributes?.[k] || k, display: String(v), decoded: decoded || null };
}

function _buildTip(props, ds) {
    if (!props) return null;
    const rows = Object.entries(props)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .slice(0, 4)
        .map(([k, v]) => {
            const label = ds?.attributes?.[k] || k;
            const cl = ds?.codelist?.[k];
            const display = (cl && typeof cl === 'object' && cl[String(v)])
                ? `${cl[String(v)]} (${v})`
                : String(v);
            return `${label}: ${display}`;
        });
    return rows.length ? rows : null;
}

function _buildPop(props, ds) {
    if (!props) return null;
    const entries = Object.entries(props).filter(([, v]) => v !== null && v !== undefined && v !== '');
    if (!entries.length) return null;
    const rows = entries.map(([k, v]) => {
        const cl = ds?.codelist?.[k];
        const label = ds?.attributes?.[k] || k;
        let cell;
        if (cl === 'admin-boundary') {
            cell = `<span class="cat-pop-code">${_esc(String(v))}</span> <span class="cat-pop-note">行政区域コード</span>`;
        } else if (cl && typeof cl === 'object' && cl[String(v)]) {
            cell = `${_esc(cl[String(v)])} <span class="cat-pop-code">(${_esc(String(v))})</span>`;
        } else {
            cell = _esc(String(v));
        }
        return `<tr><td class="cat-pop-key">${_esc(label)}</td><td class="cat-pop-val">${cell}</td></tr>`;
    }).join('');
    const title = ds?.title ? `<div class="cat-pop-title">${_esc(ds.title)}</div>` : '';
    return `${title}<table class="cat-pop-table">${rows}</table>`;
}

export function getMapInst() { return _mapInst; }

export async function execGlobeView(pbf, ds = null) {
    if (!pbf?.length) return;
    _initGadgets();
    _mapInst.autoRotate(false);
    _mapInst.on('Click.catalog', null); // 前回の geojson リスナー解除
    _tipFn?.(null);
    _popFn?.clear(true);

    if (_globeLayer) { _globeLayer.destroy(); _globeLayer = null; }

    const { arcBuffer, arcMeta, polyStream, lineStream, pointBuffer, point } = pbf.unPackGint || {};
    const hasArcs   = !!(arcBuffer && arcMeta && (polyStream?.length > 0 || lineStream?.length > 0));
    const hasPoints = !!(pointBuffer?.length > 0);

    if (hasArcs || hasPoints) {
        const { polyCompBbox } = pbf.unPackGint ?? {};
        _globeLayer = await _mapInst.createRemoteLayer({ name: 'CATALOG', type: 'gint' });
        _globeLayer.set('gint', {
            arcBuffer, arcMeta,
            polyStream:   polyStream   ?? new Int32Array(0),
            lineStream:   lineStream   ?? new Int32Array(0),
            pointBuffer:  pointBuffer  ?? null,
            point:        point        ?? null,
            polyCompBbox, minZoom: 2,
        });

        _globeLayer.onIdentify = (featureId) => {
            if (featureId === null || featureId === undefined) { _tipFn?.(null); return; }
            const f = pbf.getFeature(featureId);
            _tipFn?.(_buildTip(f?.properties, ds));
        };
        _globeLayer.onClick = (featureId, _geomType, x, y, lng, lat) => {
            if (featureId === null || featureId === undefined) return;
            const f = pbf.getFeature(featureId);
            const content = _buildPop(f?.properties, ds);
            if (content) _popFn?.(content, { x, y, lng, lat });
        };

    } else {
        const geomType = pbf.fmap[0]?.[2] ?? 4;
        const style = geomType < 2
            ? { fill: '#FF6B35', stroke: '#fff', size: 5 }
            : geomType < 4
            ? { stroke: '#00B4D8', width: 1.5 }
            : { fill: 'rgba(255,107,53,0.25)', stroke: '#FF6B35', width: 0.8 };
        const features = [];
        pbf.forEach(n => features.push(pbf.getFeature(n)));
        _globeLayer = _mapInst.createLayer({ name: 'CATALOG' });
        _globeLayer.set('geojson', { type: 'FeatureCollection', features }, style);

        _mapInst.on('Click.catalog', e => {
            if (!e || !_popFn) return;
            let hit = null;
            if (geomType >= 4) {
                hit = features.find(f => geoContains(f, [e.lng, e.lat]));
            } else if (geomType < 2) {
                let minDist = Infinity;
                for (const f of features) {
                    const c = f.geometry?.coordinates;
                    if (!c) continue;
                    const pts = f.geometry.type === 'MultiPoint' ? c : [c];
                    for (const [fx, fy] of pts) {
                        const d = Math.hypot(fx - e.lng, fy - e.lat);
                        if (d < minDist && d < 1) { minDist = d; hit = f; }
                    }
                }
            }
            if (hit) _popFn(_buildPop(hit.properties, ds), e);
        });
    }

    _mapInst.draw();
    document.getElementById('app').classList.add('viewing');

    const [w, s, e, n] = pbf.bbox;
    const zoomFeature = (e - w > 300)
        ? (() => {
                const d2r = Math.PI / 180, r2d = 180 / Math.PI;
                let sx = 0, sy = 0, sz = 0; const pts = [];
                pbf.forEach(i => {
                    const b = pbf.getBbox(i); if (!b || !isFinite(b[0])) return;
                    const lng = (b[0]+b[2])/2, lat = (b[1]+b[3])/2; pts.push([lng,lat]);
                    sx += Math.cos(lat*d2r)*Math.cos(lng*d2r);
                    sy += Math.cos(lat*d2r)*Math.sin(lng*d2r);
                    sz += Math.sin(lat*d2r);
                });
                const norm = Math.sqrt(sx*sx+sy*sy+sz*sz);
                return { type:'Feature', geometry:{ type:'MultiPoint', coordinates:pts }, properties:{},
                                 _center: norm > 0 ? [Math.atan2(sy,sx)*r2d, Math.asin(sz/norm)*r2d] : null };
            })()
        : { type:'Feature', geometry:{ type:'Polygon', coordinates:[[[w,s],[w,n],[e,n],[e,s],[w,s]]] }, properties:{} };

    const zoomOpts = zoomFeature._center ? { center: zoomFeature._center } : {};
    await _mapInst.zoomToFeature(zoomFeature, zoomOpts);
    _mapInst.draw();
    _mapInst.trigger("Drawn");
    _closeBtn.show();
}

export function exitGlobeView() {
    _mapInst.on('Click.catalog', null);
    _tipFn?.(null);
    _popFn?.clear(true);
    if (_globeLayer) { _globeLayer.destroy(); _globeLayer = null; }
    _mapInst.setView([135, 35], _initialZoom);
    _mapInst.autoRotate(true);
    _closeBtn.hide();
    document.getElementById('app').classList.remove('viewing');
}
