// ============================================================
// データソース設定
// ============================================================
const SOURCES = [
	{
		id:          'moj',
		title:       '法務省 登記所備付地図',
		attribution: '法務省',
		// bucket なし → manifest から生成
	},
	{
		id:          'nlftp',
		title:       '国土交通省 国土数値情報',
		bucket:      'catalog',
		attribution: '国土交通省 国土数値情報',
	},
	// { id: 'maff',  title: '農林水産省 筆ポリゴン',   bucket: 'maff-catalog' },
	// { id: 'soumu', title: '総務省 e-Stat GIS',       bucket: 'soumu-catalog' },
];

// ============================================================
// マニフェスト（静的インポート）
// ============================================================
import MOJ_MANIFEST         from './moj/manifest.json'        with { type: 'json' };
import MOJ_GEOJSON_MANIFEST from './moj/geojson.json'         with { type: 'json' };
import MOJ_PBF_MANIFEST     from './moj/pbf-manifest.json'   with { type: 'json' };
import MAFF_MANIFEST        from './maff/manifest.json'       with { type: 'json' };
import ESTAT_MANIFEST       from './estat/manifest.json'      with { type: 'json' };
import CENSUS_MANIFEST      from './census/manifest.json'     with { type: 'json' };
import CENSUS_2025_POP      from './census/2025-pop.json'     with { type: 'json' };
import CENSUS_2020_STATS    from './census/2020-stats.json'   with { type: 'json' };
import CENSUS_2015_STATS    from './census/2015-stats.json'   with { type: 'json' };
import { buildCensusChartSVG } from './census/charts.mjs';
import { geopbf, setApiUrl } from 'geopbf';
import { geoExec } from 'common/geoExec';
import { screenLogger } from 'common/screenLogger';
import { saveTo, openDirectory, comma } from 'common';
import orthoMap from 'ortho-map';
import { select as d3select } from 'd3';

// ============================================================
// API 設定
// ============================================================
const IS_DEV   = window.location.hostname === 'localhost';
const API_BASE = IS_DEV ? '/api' : 'https://api.ortho-earth.com';

setApiUrl(API_BASE);
const TILER_BASE = 'https://tiler.ortho-earth.com';

// ============================================================
// Globe (ortho-map) 初期化
// ============================================================
const _initialZoom = Math.log2(Math.min(window.innerWidth, window.innerHeight) / 2 * 0.5 / 256 * Math.PI * 2);
const _mapInst = await orthoMap({
	target:    d3select('#globe-bg'),
	center:    [135, 35],
	zoom:      _initialZoom,
	tilerBase: TILER_BASE,
	apiUrl:    API_BASE,
}).then(m => m.autoRotate(true));
const _closeBtn = _mapInst.gadget.close();
_mapInst.on("ortho:close", exitGlobeView);

let _globeLayer = null;
let _currentPbf = null;

async function execGlobeView(pbf) {
	if (!pbf?.length) return;
	_currentPbf = pbf;
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
	// レイヤーを描画してからパネルを隠す（データなし素グローブの一瞬を防ぐ）
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
function exitGlobeView() {
	if (_globeLayer) { _globeLayer.destroy(); _globeLayer = null; }
	_currentPbf = null;
	_mapInst.setView([135, 35], _initialZoom);
	_mapInst.autoRotate(true);
	_closeBtn.hide();
	document.getElementById('app').classList.remove('viewing');
}

function bucketUrl(src, path) {
	return `${API_BASE}/bucket/${src.bucket}/${path}`;
}

async function fetchJson(url) {
	const res = await fetch(url);
	const buf = await res.arrayBuffer();
	const head = new Uint8Array(buf, 0, 2);
	if (head[0] === 0x1f && head[1] === 0x8b) {
		const ds   = new DecompressionStream('gzip');
		const text = await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
		return JSON.parse(text);
	}
	return JSON.parse(new TextDecoder().decode(buf));
}

// ============================================================
// State
// ============================================================
const SOURCES_MAP = Object.fromEntries(SOURCES.map(s => [s.id, s]));

let catalog  = [];   // サイドバー表示用フラットリスト
let active   = null; // 選択中の dataset_code
let licFilter = 'all';
let currentCodelists = [];
let currentDs = null;

// 省庁データ（事前生成）
const MOJ_CITIES      = buildMojCities();
const MOJ_GEOJSON_MAP = buildMojGeojsonMap();
const MOJ_PBF_MAP     = new Map(MOJ_PBF_MANIFEST.map(e => [e.cityCode, e]));
const MAFF_BY_PREF = buildMaffByPref();
const ESTAT_BY_PREF = buildEstatByPref();

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

// ============================================================
// 法務省データ構築（manifest → 市区町村マップ + サイドバー1エントリ）
// ============================================================
function buildMojCities() {
	const byCity = new Map();
	for (const entry of MOJ_MANIFEST) {
		if (!byCity.has(entry.cityCode)) byCity.set(entry.cityCode, []);
		byCity.get(entry.cityCode).push(entry);
	}
	return byCity; // Map<cityCode, entry[]>
}

// cityCode（5桁）→ GeoJSON エントリ
function buildMojGeojsonMap() {
	const map = new Map();
	for (const entry of MOJ_GEOJSON_MANIFEST) {
		map.set(entry.name.slice(0, 5), entry);
	}
	return map;
}

function mojSidebarEntry() {
	return { dataset_code:'moj',  title:'登記所備付地図（14条地図）', file_count:MOJ_CITIES.size, license:'CC BY 4.0', _sourceId:'moj' };
}

// ============================================================
// 農林水産省 筆ポリゴン
// ============================================================
function buildMaffByPref() {
	const map = new Map();
	for (const e of MAFF_MANIFEST) {
		if (!map.has(e.prefCd)) map.set(e.prefCd, []);
		map.get(e.prefCd).push(e);
	}
	return map;
}

function maffSidebarEntry() {
	return { dataset_code:'maff', title:'農地（筆ポリゴン）', file_count:MAFF_MANIFEST.length, license:'CC BY 4.0', _sourceId:'maff' };
}

function buildMaffCityList() {
	return MAFF_MANIFEST.map(e => ({
		code: e.prefCityCd,
		name: e.cityName,
		pref: e.prefCd,
		year: e.year,
		size: e.size || null,
		_raw: e,
	}));
}

function maffCityItemHtml(city) {
	const sizeBadge = city.size
		? `<span class="file-sz">${fmtBytes(city.size)} <span class="size-note">PBF</span></span>`
		: '';
	return `
		<div class="moj-city-item" data-code="${city.code}" title="クリックでコピー">
			<span class="moj-city-code">${city.code}</span>
			<span class="moj-city-name">${city.name}</span>
			<span class="moj-city-file">${city.year}年度${sizeBadge}</span>
			<span class="badge fmt-geojson">GeoJSON</span>
		</div>
	`;
}

function maffToEntry(e) {
	return {
		name:        `${e.prefCityCd}_${e.year}`,
		description: `${e.prefName} ${e.cityName} 筆ポリゴン ${e.year}年度`,
		target:      `maff_${e.prefCityCd}.geopbf`,
		attribution: '農林水産省',
		license:     'CC BY 4.0',
		format:      'maff',
		_maff:       { prefCd:e.prefCd, prefName:e.prefName, cityCd:e.cityCd, cityName:e.cityName, year:e.year, prefCityCd:e.prefCityCd },
	};
}

let maffListSearch = '', maffExpandedPrefs = new Set();

function renderMaffList() {
	const cities = buildMaffCityList();
	renderMinistryList({
		id:          'maff',
		title:       '農林水産省 筆ポリゴン',
		subtitle:    '筆ポリゴンオープンデータ（農林水産省）<span class="moj-fmt-note">GeoJSON = API→zip→json</span>',
		cities,
		expanded:    maffExpandedPrefs,
		getSearch:   () => maffListSearch,
		setSearch:   v  => { maffListSearch = v; },
		itemHtml:    maffCityItemHtml,
		groupFn:     c  => ({ key: c.pref, name: PREFS[c.pref] || c.pref }),
		toEntry:     c  => maffToEntry(c._raw),
		bulkByGroup: pref => (MAFF_BY_PREF.get(pref) || []).map(maffToEntry),
		allEntries:  () => MAFF_MANIFEST.map(maffToEntry),
		groupHeaderHtml: (_key, _name, items) => {
			const total = items.reduce((s, c) => s + (c.size || 0), 0);
			return total ? `<span class="pref-size">${fmtBytes(total)} <span class="size-note">PBF</span></span>` : '';
		},
		onItemClick: city => {
			const entry = maffToEntry(city._raw);
			renderExecView(entry, () => { history.replaceState(null, '', '#maff'); renderMaffList(); });
		},
	});
}

// ============================================================
// 総務省 e-Stat 統計GIS（小地域）
// ============================================================
const ESTAT_DL_BASE  = 'https://www.e-stat.go.jp/gis/statmap-search/data';
const ESTAT_SURVEY   = 'A002005212020';
function estatDlUrl(code) {
	return `${ESTAT_DL_BASE}?dlserveyId=${ESTAT_SURVEY}&code=${code}&coordSys=1&format=shape&downloadType=5&datum=2011`;
}

function buildEstatByPref() {
	const map = new Map();
	for (const e of ESTAT_MANIFEST) {
		if (!map.has(e.prefCode)) map.set(e.prefCode, []);
		map.get(e.prefCode).push(e);
	}
	return map;
}

function estatSidebarEntry() {
	return { dataset_code:'estat', title:'統計GIS 小地域境界', file_count:ESTAT_MANIFEST.length, license:'CC BY', _sourceId:'estat' };
}

function buildEstatCityList() {
	return ESTAT_MANIFEST.map(e => ({
		code: e.code,
		name: e.name,
		pref: e.prefCode,
		size: e.size || null,
		_raw: e,
	}));
}

function estatCityItemHtml(city) {
	const sizeBadge = city.size
		? `<span class="file-sz">${fmtBytes(city.size)} <span class="size-note">ZIP</span></span>`
		: '';
	return `
		<div class="moj-city-item" data-code="${city.code}" title="クリックでコピー">
			<span class="moj-city-code">${city.code}</span>
			<span class="moj-city-name">${city.name}</span>
			<span class="moj-city-file">A002005212020_${city.code}.zip${sizeBadge}</span>
			<span class="badge fmt-shp">SHP</span>
		</div>
	`;
}

function estatToEntry(e) {
	return {
		name:        `${e.code}_${ESTAT_SURVEY}`,
		description: `${PREFS[e.prefCode] || e.prefCode} ${e.name} 小地域（国勢調査2020）`,
		target:      estatDlUrl(e.code),
		attribution: '総務省統計局',
		license:     'CC BY',
	};
}

let estatListSearch = '', estatExpandedPrefs = new Set();

function renderEstatList() {
	const cities = buildEstatCityList();
	renderMinistryList({
		id:          'estat',
		title:       '総務省 統計GIS 小地域',
		subtitle:    '国勢調査2020 小地域（町丁・字等）境界データ<span class="moj-fmt-note">SHP = zip/shp</span>',
		cities,
		expanded:    estatExpandedPrefs,
		getSearch:   () => estatListSearch,
		setSearch:   v  => { estatListSearch = v; },
		itemHtml:    estatCityItemHtml,
		groupFn:     c  => ({ key: c.pref, name: PREFS[c.pref] || c.pref }),
		toEntry:     c  => estatToEntry(c._raw),
		bulkByGroup: pref => (ESTAT_BY_PREF.get(pref) || []).map(e => estatToEntry(e)),
		allEntries:  () => ESTAT_MANIFEST.map(estatToEntry),
		downloadFn:  estatGeopbf,
		groupHeaderHtml: (_key, _name, items) => {
			const total = items.reduce((s, c) => s + (c.size || 0), 0);
			return total ? `<span class="pref-size">${fmtBytes(total)} <span class="size-note">ZIP</span></span>` : '';
		},
		onItemClick: city => {
			const entry = estatToEntry(city._raw);
			const estatFetch = async (target, _opts) => {
				const proxyUrl = `${API_BASE}/proxy/?url=${encodeURIComponent(target)}`;
				const resp = await fetch(proxyUrl);
				if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
				const blob = await resp.blob();
				return geopbf(new File([blob], `${entry.name}.zip`), { name: entry.name });
			};
			renderExecView(entry, () => { history.replaceState(null, '', '#estat'); renderEstatList(); }, estatFetch);
		},
	});
}

// ============================================================
// 総務省統計局 国勢調査 2025 速報集計
// ============================================================
const CENSUS_BY_PREF = (() => {
	const m = new Map();
	for (const e of CENSUS_MANIFEST) {
		if (!e.code.endsWith('000') && e.code !== '00000') {
			if (!m.has(e.pref)) m.set(e.pref, []);
			m.get(e.pref).push(e);
		}
	}
	return m;
})();

function census2025SidebarEntry() {
	const cities = CENSUS_MANIFEST.filter(e => !e.code.endsWith('000') && e.code !== '00000');
	return { dataset_code:'census2025', title:'国勢調査 2025 速報集計', file_count:cities.length, license:'CC BY', _sourceId:'estat', attribution:'総務省統計局' };
}
function census2020SidebarEntry() {
	const cities = CENSUS_MANIFEST.filter(e => !e.code.endsWith('000') && e.code !== '00000');
	return { dataset_code:'census2020', title:'国勢調査 2020 基本集計', file_count:cities.length, license:'CC BY', _sourceId:'estat', attribution:'総務省統計局' };
}
function census2015SidebarEntry() {
	const cities = Object.keys(CENSUS_2015_STATS);
	return { dataset_code:'census2015', title:'国勢調査 2015 基本集計', file_count:cities.length, license:'CC BY', _sourceId:'estat', attribution:'総務省統計局' };
}

function censusSign(v) { return v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1); }

