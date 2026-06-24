// ============================================================
// データソース設定 — 省庁を追加する場合はここに追記
// ============================================================
const SOURCES = [
  {
    id:          'nlftp',
    title:       '国土交通省 国土数値情報',
    bucket:      'catalog',
    attribution: '国土交通省 国土数値情報',
  },
  // { id: 'maff',  title: '農林水産省', bucket: 'maff-catalog',  attribution: '農林水産省' },
  // { id: 'moj',   title: '法務省',     bucket: 'moj-catalog',   attribution: '法務省'     },
  // { id: 'soumu', title: '総務省',     bucket: 'soumu-catalog', attribution: '総務省'     },
];

// ============================================================
// API 設定
// ============================================================
const IS_DEV   = window.location.hostname === 'localhost';
const API_BASE = IS_DEV ? '/api' : 'https://api.ortho-earth.com';

function bucketUrl(source, path) {
  return `${API_BASE}/bucket/${source.bucket}/${path}`;
}

// gzip を Content-Encoding なしで返すサーバー向けの fetch+JSON
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
let source  = SOURCES[0];
let catalog = [];    // index.json の内容
let active  = null;  // 選択中 dataset_code
let currentCodelists = [];  // renderDetail 時にセット: [null | [{code,label}], ...]
let licFilter = 'all';  // 'all' | 'ok' | 'ng'
let currentDs = null;   // 詳細表示中の DS (ファイルフィルターで参照)

