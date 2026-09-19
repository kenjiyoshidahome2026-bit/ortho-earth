# Projector 叩き台（deck.gl `project` モジュール → ortho-core の投影 seam）

位置づけ：レンダラ汎用化スレッドの再開点。「deck.gl の project シェーダモジュールを 1 本読み、
gint 整数→clip をどう封じるかを今のエンジンにマッピングして、Projector インターフェースの叩き台を作る」。
**実装ではなく契約の叩き台**。既に暗黙に存在している seam に名前を付けるのが目的で、裁定を仰ぐ点は §6。
読んだ 1 本＝deck.gl `modules/core/src/shaderlib/project/`（project.glsl.ts・viewport-uniforms.ts・
project32.ts・viewports/globe-viewport.ts、MIT・2026-09-20 時点の master）。

## 0. 結論（先出し）

1. **ortho-core には deck.gl の `project` モジュール相当が既に 4 写し存在する**。
   `gl/glsl.js` の `PROJECT` チャンク／`gl/gint/programs.js` の VS ヘッダ／`gpu/wgsl.js` の `Frame`／
   `gpu/gintwgsl.js` の `GF`。構造も deck.gl と同じ「uniform 束＋純関数チャンクを各シェーダへ文字列注入」。
   欠けているのは**名前**と**一枚化**（4 写しは手で同期している）と**外へ渡る契約の形**（overlay には
   `cameraState` の生オブジェクトが渡っている）。
2. **RTE の錨は数式レベルで deck.gl と同一だった**。deck.gl の offset mode は
   `clip = VP·V2P·[p,1] + center`（V2P＝平行移動を殺す diag(1,1,1,0)、center＝`VP·[origin,1]` を CPU で先出し）。
   これは ortho-core の `u_clipT + u_mvp * vec4(rel, 0.0)` そのもの。独立に同じ答えに着いた＝答え合わせ済み。
3. **ortho-core の方が一段上流で精度を解いている**。deck.gl は絶対座標の f32 不足を `position64Low`
   （fp64 エミュ）で補い、globe モードでは f32 の生 `sin/cos` に絶対経緯度を通す。ortho-core は頂点そのものが
   **原点相対（gint は uint 整数＋`dlonE7` 周期畳み）**で、`deltaToRel`（cosθ−1＝−2sin²(θ/2)・微小角テイラー
   `sinP`）が桁落ちを構造的に消す。fp64 エミュも、v1 の `u_jac`（線形化）とフル三角の切替も要らない。
4. 叩き台の提案＝**Projector を三つの型で定義する**：
   (A) `ViewState`＝入力（今の `cam`）、(B) `ProjectorFrame`＝CPU が f64 で作り f32 へ落とす境界の束
   （1 フレーム 1 回・原点ごと）、(C) `PROJECTOR` シェーダモジュール＝純関数チャンク（GLSL/WGSL 双子）。
   CPU 側の逆関数 `unproject` は (B) の `invMvp` から派生し、`project ∘ unproject = id` が Projector の検定になる。
5. 盗むのは「名前付きモジュール一枚・Layer→module の依存方向・getUniforms の 1 フレーム 1 回」。
   盗まないのは「projectionMode 分岐・coordinateSystem 4 種・fp64 エミュ・512px 世界・メルカトル非線形」（§4）。

## 1. deck.gl `project` の骨と ortho-core の対応

deck.gl の uniform block（`projectUniforms`, std140）を左に、ortho-core の対応物を右に。行番号は本日時点。

