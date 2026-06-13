import { GeoPBF } from "../pbf-base.js";
import { dissolve } from "../extension/dissolve.js";
import { geojson } from "../modules/geojson.js";
import { isObject } from "common";

// JSON.parse (V8ネイティブ) で一括処理できる上限。
// ボトルネックはパース速度ではなくメモリ: 100MB JSON → ヒープ約300-500MB。
const SMALL = 100 * 1024 * 1024;

// シングルパス収集のメモリ上限。これを超えると全パース済み地物を同時保持するとOOMリスク。
const LARGE = 500 * 1024 * 1024;

onmessage = async (e) => {
    const file = e.data.file;
    const pbf = new GeoPBF(e.data);

    if (file.size < SMALL) {
        // 小〜中規模: JSON.parse が最速（V8ネイティブ、単一C++呼び出し）
        await pbf.set(JSON.parse(await file.text()));

    } else if (file.size < LARGE) {
        // 中〜大規模: ストリーミング1パスで地物を蓄積し、ファイル読み取りを1回に削減
        // geojsonはchunkをpruneするためRAW JSONは保持しない（パース済みオブジェクトのみ）
        const features = [];
        await geojson(file, f => features.push(f), false);
        const [keys, bufs] = await GeoPBF.makeKeys(features.map(f => f.properties));
        pbf.setHead(keys, bufs);
        pbf.setBody(() => features.forEach(f => pbf.setFeature(f)));
        pbf.close();
        await pbf.getPosition();

    } else {
        // 超大規模: 全地物を同時保持するとOOMのため2パス（ファイル2回読み込み）を維持
        const keySet = new Set();
        const getPropertyKeys = f => {
            if (!isObject(f.properties)) return;
            for (const k in f.properties) {
                keySet.add(k);
                const v = f.properties[k]; if (!isObject(v)) continue;
                for (const sk in v) keySet.add(`${k}.${sk}`);
            }
        };
        await geojson(file, getPropertyKeys, false);
        pbf.setHead(Array.from(keySet).sort());
        pbf.setBody(() => geojson(file, f => pbf.setFeature(f), true));
        pbf.close();
        await pbf.getPosition();
    }

    console.time("dissolve");
    await dissolve(pbf);
    console.timeEnd("dissolve");
    console.log(pbf, pbf.arrayBuffer);
    const res = pbf.arrayBuffer;
    postMessage({ type: "jsondec", data: res }, [res]);
};
