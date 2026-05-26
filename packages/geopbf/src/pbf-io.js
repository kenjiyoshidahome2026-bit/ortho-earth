import { GeoPBF } from "./pbf-base.js";
import { nativeBucket, gzip, gunzip, isGzip } from "native-bucket";
const { Bucket, Cache, Fetch } = nativeBucket();

class PBFIO {
    constructor(dire) { this.dire = dire || "GIS"; }
    async open() {
        this.bucket = await Bucket(`${this.dire}/pbf`);
        this.cache = await Cache(`${this.dire}/pbf`);
        return this;
    }
    async fetch(name) {
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
                    const Buff = await gunzip(await res.blob()).arrayBuffer();
                    await this.cache(name, { ETag, Buff });
                }
            } catch (e) { console.error(`Sync failed:`, e); }
        }));
        console.log(" ✅ Sync complete.");
    }
    async load(name) {
        const val = await this.cache(name, { worker: true }).catch(console.error);
        try {
            const res = await fetch(`${this.bucket.url}${name}`, { cache: 'default' });
            if (!res.ok) throw new Error(`Failed to fetch: ${name} (HTTP ${res.status})`);
            const ETag = res.headers.get("etag");
            if (val && val.ETag === ETag)  return new GeoPBF({name}).set(val.Buff);
            const blob = await gunzip(await res.blob());
            const Buff = await blob.arrayBuffer();
            await this.cache(name, { ETag, Buff });
            return new GeoPBF().set(Buff);
        } catch (e) {
            if (val && val.Buff) {
                console.warn(e);
                return new GeoPBF().set(val.Buff);
            }
            console.error(`[Fetch Error]`, e);
        }
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
    async clean(name) {
        await this.cache(name, null);
        return name;
    }
}
export async function pbfio(dire) { return new PBFIO(dire).open(); }