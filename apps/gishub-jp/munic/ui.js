// 市区町村のオープンデータ（G空間情報センターの自治体組織）＝都道府県 → 市区町村 → データセット → 資料。
// 台帳は munic-manifest.js が作る（アプリ同梱）：目次 manifest.json（一覧）＋ 都道府県ごとの pref/<2桁>.json（市区町村を開いた時にその県の分だけ）。
// データ本体は配布元を直読みしてその場で GeoPBF 変換（G空間は CORS 可・取れない先は native-bucket の中継が自動で拾う＝bucket には置かない）。
import MUNIC from './manifest.json' with { type: 'json' };
const PREF_FILES = import.meta.glob('./pref/*.json', { import: 'default' });   // 県ごとに別チャンク
const prefCache = new Map();
async function loadCity(code) {
	const k = code.slice(0, 2);
	if (!prefCache.has(k)) prefCache.set(k, PREF_FILES[`./pref/${k}.json`]?.() ?? Promise.resolve([]));
	return (await prefCache.get(k)).find(e => e.code === code) || null;
}
import { PREFS, escHtml } from '../ui/shared.js';
import { ctx } from '../ui/ctx.js';
import { renderMinistryList } from '../ui/ministry-list.js';

const CAD = '地番図・地籍';
const CAT_ORDER = [CAD, '防災', '都市計画・道路', '施設・観光', '医療・AED', 'その他'];
const FMT_LABEL = { geojson: 'GeoJSON', kml: 'KML', kmz: 'KMZ', zip: 'Shape(zip)', gml: 'GML', gpkg: 'GPKG', fgb: 'FGB', csv: 'CSV', xlsx: 'Excel' };
const FMT_CLASS = { geojson: 'fmt-geojson', kml: 'fmt-gml', kmz: 'fmt-gml', zip: 'fmt-shp', gml: 'fmt-gml', gpkg: 'fmt-pbf', fgb: 'fmt-pbf', csv: 'fmt-none', xlsx: 'fmt-none' };
const pageOf = s => s.page || `https://www.geospatial.jp/ckan/dataset/${encodeURIComponent(s.id)}`;   // 横断検索の分は配布元のページ・G空間は id から

let listSearch = '', expanded = new Set(), cadOnly = false;

// ---- 一覧（都道府県 → 市区町村） ----
function cityItemHtml(c) {
	const e = c._raw;
	return `
		<div class="moj-city-item" data-code="${escHtml(c.code)}" title="開く">
			<span class="moj-city-code">${escHtml(c.code)}</span>
			<span class="moj-city-name">${escHtml(c.name)}${e.cad ? '<span class="area-tag munic-cad-tag">地番図</span>' : ''}</span>
			<span class="moj-city-file">${e.n} データセット</span>
			<span></span>
		</div>`;
}

export function renderMunicList() {
	const src = cadOnly ? MUNIC.filter(e => e.cad) : MUNIC;
	const cities = src.map(e => ({ code: e.code, name: e.city, pref: e.code.slice(0, 2), _raw: e }));
	renderMinistryList({
		id: 'munic',
		title: '市区町村のオープンデータ',
		subtitle: `市区町村が公開しているデータ（G空間情報センター＋データカタログ横断検索・${MUNIC.reduce((s, e) => s + e.n, 0).toLocaleString()} データセット）
			<label class="munic-cad-only"><input type="checkbox" id="munic-cad-only"${cadOnly ? ' checked' : ''}> 地番図・地籍のある自治体だけ</label>`,
		cities,
		expanded,
		getSearch: () => listSearch,
		setSearch: v => { listSearch = v; },
		itemHtml: cityItemHtml,
		groupFn: c => ({ key: c.pref, name: PREFS[c.pref] || c.pref }),
		toEntry: c => c,
		bulkByGroup: () => [],
		allEntries: () => [],
		onItemClick: async c => { const e = await loadCity(c.code); if (e) renderCity(e); },
		noBulk: true,   // 市区町村ごとの束は種類がばらばら＝一括読込は意味が無い
	});
	document.getElementById('munic-cad-only')?.addEventListener('change', ev => { cadOnly = ev.target.checked; renderMunicList(); });
}

