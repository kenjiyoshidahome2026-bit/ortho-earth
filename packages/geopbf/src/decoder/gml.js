import { GeoPBF } from "../pbf-base.js";
import { dissolve } from "../extension/dissolve.js";
import { decodeZIP } from "native-bucket";

function* getTags(src, tag) {
    const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let match;
    while ((match = regex.exec(src)) !== null) yield match[1];
}

// 🌟 srsName 属性から軸順を判定する
// CRS84 系 → 経度・緯度順（反転不要）
// EPSG:4326 系 → 緯度・経度順（反転が必要）
function needsAxisFlip(srsName) {
    if (!srsName) return true; // 未指定はEPSG:4326慣例として反転
    const s = srsName.trim();
    if (s.match(/CRS:?84/i) || s.match(/OGC.*CRS84/i)) return false;// CRS84 / OGC84 系は lng,lat 順なので反転不要
    if (s.match(/EPSG/i) && s.match(/4326/)) return true;// EPSG:4326 および URN形式の 4326 は lat,lng 順なので反転が必要
    return false;// その他（例：投影座標系）は反転しない
}

// 🌟 gml:posList / gml:pos のテキストを [lng, lat] の座標配列に変換する
function parsePosList(text, flip) {
    const nums = text.trim().split(/[\s\n\r]+/).map(Number);
    const pts = [];
    for (let i = 0; i < nums.length - 1; i += 2) {
        pts.push(flip ? [nums[i + 1], nums[i]] : [nums[i], nums[i + 1]]);
    }
    return pts;
}

// 🌟 ジオメトリブロック全体から座標を再帰的に収集する
// MultiSurface / MultiCurve の複数パッチにも対応
function extractAllPosLists(gmlBlock, flip) {
    const results = [];
    const posListRegex = /<gml:posList[^>]*>([\s\S]+?)<\/gml:posList>/gi;
    let m;
    while ((m = posListRegex.exec(gmlBlock)) !== null) {
        const pts = parsePosList(m[1], flip);
        if (pts.length > 0) results.push(pts);
    }
    return results;
}

onmessage = async (e) => {
    const { file, precision } = e.data;
    let gmlStr = "";
    if (file.name.match(/\.zip$/i)) {
        const entries = await decodeZIP(file);
        const gmlFile = entries.find(f => f.name.match(/\.gml$/i));
        if (!gmlFile) return;
        gmlStr = await gmlFile.text();
    } else {
        gmlStr = await file.text();
    }

    // 🌟 ファイル全体の srsName を取得して軸順を決定する
    // featureMember やルート要素の srsName を優先して探す
    const srsMatch = /srsName=["']([^"']+)["']/.exec(gmlStr);
    const flip = needsAxisFlip(srsMatch ? srsMatch[1] : null);

    const geometryCache = new Map();
    const keySet = new Set(); // 🌟 "bbox" の初期混入を削除

    const featureTagMatch = /<([^:>\s]+:[^:>\s]+)\s+gml:id="/.exec(gmlStr);
    const featureTag = featureTagMatch ? featureTagMatch[1] : null;

    // ジオメトリの事前キャッシュ（参照IDで引けるように）
    const geoRegex = /<(gml:(?:Surface|Curve|Point|MultiCurve|MultiSurface))\s+gml:id="([^"]+)"([\s\S]+?)<\/\1>/gi;
    let gMatch;
    while ((gMatch = geoRegex.exec(gmlStr)) !== null) {
        const id = gMatch[2];
        const block = gMatch[3];
        // gml:pos（Point）
        const posMatch = /<gml:pos[^>]*>([\s\S]+?)<\/gml:pos>/i.exec(block);
        if (posMatch) {
            const nums = posMatch[1].trim().split(/[\s\n\r]+/).map(Number);
            // Point は単一座標
            geometryCache.set(id, {
                type: "Point",
                coordinates: flip ? [nums[1], nums[0]] : [nums[0], nums[1]]
            });
            continue;
        }

        // gml:posList が1つ以上ある場合（LineString / Polygon / Multi系）
        const posLists = extractAllPosLists(block, flip);
        if (posLists.length === 1) {
            // 単一リング → Polygon か LineString として判定
            const isClosed = gMatch[1].match(/Surface/i);
            geometryCache.set(id, {
                type: isClosed ? "Polygon" : "LineString",
                coordinates: isClosed ? [posLists[0]] : posLists[0]
            });
        } else if (posLists.length > 1) {
            // 複数リング → MultiPolygon か MultiLineString
            const isClosed = gMatch[1].match(/Surface/i);
            geometryCache.set(id, {
                type: isClosed ? "MultiPolygon" : "MultiLineString",
                coordinates: isClosed ? posLists.map(r => [r]) : posLists
            });
        }
    }
    // プロパティキーの収集
    if (featureTag) {
        for (const pm of getTags(gmlStr, featureTag)) {
            const attrRegex = /<([^:>\s]+:[^:>\s]+)>([^<]+)<\/\1>/gi;
            let aMatch;
            while ((aMatch = attrRegex.exec(pm)) !== null) {
                if (!aMatch[1].match(/(pos|geometry|location|bound)/i)) {
                    keySet.add(aMatch[1].replace(/:/g, '_'));
                }
            }
        }
    }
    const pbf = new GeoPBF({
        name: file.name.replace(/\.[^\.]+$/, ""),
        precision: precision || 7
    });
    pbf.setHead(Array.from(keySet).sort());

    pbf.setBody(() => {
        if (!featureTag) return;
        for (const pm of getTags(gmlStr, featureTag)) {
            const props = {};
            const attrRegex = /<([^:>\s]+:[^:>\s]+)>([^<]+)<\/\1>/gi;
            let aMatch;
            while ((aMatch = attrRegex.exec(pm)) !== null) {
                const key = aMatch[1].replace(/:/g, '_');
                if (keySet.has(key)) props[key] = aMatch[2].trim();
            }
            // xlink:href でジオメトリを参照
            const ref = /xlink:href=["']#([^"']+)["']/.exec(pm);
            if (ref) {
                const geom = geometryCache.get(ref[1]);
                if (geom) {
                    pbf.setFeature({ type: "Feature", geometry: geom, properties: props });
                }
            }
        }
    });

    pbf.close();
    await dissolve(pbf);
    const res = pbf.arrayBuffer;
    postMessage({ type: "gmldec", data: res }, [res]);
};
