import { select as d3select } from 'd3';
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

_mapInst.on('ortho:close', exitGlobeView);

export async function execGlobeView(pbf) {
    if (!pbf?.length) return;
    _mapInst.autoRotate(false);

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
    _closeBtn.show();
}

export function exitGlobeView() {
    if (_globeLayer) { _globeLayer.destroy(); _globeLayer = null; }
    _mapInst.setView([135, 35], _initialZoom);
    _mapInst.autoRotate(true);
    _closeBtn.hide();
    document.getElementById('app').classList.remove('viewing');
}