function census2025CityItemHtml(city) {
	const p   = CENSUS_2025_POP[city.code];
	const chg = p ? `<span class="pop-chg ${p.popChange >= 0 ? 'pos' : 'neg'}">${censusSign(p.popChange)}%</span>` : '';
	const pop = p ? `<span class="pop-val">${p.pop[0].toLocaleString()}人</span>` : '';
	return `
		<div class="census-city-item moj-city-item" data-code="${city.code}">
			<span class="moj-city-code">${city.code}</span>
			<span class="moj-city-name">${city.name}</span>
			${pop}${chg}
		</div>
	`;
}
function census2020CityItemHtml(city) {
	const s   = CENSUS_2020_STATS[city.code];
	const ind = s?.ind?.[0];
	const emp = ind ? `<span class="pop-val">${ind.toLocaleString()}人就業</span>` : '';
	return `
		<div class="census-city-item moj-city-item" data-code="${city.code}">
			<span class="moj-city-code">${city.code}</span>
			<span class="moj-city-name">${city.name}</span>
			${emp}
		</div>
	`;
}
function census2015CityItemHtml(city) {
	const s   = CENSUS_2015_STATS[city.code];
	const pop = s?.pop?.[0];
	const val = pop ? `<span class="pop-val">${pop.toLocaleString()}人</span>` : '';
	return `
		<div class="census-city-item moj-city-item" data-code="${city.code}">
			<span class="moj-city-code">${city.code}</span>
			<span class="moj-city-name">${city.name}</span>
			${val}
		</div>
	`;
}

function buildCensusCityList() {
	return CENSUS_MANIFEST.filter(e => !e.code.endsWith('000') && e.code !== '00000');
}

let census2025Search = '', census2025Expanded = new Set();
let census2020Search = '', census2020Expanded = new Set();
let census2015Search = '', census2015Expanded = new Set();

function renderCensus2025List() {
	const cities = buildCensusCityList();
	renderCensusMinistryList({
		id:       'census2025',
		title:    '国勢調査 2025 速報集計',
		subtitle: '令和7年国勢調査 人口速報集計（2025年10月1日現在）<span class="moj-fmt-note">男女別人口・世帯数</span>',
		cities,
		expanded:    census2025Expanded,
		getSearch:   () => census2025Search,
		setSearch:   v  => { census2025Search = v; },
		itemHtml:    census2025CityItemHtml,
		onItemClick: code => showCensusDetail(code, '2025'),
	});
}
function renderCensus2020List() {
	const cities = buildCensusCityList();
	renderCensusMinistryList({
		id:       'census2020',
		title:    '国勢調査 2020 基本集計',
		subtitle: '令和2年国勢調査 産業別・職業別就業者、世帯経済構成<span class="moj-fmt-note">2020年10月1日現在</span>',
		cities,
		expanded:    census2020Expanded,
		getSearch:   () => census2020Search,
		setSearch:   v  => { census2020Search = v; },
		itemHtml:    census2020CityItemHtml,
		onItemClick: code => showCensusDetail(code, '2020'),
	});
}
function renderCensus2015List() {
	const codes  = new Set(Object.keys(CENSUS_2015_STATS));
	const cities = CENSUS_MANIFEST.filter(e => !e.code.endsWith('000') && e.code !== '00000' && codes.has(e.code));
	renderCensusMinistryList({
		id:       'census2015',
		title:    '国勢調査 2015 基本集計',
		subtitle: '平成27年国勢調査 産業別・職業別就業者、世帯経済構成<span class="moj-fmt-note">2015年10月1日現在</span>',
		cities,
		expanded:    census2015Expanded,
		getSearch:   () => census2015Search,
		setSearch:   v  => { census2015Search = v; },
		itemHtml:    census2015CityItemHtml,
		onItemClick: code => showCensusDetail(code, '2015'),
	});
}

// 国勢調査専用: ダウンロードなし、クリックで詳細表示
function renderCensusMinistryList({ id, title, subtitle, cities, expanded, getSearch, setSearch, itemHtml, onItemClick }) {
	setDetailHtml(`
		<div class="moj-list-wrap">
			<div class="moj-list-head">
				<div class="moj-head-row">
					<div>
						<h2>${title}</h2>
						<p class="moj-subtitle">${subtitle}<span class="moj-total">${cities.length.toLocaleString()}市区町村</span></p>
					</div>
				</div>
				<input type="text" id="${id}-search" class="moj-search" placeholder="市区町村・都道府県を検索...">
			</div>
			<div class="grouped-list" id="${id}-cities"></div>
		</div>
	`);
	const render = () => renderGroupedCities(cities, `${id}-cities`, expanded, itemHtml, {
		query:       getSearch(),
		groupFn:     c => ({ key: c.pref, name: PREFS[c.pref] || c.pref }),
		onBulkClick: () => {},
		onItemClick: e => {
			const row = e.target.closest('.moj-city-item');
			if (row) onItemClick(row.dataset.code);
		},
	});
	document.getElementById(`${id}-search`).addEventListener('input', function() {
		setSearch(this.value); render();
	});
	render();
}

// 国勢調査 小地域一覧ロード
const ESTAT_CODE_SET = new Set(ESTAT_MANIFEST.map(e => e.code));
const GIS_DL_BASE = 'https://www.e-stat.go.jp/gis/statmap-search/data';

