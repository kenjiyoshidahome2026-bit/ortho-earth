import { GeoPBF } from "./pbf-base.js";
import { gzip, gunzip, isGzip } from "native-bucket";

class PBFIO {
    constructor(dire) {
        this.dire = dire || "GIS";
    }

    /**
     * バケットとキャッシュ（IndexedDB）を初期化する
     */
    async open() {
        const { nativeBucket } = await import("native-bucket")
            .catch(e => { console.error("native-bucket load error", e); return {}; });
        const { Bucket, Cache, Fetch } = nativeBucket();
        this.bucket = await Bucket(`${this.dire}/pbf`);
        this.cache = await Cache(`${this.dire}/pbf`);
        this.nativeFetch = Fetch;
        return this;
    }
    async files() { return await this.bucket.list(); }

    /**
     * 同期処理（ブラウザ自動キャッシュ連動版）
     */
    async sync() {
        const localKeys = (await this.cache()) || [];
        if (localKeys.length === 0) return;
        console.log(` 🔄 Syncing ${localKeys.length} files...`);
        await Promise.all(localKeys.map(async (name) => {
            try {
                // 💡 手動ヘッダーは一切送らず、ブラウザの標準キャッシュ機能に任せる
                const res = await fetch(`${this.bucket.url}${name}`, {
                    cache: 'default'
                });

                if (res.ok) {
                    const ETag = res.headers.get("etag");
                    const Buff = await res.arrayBuffer();
                    await this.cache(name, { ETag, Buff });
                }
            } catch (e) { console.error(`Sync failed:`, e); }
        }));
        console.log(" ✅ Sync complete.");
    }
    async fetch(name, useCache = false) {
        if (useCache && this.fetchCache) { const v = await this.fetchCache(name); if (v) return v; }
        const [url, target] = name.split(/\#/);
        const file = target ? await this.nativeFetch(url, { target }) : await this.nativeFetch(url);
        if (this.fetchCache) await this.fetchCache(name, file);
        return file;
    }
    async load(name) {
        const val = await this.cache(name).catch(console.error);
        try {
            const res = await fetch(`${this.bucket.url}${name}`, { cache: 'default' });
            if (!res.ok) {
                if (val && val.Buff) {
                    console.warn(` ⚠️ Server Error (${res.status}). Using local cache.`);
                    return new GeoPBF().set(val.Buff);
                }
                throw new Error(`Failed to load: ${name} (HTTP ${res.status})`);
            }
            const ETag = res.headers.get("etag");
            let Buff = await res.arrayBuffer();

            if (val && val.ETag === ETag) {
                console.log(` 🟢 【304成功】サーバーデータに変更なし（キャッシュ利用）: ${name}`);
                return new GeoPBF({name}).set(val.Buff); // 保存してあったバイナリをそのまま使い、超高速で描画
            }
            let file = new File([Buff], name, { type: "application/x-geopbf" });
            (await isGzip(file)) && (file = await gunzip(file));
            Buff = await file.arrayBuffer();
            await this.cache(name, { ETag, Buff });
            return new GeoPBF().set(Buff);

        } catch (fetchError) {
            console.error(`[Fetch Error]`, fetchError);
            if (val && val.Buff) return new GeoPBF().set(val.Buff); // オフライン時の救済
            throw fetchError;
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
}

export async function pbfio(dire) { return new PBFIO(dire).open(); }