| deck.gl (`project.glsl.ts`) | 意味 | ortho-core の対応 | 所在 |
|---|---|---|---|
| `viewProjectionMatrix` | view×proj（offset mode では平行移動を殺した VP） | `u_mvp`（行0 符号反転＝東が右・楕円体 S 畳み込み済） | `camera.js:57-103` |
| `center` | `VP·[origin,1]`＝clip 空間の原点（CPU 先出し） | `u_clipT` | `glsl.js:70`, `programs.js:29` |
| `coordinateOrigin` / `commonOrigin` | 頂点の基準点（経緯度／common 空間） | `u_origin`（deg）／`u_originPt`（単位球 3D） | `glsl.js:47,71` |
| —（deck.gl に無い） | 原点の三角比（角度加算の錨） | `u_originTrig`＝(cosλ, sinλ, cosβ, sinβ) | `glsl.js:72` |
| —（deck.gl に無い） | dot(原点, eye)−1（手前半球判定の錨） | `u_origin_zr` | `programs.js:30` |
| `position64Low` | 絶対座標の fp64 下位（精度補填） | **不要**：頂点が原点相対（gint は uint＋`dlonE7`） | `programs.js:141-159` |
| `cameraPosition` | common 空間のカメラ | `u_eye`（β 単位球空間） | `glsl.js:46` |
| `viewportSize`, `devicePixelRatio` | device px | `u_viewport`, `dpr` | `glsl.js:48` |
| `focalDistance` | px→clip の換算 | `focal`＝(H/2)/tan(fovy/2) | `camera.js:101` |
| `scale` (=2^zoom, TILE_SIZE 512) | 世界の目盛り | `radPerDevPx`＝2π/(2^z·**256**·dpr) | `camera.js:9,72` |
| `commonUnitsPerMeter` | m→common | `u_elevScale`（誇張/地球半径）・`worldRadiusM()` | `programs.js:38`, `camera.js:20` |
| `wrapLongitude` (`mod(x+180,360)-180`, f32) | 経度周期 | `dlonE7`（uint で 360e7 周期・厳密） | `programs.js:141-146` |
| `projectionMode` (MERCATOR/GLOBE/IDENTITY) | 投影族の分岐 | **無し**：ortho↔透視の単一連続族（D→∞） | 裁定済（栞） |
| `coordinateSystem` (lnglat/meter-offsets/lnglat-offsets/cartesian) | 頂点の座標系 | `lnglat-offsets` 一本＋PLATEAU の重心相対 3D（`u_meshOrigin`/`u_clipMesh`） | `glsl.js:233-238` |
| `project_get_orientation_matrix(up)` | 球面での ENU 基底 | `liftDir` / `ellNormal3D` / `cameraState` の north・east | `glsl.js:99-103`, `camera.js:51` |
| `project_size_at_latitude` (1/cosφ) | メルカトルの非線形 | **不要**：z＝正射スケール（cosφ をカメラに戻さない裁定） | `camera.js:68-71` |
| `project_globe_`（絶対 λφ を f32 sin/cos、半径 256） | 球面化 | `deltaToRel`（原点相対・`sinP` テイラー・桁落ちなし） | `glsl.js:112-124` |
| `project_common_position_to_clipspace(p) = VP·p + center` | clip 化 | `u_clipT + u_mvp*vec4(rel,0)` | `programs.js:181` |
| `project_pixel_size_to_clipspace` | px→clip オフセット | `toScreen` の逆（線幅は px 空間で処理） | `glsl.js:128-131` |
| `modelMatrix` | レイヤー固有変換 | 無し（PLATEAU の meshOrigin が実質） | — |
| —（deck.gl に無い） | 楕円体 | S=diag(1,b/a,1) を mvp へ畳む＋`dBeta`（β 差分） | `camera.js:96-100`, `glsl.js:87-97` |
| —（deck.gl に無い） | 対数深度 | `applyLogDepth` / `logDepthZ` | `glsl.js:58-60`, `wgsl.js:109` |

**球のモデルの差（合わせない）**：deck.gl globe は半径 256・z-up（x=sinλcosφ, y=−cosλcosφ, z=sinφ）。
ortho-core は単位球・y-up（x=cosβcosλ, y=sinβ, z=cosβsinλ）・楕円体は mvp に畳む。これは内部空間の話で、
Projector の契約（入力＝原点相対 deg、出力＝clip）には現れない。

**v1 の `u_jac` はどこへ行ったか**：v1（`ortho-map/.../gintPrograms.js:18,55-66`）は高ズームで 2×2 ヤコビアン
（線形化）・低ズームでフル三角の 2 経路切替だった。v2 はこの切替を**捨てて**、`sinP`（|x|<0.1rad はテイラー
＝f32 で厳密同等・大角は native sin）と `deltaToRel` の一本にした。regime 境界は `sinP` の内側に沈み、式は
一本＝「不連続を出さない切替」の原則はそのまま、より鋭くなった。Projector 契約にヤコビアンは要らない。