async function unzipFirstEntry(blob) {
	const buf = await blob.arrayBuffer();
	const u8  = new Uint8Array(buf);
	const v   = new DataView(buf);
	if (v.getUint32(0, true) !== 0x04034b50) throw new Error('Not a ZIP');
	const method = v.getUint16(8, true);
	const fnLen  = v.getUint16(26, true);
	const exLen  = v.getUint16(28, true);
	const start  = 30 + fnLen + exLen;
	let comp = v.getUint32(18, true);
	if (comp === 0) {
		for (let i = start + 4; i < u8.length - 4; i++) {
			const sig = v.getUint32(i, true);
			if (sig === 0x02014b50 || sig === 0x04034b50 || sig === 0x08074b50) { comp = i - start; break; }
		}
	}
	const slice = u8.subarray(start, start + comp);
	if (method === 0) return slice;
	if (method === 8) return new Uint8Array(
		await new Response(new Blob([slice]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()
	);
	throw new Error(`ZIP method ${method}`);
}

async function fetchGisStatsCsv(cityCode, statsId) {
	const url = `${GIS_DL_BASE}?statsId=${statsId}&downloadType=2&code=${cityCode}`;
	const resp = await fetch(`${API_BASE}/proxy/?url=${encodeURIComponent(url)}`);
	if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
	const bytes = await unzipFirstEntry(await resp.blob());
	let text;
	try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
	catch { text = new TextDecoder('shift-jis').decode(bytes); }
	return text.split(/\r?\n/).map(l => l.split(',').map(s => s.replace(/^"|"$/g, '')));
}

// T001081: 人口総数・男女別（col 7=総人口, 8=男, 9=女）
// prefCode = cityCode の先頭2桁（e-Stat は都道府県単位でしか受け付けない）
async function fetchSmallAreaPop(cityCode) {
	const rows = await fetchGisStatsCsv(cityCode.substring(0, 2), 'T001081');
	const map = new Map();
	for (const t of rows) {
		const code = String(t[0] || '');
		if (code.length <= 5 || !code.startsWith(cityCode)) continue;
		map.set(code, { total: +t[7] || 0, m: +t[8] || 0, f: +t[9] || 0 });
	}
	return map;
}

// T001082: 年齢別人口（男: col 28-42 + 46 = 16グループ, 女: col 48-62 + 66）
async function fetchSmallAreaPyramid(cityCode) {
	const rows = await fetchGisStatsCsv(cityCode.substring(0, 2), 'T001082');
	const map = new Map();
	for (const t of rows) {
		const code = String(t[0] || '');
		if (code.length <= 5 || !code.startsWith(cityCode)) continue;
		const clean = (a) => a.map(v => +v || 0);
		const mAges = clean([...t.slice(28, 43), t[46]]);
		const fAges = clean([...t.slice(48, 63), t[66]]);
		map.set(code, { mAges, fAges });
	}
	return map;
}

// SVG 人口ピラミッド（小地域用・コンパクト）
function smallAreaPyramidSvg(mAges, fAges) {
	const labels = ['0','5','10','15','20','25','30','35','40','45','50','55','60','65','70','75+'];
	const total  = [...mAges, ...fAges].reduce((s, v) => s + v, 0);
	if (!total) return '<span style="color:#666;font-size:11px">データなし</span>';
	const max  = Math.max(...mAges, ...fAges);
	const bW   = 52; // half-width for each side
	const bH   = 8;
	const gap  = 1;
	const lblW = 22;
	const W    = bW * 2 + lblW;
	const H    = (bH + gap) * 16 + 14;
	const bars = [...mAges].reverse().map((m, i) => {
		const fi = 15 - i;
		const f  = fAges[fi];
		const mw = max ? (m / max * bW).toFixed(1) : 0;
		const fw = max ? (f / max * bW).toFixed(1) : 0;
		const y  = i * (bH + gap);
		const lbl = i % 2 === 0 ? `<text x="${bW + lblW / 2}" y="${y + bH - 1}" text-anchor="middle" font-size="5.5" fill="#888">${labels[fi]}</text>` : '';
		return `<rect x="${bW - mw}" y="${y}" width="${mw}" height="${bH}" fill="#68b" opacity=".85"/>` +
		       `<rect x="${bW + lblW}" y="${y}" width="${fw}" height="${bH}" fill="#c6a" opacity=".85"/>` +
		       lbl;
	}).join('');
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="display:block">` +
		`<text x="${bW/2}" y="${H-2}" text-anchor="middle" font-size="6.5" fill="#68b">男</text>` +
		`<text x="${bW+lblW+bW/2}" y="${H-2}" text-anchor="middle" font-size="6.5" fill="#c6a">女</text>` +
		bars + '</svg>';
}

// 年齢3区分のミニバー（0-14 / 15-64 / 65+）
function miniAgeBar(mAges, fAges) {
	if (!mAges?.length) return '';
	const all   = mAges.map((m, i) => m + fAges[i]);
	const total = all.reduce((s, v) => s + v, 0);
	if (!total) return '';
	const young = all.slice(0, 3).reduce((s, v) => s + v, 0);
	const work  = all.slice(3, 13).reduce((s, v) => s + v, 0);
	const old   = all.slice(13).reduce((s, v) => s + v, 0);
	const W = 60;
	const yw = (young / total * W).toFixed(1);
	const ww = (work  / total * W).toFixed(1);
	const ow = (old   / total * W).toFixed(1);
	return `<svg width="${W}" height="8" style="vertical-align:middle;border-radius:2px;overflow:hidden">` +
		`<rect x="0" y="0" width="${yw}" height="8" fill="#5a9"/>` +
		`<rect x="${yw}" y="0" width="${ww}" height="8" fill="#579"/>` +
		`<rect x="${+yw + +ww}" y="0" width="${ow}" height="8" fill="#a65"/>` +
		'</svg>';
}

async function loadSmallAreas(code, bodyEl) {
	bodyEl.innerHTML = '<span class="cs-sa-loading">読み込み中…</span>';
	try {
		const [pbfResult, popResult, pyrResult] = await Promise.allSettled([
			estatGeopbf({ name: `${code}_${ESTAT_SURVEY}`, target: estatDlUrl(code) }),
			fetchSmallAreaPop(code),
			fetchSmallAreaPyramid(code),
		]);

		if (pbfResult.status === 'rejected') throw pbfResult.reason;
		const pbf    = pbfResult.value;
		const popMap = popResult.status === 'fulfilled' ? popResult.value : new Map();
		const pyrMap = pyrResult.status === 'fulfilled' ? pyrResult.value : new Map();

		const data = pbf.getPropertyTable();
		if (!data?.length) { bodyEl.textContent = 'データなし'; return; }
		const headers = data[0];
		const rows    = data.slice(1);
		const ki = headers.findIndex(h => /KEY_CODE/i.test(String(h)));
		const ni = headers.findIndex(h => /S_NAME/i.test(String(h)));
		if (ki < 0 || ni < 0) { bodyEl.textContent = 'カラム不明'; return; }

		const seen = new Set();
		const items = rows
			.map(r => [String(r[ki]), String(r[ni])])
			.filter(t => { if (seen.has(t[0])) return false; seen.add(t[0]); return true; })
			.sort((a, b) => a[0] > b[0] ? 1 : -1);

		const hasPop = popMap.size > 0;
		const hasPyr = pyrMap.size > 0;
		const esc    = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

		const csvHead = hasPop
			? 'コード,名称,総人口,男,女'
			: 'コード,名称';
		const csvRows = items.map(([kc, nm]) => {
			const p = popMap.get(kc);
			return hasPop
				? `${kc},"${nm.replace(/"/g, '""')}",${p?.total ?? ''},${p?.m ?? ''},${p?.f ?? ''}`
				: `${kc},"${nm.replace(/"/g, '""')}"`;
		});
		const csvContent = '﻿' + csvHead + '\n' + csvRows.join('\n');

		const thPop = hasPop ? '<th>人口</th>' : '';
		const thPyr = hasPyr ? '<th>年齢構成</th>' : '';
		const bodyHtml = items.map(([kc, nm], i) => {
			const p   = popMap.get(kc);
			const pyr = pyrMap.get(kc);
			const tdPop = hasPop
				? `<td class="cs-sa-pop">${p?.total ? p.total.toLocaleString() : '—'}</td>`
				: '';
			const tdPyr = hasPyr
				? `<td class="cs-sa-bar">${pyr ? miniAgeBar(pyr.mAges, pyr.fAges) : ''}</td>`
				: '';
			return `<tr data-code="${esc(kc)}"${pyr ? ' class="has-pyr"' : ''}>` +
				`<td>${i + 1}</td><td>${esc(kc)}</td><td>${esc(nm)}</td>${tdPop}${tdPyr}</tr>`;
		}).join('');

		bodyEl.innerHTML = `
			<div class="cs-sa-toolbar">
				<span class="cs-sa-count">${items.length}件</span>
				${hasPyr ? '<span class="cs-sa-legend"><span class="cs-sa-l y"></span>年少 <span class="cs-sa-l w"></span>生産 <span class="cs-sa-l o"></span>老年</span>' : ''}
				<button class="cs-sa-csv">CSV ↓</button>
			</div>
			<div class="cs-sa-scroll">
				<table class="cs-sa-table">
					<thead><tr><th>#</th><th>コード</th><th>名称</th>${thPop}${thPyr}</tr></thead>
					<tbody>${bodyHtml}</tbody>
				</table>
			</div>
			<div class="cs-sa-pyramid-wrap" id="cs-sa-pyramid" style="display:none"></div>`;

		bodyEl.querySelector('.cs-sa-csv').addEventListener('click', () => {
			const a = document.createElement('a');
			a.href = URL.createObjectURL(new Blob([csvContent], { type: 'text/csv' }));
			a.download = `${code}_小地域.csv`;
			a.click();
			setTimeout(() => URL.revokeObjectURL(a.href), 5000);
		});

		if (hasPyr) {
			const pyrWrap = bodyEl.querySelector('#cs-sa-pyramid');
			let activeRow = null;
			bodyEl.querySelector('tbody').addEventListener('click', e => {
				const tr = e.target.closest('tr.has-pyr');
				if (!tr) return;
				if (tr === activeRow) {
					tr.classList.remove('active');
					pyrWrap.style.display = 'none';
					activeRow = null;
					return;
				}
				activeRow?.classList.remove('active');
				tr.classList.add('active');
				activeRow = tr;
				const kc  = tr.dataset.code;
				const nm  = items.find(([c]) => c === kc)?.[1] ?? kc;
				const pyr = pyrMap.get(kc);
				const p   = popMap.get(kc);
				const popLine = p?.total
					? `<span class="cs-sa-py-pop">人口 ${p.total.toLocaleString()}人（男 ${p.m.toLocaleString()} / 女 ${p.f.toLocaleString()}）</span>`
					: '';
				pyrWrap.style.display = '';
				pyrWrap.innerHTML =
					`<div class="cs-sa-py-name">${esc(nm)}${popLine}</div>` +
					smallAreaPyramidSvg(pyr.mAges, pyr.fAges);
			});
		}
	} catch (e) {
		bodyEl.textContent = `エラー: ${e.message}`;
	}
}

