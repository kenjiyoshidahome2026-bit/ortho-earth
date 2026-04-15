import { orthographic } from 'ortho-map'; // ※エントリーポイントに合わせて適宜修正してください！
import * as d3 from 'd3';

// 1. 描画先のコンテナを取得
const container = d3.select('#map-container');

// 2. ortho-map を起動！
// ※ orthographic関数がどのように呼ばれる仕様かによって書き方が変わります。
// もし d3 の拡張として動く場合は、以下のようなイメージです：
async function init() {
  try {
    // 例: container を map オブジェクトとして、そこに設定を流し込む場合
    const mapSettings = {
      baseName: "osm.street",
      zoom: 2,
      center: [135, 35]
    };

    // 描画実行！
    await orthographic.call(container, mapSettings);
    console.log("地図の初期化が完了しました！");
  } catch (e) {
    console.error("起動エラー:", e);
  }
}

init();