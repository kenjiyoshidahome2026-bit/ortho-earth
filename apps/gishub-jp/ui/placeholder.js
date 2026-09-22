// 件数は軽量メタ（重いマニフェストを初期バンドルへ引き込まない）。更新は scripts/gen-counts.mjs
import COUNTS from './counts.json' with { type: 'json' };

export function placeholder(catalog) {
    const nlftpDs    = catalog.filter(d => d._sourceId === 'nlftp');
    const nlftpFiles = nlftpDs.reduce((s, d) => s + (d.file_count || 0), 0);
    const fmt = n => typeof n === 'number' ? n.toLocaleString() : n;

    const cards = [
        {
            icon:  '🗾',
            go:    'nlftp',
            min:   '国土交通省',
            url:   'https://nlftp.mlit.go.jp/ksj/',
            label: '国土数値情報',
            cnt:   nlftpFiles || '…',
            unit:  `ファイル / ${fmt(nlftpDs.length || '…')} データセット`,
            desc:  '道路・河川・土地利用・行政区域・ハザード・地価など国土に関する各種情報',
        },
        {
            icon:  '📊',
            go:    'estat',
            min:   '総務省',
            url:   'https://www.e-stat.go.jp/gis',
            label: '統計 GIS・国勢調査',
            cnt:   COUNTS.estat,
            unit:  `市区町村（小地域境界）+ 国勢調査 3セット`,
            desc:  '小地域境界 Shapefile（e-Stat）と 2015/2020/2025 年 国勢調査の人口・世帯・産業別集計',
        },
        {
            icon:  '🏠',
            go:    'moj',
            min:   '法務省',
            url:   'https://www.geospatial.jp/ckan/organization/moj',
            label: '登記所備付地図',
            cnt:   COUNTS.moj,
            unit:  '市区町村',
            desc:  '不動産登記の基礎となる 14 条地図（GeoJSON / GeoPBF）',
        },
        {
            icon:  '🌾',
            go:    'maff',
            min:   '農林水産省',
            url:   'https://open.fude.maff.go.jp/',
            label: '農地（筆ポリゴン）',
            cnt:   COUNTS.maff,
            unit:  '市区町村',
            desc:  '全国の農地区画（筆）。耕地の種類などの属性付き（GeoPBF）',
        },
        {
            icon:  '🏘️',
            go:    'munic',
            min:   '市区町村',
            url:   'https://www.geospatial.jp/ckan/organization/',
            label: '市区町村のオープンデータ',
            cnt:   COUNTS.munic,
            unit:  `自治体 / ${fmt(COUNTS.municSets)} データセット`,
            desc:  '地番図・防災・施設・AED など、市区町村が G空間情報センターに公開しているデータ',
        },
        {
            icon:  '🏔️',
            go:    'nps',
            min:   '環境省',
            url:   'https://geo.env.go.jp/',
            label: '国立公園',
            cnt:   35,
            unit:  '公園（区域・地種区分）',
            desc:  '特別保護地区〜普通地域の地種区分付き区域界（GeoPBF）',
        },
    ].map(c => `
        <div class="ph-card" data-go="${c.go}" role="link" tabindex="0" title="${c.label}を開く">
            <div class="ph-card-min">${c.min}</div>
            <div class="ph-card-cnt">${fmt(c.cnt)}</div>
            <div class="ph-card-head">
                <span class="ph-card-icon">${c.icon}</span>
                <span class="ph-card-label">${c.label}</span>
            </div>
            <div class="ph-card-unit">${c.unit}</div>
            <div class="ph-card-desc">${c.desc}</div>
            <a class="ph-card-src" href="${c.url}" target="_blank" rel="noopener">配布元のサイト ↗</a>
        </div>
    `).join('');

    return `
        <div class="placeholder">

            <div class="ph-hero">
                <div class="ph-hero-title">
                    <img class="ph-logo" src="favicon.svg" alt="">
                    <div class="ph-title">日本の公開 GIS データ</div>
                </div>
                <div class="ph-sub">国が公開する GIS データをブラウザで読み込み、GeoPBF に変換して、Gint で地球に描きます。</div>
                <div class="ph-hero-link">
                    <a href="/gishub/" target="_blank" rel="noopener">→ GeoPBF のデモ（世界版）</a>
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

            <details class="ph-section ph-fold">
                <summary class="ph-section-title">GeoPBF とは</summary>
                <div class="ph-text">
                    <p>
                        <strong>GeoPBF</strong> は、地理データ（点・線・面とその属性）をブラウザで扱うためのバイナリのファイル形式です。
                        Protocol Buffers（Google が作ったデータの符号化方式）の書き方で GeoJSON と同じ中身を詰め、小さく・速く読めるようにしています。
                        MIT ライセンスで公開しており、npm の <code>geopbf</code> パッケージで誰でも使えます。
                    </p>
                    <p>この地図では、配布元の Shapefile や GeoJSON をブラウザの中でいったん GeoPBF に変換し、描画・属性の表示・書き出しのすべてをそこから行います。</p>
                </div>

                <h4 class="ph-sub-title">ファイルの中身</h4>
                <table class="ph-spec">
                    <tr><th>ヘッダ</th><td>名前・説明・ライセンス・出典・座標の精度・<strong>属性名の辞書（KEYS）</strong>。本体を作り直さずに書き換えられる</td></tr>
                    <tr><th>地物の並び</th><td>地物ごとに「形の種類（点／線／面／マルチ）・頂点数・座標列」と「属性（辞書の番号＋値）」</td></tr>
                    <tr><th>属性の型</th><td>文字列・整数・小数・真偽・日付・色・JSON・画像など。値ごとに型を付けて保存する</td></tr>
                </table>

                <h4 class="ph-sub-title">小さくする仕組み</h4>
                <div class="ph-text">
                    <p>
                        座標は小数の文字列ではなく、<strong>精度を決めた整数</strong>（この地図の既定は 10<sup>−6</sup> 度≒ 0.1 m、登記所備付地図は 10<sup>−7</sup> 度）にしたうえで、
                        <strong>一つ前の頂点との差（デルタ）</strong>だけを記録します。隣り合う頂点の差は小さな数なので、
                        小さな数ほど短いバイト数で書ける <strong>Varint</strong> で 1〜2 バイトに収まります。
                        属性名は地物ごとに繰り返さず、ヘッダの辞書の番号で指します。
                    </p>
                </div>
                <div class="ph-code">経度 139.740000 → 139740000 → そのまま記録
経度 139.741230 → 139741230 → 差 +1230 だけ記録（2 バイト）
経度 139.742460 → 139742460 → 差 +1230 だけ記録（2 バイト）</div>
                <div class="ph-text">
                    <p>
                        実測（国土数値情報 N03 2026 全国市区町村界・12.5 万地物・1,567 万頂点）：
                        GeoJSON 579.6 MB → <strong>GeoPBF 48.6 MB</strong>。配布時の gzip どうしでは 138.6 MB → <strong>34.4 MB</strong>（約 1/4）。
                    </p>
                </div>

                <h4 class="ph-sub-title">変換の中継点</h4>
                <div class="ph-text">
                    <p>
                        GeoPBF のライブラリは、GeoJSON・Shapefile（zip）・KML／KMZ・GML・GPX・FlatGeobuf・TopoJSON・GeoParquet・登記所備付地図（法務省 XML）などを読み、
                        GeoJSON・Shapefile・KML／KMZ・GML・GPX・FlatGeobuf・TopoJSON・GeoParquet・PMTiles などへ書き出します。
                        GeoPBF を真ん中に置くので、どの形式からどの形式へも 1 回の変換で移れます。形式は拡張子と中身の先頭から自動で判定します。
                        この画面の書き出しは GeoPBF・GeoJSON・TopoJSON・FlatGeobuf・Shapefile・KMZ／KML・GML・GPX・NDJSON・CZML・GeoParquet・PMTiles と、形つきの CSV／Excel（点は経緯度・線や面は WKT）です。
                    </p>
                    <p>
                        登記所備付地図は平面直角座標系（19 系）で配られているため、読み込み時に経緯度へ直します。
                        また経度 ±180°（日付変更線）をまたぐ形は、格納時に球面上の正確な交点で切り分けます。
                    </p>
                </div>
            </details>

            <details class="ph-section ph-fold">
                <summary class="ph-section-title">Gint とは（描画）</summary>
                <div class="ph-text">
                    <p>
                        地球に描いているのは <strong>Gint</strong> です。GeoPBF からブラウザの中で組み立てる、GPU（WebGPU / WebGL2）がそのまま読める頂点の並びで、次のことを受け持ちます。
                    </p>
                </div>
                <ul class="ph-feat-list">
                    <li><span class="ph-feat-ic">▸</span><span><strong>動的 LOD</strong> — 各頂点に Visvalingam–Whyatt の重要度を持たせ、ズームに応じた頂点の間引きを GPU の頂点シェーダで行う。ズームしても取り直しなし</span></li>
                    <li><span class="ph-feat-ic">▸</span><span><strong>位相</strong> — 隣り合うポリゴンの共有境界（arc）を 1 本にまとめる。境界線を二重に描かず、すき間も生じない</span></li>
                    <li><span class="ph-feat-ic">▸</span><span><strong>識別</strong> — クリックした地点の地物を Gint の形から引き、GeoPBF の属性を表示</span></li>
                </ul>
                <div class="ph-doc-links">
                    <span class="ph-doc-label">技術ドキュメント</span>
                    <a href="/docs/geopbf-jp.html" target="_blank" rel="noopener">GeoPBF 仕様</a>
                    <a href="/docs/MO.html"      target="_blank" rel="noopener">Morton Order</a>
                    <a href="/docs/gint-jp.html" target="_blank" rel="noopener">GINT バッファ構造</a>
                    <a href="/docs/GC.html"       target="_blank" rel="noopener">GPU Culling</a>
                </div>
            </details>

            <section class="ph-section">
                <h3 class="ph-section-title">使い方</h3>
                <p class="ph-howto">上のカードか左の一覧からデータセットを選び、市区町村やファイルを選んでください。読み込むと属性の一覧・各種 GIS 形式への書き出し・地球への描画ができます。地図は × ・ Esc ・ブラウザの「戻る」で閉じます。</p>
            </section>


        </div>
    `;
}