// ---- 市区町村の中（分類 → データセット → 資料） ----
function toEntry(e, set, r) {
	return {
		name: (r.name || set.title).replace(/\.[a-z0-9]+$/i, ''),
		description: `${PREFS[e.code.slice(0, 2)] || ''} ${e.city} ${set.title}`,
		target: r.url,
		link: pageOf(set),
		attribution: `${e.orgTitle}（${set.src || 'G空間情報センター'}）`,
		license: set.license,
		...(set.crs ? { crs: set.crs } : {}),   // .prj の無い Shapefile の座標系（CKAN の data_crs）
	};
}

function renderCity(e) {
	history.replaceState(null, '', `#munic`);
	const back = () => renderMunicList();
	// 地番図・地籍は年度違いが並ぶ＝新しい年度を上に（題名の降順＝「令和８年度…」が先）
	const groups = CAT_ORDER.map(cat => [cat, e.sets.filter(s => s.cat === cat)]).filter(([, s]) => s.length)
		.map(([cat, s]) => [cat, cat === CAD ? [...s].sort((a, b) => b.title.localeCompare(a.title, 'ja', { numeric: true })) : s]);
	const setHtml = (s, si) => `
		<div class="munic-set">
			<div class="munic-set-head">
				<span class="munic-set-title">${escHtml(s.title)}</span>
				<span class="munic-set-src">${escHtml(s.src || 'G空間情報センター')}</span>
				${s.license ? `<span class="meta-lic">${escHtml(s.license)}</span>` : ''}
				<a class="munic-src" href="${escHtml(pageOf(s))}" target="_blank" rel="noopener">配布元 ↗</a>
			</div>
			<div class="munic-res">
				${s.res.map((r, ri) => `<button class="munic-res-btn" data-s="${si}" data-r="${ri}" title="${escHtml(r.url)}"><span class="badge ${FMT_CLASS[r.fmt] || 'fmt-none'}">${escHtml(FMT_LABEL[r.fmt] || r.fmt)}</span> ${escHtml(r.name)}</button>`).join('')}
			</div>
		</div>`;
	const idx = new Map(e.sets.map((s, i) => [s, i]));
	ctx.setDetailHtml(`
		<div class="detail-inner munic-city">
			<button class="back-btn" id="munic-back">← 一覧に戻る</button>
			<header class="detail-header">
				<h2>${escHtml(PREFS[e.code.slice(0, 2)] || '')} ${escHtml(e.city)}</h2>
				<div class="detail-meta">
					<span class="mono">${escHtml(e.code)}</span>
					${e.org ? `<a class="ext-link" href="https://www.geospatial.jp/ckan/organization/${escHtml(e.org)}" target="_blank" rel="noopener">G空間情報センター「${escHtml(e.orgTitle)}」→</a>` : ''}
					<span class="mono">${e.sets.length} データセット</span>
				</div>
				<p class="munic-note">資料を押すと配布元から読み込み、その場で GeoPBF に変換します。CSV・Excel は緯度・経度の列があるものだけ地図に描けます。配布元のリンク切れや形式の違いで開けないものもあります。</p>
			</header>
			${groups.map(([cat, sets]) => `
				<section class="detail-section">
					<h3 class="section-title">${escHtml(cat)} <span class="cnt">${sets.length}</span><span class="toggle-icon">▾</span></h3>
					<div class="section-body munic-sets">${sets.map(s => setHtml(s, idx.get(s))).join('')}</div>
				</section>`).join('')}
		</div>`);
	document.getElementById('munic-back').addEventListener('click', back);
	const body = document.querySelector('.munic-city');
	body.addEventListener('click', ev => {
		const t = ev.target.closest('.section-title');
		if (t) { t.parentElement.classList.toggle('collapsed'); return; }
		const b = ev.target.closest('.munic-res-btn');
		if (!b) return;
		const set = e.sets[+b.dataset.s], r = set.res[+b.dataset.r];
		ctx.renderExecView(toEntry(e, set, r), () => renderCity(e));
	});
}