## 2. ortho-core に既にある seam（4 写し＋CPU 側）

| 写し | 宣言 | 純関数 | clip の式 | CPU 側の詰め |
|---|---|---|---|---|
| GL 基図（fill/line/terrain/building/stencil/overlay） | `glsl.js:44-51,70-72,90-91` | `sinP cosP dBeta liftDir geoLat deltaToRel(vec2) toScreen applyLogDepth` | `u_clipT + u_mvp*vec4(relW,0)` (`glsl.js:874`) | `gl/renderer.js:745-778` `setCommonUniforms` |
| GL gint（線/塗り/点/pick） | `programs.js:13-41`（第 2 写し `:369-448`） | 同名だが `deltaToRel(float,float)`・`u_origin_trig`（snake） | `fetchProject` `programs.js:177-186` | `gl/gint/utility.js:9-36` `bindSharedUniforms`＋`drawdata.js:25-63` `computeDrawData` |
| WebGPU 基図 | `wgsl.js:18-46` `struct Frame`（92 f32・4 スロット） | `wgsl.js:63-104` | `FILL_WGSL:185` ほか | `gpu/renderer.js:945-982` `packFrame`（オフセット固定） |
| WebGPU gint | `gintwgsl.js:15-36` `struct GF` | `gintwgsl.js:126-164` | `fetchProject :157` | `gpu/gint.js:576-591` `packGF` |
| PLATEAU（両 backend） | `u_meshOrigin`/`u_clipMesh`・`struct PB` | 重心相対 3D delta | `u_clipMesh + u_mvp*vec4(delta,0)` | per-batch |

**CPU 側の唯一の源**＝`cameraState(cam, W, H)` → `{ mvp, invMvp, eye, W, H, dpr, camDist, focal }`
（`camera.js:57-103`）。原点系（`clipT`/`originPt`/`originTrig`/`originZr`）は各 packer が **f64 で再計算**
（`renderer.js:750-757`, `drawdata.js:34-41`, `packFrame`, `packGF`）＝同じ式が 4 回書かれている。

**逆関数**＝`unproject(state, sx, sy, R)`（`camera.js:142-167`）＝invMvp のレイ×β 球交差→`geodeticOf`。一つだけ。
消費者：tilecover・terrain・labels2d・input・gint の view bbox／識別（`gl/gint/identify.js:66-82`、worker/embed/
WebGPU の 3 写し）。**最後の d3 残滓**＝`geopbf/src/extension/identify.js:48` の `identify(self, mx, my, proj, …)`
が d3 流 `proj.invert`/`proj.scale()` を引数に取る。v1（`ortho-map/.../gint.js:183-204`）は `lastProj = geoOrthographic()`
と `lastViewBbox`（画面 8 点 invert→Morton bbox）で同じことをしている＝v2 の `drawdata.js:94-120` が建て替え。

**外への契約**＝`map.overlay(url)`（`app.js:2081-2103`）→ renderworker が毎フレーム
`mod.frame(cam, cameraState(cam, w, h), {w,h})`（`renderworker.js:31-42`）。消費者 `quakes-gl.js:52-74,247-291` は
`u_mvp/u_eye/u_focal` を手で詰め、絶対単位球座標を `u_mvp*vec4(a_pos,1)` で素朴に回し、`gl.frontFace(CW)` で
「mvp は x 反転」の知識を抱えている。RTE も楕円体も知らない＝球規模の点なので今は困らないが、契約としては生。

## 3. 叩き台：Projector 契約

### 3.1 `ViewState`（入力・既存の `cam` に名前を付けるだけ）

```
ViewState = { center:[lon,lat], zoom, pitch(rad), bearing(rad), fovy(rad), dpr }
```
`applyView`（URL⇄表示状態）の出口・`draw(cam)`・overlay `frame(cam,…)` の第 1 引数＝既に契約。変更なし。

### 3.2 `ProjectorFrame`（CPU が f64 で作り f32 へ落とす境界・1 フレーム 1 回・原点ごと）

