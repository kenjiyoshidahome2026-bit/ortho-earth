import { gint } from "./gint.js";

export function topojson(unpackedGint, precisionRegulator = 1e7) {
    const { counts, meta, indices, buffer } = unpackedGint;

    // 1. 全アークの座標配列を相対デルタ化して抽出
    const topoArcs = [];
    const totalArcs = counts.polygonCount + counts.polylineCount;

    for (let i = 0; i < totalArcs * 4; i += 4) {
        const startIdx = indices[i + 0] / 8;
        const len = indices[i + 1];

        const arcDelta = [];
        let px = 0, py = 0;

        for (let k = 0; k < len; k++) {
            const [cx, cy] = gint.unpack(buffer[startIdx + k]);
            const rx = Math.round(cx * precisionRegulator);
            const ry = Math.round(cy * precisionRegulator);

            arcDelta.push([rx - px, ry - py]); // 🌟 TopoJSON特有の相対デルタ圧縮！
            px = rx; py = ry;
        }
        topoArcs.push(arcDelta);
    }

    // 2. metaストリームを解析して、各ジオメトリオブジェクトを復元
    const geometries = [];
    let i = 0;

    while (i < meta.length) {
        const offset = meta[i + 0];
        const arcLength = meta[i + 1];
        const featId = meta[i + 2];
        const type = meta[i + 3];

        const res = { type: "GeometryCollection", geometries: [], properties: { id: featId } };
        const refArcs = [];
        for (let a = 0; a < arcLength; a++) {
            refArcs.push(meta[offset + a]);
        }

        if (type === 0) { // Polygon
            // 単純化のため、平坦化されたアークを1つのリングとしてマッピング
            res.geometries.push({ type: "Polygon", arcs: [refArcs] });
        } else if (type === 1) { // LineString
            res.geometries.push({ type: "MultiLineString", arcs: [refArcs] });
        } else if (type === 2) { // Point
            // Pointの場合は offset 自体が buffer の絶対位置を指している
            res.geometries.push({ type: "Point", coordinates: gint.unpack(buffer[offset]) });
        }

        geometries.push(res);
        i += 4 + arcLength; // 次のフィーチャへジャンプ
    }

    return {
        type: "Topology",
        arcs: topoArcs,
        transform: { scale: [1 / precisionRegulator, 1 / precisionRegulator], translate: [0, 0] },
        objects: { collection: { type: "GeometryCollection", geometries } }
    };
}

/**
 * 条件に合致するポリゴン群を完全に融合させた MultiPolygon を生成する
 */
export function merge(unpackedGint, filterFunc = () => true) {
    const { counts, indices, buffer } = unpackedGint;

    const externalArcs = new Map(); // 外周アークを追跡 [arcId -> 方向フラグ]
    const nodes = new Map();        // リング縫合用のトポロジーノード

    // 1. 外周アークの抽出ステージ
    for (let i = 0; i < counts.polygonCount * 4; i += 4) {
        const arcId = i / 4;
        const byteOffset = indices[i + 0];
        const len = indices[i + 1];
        const leftId = indices[i + 2];
        const rightId = indices[i + 3];

        const keepLeft = leftId !== 0xFFFFFFFF && filterFunc(leftId);
        const keepRight = rightId !== 0xFFFFFFFF && filterFunc(rightId);

        // 🌟 異変（片方だけがフィルターに合致 ＝ そこが新しい「外周境界」！）
        if (keepLeft !== keepRight) {
            const startIdx = byteOffset / 8;
            const p = buffer[startIdx];
            const q = buffer[startIdx + len - 1];

            // 向きを補正してノードマップに登録（stitchRingsのロジックを直結）
            const isReversed = keepRight; // 右側が残る場合は逆向き

            // ノードの接続関係を構築
            const fromNode = isReversed ? q : p;
            const toNode = isReversed ? p : q;

            if (!nodes.has(fromNode)) nodes.set(fromNode, []);
            nodes.get(fromNode).push({ arcId, toNode, isReversed });
        }
    }

    // 2. リングの縫合（Stitch）ステージ
    const used = new Set();
    const polygons = [];

    for (const [startNode, edges] of nodes.entries()) {
        for (const edge of edges) {
            if (used.has(edge.arcId)) continue;

            let ringCoords = [];
            let currEdge = edge;

            while (currEdge && !used.has(currEdge.arcId)) {
                used.add(currEdge.arcId);

                // 座標の抽出と結合
                const idx = currEdge.arcId * 4;
                const startIdx = indices[idx + 0] / 8;
                const len = indices[idx + 1];

                let pts = [];
                for (let k = 0; k < len; k++) pts.push(gint.unpack(buffer[startIdx + k]));
                if (currEdge.isReversed) pts.reverse();

                ringCoords = ringCoords.concat(ringCoords.length === 0 ? pts : pts.slice(1));

                // 次のノードへ進む
                const nextEdges = nodes.get(currEdge.toNode) || [];
                currEdge = nextEdges.find(e => !used.has(e.arcId));
            }

            if (ringCoords.length >= 3) {
                polygons.push([ringCoords]); // 簡易的にすべて外周リングとして格納
            }
        }
    }

    return { type: "MultiPolygon", coordinates: polygons };
}

