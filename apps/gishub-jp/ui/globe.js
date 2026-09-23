// 背景の地球儀＝ortho-japan エンジン（gint v2）。旧＝ortho-map（v1）の orthoMap({target:#globe-bg})。
// エンジンは build 時に同梱（A 裁定 2026-09-23＝内製アプリは本番で /japan/lib を実行時に食わない・census2020/world と同じ型）。
// 地図の口は common/gintView（map.addGint の薄い1枚）に封じる＝このファイルの外はエンジンを知らない。
import { createGintView, showRasterMeshes } from 'common/gintView';

const engineP = import('../../ortho-japan/app.js');

// 地球の半径＝画面短辺の 1/4（旧 v1 と同じ構図）。待ち受けは日本の上空で自転
const _overviewZoom = Math.log2(Math.min(window.innerWidth, window.innerHeight) / 2 * 0.5 / 256 * Math.PI * 2);
const HOME_LAT = 35;
let _viewing = false;   // 地図に入っている間（パネルが退いている）
const _host = document.getElementById('globe-bg').appendChild(document.createElement('div'));   // エンジンに貸す容れ物（id は map へ改名される）
const _mapP = engineP.then(m => m.default({
    target: _host,
    view: `#${_overviewZoom.toFixed(2)}/${HOME_LAT}/135`,
    lang: 'ja',
    countryTip: false,             // データの tip と国名 tip を混ぜない
    persistView: false,        // 待ち受けの自転で /japan/ の「前回の視点」（同オリジンの localStorage）を上書きしない
    keyboard: () => _viewing,      // 矢印キーは地図に入っている間だけ（待ち受け中は一覧の ↑↓ 移動のもの）
    assetBase: __JAPAN_ASSETS__,   // 実行時アセット＝本番 /japan/・dev は ortho-japan/public を /@fs で
}));
const _viewP = _mapP.then(map => {
    map.mapEl.addEventListener('ortho:close', exitGlobeView);
    const view = createGintView(map, { overviewZoom: _overviewZoom });
    if (!_viewing) view.spin(true);
    return view;
});

// 地図の道具。待ち受け中はパネルの下＝初めて地図に入る時に載せる（載せた瞬間から Z=全画面 等のショートカットが window で生きるため）
let _tools = false, _legend = null;
function _mountTools(map) {
    if (_tools) return; _tools = true;
    map.gadget.close(); map.gadget.compass(); map.gadget.zoom(); map.gadget.full(); map.gadget.cpos(); map.gadget.measure(); map.gadget.shot();
    _legend = map.gadget.legend();   // 凡例（左下）の setter。二度目の搭載は空関数が返る＝ここで一度だけ
}

const _esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function _resolveValue(k, v, ds) {
    const cl = ds?.codelist?.[k];
    if (!cl || cl === 'admin-boundary') return { label: ds?.attributes?.[k] || k, display: String(v), decoded: null };
    const decoded = typeof cl === 'object' ? cl[String(v)] : null;
    return { label: ds?.attributes?.[k] || k, display: String(v), decoded: decoded || null };
}

// gishub 本家と同じ「全プロパティのテーブル」形式（.identify-table）。
// jp の強み＝codelist デコード（コード値→名称 (コード)）はセル内で維持する。
function _buildTip(props, ds) {
    if (!props) return null;
    const rows = Object.entries(props)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => {
            const label = ds?.attributes?.[k] || k;
            const cl = ds?.codelist?.[k];
            const display = (cl && typeof cl === 'object' && cl[String(v)])
                ? `${_esc(cl[String(v)])} <span class="cat-tip-code">(${_esc(String(v))})</span>`
                : _esc(String(v));
            return `<tr><th>${_esc(label)}</th><td>${display}</td></tr>`;
        });
    return rows.length ? `<table class="identify-table">${rows.join('')}</table>` : null;
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

// L03-b_r などのカスタムビューが登録するクリーンアップ関数
let _onExitExtra = null;