```
ProjectorFrame = {
  // 視点（cameraState そのまま）
  mvp: mat4, invMvp: mat4, eye: vec3, W, H, dpr, camDist, focal,
  // 原点＝RTE の錨（origin は 1e-7° に量子化：drawdata.js:34-36 の流儀）
  origin: [lon, lat], originPt: vec3, originTrig: [cosλ, sinλ, cosβ, sinβ], clipT: vec4, originZr,
  // 楕円体（球＝ellTrig 全 0・ell 0）
  ellTrig: vec4, ell: 0|1,
  // 深度
  logCoef,
}
```
`projectorFrame(cam, W, H, origin)`＝純関数（`cameraState` の上に原点系を足しただけ）。4 つの packer は
これの**写し**になる（GL は `uniform*`、WGSL は `Frame`/`GF` のオフセット、gint の `u_ix_center`/`u_iy_center`
と `lodRank`/`vbb` は gint packer が `origin` から派生）。数値はビット同値＝スクショ門で回帰ゼロが確認できる。
deck.gl の `getUniformsFromViewport`（memoize＝1 フレーム 1 回）に相当。

### 3.3 `PROJECTOR` シェーダモジュール（純関数チャンク・GLSL/WGSL 双子）

封じる範囲＝**「原点相対 deg（＋高さ m）→ clip」だけ**。gint 整数→deg（Morton decode・`dlonE7`・`onSeam`）
は Projector の**手前**（deck.gl の coordinateSystem 相当を `lnglat-offsets` 固定にした形）。`horizonClamp`・
ドレープ・距離フェードは Projector の**後**（レイヤー側）。

```glsl
// PROJECTOR（GLSL 案）。uniform は ProjectorFrame と 1:1。
uniform mat4  u_mvp;   uniform vec3 u_eye;   uniform vec2 u_viewport;
uniform vec2  u_origin; uniform vec3 u_originPt; uniform vec4 u_originTrig;
uniform vec4  u_clipT;  uniform float u_originZr;
uniform vec4  u_ellTrig; uniform float u_ell;  uniform float u_logCoef;

float sinP(float x);  float cosP(float x);          // 既存（glsl.js:76-80）
float dBeta(float dp);  vec3 liftDir(vec2 ll, vec3 dir);  float geoLat(float b);   // 既存（:87-109）
vec3  deltaToRel(vec2 dDeg);                         // 既存（:112-124）＝核

// 入口 1：原点相対 deg ＋ 高さ(m→世界単位は呼び手が掛ける) → clip。FILL/LINE/BUILDING/STENCIL/OVERLAY が使う
vec4 projectDelta(vec2 dDeg, float h) {
	vec3 rel = deltaToRel(dDeg);
	vec3 relW = rel + h * liftDir(u_origin + dDeg, u_originPt + rel);
	return u_clipT + u_mvp * vec4(relW, 0.0);
}
// 入口 2：原点相対 3D ベクトル → clip（PLATEAU の重心相対 RTE。錨は呼び手が持つ）
vec4 projectRel(vec3 rel, vec4 clipAnchor) { return clipAnchor + u_mvp * vec4(rel, 0.0); }
// 入口 3：screen px ＋ zr（gint の fetchProject 契約＝下流は px 空間のまま）
vec3 projectScreen(vec2 dDeg) {
	vec3 rel = deltaToRel(dDeg);
	float zr = u_originZr + dot(rel, u_eye);
	vec4 c = u_clipT + u_mvp * vec4(rel, 0.0);
	if (c.w <= 0.0) return vec3(u_viewport * 0.5, -1.0);
	return vec3(toScreen(c), zr);
}
vec2 toScreen(vec4 c);  void applyLogDepth();       // 既存（:58-60, :128-131）
```
WGSL 双子は同名（`projectDelta`/`projectRel`/`projectScreen`）で `Frame`/`GF` を読む。deck.gl の
`project_position_to_clipspace` / `project_common_position_to_clipspace` に対応する入口が 3 つ、で足りる。

### 3.4 CPU 逆関数と整合性の定義

`unproject(frame, sx, sy, R)`＝既存のまま Projector の一部。契約＝
**`projectDelta(lonlat − origin, 0)` を toScreen した px に `unproject` を当てると lonlat に戻る（往復 0px）**。
2026-07 の d3diff が数値で示した性質（往復 0px・逆順 4×/レベル収束）を、Projector の検定として tests に持つ
（f32 忠実シミュ＝`dlonE7` の実測と同じ流儀）。gint が唯一の座標真実、GPU の順方向と CPU の逆方向が厳密逆＝
栞の「整合性」の定義そのもの。

