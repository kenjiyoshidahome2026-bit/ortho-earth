// ============================================================
// インポート
// ============================================================
import { API_BASE }           from './ui/config.js';
import { showToast }          from './ui/shared.js';
import { setup as ctxSetup }  from './ui/ctx.js';
import { execGlobeView }      from './ui/globe.js';
import { renderExecView, closeGeoPreview } from './ui/exec-view.js';
import { bulkDownload }       from './ui/bulk-download.js';
import { initDetailEventListeners, nlftpSelectDataset } from './nlftp/ui.js';
import { loadCatalogEntries } from './nlftp/catalog.js';
import { placeholder }        from './ui/placeholder.js';
import { initSidebarToggle }  from './ui/sidebar.js';
import { mojSidebarEntry, renderMojList } from './moj/ui.js';
import { maffSidebarEntry, renderMaffList } from './maff/ui.js';
import { estatSidebarEntry, renderEstatList } from './estat/ui.js';
import { showAmedas } from './jma/ui.js';        // 別枠（カタログ外）: #amedas で描画
import { showSeismic } from './jishin/ui.js';    // 別枠（カタログ外）: #seismic で描画
import {
    census2025SidebarEntry, census2020SidebarEntry, census2015SidebarEntry,
    renderCensus2025List, renderCensus2020List, renderCensus2015List,
    censusSmall2020SidebarEntry, renderCensusSmall2020,
} from './census/ui.js';

// ============================================================
// State
// ============================================================
let catalog   = [];
let active    = null;
let licFilter = 'all';

// ============================================================
// カタログ
// ============================================================
async function loadCatalog() {
	const list = document.getElementById('dataset-list');
	list.innerHTML = '<div class="loading-msg">読み込み中...</div>';
	try {
		const staticEntries = [
			mojSidebarEntry(),
			maffSidebarEntry(),
			estatSidebarEntry(),
			census2025SidebarEntry(),
			censusSmall2020SidebarEntry(),   // 「国勢調査 2020 基本集計」= 全国→小地域の総合ドリルダウン（旧フラット2020を統合）
			census2015SidebarEntry(),
		];

		const nlftpEntries = await loadCatalogEntries().catch(e => { console.error('[nlftp] catalog load failed:', e); return []; });

		catalog = [
			...staticEntries,
			...nlftpEntries,
		];

		renderList();
		setDetailHtml(placeholder(catalog));

		const hash = location.hash.slice(1);
		if (hash) {
			if      (hash === 'moj')        { selectDataset('moj',        true); }
			else if (hash === 'maff')       { selectDataset('maff',       true); }
			else if (hash === 'estat')      { selectDataset('estat',      true); }
			else if (hash === 'census2025') { selectDataset('census2025', true); }
			else if (hash === 'census2020') { selectDataset('census2020', true); }
			else if (hash === 'census2015') { selectDataset('census2015', true); }
			else if (hash === 'census-small-2020') { selectDataset('census-small-2020', true); }
			else if (catalog.some(ds => ds.dataset_code === hash)) {
				selectDataset(hash, true);
				setTimeout(() => document.querySelector(`.ds-item[data-code="${hash}"]`)?.scrollIntoView({ block: 'center' }), 100);
			}
		}
	} catch (e) {
		list.innerHTML = `<div class="error-msg">読み込みエラー: ${e.message}</div>`;
	}
}

// ============================================================
// サイドバーリスト
// ============================================================
const SOURCE_GROUP_LABELS = {
	moj:   '法務省 G空間情報センター',
	maff:  '農林水産省',
	estat: '総務省 e-Stat',
	nlftp: '国土交通省 国土数値情報',
};

const SOURCE_GROUP_URLS = {
	moj:   'https://www.geospatial.jp/ckan/organization/moj',
	maff:  'https://open.fude.maff.go.jp/',
	estat: 'https://www.e-stat.go.jp/gis',
	nlftp: 'https://nlftp.mlit.go.jp/ksj/',
};