/**
 * .gintのインデックス構造から直接、条件に合う境界線を抽出する
 * @param {Object} unpackedGint - unpackGintAll() で復元されたオブジェクト
 * @param {Function} filterFunc - 各ポリゴンIDに対するフィルタ条件
 * @return {Object} MultiLineString 形式のジオメトリ
 */
export function mesh(unpackedGint, filterFunc = () => true) {
    const { counts, indices, buffer } = unpackedGint;
    const coordinates = [];

    // indices ストリーム（4要素ずつ）を全走査
    // [絶対バイトオフセット, 頂点数, 左所有者ID, 右所有者ID]
    const totalArcs = counts.polygonCount + counts.polylineCount;
    for (let i = 0; i < totalArcs * 4; i += 4) {
        const byteOffset = indices[i + 0];
        const len = indices[i + 1];
        const leftId = indices[i + 2];
        const rightId = indices[i + 3];

        // 🌟 隣接条件の判定（左右のポリゴンがフィルター条件を満たすか）
        const keepLeft = leftId !== 0xFFFFFFFF && filterFunc(leftId);
        const keepRight = rightId !== 0xFFFFFFFF && filterFunc(rightId);

        // 境界線（あるいは外周）を抽出する条件（例：片方だけが残る、または両方残るなど）
        // ここでは「指定された領域内の境界線」を引くため、両方のポリゴンがフィルターを通る場合を抽出
        if (keepLeft && keepRight) {
            const arcCoords = [];
            const startIdx = byteOffset / 8; // バイト位置を BigUint64 のインデックスに戻す

            for (let k = 0; k < len; k++) {
                arcCoords.push(gint.unpack(buffer[startIdx + k]));
            }
            coordinates.push(arcCoords);
        }
    }

    return { type: "MultiLineString", coordinates };
}

/**
 * 全ポリゴンの隣接関係マップを 1 パスで構築する
 * @param {Object} unpackedGint
 * @return {Array<Array<number>>} 各IDごとの隣接ID配列
 */
export function neighbors(unpackedGint) {
    const { counts, indices } = unpackedGint;
    const table = [];

    for (let i = 0; i < counts.polygonCount * 4; i += 4) {
        const leftId = indices[i + 2];
        const rightId = indices[i + 3];

        if (leftId !== 0xFFFFFFFF && rightId !== 0xFFFFFFFF) {
            (table[leftId] = table[leftId] || new Set()).add(rightId);
            (table[rightId] = table[rightId] || new Set()).add(leftId);
        }
    }

    // Set を通常の配列に変換して返却
    return table.map(set => set ? Array.from(set) : []);
}