// 地図に入る＝履歴を 1 段積む（ブラウザの「戻る」・スマホの戻る操作で地図を閉じて一覧へ戻れる）
function _enter(map) {
    _mountTools(map);
    if (!_viewing) history.pushState({ ...history.state, globe: 1 }, '', location.href);
    _viewing = true;
    document.getElementById('app').classList.add('viewing');
    document.body.classList.add('globe-viewing');
}

// 「戻る」で地図の段を抜けた（× / Esc で閉じた時は _viewing が先に落ちている＝空振り）
window.addEventListener('popstate', () => { if (_viewing && !history.state?.globe) exitGlobeView(); });

// 地球ビューに入る（× ボタン・Esc で exitGlobeView ＋ cleanup）。戻り値＝map（カスタムビューが map.raster 等を使う）
export async function enterGlobeView(cleanup) {
    const [map, view] = await Promise.all([_mapP, _viewP]);
    view.clear();
    view.spin(false);
    _onExitExtra = cleanup ?? null;
    _enter(map);
    return map;
}

// 経緯度矩形の画像群（Map<key,{webpData,bbox}>）を画像タイル層として重ねる＝戻り値は外す関数。
// opts.palette（分類色表）があれば：色を分類色へ吸着＋ホバーで分類名の tip＋凡例（opts.legendTitle）
export async function showMeshRaster(meshes, opts = {}) {
    const [map, view] = await Promise.all([_mapP, _viewP]);
    const remove = await showRasterMeshes(map, meshes, opts);
    if (!opts.palette?.length) return remove;
    const swatch = p => `<div style="display:flex;align-items:center;gap:6px;font-size:11px;line-height:1.6"><span style="width:14px;height:10px;border-radius:2px;display:inline-block;background:rgb(${p.rgb.join(',')})"></span>${_esc(p.label)}</div>`;
    _legend?.(`<div style="font-size:12px;font-weight:600;margin-bottom:4px">${_esc(opts.legendTitle || opts.name || '')}</div>${opts.palette.map(swatch).join('')}`);
    // ホバー＝カーソル位置の分類名（1フレームに1回・最後の位置だけ引く）
    const el = map.mapEl;
    let raf = 0, last = null, seq = 0;
    const onMove = e => {
        const r = el.getBoundingClientRect();
        last = [e.clientX - r.left, e.clientY - r.top];
        if (raf) return;
        raf = requestAnimationFrame(async () => {
            raf = 0;
            const my = ++seq, ll = last && map.unprojectXY(last[0], last[1]);
            const hit = ll ? await remove.query(ll[0], ll[1]) : null;
            if (my === seq) view.tip(hit ? `${_esc(hit.label)} <span class="cat-tip-code">(${_esc(String(hit.code))})</span>` : null);
        });
    };
    const onLeave = () => { seq++; view.tip(null); };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', onLeave);
    return () => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerleave', onLeave);
        cancelAnimationFrame(raf); seq++;
        view.tip(null);
        _legend?.(null);
        remove();
    };
}

export async function execGlobeView(pbf, ds = null) {
    if (!pbf?.length) return;
    const [map, view] = await Promise.all([_mapP, _viewP]);
    _onExitExtra?.();   // L03-b_r などのカスタムビューを畳む
    _onExitExtra = null;
    _enter(map);
    await view.show(pbf, {
        tipHtml: (fid, props) => _buildTip(props ?? pbf.getFeature(fid)?.properties, ds),
        popHtml: (fid, props) => _buildPop(props ?? pbf.getFeature(fid)?.properties, ds),
    });
}

export async function exitGlobeView() {
    if (!_viewing) return;   // Esc（close ガジェット）は待ち受け中にも飛ぶ
    _viewing = false;
    if (history.state?.globe) history.back();   // × / Esc で閉じた＝積んだ段を戻す（URL は同じ＝hashchange は立たない）
    _onExitExtra?.();
    _onExitExtra = null;
    document.getElementById('app').classList.remove('viewing');
    document.body.classList.remove('globe-viewing');
    const view = await _viewP;
    view.clear();
    view.home(HOME_LAT);
}
