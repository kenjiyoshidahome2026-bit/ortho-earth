////---------------------------------------------------------------------------------------------------------
//// ArrayBufferの圧縮・伸長
////---------------------------------------------------------------------------------------------------------
const pipe = async(q, filter) => new Response(new Blob([q]).stream().pipeThrough(filter)).arrayBuffer();
const enc = q => pipe(q, new CompressionStream("deflate-raw"));
const dec = q => pipe(q, new DecompressionStream("deflate-raw"));
const thenMap = (a, func) => Promise.all(a.map((v, i) => func(v, i).catch(console.error)));
////---------------------------------------------------------------------------------------------------------
//// bufferTub (ArrayBufferを効率的に、アレイ化)
////---------------------------------------------------------------------------------------------------------
export class bufferTub {
    constructor() { this.tub = []; }
    set(q) { if (q instanceof ArrayBuffer) return abset(this.tub, q); }
    async close() { const a = this.tub.sort((p, q) => p[1] - q[1]).map(t => t[0]); this.tub = [];
        return thenMap(a, enc);
    }
}
export class readBufs { 
    constructor() { this.tub = []; }
    set(q) { this.tub.push(q); }
    async close() { const tobuf = v => v.buffer ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v;
        const a = this.tub.map(tobuf); this.tub = [];
        return thenMap(a, dec);
    }
}
function abcomp(buf1, buf2) {
    if (buf1 === buf2) return 0;
    let d = buf2.byteLength - buf1.byteLength; if (d) return d;
    const v1 = new Uint8Array(buf1), v2 = new Uint8Array(buf2);
    for (let i = 0; i < v1.length; i++) {  d = v2[i] - v1[i]; if (d) return d;  }
    return 0;
}
function abset(a, buf) { const len = a.length;
    if (len === 0) { a[0] = [buf, 0]; return 0; }
    return (function cmp(m0, m1) {
        const mid = (m0 + m1) >>> 1;
        const v = abcomp(a[mid][0], buf);
        if (!v) return a[mid][1];
        if (m0 >= m1) {
            const idx = v > 0 ? mid + 1 : mid;
            a.splice(idx, 0, [buf, len]);
            return len;
        }
        return v > 0 ? cmp(mid + 1, m1) : cmp(m0, mid - 1);
    })(0, len - 1);
}