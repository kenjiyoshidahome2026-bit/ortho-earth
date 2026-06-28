import { GeoPBF } from "./pbf-base.js";
import { nativeBucket, gzip, gunzip, isGzip } from "native-bucket";

class PBFIO {
    constructor(nb, dire) { this.nb = nb; this.dire = dire || "GIS"; }
    async open() {
        const { Bucket, Cache } = this.nb;
        this.bucket = await Bucket(`${this.dire}/pbf`);
        this.cache = await Cache(`${this.dire}/pbf`);
        return this;
    }
    async fetch(name) {
        const { Fetch } = this.nb;
        const [url, target] = name.split(/\#/);
        return target ? await Fetch(url, { target }) : await Fetch(url);
    }
    async files() { return await this.bucket.list(); }
    async sync() {
        const localKeys = (await this.cache()) || []; if (localKeys.length === 0) return;
        await Promise.all(localKeys.map(async (name) => {
            try {
                const val = await this.cache(name); if (!val.etag) return;
                console.log(` 🔄 Syncing ${name} ...`);
                const res = await fetch(`${this.bucket.url}${name}`, { cache: 'default' });
                if (res.ok) {
                    const ETag = res.headers.get("etag"); if (ETag == val.ETag) return;
                    const PBF = await gunzip(await res.blob()).arrayBuffer();
                    await this.cache(name, { ETag, PBF });
                }
            } catch (e) { console.error(`Sync failed:`, e); }
        }));
        console.log(" ✅ Sync complete.");
    }
    async load(name, opts = {}) {
        const val = await this.cache(name).catch(console.error);
        try {
            const res = await fetch(`${this.bucket.url}${name}`, { cache: 'default' });
            if (!res.ok) throw new Error(`Failed to fetch: ${name} (HTTP ${res.status})`);
            const ETag = res.headers.get("etag");
            if (val && val.ETag === ETag && val.PBF && val.GINT) return await (await new GeoPBF().set(val.PBF)).setGintBUF(val.GINT);
            const blob = await gunzip(await res.blob());
            const pbf = await new GeoPBF().set(await blob.arrayBuffer());
            pbf._etag = ETag;
            await pbf.gint({ gint: opts.gint });
            await this.put(pbf);
            return pbf;
        } catch (e) {
            if (val && val.PBF && val.GINT) return await (await new GeoPBF().set(val.PBF)).setGintBUF(val.GINT);
            console.error(`[Fetch Error]`, e);
        }
    }
    async save(pbf) {
        const name = pbf.name(); if (!name) return null;
        const file = new File([pbf.arrayBuffer], pbf._name, { type: "application/x-geopbf" });
        await this.bucket.put(file);
        pbf._etag = await this.bucket.etag(name);
        await this.put(pbf);
        return name;
    }
    async put(pbf) {
        const name = pbf.name(); if (!name) return null;
        const val = { PBF: pbf.arrayBuffer };
        pbf._etag && (val.ETag = pbf._etag);
        pbf._gintBuffer && (val.GINT = new Uint8Array(pbf._gintBuffer).slice().buffer);
        await this.cache(name, val);
        return name;
    }
    async delete(name) {
        await this.bucket.del(name);
        await this.cache(name, null);
        return name;
    }
    async clean(name) {
        await this.cache(name, null);
        return name;
    }
}

export function createPbfio(apiBase, options = {}) {
    const nb = nativeBucket(apiBase, options);
    return (dire) => new PBFIO(nb, dire).open();
}
