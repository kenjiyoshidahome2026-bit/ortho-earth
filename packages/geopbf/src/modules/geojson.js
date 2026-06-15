const CHAR_QUOTE = 34;       // "
const CHAR_BACKSLASH = 92;   // \
const CHAR_LBRACE = 123;     // {
const CHAR_RBRACE = 125;     // }
const CHAR_LBRACKET = 91;    // [

const FEAT_BYTES = [34, 102, 101, 97, 116, 117, 114, 101, 115, 34]; // "features"

// 注目バイトのルックアップテーブル。大半のバイトは 0（無視）で1比較で即抜けられる
const SCAN_TABLE = new Uint8Array(256);
SCAN_TABLE[CHAR_QUOTE] = 1;
SCAN_TABLE[CHAR_BACKSLASH] = 2;
SCAN_TABLE[CHAR_LBRACE] = 3;
SCAN_TABLE[CHAR_RBRACE] = 4;

export const geojson = (file, callback, syncFlag = false) => {
    const decoder = new TextDecoder();
    const chunkSize = 2 * 1024 * 1024; // 2MB (sync path)

    const chunks = [];

    let inFeatures = false;
    let featMatchIdx = 0;

    let braceCount = 0;
    let inString = false;
    let isEscaped = false;

    // scanPos: 残存チャンク群の先頭を 0 とするグローバル位置（prune のたびに再調整される）
    let scanPos = 0;
    let featureStartPos = -1;

    const pruneChunks = (uptoPos) => {
        while (chunks.length > 0 && uptoPos >= chunks[0].length) {
            const removedLen = chunks[0].length;
            uptoPos   -= removedLen;
            scanPos   -= removedLen;
            if (featureStartPos !== -1) featureStartPos -= removedLen;
            chunks.shift();
        }
    };

    // featureStartPos〜end の範囲を文字列化する
    const extractJsonString = (start, end) => {
        const c0 = chunks[0];
        // 高速パス: prune 後は最頻ケースとして chunks[0] 内に完全に収まる
        if (end <= c0.length) return decoder.decode(c0.subarray(start, end));
        // 複数チャンクをまたぐ場合: バッファを結合してデコード
        const res = new Uint8Array(end - start);
        let cBase = 0, resOff = 0;
        for (let i = 0; i < chunks.length; i++) {
            const c = chunks[i], cEnd = cBase + c.length;
            if (start < cEnd && end > cBase) {
                const cs = Math.max(0, start - cBase), ce = Math.min(c.length, end - cBase);
                res.set(c.subarray(cs, ce), resOff);
                resOff += ce - cs;
            }
            cBase = cEnd;
            if (cBase >= end) break;
        }
        return decoder.decode(res);
    };

    // scanPos を含むチャンクを特定する
    const findChunk = () => {
        let ci = 0, cBase = 0;
        while (ci < chunks.length && cBase + chunks[ci].length <= scanPos) {
            cBase += chunks[ci].length; ci++;
        }
        return [ci, cBase];
    };

    const processBinary = () => {
        let [ci, cBase] = findChunk();

        // Phase 1: "features" 直後の '[' を探す（1ファイル1回のみ）
        if (!inFeatures) {
            outer1: while (ci < chunks.length) {
                const chunk = chunks[ci];
                let lp = scanPos - cBase;
                while (lp < chunk.length) {
                    const b = chunk[lp++]; scanPos++;
                    if (featMatchIdx < FEAT_BYTES.length) {
                        if (b === FEAT_BYTES[featMatchIdx]) { featMatchIdx++; }
                        else { featMatchIdx = (b === FEAT_BYTES[0]) ? 1 : 0; }
                    } else if (b === CHAR_LBRACKET) {
                        inFeatures = true;
                        pruneChunks(scanPos); // ヘッダー部分をメモリから解放
                        [ci, cBase] = findChunk();
                        break outer1;
                    }
                }
                cBase += chunk.length; ci++;
            }
            if (!inFeatures) return;
        }

        // Phase 2: 波括弧の深さで Feature オブジェクトを切り出す
        // getByteAt 関数を介さずチャンクを直接参照することで呼び出しオーバーヘッドを排除
        while (ci < chunks.length) {
            const chunk = chunks[ci];
            let lp = scanPos - cBase;
            let doRestart = false;

            while (lp < chunk.length) {
                const b = chunk[lp++]; scanPos++;

                if (isEscaped) { isEscaped = false; continue; }

                const code = SCAN_TABLE[b];
                if (code === 0) continue;                        // 大半のバイト: 1比較で即抜ける
                if (code === 2) { isEscaped = true; continue; } // backslash
                if (code === 1) { inString = !inString; continue; } // quote
                if (inString) continue;

                if (code === 3) {                                // lbrace
                    if (braceCount++ === 0) featureStartPos = scanPos - 1;
                } else {                                         // rbrace
                    if (--braceCount === 0 && featureStartPos !== -1) {
                        try { callback(JSON.parse(extractJsonString(featureStartPos, scanPos))); }
                        catch (ex) { console.warn("Parse Error:", ex); }
                        pruneChunks(scanPos); // 抽出済み部分を即座に GC へ
                        featureStartPos = -1;
                        [ci, cBase] = findChunk(); // prune 後のチャンク位置を再確定
                        doRestart = true;
                        break;
                    }
                }
            }

            // doRestart のときはチャンクを advance せず、更新済みの ci/cBase で再開
            if (!doRestart) { cBase += chunk.length; ci++; }
        }
    };

    if (syncFlag) {
        let offset = 0;
        const reader = new FileReaderSync();
        while (offset < file.size) {
            chunks.push(new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, offset + chunkSize))));
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
                processBinary();
            }
            resolve();
        });
    }
};
