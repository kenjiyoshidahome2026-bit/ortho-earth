export class gint {
    static TERMINAL_BIT = 1n << 63n;
    static WEIGHT_MASK = 0x3Fn;
    static SCALE_E = 1e7;
    static INV_SCALE_E = 1e-7;

    static pack([lng, lat]) {
        const ix = Math.round((lng + 180) * this.SCALE_E);
        const iy = Math.round((lat + 90) * this.SCALE_E);
        return this._pureMortonFromInt(ix, iy) | this.TERMINAL_BIT;
    }

    static packFromInt(ix, iy) {
        const xl = this._spread16(ix & 0xFFFF), xh = this._spread16((ix >>> 16) & 0xFFFF);
        const yl = this._spread16(iy & 0xFFFF), yh = this._spread16((iy >>> 16) & 0xFFFF);
        return ((BigInt((xh | (yh << 1)) >>> 0) << 32n) | BigInt((xl | (yl << 1)) >>> 0)) | this.TERMINAL_BIT;
    }

    static unpackToInt(m) {
        const isL1 = (m & this.TERMINAL_BIT) !== 0n;
        const morton = isL1 ? (m & ~this.TERMINAL_BIT) : (m & ~this.WEIGHT_MASK);
        const low32 = Number(morton & 0xFFFFFFFFn) >>> 0;
        const high32 = Number((morton >> 32n) & 0x7FFFFFFFn) >>> 0;
        const ix = ((this._compact16(high32) << 16) | this._compact16(low32)) >>> 0;
        const iy = ((this._compact16(high32 >>> 1) << 16) | this._compact16(low32 >>> 1)) >>> 0;
        return [ix, iy];
    }

    static intToVal([ix, iy]) {
        return [(ix * this.INV_SCALE_E) - 180, (iy * this.INV_SCALE_E) - 90].map(t => Number(t.toFixed(7)));
    }

    static unpack(m) {
        return this.intToVal(this.unpackToInt(m));
    }

    static toL2(L1, weight) {
        const [ix, iy] = this.unpackToInt(L1);
        const rx = Math.round(ix / 8) * 8;
        const ry = Math.round(iy / 8) * 8;
        return (this._pureMortonFromInt(rx, ry) & ~this.WEIGHT_MASK) | BigInt(weight & 0x3F);
    }

    static getWeight(m) {
        return (m & this.TERMINAL_BIT) !== 0n ? 63 : Number(m & this.WEIGHT_MASK);
    }

    static _pureMortonFromInt(ix, iy) {
        const xl = this._spread16(ix & 0xFFFF), xh = this._spread16((ix >>> 16) & 0xFFFF);
        const yl = this._spread16(iy & 0xFFFF), yh = this._spread16((iy >>> 16) & 0xFFFF);
        return (BigInt((xh | (yh << 1)) >>> 0) << 32n) | BigInt((xl | (yl << 1)) >>> 0);
    }

    static _spread16(x) {
        x = (x | (x << 8)) & 0x00FF00FF;
        x = (x | (x << 4)) & 0x0F0F0F0F;
        x = (x | (x << 2)) & 0x33333333;
        x = (x | (x << 1)) & 0x55555555;
        return x >>> 0;
    }

    static _compact16(m) {
        m &= 0x55555555;
        m = (m | (m >>> 1)) & 0x33333333;
        m = (m | (m >>> 2)) & 0x0F0F0F0F;
        m = (m | (m >>> 4)) & 0x00FF00FF;
        m = (m | (m >>> 8)) & 0x0000FFFF;
        return m & 0xFFFF;
    }
}