// 国勢調査詳細パネル
function showCensusDetail(code, year) {
	const entry = CENSUS_MANIFEST.find(e => e.code === code);
	if (!entry) return;
	const pop  = year === '2025' || year === '2020' ? CENSUS_2025_POP[code] : null;
	const stat = year === '2020' ? CENSUS_2020_STATS[code]
						 : year === '2015' ? CENSUS_2015_STATS[code]
						 : null;
	const name = entry.name;

	let popHtml = '';

	if (pop) {
		const total = pop.pop[0], male = pop.pop[1], female = pop.pop[2];
		const chgSign = pop.popChange >= 0 ? `+${pop.popChange.toFixed(1)}` : pop.popChange.toFixed(1);
		const chgCl   = pop.popChange >= 0 ? '#0a0' : '#c00';
		popHtml = `
			<div class="cs-section">
				<h3>人口・世帯 <span class="cs-year">2025年</span></h3>
				<div class="cs-kv-grid">
					<div class="cs-kv"><span class="cs-k">総人口</span><span class="cs-v">${total.toLocaleString()} 人</span></div>
					<div class="cs-kv"><span class="cs-k">男性</span><span class="cs-v">${male.toLocaleString()} 人</span></div>
					<div class="cs-kv"><span class="cs-k">女性</span><span class="cs-v">${female.toLocaleString()} 人</span></div>
					<div class="cs-kv"><span class="cs-k">世帯数</span><span class="cs-v">${pop.hh.toLocaleString()} 世帯</span></div>
					<div class="cs-kv"><span class="cs-k">5年間増減率</span><span class="cs-v" style="color:${chgCl};font-weight:600">${chgSign}%</span></div>
					<div class="cs-kv"><span class="cs-k">2020年人口(組替)</span><span class="cs-v">${pop.pop2020.toLocaleString()} 人</span></div>
					${entry.area ? `<div class="cs-kv"><span class="cs-k">面積</span><span class="cs-v">${entry.area.toLocaleString()} km²</span></div>` : ''}
					${entry.density ? `<div class="cs-kv"><span class="cs-k">人口密度</span><span class="cs-v">${entry.density.toLocaleString()} 人/km²</span></div>` : ''}
				</div>
			</div>`;
	} else if (year === '2015' && stat?.pop) {
		const [total, male, female] = stat.pop;
		popHtml = `
			<div class="cs-section">
				<h3>人口・世帯 <span class="cs-year">2015年</span></h3>
				<div class="cs-kv-grid">
					<div class="cs-kv"><span class="cs-k">総人口</span><span class="cs-v">${total.toLocaleString()} 人</span></div>
					<div class="cs-kv"><span class="cs-k">男性</span><span class="cs-v">${male.toLocaleString()} 人</span></div>
					<div class="cs-kv"><span class="cs-k">女性</span><span class="cs-v">${female.toLocaleString()} 人</span></div>
					<div class="cs-kv"><span class="cs-k">世帯数</span><span class="cs-v">${stat.hh.toLocaleString()} 世帯</span></div>
				</div>
			</div>`;
	}

	const chartSvg = stat ? buildCensusChartSVG(stat, year) : null;

	const hasSmallArea = ESTAT_CODE_SET.has(code);

	const panel = document.getElementById('geo-preview') || document.createElement('div');
	panel.classList.add('visible');
	panel.innerHTML = `
		<div class="geo-preview-header">
			<span class="geo-preview-label">${escHtml(name)} — 国勢調査統計</span>
			<button class="geo-preview-close">✕</button>
		</div>
		<div class="geo-preview-body census-detail">
			${popHtml}
			${chartSvg ? `<div class="cs-section cs-svg-wrap">${chartSvg}</div>` : ''}
			${!pop && !stat ? '<p style="padding:16px;color:#aaa">統計データなし</p>' : ''}
			${hasSmallArea ? `
			<div class="cs-section cs-sa-section">
				<h3>小地域（町丁・字等） <span class="cs-year">2020年</span></h3>
				<div class="cs-sa-body" id="cs-sa-body">
					<button class="cs-sa-load">📋 一覧を読み込む</button>
				</div>
			</div>` : ''}
		</div>
	`;
	panel.querySelector('.geo-preview-close').addEventListener('click', closeGeoPreview);
	if (hasSmallArea) {
		const bodyEl = panel.querySelector('#cs-sa-body');
		panel.querySelector('.cs-sa-load').addEventListener('click', () => loadSmallAreas(code, bodyEl));
	}
	panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ============================================================
// 省庁リスト共通レンダラー
// ============================================================
function renderMinistryList({
	id, title, subtitle, cities, expanded,
	getSearch, setSearch, itemHtml, groupFn,
	toEntry, bulkByGroup, allEntries, downloadFn = null,
	groupHeaderHtml = null, onItemClick = null,
}) {
	const totalSize = cities.reduce((s, c) => s + (c.size || 0), 0);
	const totalSizeLabel = totalSize
		? `<span class="moj-total-size">${fmtBytes(totalSize)}</span>`
		: '';
	setDetailHtml(`
		<div class="moj-list-wrap">
			<div class="moj-list-head">
				<div class="moj-head-row">
					<div>
						<h2>${title}</h2>
						<p class="moj-subtitle">${subtitle}<span class="moj-total">${cities.length.toLocaleString()}市区町村</span>${totalSizeLabel}</p>
					</div>
					<button class="bulk-dl-btn" id="${id}-bulk-all">全国一括読込(→IDB)</button>
				</div>
				<input type="text" id="${id}-search" class="moj-search" placeholder="市区町村・都道府県を検索...">
			</div>
			<div class="grouped-list" id="${id}-cities"></div>
		</div>
	`);

	document.getElementById(`${id}-bulk-all`).addEventListener('click', function() {
		if (downloadFn) bulkDownload(allEntries(), title, downloadFn);
		else copyEntries(allEntries(), this);
	});

	const render = () => renderGroupedCities(cities, `${id}-cities`, expanded, itemHtml, {
		query:       getSearch(),
		groupFn,
		groupHeaderHtml,
		onBulkClick: (group, btn) => {
			if (downloadFn) bulkDownload(bulkByGroup(group), `${title} ${PREFS[group] || group}`, downloadFn);
			else copyEntries(bulkByGroup(group), btn);
		},
		onItemClick: e => {
			const row = e.target.closest('.moj-city-item');
			if (!row) return;
			const city = cities.find(c => c.code === row.dataset.code);
			if (!city) return;
			if (onItemClick) onItemClick(city);
			else copyEntries([toEntry(city)], null);
		},
	});

	document.getElementById(`${id}-search`).addEventListener('input', function() {
		setSearch(this.value); render();
	});

	render();
}

// ============================================================
// カタログ読み込み
// ============================================================
async function loadCatalog() {
	const list = document.getElementById('dataset-list');
	list.innerHTML = '<div class="loading-msg">読み込み中...</div>';
	try {
		// 省庁データは manifest から直接1エントリ
		const staticEntries = [
			mojSidebarEntry(),
			maffSidebarEntry(),
			estatSidebarEntry(),
			census2025SidebarEntry(),
			census2020SidebarEntry(),
			census2015SidebarEntry(),
		];

		// 国交省 nlftp はバケットからフェッチ
		const others = await Promise.allSettled(
			SOURCES.filter(s => s.bucket).map(async src => {
				const datasets = await fetchJson(bucketUrl(src, 'index.json'));
				return datasets.map(ds => ({ ...ds, _sourceId: src.id }));
			})
		);

		catalog = [
			...staticEntries,
			...others.flatMap(r => r.status === 'fulfilled' ? r.value : []),
		];

		renderList();
		setDetailHtml(placeholder());

		// URL ハッシュ復元
		const hash = location.hash.slice(1);
		if (hash) {
			if (hash === 'moj')  { selectDataset('moj',  true); }
			else if (hash === 'maff')       { selectDataset('maff',       true); }
			else if (hash === 'estat')      { selectDataset('estat',      true); }
			else if (hash === 'census2025') { selectDataset('census2025', true); }
			else if (hash === 'census2020') { selectDataset('census2020', true); }
			else if (hash === 'census2015') { selectDataset('census2015', true); }
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
// サイドバーリスト描画
// ============================================================
const SOURCE_GROUP_LABELS = {
	moj:   '法務省 G空間情報センター',
	maff:  '農林水産省',
	estat: '総務省 e-Stat',
	nlftp: '国土交通省 国土数値情報',
};

function dsItemHtml(ds) {
	return `
		<div class="ds-item${ds.dataset_code === active ? ' active' : ''}"
				 data-code="${ds.dataset_code}">
			<div class="ds-line1">
				<span class="ds-code">${ds.dataset_code}</span>
				<span class="ds-line1-right">
					<span class="meta-num">${ds.file_count.toLocaleString()}件</span>
					<span class="meta-lic">${ds.license}</span>
				</span>
			</div>
			<div class="ds-title">${ds.title}</div>
		</div>
	`;
}

function renderList() {
	const q = document.getElementById('search').value.toLowerCase();

	const items = catalog.filter(ds => {
		if (q && !ds.title.toLowerCase().includes(q) && !ds.dataset_code.toLowerCase().includes(q)) return false;
		if (licFilter === 'ok' && licKey(ds.license) !== 'ok') return false;
		if (licFilter === 'ng' && licKey(ds.license) !== 'ng') return false;
		return true;
	});

	document.getElementById('list-count').textContent = `${items.length} / ${catalog.length} 件`;

	const list = document.getElementById('dataset-list');
	if (!items.length) {
		list.innerHTML = '<div class="empty-msg">該当なし</div>';
		return;
	}

	// gishub 同様にソース別グループ化
	const groups = new Map();
	for (const ds of items) {
		const sid = ds._sourceId || 'other';
		if (!groups.has(sid)) groups.set(sid, []);
		groups.get(sid).push(ds);
	}

	const html = [];
	for (const [sid, dsItems] of groups) {
		const label = SOURCE_GROUP_LABELS[sid] || sid;
		html.push(`<div class="sidebar-group">`);
		html.push(`<h2 class="sidebar-group-title">${label}</h2>`);
		html.push(dsItems.map(dsItemHtml).join(''));
		html.push(`</div>`);
	}

	list.innerHTML = html.join('');

	list.querySelectorAll('.ds-item').forEach(el => {
		el.addEventListener('click', () => selectDataset(el.dataset.code, true));
	});
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

	document.querySelectorAll('.ds-item').forEach(el => {
		el.classList.toggle('active', el.dataset.code === code);
	});

	if (code === 'moj')        { history.replaceState(null, '', '#moj');        renderMojList();        return; }
	if (code === 'maff')       { history.replaceState(null, '', '#maff');       renderMaffList();       return; }
	if (code === 'estat')      { history.replaceState(null, '', '#estat');      renderEstatList();      return; }
	if (code === 'census2025') { history.replaceState(null, '', '#census2025'); renderCensus2025List(); return; }
	if (code === 'census2020') { history.replaceState(null, '', '#census2020'); renderCensus2020List(); return; }
	if (code === 'census2015') { history.replaceState(null, '', '#census2015'); renderCensus2015List(); return; }

	// 通常ソース（国交省等バケットベース）
	const ds = catalog.find(d => d.dataset_code === code);
	const src = SOURCES_MAP[ds?._sourceId];
	if (!src) return;

	history.replaceState(null, '', `#${code}`);

	setDetailHtml('<div class="loading-msg" style="padding:40px">読み込み中...</div>');

	try {
		const data = await fetchJson(bucketUrl(src, `${code}.json`));
		data._source = src;
		renderDetail(data);
	} catch (e) {
		setDetailHtml(`<div class="error-msg">エラー: ${e.message}</div>`);
	}
}

// ============================================================
// 法務省: gishub エントリJSON生成ヘルパー
// ============================================================
function mojCityEntries(cityCode) {
	const geojson = MOJ_GEOJSON_MAP.get(cityCode);
	if (geojson) return [{ ...geojson }]; // GeoJSON fast path
	const pbf = MOJ_PBF_MAP.get(cityCode);
	if (pbf) return [{ ...pbf }]; // server-hosted GeoPBF
	return (MOJ_CITIES.get(cityCode) || []).map(e => ({
		name:        e.filename.replace(/\.zip$/i, ''),
		description: e.title.replace(/\s*登記所備付地図.*$/, '').trim(),
		target:      e.url,
		link:        `https://www.geospatial.jp/ckan/dataset/${e.packageName}`,
		attribution: '法務省',
		license:     'CC BY 4.0',
		format:      'moj',
		size:        e.size || null,
	}));
}

function mojPrefEntries(prefCode) {
	const result = [];
	for (const code of MOJ_CITIES.keys()) {
		if (code.slice(0, 2) === prefCode) result.push(...mojCityEntries(code));
	}
	return result;
}

function mojAllEntries() {
	const result = [];
	for (const code of MOJ_CITIES.keys()) result.push(...mojCityEntries(code));
	return result;
}

// ============================================================
// 一括読込 → IDB（並列 Worker）
// ============================================================
let _dlActive = false;
let _dlCancel = false;

async function bulkDownload(entries, label, fetchFn = null, parallel = null) {
	if (_dlActive || !entries.length) return;

	const isMoj = entries.some(e => e.format === 'moj');
	if (isMoj && entries.length > 1) {
		const totalZip = entries.reduce((s, e) => s + (e.size || 0), 0);
		// GML/XML は ZIP 比 10〜30 倍に展開されメモリを圧迫するため常に確認
		const ok = window.confirm(
			`${label}\n\n` +
			(totalZip ? `ZIP合計: ${fmtBytes(totalZip)}\n推定メモリ使用: ${fmtBytes(totalZip * 20)} 程度\n\n` : '') +
			`MOJ（14条地図）は GML/XML 形式のため、ZIP サイズの\n` +
			`10〜30 倍のメモリを消費します。\n` +
			`${entries.length} 件を最大5件並列で処理します。\n\n続行しますか？`
		);
		if (!ok) return;
	}

	_dlActive = true;
	_dlCancel = false;

	const fn       = fetchFn ?? (e => e.format === 'moj' ? geopbf(e.target, { format: 'moj' }) : geopbf(e.target));
	const PARALLEL = parallel ?? 5;
	const total    = entries.length;
	let done = 0, errors = 0;
	// name → { loaded, total, phase: 'fetch'|'convert' }
	const active = new Map();

	const modal = openDlModal(label, total);
	modal.querySelector('.dl-cancel-btn').onclick = () => {
		_dlCancel = true;
		_dlActive = false;
		closeDlModal(modal);
	};

	const refresh = () => refreshDlModal(modal, done, total, errors, active);

	// geopbf が window に投げるイベントでバイト進捗・変換フェーズを受け取る
	const onFetchProgress = ({ detail }) => {
		const name = (detail.name || '').replace(/\.[^.]+$/, '');
		if (!active.has(name)) return;
		const s = active.get(name);
		s.phase = 'fetch'; s.loaded = detail.loaded; s.total = detail.total;
		refresh();
	};
	const onConvertStart = ({ detail }) => {
		if (!active.has(detail.name)) return;
		active.get(detail.name).phase = 'convert';
		refresh();
	};
	const onConvertProgress = ({ detail }) => {
		if (!active.has(detail.name)) return;
		const s = active.get(detail.name);
		s.phase = 'convert';
		s.loaded = detail.loaded;
		s.total  = detail.total;
		refresh();
	};
	window.addEventListener('FetchProgress',    onFetchProgress);
	window.addEventListener('ConvertStart',     onConvertStart);
	window.addEventListener('ConvertProgress',  onConvertProgress);

	const queue = [...entries];

	const runWorker = async () => {
		while (queue.length && !_dlCancel) {
			const entry = queue.shift();
			active.set(entry.name, { loaded: 0, total: 0, phase: 'fetch' });
			refresh();
			try {
				const pbf = await fn(entry);
				done++;
				const s = active.get(entry.name);
				if (s) {
					s.phase = 'done';
					const sz = pbf?.size || entry.size || s.total || s.loaded;
					s.loaded = sz;
					s.total  = sz;
					if (pbf?.size && entry.format === 'moj') mojSavePbfSize(entry.name, pbf.size);
				}
			} catch (err) {
				if (!_dlCancel) errors++;
				const s = active.get(entry.name);
				if (s) s.phase = 'error';
			}
			refresh();
			await new Promise(r => setTimeout(r, 200));
			active.delete(entry.name);
			refresh();
		}
	};

	try {
		await Promise.all(Array.from({ length: PARALLEL }, runWorker));
	} finally {
		window.removeEventListener('FetchProgress',   onFetchProgress);
		window.removeEventListener('ConvertStart',    onConvertStart);
		window.removeEventListener('ConvertProgress', onConvertProgress);
		_dlActive = false;
	}

	if (!_dlCancel) {
		closeDlModal(modal);
		showToast(`${done.toLocaleString()}件をIDBに保存${errors ? ` (${errors}件エラー)` : ''}`);
	}
}

function openDlModal(label, total) {
	const el = document.createElement('div');
	el.className = 'dl-modal';
	el.innerHTML = `
		<div class="dl-box">
			<div class="dl-header">
				<span class="dl-title">一括読込 → IDB</span>
				<span class="dl-label">${escHtml(label)}</span>
			</div>
			<div class="dl-bar-wrap"><div class="dl-bar-fill" id="dl-fill"></div></div>
			<div class="dl-stat">
				<span id="dl-pct" class="dl-pct">0%</span>
				<span id="dl-done">0</span> / <span class="dl-total">${total.toLocaleString()}</span>
				<span id="dl-err" class="dl-err"></span>
			</div>
			<div class="dl-active" id="dl-active-list"></div>
			<button class="dl-cancel-btn">キャンセル</button>
		</div>
	`;
	document.body.appendChild(el);
	return el;
}

function refreshDlModal(modal, done, total, errors, active) {
	if (!modal.isConnected) return;
	const pct = (done / total * 100).toFixed(1);
	const fill = modal.querySelector('#dl-fill'); if (fill) fill.style.width = `${pct}%`;
	const pctEl = modal.querySelector('#dl-pct'); if (pctEl) pctEl.textContent = `${pct}%`;
	const doneEl = modal.querySelector('#dl-done'); if (doneEl) doneEl.textContent = done.toLocaleString();
	const errEl = modal.querySelector('#dl-err'); if (errEl) errEl.textContent = errors ? `${errors}件エラー` : '';
	const list = modal.querySelector('#dl-active-list');
	if (!list) return;
	list.innerHTML = [...active.entries()].map(([n, s]) => {
		const mark = s.phase === 'done' ? '✓' : s.phase === 'error' ? '✗' : s.phase === 'convert' ? '⚙' : '↓';
		const info = s.phase === 'convert' && s.total
			? ` <span class="dl-bytes">${s.loaded} / ${s.total}</span>`
			: s.total  ? ` <span class="dl-bytes">${fmtBytes(s.loaded)} / ${fmtBytes(s.total)}</span>`
			: s.loaded ? ` <span class="dl-bytes">${fmtBytes(s.loaded)}</span>`
			: '';
		const bytes = info;
		const cls = `dl-item dl-item-${s.phase}`;
		return `<div class="${cls}">${mark} ${escHtml(n)}${bytes}</div>`;
	}).join('');
}

function closeDlModal(modal) {
	modal.classList.add('dl-closing');
	setTimeout(() => modal.remove(), 200);
}

// ============================================================
// 農水省 FUDE API → geopbf
// ============================================================
async function maffGeopbf(entry) {
	// サーバー側で変換済みの GeoPBF をバケットから取得（IDB キャッシュ付き）
	const code = entry._maff.prefCityCd;
	return geopbf(`maff_${code}.geopbf`, { name: entry.name });
}

// ============================================================
// 総務省 e-Stat ZIP/SHP → geopbf
// ============================================================
async function estatGeopbf(entry) {
	// e-Stat URL に拡張子なし → proxy 経由でフェッチし .zip として渡す
	const proxyBase = `${API_BASE}/proxy/`;
	const proxyUrl  = `${proxyBase}?url=${encodeURIComponent(entry.target)}`;
	const resp = await fetch(proxyUrl);
	if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
	const blob = await resp.blob();
	const file = new File([blob], `${entry.name}.zip`);
	return geopbf(file, { name: entry.name });
}

async function copyEntries(entries, feedbackEl) {
	const text = entries.length === 1
		? JSON.stringify(entries[0], null, 2)
		: JSON.stringify(entries, null, 2);
	try { await navigator.clipboard.writeText(text); } catch {}
	const label = entries.length === 1
		? entries[0].name
		: `${entries.length}件をクリップボードにコピーしました`;
	showToast(label);
	if (!feedbackEl) return;
	const orig = feedbackEl.textContent;
	feedbackEl.textContent = '✓ コピー済み';
	setTimeout(() => { feedbackEl.textContent = orig; }, 1800);
}

// ============================================================
// 法務省: メインパネルに市区町村リスト（都道府県別折りたたみ）
// ============================================================
let mojListSearch = '';
let mojExpandedPrefs = new Set();

function fmtBytes(b) {
	if (!b) return '';
	if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)} MB`;
	return `${Math.round(b / 1024)} KB`;
}

// ダウンロード済み PBF サイズを localStorage に保存・参照
const MOJ_SIZE_KEY = 'moj-pbf-sizes';
function mojSavedSizes() {
	try { return JSON.parse(localStorage.getItem(MOJ_SIZE_KEY) || '{}'); } catch { return {}; }
}
function mojSavePbfSize(name, bytes) {
	try {
		const saved = mojSavedSizes();
		saved[name] = bytes;
		localStorage.setItem(MOJ_SIZE_KEY, JSON.stringify(saved));
	} catch {}
}

function buildMojCityList() {
	const saved = mojSavedSizes();
	return [...MOJ_CITIES.entries()].map(([code, entries]) => {
		const e = entries[0];
		const name = e.title.replace(/（[^）]*）.*$/, '').replace(/\s*登記所備付地図.*$/, '').trim();
		const pref = code.slice(0, 2);
		// 919B は Range GET が失敗した無効値なので除外（1000B 以下を無効とみなす）
		const validSize = entries.reduce((s, x) => s + (x.size > 1000 ? x.size : 0), 0);
		const geojson = MOJ_GEOJSON_MAP.get(code);
		const pbf     = MOJ_PBF_MAP.get(code);
		const fastEntry = geojson || pbf;
		const savedPbf = fastEntry
			? (saved[fastEntry.name] || 0)
			: entries.map(x => saved[x.filename.replace(/\.zip$/i, '')] || 0).reduce((s, v) => s + v, 0);
		return {
			code, name, pref, prefName: PREFS[pref] || pref, area: cityArea(code),
			filename: e.filename, extra: entries.length - 1,
			size:       validSize || null,
			pbfSize:    savedPbf  || null,
			hasGeojson: !!geojson,
			hasPbf:     !geojson && !!pbf,
		};
	});
}

function mojCityItemHtml(city) {
	const extra = !city.hasGeojson && city.extra > 0 ? `<span class="extra-cnt">+${city.extra}</span>` : '';
	const badge = city.hasGeojson
		? `<span class="badge fmt-geojson">GeoJSON</span>`
		: city.hasPbf
		? `<span class="badge fmt-pbf">PBF</span>`
		: `<span class="badge fmt-moj">MOJ</span>`;
	const fname = city.hasGeojson
		? escHtml(MOJ_GEOJSON_MAP.get(city.code)?.name || city.filename)
		: city.hasPbf
		? escHtml(MOJ_PBF_MAP.get(city.code)?.name || city.filename)
		: escHtml(city.filename);
	const sizeBadge = city.pbfSize
		? `<span class="file-sz">${fmtBytes(city.pbfSize)} <span class="size-note">PBF</span></span>`
		: city.size && !city.hasGeojson
		? `<span class="file-sz">${fmtBytes(city.size)} <span class="size-note">ZIP</span></span>`
		: '';
	return `
		<div class="moj-city-item" data-code="${city.code}" title="クリックで読込・描画">
			<span class="moj-city-code">${city.code}</span>
			<span class="moj-city-name">${escHtml(city.name)}<span class="area-tag">平面直角座標系:${city.area}</span></span>
			<span class="moj-city-file">${fname}${extra}${sizeBadge}</span>
			${badge}
		</div>
	`;
}

function renderMojList() {
	const cities = buildMojCityList();
	const totalPbfBytes = cities.reduce((s, c) => s + (c.pbfSize || 0), 0);
	const totalZipBytes = cities.reduce((s, c) => s + (c.size   || 0), 0);
	const totalSizeLabel = totalPbfBytes
		? `<span class="moj-total-size">${fmtBytes(totalPbfBytes)} <span class="size-note">PBF</span></span>`
		: totalZipBytes
		? `<span class="moj-total-size">${fmtBytes(totalZipBytes)} <span class="size-note">ZIP</span></span>`
		: '';

	setDetailHtml(`
		<div class="moj-list-wrap">
			<div class="moj-list-head">
				<div class="moj-head-row">
					<div>
						<h2>法務省 登記所備付地図</h2>
						<p class="moj-subtitle">登記所備付地図データ（14条地図）<span class="moj-total">${cities.length.toLocaleString()}市区町村</span>${totalSizeLabel}<span class="moj-fmt-note"><span class="badge fmt-geojson">GeoJSON</span>${MOJ_GEOJSON_MAP.size.toLocaleString()}市区町村 / <span class="badge fmt-moj">MOJ</span>残り</span></p>
					</div>
					<button class="bulk-dl-btn" id="moj-bulk-all">全国一括読込(→IDB)</button>
				</div>
				<input type="text" id="moj-search" class="moj-search" placeholder="市区町村・都道府県を検索..." value="${escHtml(mojListSearch)}">
			</div>
			<div class="grouped-list" id="moj-cities"></div>
		</div>
	`);

	const mojRender = () => renderGroupedCities(cities, 'moj-cities', mojExpandedPrefs, mojCityItemHtml, {
		query:       mojListSearch,
		groupFn:     c => ({ key: c.pref, name: PREFS[c.pref] || c.pref }),
		onBulkClick: (pref, _btn) => bulkDownload(mojPrefEntries(pref), `法務省 ${PREFS[pref] || pref}`),
		onItemClick: e => {
			const item = e.target.closest('.moj-city-item');
			if (!item) return;
			const entries = mojCityEntries(item.dataset.code);
			if (!entries.length) return;
			renderExecView(entries[0], () => { history.replaceState(null, '', '#moj'); renderMojList(); });
		},
		groupHeaderHtml: (_key, _name, items) => {
			const areas = [...new Set(items.map(c => c.area))].sort((a, b) => a - b);
			const totalPbf = items.reduce((s, c) => s + (c.pbfSize || 0), 0);
			const totalZip = items.reduce((s, c) => s + (c.size   || 0), 0);
			const sizeHtml = totalPbf
				? `<span class="pref-size">${fmtBytes(totalPbf)} <span class="size-note">PBF</span></span>`
				: totalZip
				? `<span class="pref-size">${fmtBytes(totalZip)} <span class="size-note">ZIP</span></span>`
				: '';
			return `<span class="pref-coord-sys">直角座標系:${areas.join(',')}</span>` + sizeHtml;
		},
	});

	document.getElementById('moj-bulk-all').addEventListener('click', () => {
		bulkDownload(mojAllEntries(), '法務省 登記所備付地図 全国');
	});

	document.getElementById('moj-search').addEventListener('input', function() {
		mojListSearch = this.value;
		mojRender();
	});

	mojRender();
}

// 都道府県グループ折りたたみリスト（法務省・農水省・総務省 共通）
function renderGroupedCities(cities, containerId, expandedSet, itemHtml, {
	query           = '',
	groupFn         = c => ({ key: c.pref, name: PREFS[c.pref] || c.pref }),
	onBulkClick     = null,
	onItemClick     = null,
	groupHeaderHtml = null,
} = {}) {
	const q = query.toLowerCase();
	const container = document.getElementById(containerId);
	if (!container) return;

	const groups = new Map();
	for (const c of cities) {
		const { key, name } = groupFn(c);
		if (!groups.has(key)) groups.set(key, { name, items: [] });
		groups.get(key).items.push(c);
	}

	const isSearching = q.length > 0;
	const html = [];

	for (const [key, { name: groupName, items: members }] of groups) {
		const groupMatch = isSearching && groupName.toLowerCase().includes(q);
		const matched = isSearching
			? members.filter(c => groupMatch || c.name?.toLowerCase().includes(q) || c.code?.includes(q) || c.prefName?.toLowerCase().includes(q))
			: members;

		if (isSearching && matched.length === 0) continue;

		const isExpanded = isSearching || expandedSet.has(key);

		const extraHtml = groupHeaderHtml ? groupHeaderHtml(key, groupName, matched) : '';
		html.push(`
			<div class="detail-section pref-group" data-group="${escHtml(key)}">
				<div class="pref-header${isExpanded ? '' : ' collapsed'}" data-group="${escHtml(key)}">
					<span class="pref-arrow">▾</span>
					<span class="pref-name">${escHtml(groupName)}</span>
					${extraHtml}
					<span class="cnt">${matched.length}</span>
					<button class="pref-bulk-btn" data-group="${escHtml(key)}">一括読込(→IDB)</button>
				</div>
				<div class="pref-cities${isExpanded ? '' : ' hidden'}">
					${matched.map(c => itemHtml(c)).join('')}
				</div>
			</div>
		`);
	}

	if (!html.length) {
		container.innerHTML = '<div class="empty-msg" style="padding:24px">該当なし</div>';
		return;
	}

	container.innerHTML = html.join('');

	container.onclick = e => {
		const bulkBtn = e.target.closest('.pref-bulk-btn');
		if (bulkBtn) {
			onBulkClick?.(bulkBtn.dataset.group, bulkBtn);
			return;
		}
		const header = e.target.closest('.pref-header');
		if (header) {
			const key = header.dataset.group;
			const citiesDiv = header.nextElementSibling;
			const expanding = header.classList.contains('collapsed');
			header.classList.toggle('collapsed', !expanding);
			citiesDiv.classList.toggle('hidden', !expanding);
			expanding ? expandedSet.add(key) : expandedSet.delete(key);
			return;
		}
		onItemClick?.(e);
	};
}

// ============================================================
// 詳細表示（showBack: 法務省市区町村詳細からの戻りボタン）
// ============================================================
function renderDetail(ds, showBack = false) {
	currentDs = ds;
	currentCodelists = (ds.attributes || []).map(a => Array.isArray(a.codelist) ? a.codelist : null);

	const backHtml = showBack ? `
		<button class="back-btn" id="back-to-moj">← 一覧に戻る</button>
	` : '';

	const attrHtml = ds.attributes?.length ? `
		<section class="detail-section">
			<h3 class="section-title">
				属性 <span class="cnt">${ds.attributes.length}</span>
				<span class="toggle-icon">▾</span>
			</h3>
			<div class="section-body">
				<table class="attr-table">
					<thead><tr><th>コード</th><th>ラベル</th><th>コードリスト</th></tr></thead>
					<tbody>
						${ds.attributes.map((a, i) => `
							<tr>
								<td class="mono">${a.code}</td>
								<td>${a.label}</td>
								<td>${Array.isArray(a.codelist)
									? `<button class="codelist-btn" data-cl-idx="${i}">参照</button>`
									: '—'}</td>
							</tr>
						`).join('')}
					</tbody>
				</table>
			</div>
		</section>
	` : '';

	const fileHtml = renderFiles(ds);

	setDetailHtml(`
		<div class="detail-inner">
			${backHtml}
			<header class="detail-header">
				<h2>${ds.title}</h2>
				<div class="detail-meta">
					<span class="badge lic-${licKey(ds.license)}">${ds.license}</span>
					<span class="mono" style="color:#888">${ds.dataset_code}</span>
					<a href="${ds.page_url}" target="_blank" rel="noopener" class="ext-link">データページ →</a>
				</div>
			</header>
			${attrHtml}
			${fileHtml}
		</div>
	`);

	document.getElementById('back-to-moj')?.addEventListener('click', () => {
		history.replaceState(null, '', '#moj');
		renderMojList();
	});
}

function licKey(lic) {
	if (!lic) return 'ng';
	if (lic.includes('商用可') || lic.includes('CC BY') || lic.includes('CC_BY')) return 'ok';
	return 'ng';
}

// ============================================================
// ファイル一覧描画
// ============================================================
function renderFiles(ds) {
	if (!ds.files?.length) return '<p class="no-files">GISファイルなし</p>';

	const raw      = ds.files.some(f => f.format === 'geojson')
		? ds.files.filter(f => f.format !== 'shp')
		: ds.files;
	const allFiles = sortFiles(raw);

	const years    = [...new Set(allFiles.map(f => f.year).filter(Boolean))].sort().reverse();
	const formats  = [...new Set(allFiles.map(f => f.format))].sort();
	const prefCodes = [...new Set(allFiles.filter(f => f.pref_code).map(f => f.pref_code))].sort();

	const yearOpts = ['all', ...years].map(y =>
		`<option value="${y}">${y === 'all' ? '年度: すべて' : y}</option>`).join('');
	const fmtOpts  = ['all', ...formats].map(f =>
		`<option value="${f}">${f === 'all' ? '形式: すべて' : f.toUpperCase()}</option>`).join('');
	const prefOpts = prefCodes.length ? `
		<select class="file-filter" id="ff-pref">
			<option value="all">都道府県: すべて</option>
			${prefCodes.map(c => `<option value="${c}">${PREFS[String(c).padStart(2,'0')] || c}</option>`).join('')}
		</select>` : '';

	return `
		<section class="detail-section" id="files-section">
			<h3 class="section-title">
				ファイル <span class="cnt" id="files-cnt">${allFiles.length}</span>
				<span class="toggle-icon">▾</span>
			</h3>
			<div class="section-body">
				<div class="file-filters">
					${years.length > 1   ? `<select class="file-filter" id="ff-year">${yearOpts}</select>` : ''}
					${formats.length > 1 ? `<select class="file-filter" id="ff-fmt">${fmtOpts}</select>`  : ''}
					${prefOpts}
					<button class="bulk-dl-btn" id="files-dl-all">一括↓IDB</button>
				</div>
				<div class="file-list">
					<div class="file-list-header">
						<span>年度</span><span>エリア</span><span>ファイル</span><span>形式</span>
					</div>
					<div id="files-list">
						${buildFileRows(allFiles, ds)}
					</div>
				</div>
			</div>
		</section>
	`;
}

function buildFileRows(files, ds, limit = 200) {
	const shown = files.slice(0, limit);
	const rest  = files.length - shown.length;
	return shown.map(f => fileRow(f, ds)).join('') +
		(rest ? `<div class="more-row"><span>…残り ${rest} 件</span> <button class="load-more-btn">すべて表示</button></div>` : '');
}

const PREFS = {
	'01':'北海道','02':'青森','03':'岩手','04':'宮城','05':'秋田',
	'06':'山形','07':'福島','08':'茨城','09':'栃木','10':'群馬',
	'11':'埼玉','12':'千葉','13':'東京','14':'神奈川','15':'新潟',
	'16':'富山','17':'石川','18':'福井','19':'山梨','20':'長野',
	'21':'岐阜','22':'静岡','23':'愛知','24':'三重','25':'滋賀',
	'26':'京都','27':'大阪','28':'兵庫','29':'奈良','30':'和歌山',
	'31':'鳥取','32':'島根','33':'岡山','34':'広島','35':'山口',
	'36':'徳島','37':'香川','38':'愛媛','39':'高知','40':'福岡',
	'41':'佐賀','42':'長崎','43':'熊本','44':'大分','45':'宮崎',
	'46':'鹿児島','47':'沖縄',
};

// ============================================================
// 19地域区分（getArea 関数準拠）
// ============================================================
const AREA_NAMES = {
	1:'長崎・奄美', 2:'九州', 3:'中国西部', 4:'四国', 5:'近畿南部・中国東部',
	6:'近畿', 7:'北陸・東海', 8:'甲信越・静岡', 9:'関東', 10:'東北',
	11:'道南', 12:'北海道', 13:'道東', 14:'小笠原',
	15:'沖縄', 16:'沖縄・先島', 17:'沖縄・大東', 18:'伊豆諸島', 19:'東京・遠隔離島',
};

// 都道府県コード(整数) → 地域番号 ※pref 9(栃木)は原典コードで欠落→ 9 を補完
const PREF_TO_AREA = {
	1:12,2:10,3:10,4:10,5:10,6:10,7:9,8:9,9:9,10:9,11:9,12:9,13:9,14:9,
	15:8,16:7,17:7,18:6,19:8,20:8,21:7,22:8,23:7,
	24:6,25:6,26:6,27:6,28:6,29:6,30:5,
	31:5,32:3,33:5,34:3,35:3,
	36:4,37:4,38:4,39:4,
	40:2,41:2,42:1,43:2,44:2,45:2,46:2,47:15,
};

// 北海道 道南(11) ・ 道東(13) の市区町村コード（整数）
const HOKKAIDO_AREA11 = new Set([
	1202,1203,1233,1236,1331,1332,1333,1334,1337,1343,1345,1346,1347,
	1361,1362,1363,1364,1367,1370,1371,
	1391,1392,1393,1394,1395,1396,1397,1398,1399,
	1400,1401,1402,1403,1404,1405,1406,1407,1408,1409,1571,1575,1584,
]);
const HOKKAIDO_AREA13 = new Set([
	1206,1207,1208,1211,1223,
	1543,1544,1545,1546,1547,1549,1550,1552,1564,
	1631,1632,1633,1634,1635,1636,1637,1638,1639,
	1641,1642,1643,1644,1645,1646,1647,1648,1649,
	1661,1662,1663,1664,1665,1667,1668,1691,1692,1693,1694,
]);

// 奄美地方 (鹿児島 area 1)
const AMAMI_CODES = new Set([46207,46222,46523,46524,46525,46527,46529,46530,46531,46532,46533,46534,46535]);
// 沖縄・先島諸島 (area 16)
const SAKISHIMA_CODES = new Set([47207,47214,47381,47382]);

function cityArea(code5) {
	const num = parseInt(code5, 10);
	const pref = Math.floor(num / 1000);
	if (pref === 1)  { return HOKKAIDO_AREA11.has(num) ? 11 : HOKKAIDO_AREA13.has(num) ? 13 : 12; }
	if (pref === 46) { return AMAMI_CODES.has(num) ? 1 : 2; }
	if (pref === 47) {
		if (num === 47303 || num === 47304) return 17; // 大東諸島
		if (SAKISHIMA_CODES.has(num)) return 16;
		return 15;
	}
	if (pref === 13 && num === 13421) return 14; // 小笠原
	return PREF_TO_AREA[pref] ?? 9;
}

function scopeLabel(f) {
	const scope = f.scope || '全国';
	if (scope === '全国') return f.location_code || '全国';
	if (scope === '都道府県') {
		const code = String(f.pref_code || '').padStart(2, '0');
		return PREFS[code] || f.pref_code || '都道府県';
	}
	if (scope.includes('メッシュ')) return f.location_code || scope;
	return f.location_code || f.pref_code || scope;
}

function sortFiles(files) {
	return [...files].sort((a, b) => {
		const scopeOrder = s => s === '全国' ? 0 : s === '都道府県' ? 1 : s.includes('メッシュ') ? 2 : 3;
		const so = scopeOrder(a.scope || '全国') - scopeOrder(b.scope || '全国');
		if (so !== 0) return so;
		const ka = a.pref_code || a.location_code || '';
		const kb = b.pref_code || b.location_code || '';
		return ka < kb ? -1 : ka > kb ? 1 : 0;
	});
}

function fileEntry(f, ds) {
	const zipUrl   = f.target.split('#')[0];
	const zipName  = zipUrl.split('/').pop();
	const fileName = f.target.split('#')[1] || '';
	const name     = fileName.replace(/\.[^.]+$/, '') || zipName.replace(/\.[^.]+$/, '');
	const area     = scopeLabel(f);
	const desc     = `${ds.title}${area !== '全国' ? ' (' + area + ')' : ''}${f.year ? ':' + f.year : ''}`;
	return {
		name,
		description: desc,
		target:      f.target,
		link:        ds.page_url,
		attribution: (ds._source || {}).attribution || '',
		license:     ds.license,
		...(f.format === 'moj' ? { format: 'moj' } : {}),
	};
}

function fileRow(f, ds) {
	const entry    = fileEntry(f, ds);
	const zipUrl   = f.target.split('#')[0];
	const zipName  = zipUrl.split('/').pop();
	const fileName = f.target.split('#')[1] || '';
	const area     = scopeLabel(f);

	return `
		<div class="file-row" data-entry="${escHtml(JSON.stringify(entry))}">
			<span class="file-year">${f.year || '—'}</span>
			<span class="file-area">${area}</span>
			<span class="file-name">${zipName}${fileName ? `<br><span class="file-sub">${fileName}</span>` : ''}</span>
			<span class="file-fmt"><span class="badge fmt-${f.format}">${f.format.toUpperCase()}</span></span>
		</div>
	`;
}

// ============================================================
// ファイルフィルター
// ============================================================
document.getElementById('detail').addEventListener('change', e => {
	if (!e.target.classList.contains('file-filter')) return;
	applyFileFilters();
});

let _currentFilteredFiles = [];

function applyFileFilters() {
	if (!currentDs?.files?.length) return;
	const year = document.getElementById('ff-year')?.value || 'all';
	const fmt  = document.getElementById('ff-fmt')?.value  || 'all';
	const pref = document.getElementById('ff-pref')?.value || 'all';

	const raw = currentDs.files.some(f => f.format === 'geojson')
		? currentDs.files.filter(f => f.format !== 'shp')
		: currentDs.files;

	const filtered = sortFiles(raw.filter(f => {
		if (year !== 'all' && String(f.year) !== year) return false;
		if (fmt  !== 'all' && f.format !== fmt)        return false;
		if (pref !== 'all' && String(f.pref_code) !== pref) return false;
		return true;
	}));

	_currentFilteredFiles = filtered;
	document.getElementById('files-cnt').textContent  = filtered.length;
	document.getElementById('files-list').innerHTML   = buildFileRows(filtered, currentDs);
}

// ============================================================
// クリックイベント（詳細パネル）
// ============================================================
document.getElementById('detail').addEventListener('click', async e => {
	if (e.target.classList.contains('load-more-btn')) { handleLoadMore(e.target); return; }

	const title = e.target.closest('.section-title');
	if (title) { title.parentElement.classList.toggle('collapsed'); return; }

	if (e.target.classList.contains('codelist-btn')) {
		showCodelistPopup(currentCodelists[parseInt(e.target.dataset.clIdx)] || [], e.target);
		return;
	}

	if (e.target.id === 'files-dl-all') {
		const files = _currentFilteredFiles.length ? _currentFilteredFiles : (currentDs?.files || []);
		const entries = files.map(f => fileEntry(f, currentDs));
		bulkDownload(entries, currentDs?.title || '国土数値情報');
		return;
	}

	// ファイル行クリック → Exec ビュー
	const row = e.target.closest('.file-row');
	if (row?.dataset.entry) {
		const entry = JSON.parse(row.dataset.entry);
		renderExecView(entry, () => renderDetail(currentDs));
		return;
	}
});

// ============================================================
// コードリストポップアップ
// ============================================================
function showCodelistPopup(entries, btn) {
	document.querySelectorAll('.codelist-popup').forEach(el => el.remove());
	const popup = document.createElement('div');
	popup.className = 'codelist-popup';

	popup.innerHTML = entries.length ? `
		<div class="cl-header">
			<span>${entries.length}件</span>
			<button class="cl-close" onclick="this.closest('.codelist-popup').remove()">✕</button>
		</div>
		<div class="cl-body">
			<table>
				<thead><tr><th>コード</th><th>名称</th></tr></thead>
				<tbody>${entries.map(r => `<tr><td class="mono">${escHtml(r.code)}</td><td>${escHtml(r.label)}</td></tr>`).join('')}</tbody>
			</table>
		</div>` : '<div class="cl-loading">データなし</div>';

	document.body.appendChild(popup);
	const rect = btn.getBoundingClientRect();
	const pw = 320;
	let left = rect.right - pw; if (left < 4) left = 4;
	let top  = rect.bottom + 4; if (top + 340 > window.innerHeight) top = rect.top - 340;
	popup.style.left = `${left}px`;
	popup.style.top  = `${top}px`;

	const close = e => { if (!popup.contains(e.target) && e.target !== btn) { popup.remove(); document.removeEventListener('click', close, true); } };
	setTimeout(() => document.addEventListener('click', close, true), 0);
}

function showToast(url) {
	const t = document.createElement('div');
	t.className = 'toast'; t.textContent = url;
	document.body.appendChild(t);
	requestAnimationFrame(() => t.classList.add('show'));
	setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2500);
}

async function handleLoadMore(btn) {
	const row = btn.closest('.more-row');
	btn.disabled = true; btn.textContent = '読み込み中...';
	try {
		const files = currentDs.files.some(f => f.format === 'geojson')
			? currentDs.files.filter(f => f.format !== 'shp')
			: currentDs.files;
		row.insertAdjacentHTML('beforebegin', sortFiles(files).slice(200).map(f => fileRow(f, currentDs)).join(''));
		row.remove();
	} catch { btn.textContent = 'エラー'; }
}

// ============================================================
// ユーティリティ
// ============================================================
function placeholder() {
	const nlftpDs    = catalog.filter(d => d._sourceId === 'nlftp');
	const nlftpFiles = nlftpDs.reduce((s, d) => s + (d.file_count || 0), 0);
	const fmt = n => typeof n === 'number' ? n.toLocaleString() : n;

	const cards = [
		{
			icon:  '🗾',
			min:   '国土交通省',
			label: '国土数値情報',
			cnt:   nlftpFiles || '…',
			unit:  `ファイル / ${fmt(nlftpDs.length || '…')} データセット`,
			desc:  '道路・河川・土地利用・行政区域・ハザード・地価など国土に関する各種情報',
		},
		{
			icon:  '📊',
			min:   '総務省',
			label: '統計 GIS・国勢調査',
			cnt:   ESTAT_MANIFEST.length + CENSUS_MANIFEST.length,
			unit:  `市区町村（小地域境界 + 国勢調査 3施行分）`,
			desc:  '小地域境界 Shapefile（e-Stat）と 2015/2020/2025 年 国勢調査の人口・世帯・産業別集計',
		},
		{
			icon:  '🏠',
			min:   '法務省',
			label: '登記所備付地図',
			cnt:   MOJ_CITIES.size,
			unit:  '市区町村',
			desc:  '不動産登記の基礎となる 14 条地図（GeoJSON / GeoPBF）',
		},
		{
			icon:  '🌾',
			min:   '農林水産省',
			label: '農地（筆ポリゴン）',
			cnt:   MAFF_MANIFEST.length,
			unit:  '市区町村',
			desc:  '全国の農地区画。作付・耕地種別などの属性付き（GeoJSON）',
		},
	].map(c => `
		<div class="ph-card">
			<div class="ph-card-min">${c.min}</div>
			<div class="ph-card-cnt">${fmt(c.cnt)}</div>
			<div class="ph-card-head">
				<span class="ph-card-icon">${c.icon}</span>
				<span class="ph-card-label">${c.label}</span>
			</div>
			<div class="ph-card-unit">${c.unit}</div>
			<div class="ph-card-desc">${c.desc}</div>
		</div>
	`).join('');

	return `
		<div class="placeholder">

			<div class="ph-hero">
				<div class="ph-hero-title">
					<img class="ph-logo" src="favicon.svg" alt="">
					<div class="ph-title">GIS-HUB-jp 🇯🇵</div>
				</div>
				<div class="ph-sub">GeoPBF を使用して、国が公開するGISデータを直接地図に描画します。</div>
				<div class="ph-hero-link">
					<a href="/gishub" target="_blank" rel="noopener">→ GIS-HUB（グローバル版）</a>
					<a href="https://github.com/kenjiyoshidahome2026-bit/ortho-earth" target="_blank" rel="noopener" class="ph-github-link">
						<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
						GitHub（オープンソース）
					</a>
				</div>
			</div>

			<section class="ph-section">
				<h3 class="ph-section-title">収録データ</h3>
				<div class="ph-cards">${cards}</div>
			</section>

			<section class="ph-section">
				<h3 class="ph-section-title">GeoPBF とは</h3>
				<div class="ph-geopbf">
					<div class="ph-geopbf-text">
						<p>
							<strong>GeoPBF</strong> は Web ブラウザ向けに設計された地理データフォーマットです。
							国が配布する ZIP 内の Shapefile・GeoJSON 等を変換して<strong>GeoPBF</strong>を生成しています。
						</p>
						<p>
							従来の GeoJSON や Shapefile はファイルサイズが大きく、ブラウザでの読み込みと描画に時間がかかります。
							<strong>GeoPBF</strong> はトポロジーを保持したまま頂点列を圧縮し、
							WebGL2 シェーダーへ直接送信できるバイナリ構造を持ちます。
							全国規模の数百万フィーチャーも、GPUのパワーでで、ズームに連動した動的LODとリアルタイムの描画三角形の生成で、スムーズに1/60秒で描画します。
							また、<strong>GeoPBF</strong>は従来のGISフォーマットにも即時変換可能です。
						</p>
					</div>
					<ul class="ph-feat-list">
						<li><span class="ph-feat-ic">▸</span><span><strong>高圧縮</strong> — GeoJSON 比で 約1/10 のファイルサイズ。国勢調査の全市区町村境界もブラウザで即時ロード</span></li>
						<li><span class="ph-feat-ic">▸</span><span><strong>直接描画</strong> — CPU 変換なし。WebGL2 の頂点バッファへそのまま転送して GPU がレンダリング</span></li>
						<li><span class="ph-feat-ic">▸</span><span><strong>位相保持</strong> — 隣接ポリゴンの共有境界を重複なく格納。面積誤差・すき間が生じない</span></li>
						<li><span class="ph-feat-ic">▸</span><span><strong>動的 LOD</strong> — ズームレベルに応じて頂点を間引き。広域〜詳細まで同一データで対応</span></li>
						<li><span class="ph-feat-ic">▸</span><span><strong>属性アクセス</strong> — フィーチャー ID から属性を O(1) で取得。クリック identify が高速</span></li>
					</ul>
				</div>
				<div class="ph-doc-links">
					<span class="ph-doc-label">技術ドキュメント</span>
					<a href="/docs/geopbf-jp.html" target="_blank" rel="noopener">GeoPBF 仕様</a>
					<a href="/docs/gint.html"      target="_blank" rel="noopener">GINT レンダラー</a>
					<a href="/docs/gintbuf-jp.html" target="_blank" rel="noopener">GINT バッファ構造</a>
					<a href="/docs/lod.html"       target="_blank" rel="noopener">LOD アルゴリズム</a>
				</div>
			</section>

			<section class="ph-section">
				<h3 class="ph-section-title">使い方</h3>
				<p class="ph-howto">左のデータセットを選択して、ファイルを選んでください。プレビューや属性が表示され、多種の GIS ファイルへの変換・地図への描画が可能です。</p>
			</section>

			<div class="ph-closing">
				GeoPBF は生まれたてのテクノロジーです。バグや改善点があればぜひ教えてください。多くの方の参加と協力をお待ちしています。
				<div class="ph-author">Kenji Yoshida @ Yokohama &nbsp;·&nbsp; <a href="https://github.com/kenjiyoshidahome2026-bit/ortho-earth/issues" target="_blank" rel="noopener">GitHub Issues</a></div>
			</div>

		</div>
	`;
}

function escHtml(s) {
	return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ============================================================
// キーボードナビゲーション
// ============================================================
document.addEventListener('keydown', e => {
	const tag = document.activeElement?.tagName;
	const inInput = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

	if (e.key === '/' && !inInput) {
		e.preventDefault(); document.getElementById('search').select(); return;
	}
	if (e.key === 'Escape' && tag === 'INPUT') {
		const s = document.getElementById('search');
		if (s.value) { s.value = ''; renderList(); }
		s.blur(); return;
	}
	if (!['ArrowUp','ArrowDown','Enter'].includes(e.key) || inInput) return;
	e.preventDefault();

	const items = [...document.querySelectorAll('.ds-item')];
	if (!items.length) return;

	if (e.key === 'Enter') {
		const cur = document.querySelector('.ds-item.active');
		if (cur) selectDataset(cur.dataset.code); return;
	}

	const curIdx = items.findIndex(el => el.dataset.code === active);
	const nextIdx = e.key === 'ArrowDown'
		? (curIdx < 0 ? 0 : Math.min(curIdx + 1, items.length - 1))
		: (curIdx < 0 ? items.length - 1 : Math.max(curIdx - 1, 0));

	const next = items[nextIdx];
	items.forEach(el => el.classList.remove('kbd-focus'));
	next.classList.add('kbd-focus');
	next.scrollIntoView({ block: 'nearest' });
	selectDataset(next.dataset.code);
});

// ============================================================
// ハッシュ変更
// ============================================================
window.addEventListener('hashchange', () => {
	const hash = location.hash.slice(1);
	if (!hash) return;
	if (hash === 'moj') { if (active !== 'moj') selectDataset('moj', true); return; }
	if (hash !== active && catalog.some(ds => ds.dataset_code === hash)) {
		selectDataset(hash, true);
		setTimeout(() => document.querySelector(`.ds-item[data-code="${hash}"]`)?.scrollIntoView({ block: 'center' }), 100);
	}
});

// ============================================================
function showPropTable(pbf, logEl, tablesEl, actionEl) {
    const PAGE = 100;
    const data = pbf.getPropertyTable();
    if (!data?.length) { return; }
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
    const tbody = tablesEl.select('tbody');
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
    const saveProp = async s => { if (!s) return; const v = await saveTo(s); if (v) {} };
    btnRow.append('button').text('📥 CSV').on('click', () =>
        saveProp(new File([pbf.getCSV()], (pbf._name || 'data') + '.csv', { type: 'text/csv' })));
    btnRow.append('button').text('📥 Excel').on('click', async () => {
        window.XLSX || await import('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
        const wb = window.XLSX.read(pbf.getCSV(), { type: 'string', raw: true });
        const buf = window.XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        saveProp(new File([buf], (pbf._name || 'data') + '.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    });
    btnRow.append('button').text('✕ 閉じる').on('click', () => { tablesEl.hide().html(''); logEl.show(); actionEl.show(); });
}

// ============================================================
// Exec ビュー（全省庁共通）― gishub と同じ画面
// ============================================================
function renderExecView(entry, onBack = null, geopbfFn = null) {
	closeGeoPreview();
	setDetailHtml(`
		<div class="detail-inner">
			<div id="exec-action"></div>
			<div id="exec-log"></div>
			<div id="exec-tables"></div>
		</div>
	`);

	const actionEl  = d3select('#exec-action');
	const logEl     = d3select('#exec-log');
	const tablesEl  = d3select('#exec-tables').hide();
	const logger    = new screenLogger(logEl);

	geoExec(entry, {
		geopbf: geopbfFn || geopbf,
		logger,
		async onSuccess(pbf) {
			_currentPbf = pbf;

			actionEl.html('');
			const p = actionEl.append('div').classed('exec-action-row', true);
			p.append('button').classed('accent', true).text('🌍 地図に描画').on('click', () => execGlobeView(pbf));
			p.append('button').text('🏷️ 属性の一覧').on('click', () => showPropTable(pbf, logEl, tablesEl, actionEl));
			p.append('button').text('🔄 再読み込み').on('click', () => renderExecView({ ...entry, nocache: true }, onBack));
			p.append('button').text('← 一覧に戻る').on('click', () => { _currentPbf = null; onBack?.(); });

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

function closeGeoPreview() {
	const panel = document.getElementById('geo-preview');
	panel.classList.remove('visible');
	panel.innerHTML = '';
}

// ============================================================
// サイドバー折りたたみ
// ============================================================
function initSidebarToggle() {
	const app     = document.getElementById('app');
	const toggle  = document.getElementById('sidebar-toggle');
	const openBtn = document.getElementById('sidebar-open-btn');
	const backdrop = document.getElementById('sidebar-backdrop');

	const isMobile = () => window.innerWidth <= 640;

	// デスクトップ: localStorage で状態復元
	if (!isMobile() && localStorage.getItem('sidebar-collapsed') === '1') {
		app.classList.add('sidebar-collapsed');
		toggle.textContent = '▶';
	}

	// モバイル: デフォルト collapsed
	if (isMobile()) {
		app.classList.add('sidebar-collapsed');
	}

	function setSidebarCollapsed(collapsed) {
		app.classList.toggle('sidebar-collapsed', collapsed);
		if (!isMobile()) {
			localStorage.setItem('sidebar-collapsed', collapsed ? '1' : '0');
		}
	}

	toggle.addEventListener('click', () => setSidebarCollapsed(!app.classList.contains('sidebar-collapsed')));
	openBtn?.addEventListener('click', () => setSidebarCollapsed(false));
	backdrop?.addEventListener('click', () => setSidebarCollapsed(true));

	// モバイルでデータセット選択時にサイドバーを自動的に閉じる
	document.getElementById('dataset-list').addEventListener('click', e => {
		if (isMobile() && e.target.closest('.ds-item')) {
			setSidebarCollapsed(true);
		}
	});

	// ウィンドウリサイズでモバイル↔デスクトップ切り替え
	window.addEventListener('resize', () => {
		if (!isMobile()) {
			// デスクトップに切り替わったとき: localStorage の状態を復元
			const saved = localStorage.getItem('sidebar-collapsed') === '1';
			setSidebarCollapsed(saved);
			toggle.textContent = saved ? '▶' : '◀';
		} else {
			// モバイルに切り替わったとき: 閉じる
			app.classList.add('sidebar-collapsed');
			toggle.textContent = '◀';
		}
	});
}

// ============================================================
// 起動
// ============================================================
init();
initSidebarToggle();

document.getElementById('sidebar-brand').addEventListener('click', () => {
	currentDs = null;
	history.replaceState(null, '', '#');
	setDetailHtml(placeholder());
	closeGeoPreview();
});
