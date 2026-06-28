import MAFF_MANIFEST   from '../maff/manifest.json'   with { type: 'json' };
import ESTAT_MANIFEST  from '../estat/manifest.json'  with { type: 'json' };
import CENSUS_MANIFEST from '../census/manifest.json' with { type: 'json' };
import { MOJ_CITIES } from '../moj/ui.js';

export function placeholder(catalog) {
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
