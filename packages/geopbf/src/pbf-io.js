import { GeoPBF } from "./pbf-base.js";
class PBFIO {
    constructor(dire) { this.dire = dire || "GIS"; }
    async open() {
        const { nativeBucket } = await import("native-bucket")
            .catch(e => { console.error("native-bucket load error", e); return {}; });
        const { Bucket, Cache, Fetch } = nativeBucket();
        this.bucket = await Bucket(`${this.dire}/pbf`);
        this.cache = await Cache(`${this.dire}/pbf`);
        this.nativeFetch = Fetch; // インスタンスに保存
        this.fetchCache = await Cache(`${this.dire}/loaded`);
        return this;
    }
    async files() { return await this.bucket.list(); }
    async _sync(name, ETag) {
        const blob = await this.bucket.get(name);
        const Buff = await blob.arrayBuffer();
        await this.cache(name, { ETag, Buff });
        return Buff
    }
    async sync() {
        const localKeys = (await this.cache()) || [];
        for (const name of localKeys) {
            const ETag = await this.bucket.etag(name);
            if (ETag === false) break
            (ETag === null) ? await this.delete(name) : await this._sync(name, ETag);
        }
    }
    async fetch(name, useCache = true) {
        if (useCache && this.fetchCache) { const v = await this.fetchCache(name); if (v) return v; }
        const [url, target] = name.split(/\#/);
        const file = target ? await this.nativeFetch(url, { target }) : await this.nativeFetch(url);
        if (this.fetchCache) await this.fetchCache(name, file);
        return file;
    }
    async load(name) {
        const val = await this.cache(name);
        if (!val) return new GeoPBF().set(await this._sync(name)); 
        const ETag = await this.bucket.etag(name);
        if (ETag === val.ETag) return new GeoPBF().set(val.Buff);
        return new GeoPBF().set(await this._sync(name, ETag));
    }
    async save(pbf) {
        const name = pbf.name(); if (!name) return null;
        const file = new File([pbf.arrayBuffer], pbf._name, { type: "application/x-geopbf" });
        await this.bucket.put(file);
        const ETag = await this.bucket.etag(name);
        await this.cache(name, { ETag, Buff: pbf.arrayBuffer });
        return name;
    }
    async delete(name) {
        await this.bucket.del(name);
        await this.cache(name, null);
        return name;
    }
}
export async function pbfio(dire) { return new PBFIO(dire).open(); } 