function dsItemHtml(ds) {
	return `
		<div class="ds-item${ds.dataset_code === active ? ' active' : ''}" data-code="${ds.dataset_code}">
			<div class="ds-line1">
				<span class="ds-code">${ds.dataset_code}</span>
				<span class="ds-line1-right">
					<span class="meta-num">${ds.file_count.toLocaleString()}件</span>
					<span class="meta-lic">${ds.license}</span>
				</span>
			</div>
			<div class="ds-title">${ds.title}</div>
			${ds.note ? `<div class="ds-note">${ds.note}</div>` : ''}
		</div>
	`;
}

function renderList() {
	const q = document.getElementById('search').value.toLowerCase();
	const items = catalog.filter(ds => {
		if (q && !ds.title.toLowerCase().includes(q) && !ds.dataset_code.toLowerCase().includes(q)) return false;
		if (licFilter === 'ok' && _licFilterKey(ds.license) !== 'ok') return false;
		if (licFilter === 'ng' && _licFilterKey(ds.license) !== 'ng') return false;
		return true;
	});

	document.getElementById('list-count').textContent = `${items.length} / ${catalog.length} 件`;

	const list = document.getElementById('dataset-list');
	if (!items.length) { list.innerHTML = '<div class="empty-msg">該当なし</div>'; return; }

	const groups = new Map();
	for (const ds of items) {
		const sid = ds._sourceId || 'other';
		if (!groups.has(sid)) groups.set(sid, []);
		groups.get(sid).push(ds);
	}

	const html = [];
	for (const [sid, dsItems] of groups) {
		const label = SOURCE_GROUP_LABELS[sid] || sid;
		const url   = SOURCE_GROUP_URLS[sid];
		const titleHtml = url
			? `<a class="sidebar-group-link" href="${url}" target="_blank">${label}</a>`
			: label;
		html.push(`<div class="sidebar-group"><h2 class="sidebar-group-title">${titleHtml}</h2>`);
		html.push(dsItems.map(dsItemHtml).join(''));
		html.push(`</div>`);
	}
	list.innerHTML = html.join('');
	list.querySelectorAll('.ds-item').forEach(el => {
		el.addEventListener('click', () => selectDataset(el.dataset.code, true));
	});
}

function _licFilterKey(lic) {
	if (!lic) return 'ng';
	if (lic.includes('NC')) return 'ng';   // CC BY-NC 系＝非商用（"CC BY"を含むため先に弾く）
	if (lic.includes('商用可') || lic.includes('CC BY') || lic.includes('CC_BY')) return 'ok';
	return 'ng';
}

// ============================================================
// データセット選択
// ============================================================
function setDetailHtml(html) {
	document.getElementById('detail-body').innerHTML = html;
	const isTop = html.includes('class="placeholder"');
	document.getElementById('detail-header').style.display = isTop ? 'none' : '';
}

let _selectTimer = null;
function selectDataset(code, immediate = false) {
	clearTimeout(_selectTimer);
	if (immediate) { _selectDatasetNow(code); return; }
	_selectTimer = setTimeout(() => _selectDatasetNow(code), 150);
}

async function _selectDatasetNow(code) {
	active = code;
	closeGeoPreview();
	document.querySelectorAll('.ds-item').forEach(el => el.classList.toggle('active', el.dataset.code === code));

	if (code === 'moj')        { history.replaceState(null,'','#moj');        renderMojList();        return; }
	if (code === 'maff')       { history.replaceState(null,'','#maff');       renderMaffList();       return; }
	if (code === 'estat')      { history.replaceState(null,'','#estat');      renderEstatList();      return; }
	if (code === 'amedas')     { history.replaceState(null,'','#amedas');     showAmedas();           return; }
	if (code === 'seismic')    { history.replaceState(null,'','#seismic');    showSeismic();          return; }
	if (code === 'census2025') { history.replaceState(null,'','#census2025'); renderCensus2025List(); return; }
	if (code === 'census2020') { history.replaceState(null,'','#census2020'); renderCensus2020List(); return; }
	if (code === 'census2015')       { history.replaceState(null,'','#census2015');       renderCensus2015List(); return; }
	if (code === 'census-small-2020') { history.replaceState(null,'','#census-small-2020'); renderCensusSmall2020(); return; }

	nlftpSelectDataset(code);
}

