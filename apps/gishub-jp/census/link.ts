// 国勢調査（2025 速報・2020 基本集計・2015 基本集計）のドリルダウンは census2020 アプリ（/japan/census2020/）へ一本化した（2026-10-31 本人裁定）。
// 旧＝census2020 を作った時（2026-08-12）の写し（census/ui.ts・small-area.ts）がここにも残り、直すたびに 2 か所だった。
// 7/16 の方針（gishub-jp はアップローダーに・描画は japan の側）に沿って、ここは入口だけを置く。データと変換の道具（scripts/・packages/jp/census）は残す。
import { ctx } from '../ui/ctx.ts';

const CENSUS_APP = '/japan/census2020/';

export function renderCensusLink() {
    ctx.setDetailHtml(`
        <div class="detail-inner">
            <header class="detail-header">
                <h2>国勢調査</h2>
                <div class="detail-meta">
                    <span class="badge">CC BY</span>
                    <span class="mono" style="color:#888">総務省統計局</span>
                </div>
            </header>
            <section class="detail-section">
                <p>2025 年速報・2020 年・2015 年の国勢調査を、全国から都道府県・市区町村・町丁目（小地域）までたどる画面は、国勢調査のアプリにまとめました。</p>
                <p><a href="${CENSUS_APP}" class="ext-link">国勢調査 2020 を球で読む →</a></p>
            </section>
        </div>
    `);
}