// ============================================================
// 初期化
// ============================================================
async function init() {
  buildSourceSelect();
  document.getElementById('source-select').addEventListener('change', async e => {
    source = SOURCES.find(s => s.id === e.target.value) || SOURCES[0];
    active = null;
    document.getElementById('detail').innerHTML = placeholder();
    await loadCatalog();
  });

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

function buildSourceSelect() {
  const sel = document.getElementById('source-select');
  sel.innerHTML = SOURCES.map(s =>
    `<option value="${s.id}">${s.title}</option>`
  ).join('');
}

// ============================================================
// カタログ読み込み
// ============================================================
async function loadCatalog() {
  const list = document.getElementById('dataset-list');
  list.innerHTML = '<div class="loading-msg">読み込み中...</div>';
  try {
    catalog = await fetchJson(bucketUrl(source, 'index.json'));
    renderList();
    // URL ハッシュに一致するデータセットを自動選択
    const hash = location.hash.slice(1);
    if (hash && catalog.some(ds => ds.dataset_code === hash)) {
      selectDataset(hash, true);
      // リスト内で該当アイテムを表示位置に合わせる
      setTimeout(() => {
        document.querySelector(`.ds-item[data-code="${hash}"]`)?.scrollIntoView({ block: 'center' });
      }, 100);
    }
  } catch (e) {
    list.innerHTML = `<div class="error-msg">読み込みエラー: ${e.message}</div>`;
  }
}

// ============================================================
// リスト描画
// ============================================================
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

  list.innerHTML = items.map(ds => {
      return `
      <div class="ds-item${ds.dataset_code === active ? ' active' : ''}"
           data-code="${ds.dataset_code}">
        <div class="ds-line1">
          <span class="ds-code">${ds.dataset_code}</span>
          <span class="ds-line1-right">
            <span class="meta-num">${ds.file_count}件</span>
            <span class="meta-lic">${ds.license}</span>
          </span>
        </div>
        <div class="ds-title">${ds.title}</div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('.ds-item').forEach(el => {
    el.addEventListener('click', () => selectDataset(el.dataset.code, true));
  });
}

// ============================================================
// データセット選択（キー連打時はデバウンス）
// ============================================================
let _selectTimer = null;
function selectDataset(code, immediate = false) {
  clearTimeout(_selectTimer);
  if (immediate) { _selectDatasetNow(code); return; }
  _selectTimer = setTimeout(() => _selectDatasetNow(code), 150);
}

async function _selectDatasetNow(code) {
  active = code;

  // URL ハッシュ更新（ブラウザ履歴に残さない）
  history.replaceState(null, '', `#${code}`);

  // サイドバーのアクティブ表示更新
  document.querySelectorAll('.ds-item').forEach(el => {
    el.classList.toggle('active', el.dataset.code === code);
  });

  const detail = document.getElementById('detail');
  detail.innerHTML = '<div class="loading-msg" style="padding:40px">読み込み中...</div>';

  try {
    const ds = await fetchJson(bucketUrl(source, `${code}.json`));
    renderDetail(ds);
  } catch (e) {
    detail.innerHTML = `<div class="error-msg">エラー: ${e.message}</div>`;
  }
}

// ============================================================
// 詳細表示
// ============================================================
function renderDetail(ds) {
  const detail = document.getElementById('detail');
  currentDs = ds;

  // コードリストをモジュール変数にセット（ボタン click で参照）
  currentCodelists = (ds.attributes || []).map(a => Array.isArray(a.codelist) ? a.codelist : null);

  // 属性テーブル
  const attrHtml = ds.attributes.length ? `
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

  // ファイル一覧
  const fileHtml = renderFiles(ds);

  detail.innerHTML = `
    <div class="detail-inner">
      <header class="detail-header">
        <h2>${ds.title}</h2>
        <div class="detail-meta">
          <span class="badge lic-${licKey(ds.license)}">${ds.license}</span>
          <span class="mono" style="color:#888">${ds.dataset_code}</span>
          <a href="${ds.page_url}" target="_blank" rel="noopener" class="ext-link">NLFTPページ →</a>
        </div>
      </header>
      ${attrHtml}
      ${fileHtml}
    </div>
  `;
}

function licKey(lic) {
  return lic?.includes('商用可') ? 'ok' : 'ng';
}

// ============================================================
// ファイル一覧描画
// ============================================================
function renderFiles(ds) {
  if (!ds.files.length) return '<p class="no-files">GISファイルなし</p>';

  // GeoJSON があれば SHP は除外、その後ソート
  const raw   = ds.files.some(f => f.format === 'geojson')
    ? ds.files.filter(f => f.format !== 'shp')
    : ds.files;
  const allFiles = sortFiles(raw);

  // フィルター選択肢を収集
  const years   = [...new Set(allFiles.map(f => f.year).filter(Boolean))].sort().reverse();
  const formats = [...new Set(allFiles.map(f => f.format))].sort();

  const yearOpts   = ['all', ...years].map(y =>
    `<option value="${y}">${y === 'all' ? '年度: すべて' : y}</option>`).join('');
  const fmtOpts    = ['all', ...formats].map(f =>
    `<option value="${f}">${f === 'all' ? '形式: すべて' : f.toUpperCase()}</option>`).join('');

  // 都道府県フィルター（スコープが「都道府県」のファイルがある場合のみ）
  const prefCodes = [...new Set(allFiles.filter(f => f.pref_code).map(f => f.pref_code))].sort();
  const prefOpts  = prefCodes.length ? `
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
          ${years.length > 1 ? `<select class="file-filter" id="ff-year">${yearOpts}</select>` : ''}
          ${formats.length > 1 ? `<select class="file-filter" id="ff-fmt">${fmtOpts}</select>` : ''}
          ${prefOpts}
        </div>
        <table class="file-table">
          <thead><tr>
            <th style="width:50px">年度</th>
            <th style="width:80px">エリア</th>
            <th style="width:62px">形式</th>
            <th>ZIP</th>
            <th style="width:44px"></th>
          </tr></thead>
          <tbody id="files-tbody">
            ${buildFileRows(allFiles, ds)}
          </tbody>
        </table>
        <p class="dl-note">→ ボタンで zip_url#filename をコピー → GIS-HUB にペーストして GeoPBF 変換</p>
      </div>
    </section>
  `;
}

function buildFileRows(files, ds, limit = 200) {
  const shown = files.slice(0, limit);
  const rest  = files.length - shown.length;
  return shown.map(f => fileRow(f, ds)).join('') +
    (rest ? `<tr><td colspan="5" class="more-row" data-code="${ds.dataset_code}">…残り ${rest} 件 <button class="load-more-btn">すべて表示</button></td></tr>` : '');
}

// 都道府県コード → 名称テーブル
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

// scope フィールドを正として表示ラベルを決定
function scopeLabel(f) {
  const scope = f.scope || '全国';
  if (scope === '全国') return '全国';
  if (scope === '都道府県') {
    const code = String(f.pref_code || '').padStart(2, '0');
    return PREFS[code] || f.pref_code || '都道府県';
  }
  if (scope.includes('メッシュ')) return f.location_code || scope;
  // 市区町村・地方区分
  return f.location_code || f.pref_code || scope;
}

// ソートキー: 全国を先頭、次に pref_code / location_code 昇順
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

function fileRow(f, ds) {
  const zipUrl   = f.target.split('#')[0];
  const zipName  = zipUrl.split('/').pop();
  const fileName = f.target.split('#')[1] || '';
  const name     = fileName.replace(/\.[^.]+$/, '');
  const area     = scopeLabel(f);
  const desc     = `${ds.title}${area !== '全国' ? ' (' + area + ')' : ''}${f.year ? ':' + f.year : ''}`;

  const entry = {
    name,
    description: desc,
    target:      f.target,
    link:        ds.page_url,
    attribution: source.attribution || '',
    license:     ds.license,
  };

  return `
    <tr>
      <td>${f.year || '—'}</td>
      <td class="mono">${area}</td>
      <td><span class="badge fmt-${f.format}">${f.format.toUpperCase()}</span></td>
      <td class="mono">${zipName}${fileName ? `<br><span class="file-sub">${fileName}</span>` : ''}</td>
      <td><button class="copy-btn" data-entry="${escHtml(JSON.stringify(entry))}">→</button></td>
    </tr>
  `;
}

// ============================================================
// ファイルフィルター (change イベント)
// ============================================================
document.getElementById('detail').addEventListener('change', e => {
  if (!e.target.classList.contains('file-filter')) return;
  applyFileFilters();
});

function applyFileFilters() {
  if (!currentDs?.files?.length) return;
  const year  = document.getElementById('ff-year')?.value  || 'all';
  const fmt   = document.getElementById('ff-fmt')?.value   || 'all';
  const pref  = document.getElementById('ff-pref')?.value  || 'all';

  const raw = currentDs.files.some(f => f.format === 'geojson')
    ? currentDs.files.filter(f => f.format !== 'shp')
    : currentDs.files;

  const filtered = sortFiles(raw.filter(f => {
    if (year !== 'all' && String(f.year) !== year) return false;
    if (fmt  !== 'all' && f.format !== fmt)        return false;
    if (pref !== 'all' && String(f.pref_code) !== pref) return false;
    return true;
  }));

  document.getElementById('files-cnt').textContent  = filtered.length;
  document.getElementById('files-tbody').innerHTML  = buildFileRows(filtered, currentDs);
}

// ============================================================
// クリックイベント
// ============================================================
document.getElementById('detail').addEventListener('click', async e => {
  // 「すべて表示」ボタン
  if (e.target.classList.contains('load-more-btn')) { handleLoadMore(e.target); return; }

  // セクション折りたたみ
  const title = e.target.closest('.section-title');
  if (title) { title.parentElement.classList.toggle('collapsed'); return; }

  // コードリストボタン
  if (e.target.classList.contains('codelist-btn')) {
    const idx = parseInt(e.target.dataset.clIdx);
    const entries = currentCodelists[idx] || [];
    showCodelistPopup(entries, e.target);
    return;
  }

  // → ボタン: gishub catalog エントリをクリップボードへ
  if (!e.target.classList.contains('copy-btn')) return;
  const btn   = e.target;
  const entry = JSON.parse(btn.dataset.entry);
  const text  = JSON.stringify(entry, null, 2);
  try { await navigator.clipboard.writeText(text); } catch {}
  btn.textContent = '✓';
  showToast(entry.target);
  setTimeout(() => { btn.textContent = '→'; }, 1500);
});

// ============================================================
// コードリスト表示（pre-parsed 配列をそのまま表示）
// ============================================================
function showCodelistPopup(entries, btn) {
  document.querySelectorAll('.codelist-popup').forEach(el => el.remove());

  const popup = document.createElement('div');
  popup.className = 'codelist-popup';

  if (!entries.length) {
    popup.innerHTML = '<div class="cl-loading">データなし</div>';
  } else {
    popup.innerHTML = `
      <div class="cl-header">
        <span>${entries.length}件</span>
        <button class="cl-close" onclick="this.closest('.codelist-popup').remove()">✕</button>
      </div>
      <div class="cl-body">
        <table>
          <thead><tr><th>コード</th><th>名称</th></tr></thead>
          <tbody>${entries.map(r => `<tr><td class="mono">${escHtml(r.code)}</td><td>${escHtml(r.label)}</td></tr>`).join('')}</tbody>
        </table>
      </div>`;
  }

  document.body.appendChild(popup);

  // ボタン位置に合わせて fixed 配置
  const rect = btn.getBoundingClientRect();
  const pw = 320;
  let left = rect.right - pw;
  if (left < 4) left = 4;
  let top = rect.bottom + 4;
  if (top + 340 > window.innerHeight) top = rect.top - 340;
  popup.style.left = `${left}px`;
  popup.style.top  = `${top}px`;

  const close = e => { if (!popup.contains(e.target) && e.target !== btn) { popup.remove(); document.removeEventListener('click', close, true); } };
  setTimeout(() => document.addEventListener('click', close, true), 0);
}

function showToast(url) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = url;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2500);
}

// ============================================================
// 「すべて表示」— DS を再取得して tbody に追記
// ============================================================
async function handleLoadMore(btn) {
  const row  = btn.closest('tr');
  btn.disabled = true;
  btn.textContent = '読み込み中...';
  try {
    const ds    = currentDs;
    const files = ds.files.some(f => f.format === 'geojson')
      ? ds.files.filter(f => f.format !== 'shp')
      : ds.files;
    const newRows = sortFiles(files).slice(200).map(f => fileRow(f, ds)).join('');
    row.insertAdjacentHTML('beforebegin', newRows);
    row.remove();
  } catch (e) {
    btn.textContent = 'エラー';
  }
}

// ============================================================
// ユーティリティ
// ============================================================
function placeholder() {
  return `<div class="placeholder"><div class="placeholder-icon">🗂</div><p>← データセットを選択してください</p></div>`;
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

  // '/' でサイドバー検索にフォーカス
  if (e.key === '/' && !inInput) {
    e.preventDefault();
    document.getElementById('search').select();
    return;
  }

  // Escape で検索クリア
  if (e.key === 'Escape' && tag === 'INPUT') {
    const search = document.getElementById('search');
    if (search.value) { search.value = ''; renderList(); }
    search.blur();
    return;
  }

  // ArrowUp / ArrowDown / Enter — リスト内ナビゲーション
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter') return;
  if (inInput) return;
  e.preventDefault();

  const items = [...document.querySelectorAll('.ds-item')];
  if (!items.length) return;

  if (e.key === 'Enter') {
    const cur = document.querySelector('.ds-item.active');
    if (cur) selectDataset(cur.dataset.code);
    return;
  }

  const curIdx = items.findIndex(el => el.dataset.code === active);
  let nextIdx;
  if (e.key === 'ArrowDown') nextIdx = curIdx < 0 ? 0 : Math.min(curIdx + 1, items.length - 1);
  else                        nextIdx = curIdx < 0 ? items.length - 1 : Math.max(curIdx - 1, 0);

  const next = items[nextIdx];
  // アクティブ切り替えだけ（詳細ロードはしない）
  items.forEach(el => el.classList.remove('kbd-focus'));
  next.classList.add('kbd-focus');
  next.scrollIntoView({ block: 'nearest' });

  // Enter の代わりに短押しで選択
  selectDataset(next.dataset.code);
});

// ============================================================
// ハッシュ変更（ブラウザ前後ボタン / 外部リンク）
// ============================================================
window.addEventListener('hashchange', () => {
  const hash = location.hash.slice(1);
  if (hash && hash !== active && catalog.some(ds => ds.dataset_code === hash)) {
    selectDataset(hash, true);
    setTimeout(() => {
      document.querySelector(`.ds-item[data-code="${hash}"]`)?.scrollIntoView({ block: 'center' });
    }, 100);
  }
});

// ============================================================
// 起動
// ============================================================
init();