// ============================================================
// ユーティリティ
// ============================================================
async function copyEntries(entries, feedbackEl) {
	const text = entries.length === 1
		? JSON.stringify(entries[0], null, 2)
		: JSON.stringify(entries, null, 2);
	try { await navigator.clipboard.writeText(text); } catch {}
	showToast(entries.length === 1 ? entries[0].name : `${entries.length}件をクリップボードにコピーしました`);
	if (!feedbackEl) return;
	const orig = feedbackEl.textContent;
	feedbackEl.textContent = '✓ コピー済み';
	setTimeout(() => { feedbackEl.textContent = orig; }, 1800);
}

// ============================================================
// ctx 登録（省庁モジュールが参照する共有関数）
// ============================================================
ctxSetup({ setDetailHtml, renderExecView, bulkDownload, copyEntries, closeGeoPreview, renderMojList });

// ============================================================
// キーボードナビゲーション
// ============================================================
document.addEventListener('keydown', e => {
	const tag = document.activeElement?.tagName;
	const inInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

	if (e.key === '/' && !inInput) { e.preventDefault(); document.getElementById('search').select(); return; }
	if (e.key === 'Escape' && tag === 'INPUT') {
		const s = document.getElementById('search');
		if (s.value) { s.value = ''; renderList(); }
		s.blur(); return;
	}
	if (!['ArrowUp','ArrowDown','Enter'].includes(e.key) || inInput) return;
	e.preventDefault();

	const items = [...document.querySelectorAll('.ds-item')];
	if (!items.length) return;
	if (e.key === 'Enter') { const cur = document.querySelector('.ds-item.active'); if (cur) selectDataset(cur.dataset.code); return; }

	const curIdx  = items.findIndex(el => el.dataset.code === active);
	const nextIdx = e.key === 'ArrowDown'
		? (curIdx < 0 ? 0 : Math.min(curIdx + 1, items.length - 1))
		: (curIdx < 0 ? items.length - 1 : Math.max(curIdx - 1, 0));

	const next = items[nextIdx];
	items.forEach(el => el.classList.remove('kbd-focus'));
	next.classList.add('kbd-focus');
	next.scrollIntoView({ block: 'nearest' });
	selectDataset(next.dataset.code);
});

window.addEventListener('hashchange', () => {
	const hash = location.hash.slice(1);
	if (!hash) return;
	if (hash === 'moj') { if (active !== 'moj') selectDataset('moj', true); return; }
	if (hash === 'amedas' || hash === 'seismic') { selectDataset(hash, true); return; }   // 別枠（カタログ外）
	if (hash !== active && catalog.some(ds => ds.dataset_code === hash)) {
		selectDataset(hash, true);
		setTimeout(() => document.querySelector(`.ds-item[data-code="${hash}"]`)?.scrollIntoView({ block: 'center' }), 100);
	}
});

// ============================================================
// 初期化
// ============================================================
async function init() {
	document.getElementById('search').addEventListener('input', renderList);
	document.getElementById('license-filter').addEventListener('click', e => {
		const btn = e.target.closest('.chip');
		if (!btn) return;
		licFilter = btn.dataset.lic;
		document.querySelectorAll('#license-filter .chip').forEach(b => b.classList.toggle('active', b === btn));
		renderList();
	});
	await loadCatalog();
}


init();
initSidebarToggle();
initDetailEventListeners();

document.getElementById('sidebar-brand').addEventListener('click', () => {
	history.replaceState(null, '', '#');
	setDetailHtml(placeholder(catalog));
	closeGeoPreview();
});

// execGlobeView を globalThis に置く（将来の外部連携用）
globalThis._execGlobeView = execGlobeView;
