import { Fetch } from '../../packages/native-bucket/src/index.js';

const PROXY_URL = `${window.location.origin}/api/proxy/`;
const BASE_URL = 'https://nlftp.mlit.go.jp/ksj/gml/';
const MAIN_LIST_URL = `${window.location.origin}/api/catalog/gml_datalist.html`;

const fetchBtn = document.getElementById('fetchBtn');
const clearBtn = document.getElementById('clearBtn');
const loading = document.getElementById('loading');
const stats = document.getElementById('stats');
const datasetList = document.getElementById('datasetList');
const countSpan = document.getElementById('count');

const modal = document.getElementById('modal');
const closeBtn = document.getElementById('closeBtn');
const modalTitle = document.getElementById('modalTitle');
const modalLoading = document.getElementById('modalLoading');
const downloadLinks = document.getElementById('downloadLinks');

const EMPTY_STATE = `
  <div class="empty-state">
    <div class="empty-state-icon">📁</div>
    <p>「カタログを取得」ボタンをクリックして、利用可能なデータセットを表示します</p>
  </div>
`;

async function fetchCatalog() {
  loading.classList.add('active');
  fetchBtn.disabled = true;
  datasetList.innerHTML = '';
  stats.classList.remove('active');

  try {
    const res = await fetch(MAIN_LIST_URL);
    if (!res.ok) throw new Error(`HTTPエラー: ${res.status}`);
    const html = await res.text();

    const linkRegex = /<a\s+[^>]*href=["']([^"']*datalist\/KsjTmplt-[^"']+\.html)["'][^>]*>([\s\S]*?)<\/a>/g;
    const seen = new Set();
    const items = [];
    let match;

    while ((match = linkRegex.exec(html)) !== null) {
      const url = new URL(match[1], BASE_URL).href;
      const title = match[2].replace(/<[^>]*>/g, '').trim();
      if (!seen.has(url) && title) {
        seen.add(url);
        items.push({ title, url });
      }
    }

    countSpan.textContent = items.length;
    stats.classList.add('active');
    datasetList.innerHTML = items.map(item => `
      <div class="dataset-item" data-url="${item.url}" data-title="${item.title.replace(/"/g, '&quot;')}">
        <div class="dataset-title">${item.title}</div>
        <div class="dataset-url">${new URL(item.url).pathname}</div>
      </div>
    `).join('');

  } catch (error) {
    datasetList.innerHTML = `
      <div class="empty-state" style="grid-column: 1/-1;">
        <div class="empty-state-icon">❌</div>
        <p>エラーが発生しました: ${error.message}</p>
      </div>
    `;
  } finally {
    loading.classList.remove('active');
    fetchBtn.disabled = false;
  }
}

async function openDatasetModal(title, url) {
  modal.classList.add('active');
  modalTitle.textContent = title;
  modalLoading.style.display = 'block';
  downloadLinks.style.display = 'none';
  downloadLinks.innerHTML = '';

  try {
    const html = await Fetch(url, { type: 'text', proxy: PROXY_URL });
    let links = findDownloadLinks(html, url);

    if (links.length === 0) {
      links = await findTokeiLinks(html, url);
    }

    downloadLinks.innerHTML = links.length > 0
      ? links.map(link => `
          <div class="download-item">
            <a href="${link.url}" target="_blank">${link.name}</a>
            <span class="download-icon">📥</span>
          </div>
        `).join('')
      : `<p style="color: #999;">
          直接的なダウンロードリンクが見つかりません。<br><br>
          <a href="${url}" target="_blank" style="color: #667eea; text-decoration: underline;">
            📄 詳細ページを開く →
          </a>
        </p>`;
  } catch (error) {
    downloadLinks.innerHTML = `<p style="color: red;">エラー: ${error.message}</p>`;
  } finally {
    modalLoading.style.display = 'none';
    downloadLinks.style.display = 'block';
  }
}

async function findTokeiLinks(html, baseUrl) {
  const links = [];
  const scriptRegex = /src="([^"]*tokei_data\d+\.js)"/g;
  let match;

  while ((match = scriptRegex.exec(html)) !== null) {
    const jsUrl = new URL(match[1], baseUrl).href;
    try {
      const jsText = await Fetch(jsUrl, { type: 'text', proxy: PROXY_URL });
      const jsonText = jsText.replace(/^const\s+\w+\s*=\s*/, '').replace(/;\s*$/, '');
      const data = JSON.parse(jsonText);
      for (const entry of data) {
        if (entry.data === 'GEOJSON形式' && entry.dl) {
          const url = new URL(entry.dl, 'https://nlftp.mlit.go.jp').href;
          links.push({ name: entry.file, url });
        }
      }
    } catch (e) {}
  }

  return links;
}

function findDownloadLinks(html, baseUrl) {
  const seen = new Set();
  const links = [];
  const regex = /DownLd\([^,]+,\s*'([^']+)',\s*'([^']+)'/g;
  let match;

  while ((match = regex.exec(html)) !== null) {
    const name = match[1].trim();
    const url = new URL(match[2].trim(), baseUrl).href;
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ name, url });
    }
  }
  return links;
}

// イベント委譲でデータセットクリックを処理
datasetList.addEventListener('click', (e) => {
  const item = e.target.closest('.dataset-item');
  if (!item) return;
  openDatasetModal(item.dataset.title, item.dataset.url);
});

fetchBtn.addEventListener('click', fetchCatalog);
clearBtn.addEventListener('click', () => {
  datasetList.innerHTML = EMPTY_STATE;
  stats.classList.remove('active');
});

closeBtn.addEventListener('click', () => modal.classList.remove('active'));
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.classList.remove('active');
});
