import { GeoPBF } from "../pbf-base.js";
const getFeatures = (file, callback, isSync = false) => {
    const decoder = new TextDecoder();
    const chunkSize = 1024 * 1024;
    let buffer = "";
    let offset = 0;
    let inFeatures = false;
    let braceCount = 0;
    let startIdx = -1;

    const processChunk = (chunk) => {
        buffer += decoder.decode(chunk, { stream: true });
        if (!inFeatures) {
            const featIdx = buffer.indexOf('"features"');
            if (featIdx !== -1) {
                const startBracket = buffer.indexOf("[", featIdx);
                if (startBracket !== -1) {
                    inFeatures = true;
                    buffer = buffer.substring(startBracket + 1);
                }
            }
        }
        if (inFeatures) {
            for (let i = 0; i < buffer.length; i++) {
                const char = buffer[i];
                if (char === "{") {
                    if (braceCount === 0) startIdx = i;
                    braceCount++;
                } else if (char === "}") {
                    braceCount--;
                    if (braceCount === 0 && startIdx !== -1) {
                        const jsonStr = buffer.substring(startIdx, i + 1);
                        try {
                            const obj = JSON.parse(jsonStr);
                            if (obj.type === "Feature") callback(obj);
                        } catch (e) { }
                        startIdx = -1;
                        buffer = buffer.substring(i + 1);
                        i = -1;
                    }
                }
            }
        }
    };
    if (isSync) {
        const reader = new FileReaderSync();
        while (offset < file.size) {
            const chunk = new Uint8Array(reader.readAsArrayBuffer(file.slice(offset, offset + chunkSize)));
            processChunk(chunk);
            offset += chunkSize;
        }
    } else {
        return new Promise(async (resolve) => {
            const stream = file.stream().getReader();
            while (true) {
                const { done, value } = await stream.read();
                if (done) break;
                processChunk(value);
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
        await getFeatures(file, f => {
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
            getFeatures(file, f => pbf.setFeature(f), true);
        });
        pbf.close();
        const res = pbf.arrayBuffer;
        postMessage({ type: "jsondec", data: res }, [res]);
    }
};