import { orthoEarth } from 'ortho-map';
const map = await orthoEarth();
map.explain = map.gadget.explain({ width: 300 });
map.tip = map.gadget.tip({});
map.pop = map.gadget.pop({});
////---------------------------------------------
map.gadget.loading();//ファイル読み込み中表示
map.gadget.layers();//レイヤーの切り替え
map.isNarrow || map.gadget.zoom();//ズームイン・ズームアウト
map.isNarrow || map.gadget.full();//全画面表示
map.gadget.north();//北向きに修正
map.gadget.shot();//スクリーンショット
map.isNarrow || map.gadget.print();//印刷
map.gadget.cpos();//現在地表示
map.gadget.measure();//距離測定
map.explain("<h3>White Earth Demo</h3><p>正投影法の地図(White Earth)のデモページです。このプラットフォーム上に、いろんな機能を実装することが可能です。</p>");