### 3.5 外への契約（overlay モジュール・adapter）

`frame(cam, camState, size)` の第 2 引数を `ProjectorFrame` に**拡張**（今の `mvp/invMvp/eye/W/H/dpr/camDist/focal`
はそのまま残る＝足すだけ・後方互換）。加えて `PROJECTOR` チャンク文字列（GLSL/WGSL）を overlay の `init(canvas, opts)`
の `opts` で配れば、overlay 作者は `projectDelta` を呼ぶだけで RTE・楕円体・鏡像（`frontFace` の CW）を知らずに
済む＝deck.gl の「Layer は project モジュールを import するだけ」の写し。quakes-gl の移設が実証になる。
将来の adapter（v1 ortho-map の d3 `lastProj` 撤去・geopbf `identify()` の `proj.invert` 引数）も同じ口。

## 4. 盗む／盗まない

**盗む**
- 名前付きモジュール一枚＋uniform 束（文字列注入は既にやっている＝**名前と一枚化だけ**が足りない）
- 「VP×origin を CPU で先出し・delta だけ回す」＝既に `u_clipT`（deck.gl と同型＝答え合わせ）
- Layer→module の依存方向（overlay/adapter が Projector を import する。逆はない）
- `getUniforms(viewport)` の memoize＝`projectorFrame` を 1 フレーム 1 回・原点ごと

**盗まない（裁定済みの延長）**
- `projectionMode` 分岐：ortho↔透視は単一連続族。メルカトルは取り込みの問題（栞）
- `coordinateSystem` 4 種：`lnglat-offsets`（deg）＋重心相対 3D（PLATEAU）の 2 入口で足りる
- `position64Low`（fp64 エミュ）：原点相対＋uint gint＋`deltaToRel` が上流で解いている
- `TILE_SIZE=512`・`GLOBE_RADIUS=256`：`WORLD_PX=256`・単位球が正本
- `project_size_at_latitude`（1/cosφ）：z＝正射スケール
- z-up 左手：y-up 単位球のまま（楕円体は mvp に畳む＝deck.gl に無い強み）

## 5. 進めるなら（小さく・可逆・順番）

1. `camera.js` に `projectorFrame()` を足し、4 packer（`setCommonUniforms`／`bindSharedUniforms`＋`computeDrawData`／
   `packFrame`／`packGF`）をその写しにする。数値ビット同値＝スクショ門で回帰ゼロ。
2. `PROJECTOR` チャンクを `glsl.js` から切り出し、gint `programs.js` のヘッダがそれを取り込む
   （`deltaToRel` の二重定義解消・`vec2` 署名と `u_originTrig` 名へ統一）。WGSL も同様。
3. tests：`projectDelta ∘ unproject = id` 検定（f32 シミュ・d3diff の後継）。
4. overlay 契約へ `ProjectorFrame`＋`PROJECTOR` 文字列を配り、quakes-gl を移して実証。
5. （将来）adapter：v1 ortho-map の d3 `lastProj`→`projectorFrame`／geopbf `identify()` の `proj.invert`→`unproject`。

## 6. 裁定を仰ぐ点

- **名前**：Projector／`ProjectorFrame`／`PROJECTOR` チャンク（deck.gl は `project`）。
- **置き場**：`camera.js` 同居（camera＝視点、projector＝視点＋原点＋錨）か、新 `projector.js`（`index.js` から公開）か。
- **overlay 契約の拡張**：第 2 引数の拡張＋`opts` でチャンク配布＝足すだけ（既存 overlay は無改修）。
- **gint 側の署名統一（§5-2）は「危険な修正」として先に申告**：機械的置換だが GLSL/WGSL × 基図/gint の
  4 箇所・検定はスクショ門と `tests/t-gintgpu.html`。やらずに写し 4 つのまま `projectorFrame` だけ入れる（§5-1 止め）
  も選べる。
- **時期**：今やるか、#7（ortho-globe 建設）と束ねるか。globe の芯＝ortho-core 公開面の一部として Projector を
  出すのが自然なら、#7 の段階 1 の前に §5-1〜3 だけ済ませておく案。
