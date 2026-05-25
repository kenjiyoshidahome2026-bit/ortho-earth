import { gint } from "../extension/gint.js";
import { analyzeTopology } from "../extension/topology.js";

/**
 * GeoPBFインスタンスから、最強のトポロジー＆描画構造体「.gint」バイナリを生成する
 * @param {GeoPBF} pbf - 解析対象の一時的なコンテナ
 * @return {ArrayBuffer} 究極の1次元統合バイナリ
 */
export async function pbf2gint(pbf) {
    // 🛑 STAGE 1: 境界線のトポロジー解析（purify / simplify を内包）
    // あなたが手を焼き、完璧にハッシュ縫合したアークプールをここで一撃展開！
    const structures = pbf.structures || analyzeTopology(pbf);
    
    // 骨格となるトポロジーレイヤーの抽出
    const polyLayer = pbf.polygon;   // 面
    const lineLayer = pbf.polyline;  // 線
    const pointLayer = pbf.point;    // 点

    // 各要素のカウント
    const polygonCount = polyLayer ? polyLayer.count : 0;
    const lineCount = lineLayer ? lineLayer.count : 0;
    const pointCount = pointLayer ? pointLayer.count : 0;

    // --- 🚨 1次元ストリームへのフラットパッキング ---
    // 1. buffer (全アーク共通頂点 ＋ 独立ポイントの座標の海)
    const bufferBytes = (polyLayer ? polyLayer.buffer.byteLength : 0) + 
                        (lineLayer ? lineLayer.buffer.byteLength : 0) + 
                        (pointLayer ? pointLayer.buffer.byteLength : 0);
    const unifiedBuffer = new ArrayBuffer(bufferBytes);
    const unifiedBufferU8 = new Uint8Array(unifiedBuffer);

    let bufOffset = 0;
    if (polyLayer) {
        unifiedBufferU8.set(new Uint8Array(polyLayer.buffer.buffer, polyLayer.buffer.byteOffset, polyLayer.buffer.byteLength), bufOffset);
        bufOffset += polyLayer.buffer.byteLength;
    }
    const polyBufEnd = bufOffset; // ポリゴンアークの終端境界

    if (lineLayer) {
        unifiedBufferU8.set(new Uint8Array(lineLayer.buffer.buffer, lineLayer.buffer.byteOffset, lineLayer.buffer.byteLength), bufOffset);
        bufOffset += lineLayer.buffer.byteLength;
    }
    const lineBufEnd = bufOffset; // ラインアークの終端境界

    if (pointLayer) {
        unifiedBufferU8.set(new Uint8Array(pointLayer.buffer.buffer, pointLayer.buffer.byteOffset, pointLayer.buffer.byteLength), bufOffset);
    }

    // 2. indices (各アークの [offset, len] を司る直線ストリーム)
    // 所有者情報(owner)もここにマージし、Mesh/Mergeの超爆速解析の引き金にする！
    const arcMetaArray = [];
    const processIndices = (layer, bufStartShift) => {
        if (!layer) return;
        const { meta, mlen, owner } = layer;
        for (let i = 0; i < layer.count; i++) {
            const off = meta[i * mlen];      // 元アークのローカルオフセット
            const len = meta[i * mlen + 1];  // アークの頂点数
            const owners = owner[i] || [];   // あなたが作った、アークを共有するポリゴンIDリスト
            
            // フラットストリームへ格納
            arcMetaArray.push(
                (off * 8) + bufStartShift,   // 全体bufferにおける絶対バイトオフセット
                len,                         // 頂点数
                owners[0] !== undefined ? owners[0] : 0xFFFFFFFF, // 隣接所有者1 (左)
                owners[1] !== undefined ? owners[1] : 0xFFFFFFFF  // 隣接所有者2 (右) -> Mesh/Merge用！
            );
        }
    };
    processIndices(polyLayer, 0);
    processIndices(lineLayer, polyBufEnd);

    const indicesArray = new Uint32Array(arcMetaArray);

    // 3. meta (各フィーチャIDが「どのアーク」を繋ぎ合わせているかの接続トポロジー)
    const featureMetaArray = [];
    
    // ポリゴンの接続アークストリームのパッキング
    if (structures[2]) {
        structures[2].forEach(feat => {
            // feat.arcs は [ [arcId, arcId], [arcId] ] のようなリング構造
            const flatArcs = feat.arcs.flat();
            const offset = featureMetaArray.length + 4;
            
            // [ストリーム内オフセット, 参照アーク数, フィーチャID, タイプ(0:Polygon)]
            featureMetaArray.push(offset, flatArcs.length, feat.id, 0);
            flatArcs.forEach(arcId => featureMetaArray.push(arcId));
        });
    }

    // ラインの接続アークストリームのパッキング
    if (structures[1]) {
        structures[1].forEach(feat => {
            const flatArcs = [feat.arcs].flat();
            const offset = featureMetaArray.length + 4;
            // [ストリーム内オフセット, 参照アーク数, フィーチャID, タイプ(1:LineString)]
            featureMetaArray.push(offset, flatArcs.length, feat.id, 1);
            // ラインアークのインデックスはポリゴンの後ろに結合されるため、polygonCount分シフト
            flatArcs.forEach(arcId => {
                const id = arcId < 0 ? ~arcId : arcId;
                const shiftedId = id + polygonCount;
                featureMetaArray.push(arcId < 0 ? ~shiftedId : shiftedId);
            });
        });
    }

    // ポイントのパッキング (接続情報はないため、直接座標の海(buffer)の絶対位置をマーク)
    if (structures[0]) {
        structures[0].forEach(feat => {
            const globalPointOffset = (lineBufEnd / 8) + feat.id; // buffer内での絶対インデックス位置
            // [絶対位置オフセット, 1頂点, フィーチャID, タイプ(2:Point)]
            featureMetaArray.push(globalPointOffset, 1, feat.id, 2);
        });
    }

    const metaArray = new Uint32Array(featureMetaArray);

    // =================================================================
    // 🚀 STAGE 2: 究極の「単一 ArrayBuffer」への超高速パッキング
    // =================================================================
    const metaBytes = metaArray.byteLength;
    const indicesBytes = indicesArray.byteLength;

    // 24バイトの固定ヘッダー ＋ 3つの直線ストリームの総和
    const totalBytes = 24 + metaBytes + indicesBytes + bufferBytes;
    const outBuffer = new ArrayBuffer(totalBytes);

    // 24Bヘッダーの書き込み
    const headerView = new Uint32Array(outBuffer, 0, 6);
    headerView[0] = polygonCount;
    headerView[1] = lineCount;
    headerView[2] = pointCount;
    headerView[3] = metaBytes;
    headerView[4] = indicesBytes;
    headerView[5] = bufferBytes;

    // 生メモリの超光速横流しコピー（パース負荷完全ゼロ）
    new Uint8Array(outBuffer, 24, metaBytes).set(new Uint8Array(metaArray.buffer));
    new Uint8Array(outBuffer, 24 + metaBytes, indicesBytes).set(new Uint8Array(indicesArray.buffer));
    new Uint8Array(outBuffer, 24 + metaBytes + indicesBytes, bufferBytes).set(unifiedBufferU8);

    console.log(`[gint-encoder] 👑 壮大なる構想の鋳造完了。ポリゴン:${polygonCount}, ライン:${lineCount}, ポイント:${pointCount} を内包した最強の .gint 配列を生成しました。`);
    return outBuffer; 
}