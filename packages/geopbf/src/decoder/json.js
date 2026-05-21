import { GeoPBF } from "../pbf-base.js";

// ASCIIコードの定数化
const CHAR_QUOTE = 34;    // "
const CHAR_SLASH = 92;    // \
const CHAR_LBRACE = 123;  // {
const CHAR_RBRACE = 125;  // }
const CHAR_LBRACKET = 91; // [

// "features" のASCIIバイト列: [ '"', 'f', 'e', 'a', 't', 'u', 'r', 'e', 's', '"' ]
const FEAT_BYTES = [34, 102, 101, 97, 116, 117, 114, 101, 115, 34];

const getFeaturesFast = (file, callback, isSync = false) => {
    const decoder = new TextDecoder();
    const chunkSize = 2 * 1024 * 1024; // 2MB
    
    const chunks = [];
    let totalBytes = 0;
    
    // ステート管理
    let inFeatures = false;
    let featMatchIdx = 0; // "features" 検索用マッチカウント
    
    let braceCount = 0;
    let inString = false;
    let isEscaped = false;
    
    let scanPos = 0;
    let featureStartPos = -1;

    // ★高速化：現在参照しているチャンク位置をキャッシュ（O(1)でバイトアクセスするため）
    let currentChunkIdx = 0;
    let currentChunkBase = 0;

    const getByteAt = (pos) => {
        // 基本的にポインタは前にしか進まないため、キャッシュ位置から走査を展開
        while (currentChunkIdx < chunks.length) {
            const c = chunks[currentChunkIdx];
            if (pos < currentChunkBase + c.length) {
                return c[pos - currentChunkBase];
            }
            currentChunkBase += c.length;
            currentChunkIdx++;
        }
        // 万が一ポインタが前に戻った場合のセーフティリセット
        currentChunkIdx = 0;
        currentChunkBase = 0;
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            if (pos < currentChunkBase + c.length) {
                currentChunkIdx = i;
                return c[pos - currentChunkBase];
            }
            currentChunkBase += c.length;
        }
        return -1;
    };

    const extractJsonString = (start, end) => {
        const length = end - start;
        let currentOffset = 0;

        // 1. 【高速化ルート】単一チャンク内に完全に収まっているかの判定
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            const cStart = currentOffset;
            const cEnd = currentOffset + c.length;

            // 要求範囲がこのチャンク内に完全に包含されている場合
            if (start >= cStart && end <= cEnd) {
                const localStart = start - cStart;
                const localEnd = end - cStart;
                // subarray はメモリを再確保せず元のバッファのビューを作るため、ゼロコピーで極めて高速
                return decoder.decode(c.subarray(localStart, localEnd));
            }

            currentOffset += c.length;
            // 探索中のオフセットが要求終端を超えたら、単一チャンク包含の可能性はないので抜ける
            if (currentOffset >= end) break;
        }

        // 2. 【安全ルート】複数のチャンクを跨いでいる場合のバッファ結合処理
        const res = new Uint8Array(length);
        currentOffset = 0;
        let resOffset = 0;

        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i];
            const cStart = currentOffset;
            const cEnd = currentOffset + c.length;

            if (start < cEnd && end > cStart) {
                const copyStart = Math.max(0, start - cStart);
                const copyEnd = Math.min(c.length, end - cStart);
                res.set(c.subarray(copyStart, copyEnd), resOffset);
                resOffset += (copyEnd - copyStart);
            }
            currentOffset += c.length;
            if (resOffset >= length) break;
        }

        return decoder.decode(res);
    };

    const pruneChunks = (uptoPos) => {
        while (chunks.length > 0 && uptoPos >= chunks[0].length) {
            const removedLen = chunks[0].length;
            uptoPos -= removedLen;
            scanPos -= removedLen;
            if (featureStartPos !== -1) featureStartPos -= removedLen;
            totalBytes -= removedLen;
            
            // キャッシュ位置のズレも追従させる
            currentChunkBase -= removedLen;
            if (currentChunkIdx > 0) currentChunkIdx--;
            
            chunks.shift(); // 処理済みバッファを完全破棄
        }
    };

    const processBinary = () => {
        // 1. 100%バイナリセーフな "features": [ の検索
        if (!inFeatures) {
            while (scanPos < totalBytes) {
                const b = getByteAt(scanPos);
                
                // '"features"' というバイト列との合致を確認
                if (featMatchIdx < FEAT_BYTES.length) {
                    if (b === FEAT_BYTES[featMatchIdx]) {
                        featMatchIdx++;
                    } else {
                        // 不一致ならリセット（現在のバイトが先頭文字なら1から再開）
                        featMatchIdx = (b === FEAT_BYTES[0]) ? 1 : 0;
                    }
                } 
                // "features" を見つけた後、開始の '[' を探す
                else {
                    if (b === CHAR_LBRACKET) {
                        inFeatures = true;
                        scanPos++; // '[' の直後へポインタを移動
                        pruneChunks(scanPos); // ヘッダー部分をメモリから解放
                        break;
                    }
                }
                scanPos++;
            }
            if (!inFeatures) return; // まだ見つからなければ次のチャンクを待つ
        }

        // 2. 高速バイナリスキャン（マルチバイト完全無視）
        while (scanPos < totalBytes) {
            const b = getByteAt(scanPos);

            if (isEscaped) {
                isEscaped = false;
                scanPos++;
                continue;
            }
            if (b === CHAR_SLASH) {
                isEscaped = true;
                scanPos++;
                continue;
            }

            if (b === CHAR_QUOTE) {
                inString = !inString;
                scanPos++;
                continue;
            }

            if (!inString) {
                if (b === CHAR_LBRACE) {
                    if (braceCount === 0) featureStartPos = scanPos;
                    braceCount++;
                } else if (b === CHAR_RBRACE) {
                    braceCount--;

                    // 1つのFeatureオブジェクトの終わりを検知
                    if (braceCount === 0 && featureStartPos !== -1) {
                        const jsonStr = extractJsonString(featureStartPos, scanPos + 1);
                        try {
                            callback(JSON.parse(jsonStr));
                        } catch (e) {
                            console.warn("Parse Error:", e);
                        }
                        
                        scanPos++;
                        pruneChunks(scanPos); // 抽出完了した部分まで即座にGCへ回す
                        featureStartPos = -1;
                        continue;
                    }
                }
            }
            scanPos++;
        }
    };

    if (isSync) {
        let offset = 0;
        const reader = new FileReaderSync();
        while (offset < file.size) {
            const chunk = new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, offset + chunkSize)));
            chunks.push(chunk);
            totalBytes += chunk.length;
            processBinary();
            offset += chunkSize;
        }
    } else {
        return new Promise(async (resolve) => {
            const stream = file.stream().getReader();
            while (true) {
                const { done, value } = await stream.read();
                if (done) break;
                chunks.push(value);
                totalBytes += value.length;
                processBinary();
            }
            resolve();
        });
    }
};
onmessage = async (e) => {
    const { file, precision } = e.data;
    const threshold = 50 * 1024 * 1024;
    if (file.size < threshold) {
        const json = JSON.parse(await file.text());
        const pbf = new GeoPBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision });
        await pbf.set(json);
        const res = pbf.arrayBuffer;
        postMessage({ type: "jsondec", data: res }, [res]);
    } else {
        const keySet = new Set();
        await getFeaturesFast(file, f => {
            if (f.properties) {
                for (const k in f.properties) {
                    keySet.add(k);
                    const v = f.properties[k];
                    if (v && typeof v === 'object' && !Array.isArray(v)) {
                        for (const sk in v) keySet.add(`${k}.${sk}`);
                    }
                }
            }
        }, false);
        const pbf = new GeoPBF({ name: file.name.replace(/\.[^\.]+$/, ""), precision });
        pbf.setHead(Array.from(keySet).sort());
        pbf.setBody(() => {
            getFeaturesFast(file, f => pbf.setFeature(f), true);
        });
        pbf.close();
        const res = pbf.arrayBuffer;
        postMessage({ type: "jsondec", data: res }, [res]);
    }
};