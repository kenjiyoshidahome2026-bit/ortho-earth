import { gint } from "./gint.js";

export function topojson(self) {
    const { e, bbox, unPackGint } = self;
    const { counts, meta, indices, buffer } = unPackGint;
    const shift = i => (i < 0 ? ~((~i) + counts.polygonCount) : i + counts.polygonCount);
    const elem = (a, n) => {
        const properties = this.getProperties(n);
        const len = a.map(t => t.length);
        if (len[0] && !len[1] && !len[2]) return _point(a[0]);
        if (!len[0] && len[1] && !len[2]) return _polyline(a[1]);
        if (!len[0] && !len[1] && len[2]) return _polygon(a[2]);
        const type = PBF.geometryTypes[6], geometries = [];
        len[0] && geometries.push(_point(a[0]));
        len[1] && geometries.push(_polyline(a[1]));
        len[2] && geometries.push(_polygon(a[2]));
        return { type, geometries, properties };
        function _point(p) {
            const isM = p.length > 1, type = PBF.geometryTypes[isM ? 1 : 0];
            const trans = p => gint.unpack(buffer[p]).map(t => Math.round(t * e));
            return { type, coordinates: isM ? p.map(trans) : trans(p[0]), properties };
        }
        function _polyline(p) {
            const isM = p.length > 1, type = PBF.geometryTypes[isM ? 3 : 2];
            return { type, arcs: isM ? p.map(t => t.map(shift)) : p[0].map(shift), properties };
        }
        function _polygon(p) {
            const isM = p.length > 1, type = PBF.geometryTypes[isM ? 5 : 4];
            return { type, arcs: isM ? p : p[0], properties };
        }
    };
    const arcs = [];
    for (let i = 0; i < indices.length; i += 4) {
        const off = indices[i + 0] / 8, len = indices[i + 1], arc = new Array(len);
        let px = 0, py = 0;
        for (let j = 0; j < len; j++) {
            const [cx, cy] = gint.unpack(buffer[off + j]);
            arc[j] = [Math.round((cx - px) * e), Math.round((cy - py) * e)];
            px = cx; py = cy;
        }
        arcs.push(arc);
    }
    const geometries = [];
    for (let i = 0; i < meta.length; i += 4) {
        const off = meta[i + 0], len = meta[i + 1], id = meta[i + 2], type = meta[i + 3];
        const a = [[], [], []], ref = [];
        for (let j = 0; j < len; j++) ref.push(meta[off + j]);
        if (type === 0 || type === 4) a[0] = [off];
        else if (type === 1 || type === 2) a[1] = [ref];
        else if (type === 3 || type === 5) a[2] = [ref];
        geometries.push(elem(a, id));
    }
    logger.success("output topojson");
    return { type: "Topology", bbox: [...bbox], arcs,
        transform: { scale: [1 / e, 1 / e], translate: [0, 0] },
        objects: { collection: { type: "GeometryCollection", geometries } }
    };
}
/**
 * 条件に合致するポリゴン群を完全に融合させた MultiPolygon を生成する
 */
export function merge(self, filterFunc = () => true) {
    const { counts, indices, buffer } = self.unPackGint;
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
 * @param {Object} unPackGint - unPackGint() で復元されたオブジェクト
 * @param {Function} filterFunc - 各ポリゴンIDに対するフィルタ条件
 * @return {Object} MultiLineString 形式のジオメトリ
 */
export function mesh(self, filterFunc = () => true) {
    const { counts, indices, buffer } = self.unPackGint;
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
 * @param {Object} unPackGint
 * @return {Array<Array<number>>} 各IDごとの隣接ID配列
 */
export function neighbors(self) {
    const { counts, indices } = self.unPackGint;
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