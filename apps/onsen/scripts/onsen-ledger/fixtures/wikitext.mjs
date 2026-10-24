// 検定用の wikitext（実記事の形を真似た最小のもの）
export const PAGES = {
  "吾妻温泉郷": `'''吾妻温泉郷'''（あがつまおんせんきょう）は、[[群馬県]][[吾妻郡]]に点在する温泉の総称。[[草津温泉]]、[[万座温泉]]、[[架空温泉]]などからなる。
[[Category:群馬県の温泉]]`,
  "草津温泉": `{{日本の温泉地
| 名称 = 草津温泉
| 画像 = Kusatsu Onsen.jpg
| 所在地 = [[群馬県]][[吾妻郡]][[草津町]]
| 交通 = [[JR]][[長野原草津口駅]]からバス
| 泉質 = [[酸性泉]]（酸性低張性高温泉）<ref>環境省</ref>
| 泉温 = 50 - 96
| 湧出量 = 毎分32,300L
| pH = 2.1
| 液性 = 酸性
| 浸透圧 = 低張性
| 宿泊施設数 = 約160
| 外部リンク = [https://www.kusatsu-onsen.ne.jp/ 草津温泉観光協会]
}}
'''草津温泉'''（くさつおんせん）は、[[群馬県]][[吾妻郡]][[草津町]]にある[[温泉]]。
== 泉質 ==
* 酸性泉
[[Category:群馬県の温泉]]`,
  "湯の川温泉 (島根県)": `'''湯の川温泉'''（ゆのかわおんせん）は、[[島根県]][[出雲市]]（旧[[出雲国]]）にある[[温泉]]。{{ウィキ座標2段度分秒|35|22|5|N|132|49|25|E|type:landmark_region:JP|display=title}}
== 泉質 ==
* [[ナトリウム・カルシウム-硫酸塩・塩化物泉]]
[[Category:島根県の温泉]]`,
  "別府温泉": `{{日本の温泉地|名称=別府温泉|所在地=[[大分県]][[別府市]]|泉質=単純温泉、[[塩化物泉]]ほか|緯度度=33|緯度分=17|緯度秒=0|N(S)=N|経度度=131|経度分=29|経度秒=0|E(W)=E}}
'''別府温泉'''（べっぷおんせん）は、[[大分県]][[別府市]]内に数多く存在する[[温泉]]の総称。
[[Category:大分県の温泉]][[Category:別府温泉]]`,
  "架空温泉": `'''架空温泉'''(かくうおんせん)は、[[北海道]][[上川郡 (石狩国)|上川郡]][[東川町]]にあった温泉。\n[[Category:北海道の温泉]]
源泉は約3 km離れた山中にあり、[[草津温泉]]から引湯している。`,
  "温泉饅頭": `'''温泉饅頭'''は[[饅頭]]の一種。`,
  "座標なし温泉": `'''座標なし温泉'''（ざひょうなしおんせん）は、[[長野県]][[松本市]]にある温泉。{{coord|36.2|137.9|display=title}}`,
};
export const META = {
  "吾妻温泉郷": { pageid: 1007, qid: "Q99999007", coord: { lat: 36.62, lon: 138.6 } },
  "草津温泉": { pageid: 1001, coord: { lat: 36.6214, lon: 138.5961 }, qid: "Q1143283" },
  "湯の川温泉 (島根県)": { pageid: 1002, qid: "Q11487101" },
  "別府温泉": { pageid: 1003, coord: { lat: 33.2833, lon: 131.4833 }, qid: "Q806427" },
  "架空温泉": { pageid: 1004, qid: "Q99999001" },
  "温泉饅頭": { pageid: 1005 },
  "座標なし温泉": { pageid: 1006 },
};
export const REDIRECTS = { "湯の川温泉（出雲）": "湯の川温泉 (島根県)" };
export const CATS = {
  "Category:日本の温泉地": { subcats: ["Category:群馬県の温泉", "Category:島根県の温泉", "Category:大分県の温泉", "Category:北海道の温泉", "Category:温泉旅館"], pages: ["温泉饅頭"] },
  "Category:群馬県の温泉": { subcats: [], pages: ["草津温泉", "吾妻温泉郷"] },
  "Category:島根県の温泉": { subcats: [], pages: ["湯の川温泉 (島根県)"] },
  "Category:大分県の温泉": { subcats: ["Category:別府温泉"], pages: ["別府温泉"] },
  "Category:別府温泉": { subcats: [], pages: ["別府温泉"] },
  "Category:北海道の温泉": { subcats: [], pages: ["架空温泉"] },
  "Category:温泉旅館": { subcats: [], pages: ["ホテル何々"] },
};
export const LISTS = { "日本の温泉地一覧": ["草津温泉", "湯の川温泉（出雲）", "座標なし温泉", "温泉法", "温泉"], "長野県の温泉地一覧": ["座標なし温泉"] };
export const WD = {
  Q1143283: { labels: { ja: "草津温泉", en: "Kusatsu Onsen" }, sitelinks: { jawiki: "草津温泉", enwiki: "Kusatsu Onsen" }, P625: { latitude: 36.62, longitude: 138.6 }, P131: ["Q1023530"], P18: "Kusatsu Onsen.jpg" },
  Q11487101: { labels: { ja: "湯の川温泉" }, sitelinks: { jawiki: "湯の川温泉 (島根県)" }, P625: { latitude: 35.3681, longitude: 132.8236 }, P131: ["Q848254"] },
  Q806427: { labels: { ja: "別府温泉", en: "Beppu Onsen" }, sitelinks: { jawiki: "別府温泉", enwiki: "Beppu Onsen" }, P131: ["Q484183"] },
  Q99999001: { labels: { ja: "架空温泉" }, sitelinks: { jawiki: "架空温泉" }, P131: ["Q1189296"] },
  Q99999002: { labels: { ja: "記事なし温泉", en: "No Article Onsen" }, sitelinks: {}, P625: { latitude: 43.1, longitude: 141.3 }, P131: ["Q1189296"] },
  Q99999003: { labels: { en: "Nowhere Onsen" }, sitelinks: {}, P131: [] },
  Q99999007: { labels: { ja: "吾妻温泉郷" }, sitelinks: { jawiki: "吾妻温泉郷" }, P131: ["Q1023530"] },
};
// 05-geocode の模擬: Nominatim と地理院住所検索
export const OSM = { "架空温泉 北海道": [{ lat: "43.70", lon: "142.80", name: "架空温泉", display_name: "架空温泉, 東川町, 上川郡, 北海道, 日本" }] };
export const GSI_HITS = { "北海道東川町": [{ geometry: { coordinates: [142.81, 43.69], type: "Point" }, properties: { title: "北海道上川郡東川町" } }], "長野県松本市": [{ geometry: { coordinates: [137.97, 36.24], type: "Point" }, properties: { title: "長野県松本市" } }] };
// 06-hitou の模擬: 会員宿一覧と宿頁（JSON-LD）
export const HITOU_LIST = `<html><body><a href="/provider/901">草津 架空の宿</a><a href="/provider/902">別の宿</a></body></html>`;
export const HITOU_PAGES = {
  "901": `<html><head><title>草津温泉 草津温泉 架空の宿 宿泊予約 - 日本秘湯を守る会</title><script type="application/ld+json">{"@type":"Hotel","name":"架空の宿","address":{"@type":"PostalAddress","postalCode":"377-1711","addressRegion":"群馬県","streetAddress":"群馬県吾妻郡草津町草津1"},"geo":{"@type":"GeoCoordinates","latitude":36.6220,"longitude":138.5970}}</script></head><body>通年営業<table><tr><th>泉質</th><td>酸性泉</td></tr></table></body></html>`,
  "902": `<html><head><title>別の宿 宿泊予約 - 日本秘湯を守る会</title><script type="application/ld+json">{"@type":"Hotel","name":"別の宿","address":{"@type":"PostalAddress","addressRegion":"島根県","streetAddress":"島根県出雲市斐川町学頭1"},"geo":{"@type":"GeoCoordinates","latitude":35.3690,"longitude":132.8240}}</script></head><body>期間営業</body></html>`,
};
export const ADM = { Q1023530: { ja: "草津町", pref: "群馬県" }, Q848254: { ja: "出雲市", pref: "島根県" }, Q484183: { ja: "別府市", pref: "大分県" }, Q1189296: { ja: "東川町", pref: "北海道" } };
