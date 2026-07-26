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
        // キャッシュの GINT（派生物）は ETag 一致でも信用しきらない：GintBUF のフォーマットが変わると
        // ETag（ソース PBF の版）は同じまま unpack が失敗する。失敗したら下の「取得→再焼き→put」へ
        // フォールスルー＝次回からは新フォーマットのキャッシュ（自己修復。旧版キャッシュで海岸線が全端末で消えた教訓）。
        const fromCache = async v => {
            const pbf = await (await new GeoPBF().set(v.PBF)).setGintBUF(v.GINT).catch(() => null);
            return pbf && pbf.unPackGint ? pbf : null;
        };
        // IDB ファースト：GintBUF まで揃っていれば即返す＝表示をネットワーク往復で待たせない
        //（激遅回線はタイムアウトまで海岸線が出ない、が旧構図）。ETag 確認は裏で回し、
        // 新版は IDB だけ更新＝次回起動から反映（stale-while-revalidate）。
        if (val && val.PBF && val.GINT) {
            const cached = await fromCache(val);
            if (cached) {
                this.revalidate(name, val.ETag, opts).catch(() => {});
                return cached;
            }
            console.warn(`[geopbf] ${name}: キャッシュの GintBUF が読めない（旧フォーマット）→ 再焼き`);
        }
        try {
            const res = await fetch(`${this.bucket.url}${name}`, { cache: 'default' });
            if (!res.ok) throw new Error(`Failed to fetch: ${name} (HTTP ${res.status})`);
            const blob = await gunzip(await res.blob());
            const pbf = await new GeoPBF().set(await blob.arrayBuffer());
            pbf._etag = res.headers.get("etag");
            await pbf.gint({ gint: opts.gint });
            await this.put(pbf);
            return pbf;
        } catch (e) {
            console.error(`[Fetch Error]`, e);
        }
    }
    // 裏の版確認：ETag が変わっていたら取得し直して IDB を更新（今の描画は触らない＝次回反映）。
    async revalidate(name, oldETag, opts = {}) {
        const res = await fetch(`${this.bucket.url}${name}`, { cache: 'default' });
        if (!res.ok) return;
        const ETag = res.headers.get("etag");
        if (ETag === oldETag) { res.body?.cancel?.().catch(() => {}); return; }
        const blob = await gunzip(await res.blob());
        const pbf = await new GeoPBF().set(await blob.arrayBuffer());
        pbf._etag = ETag;
        await pbf.gint({ gint: opts.gint });
        await this.put(pbf);
        console.log(`[geopbf] ${name}: 新版を検出 → IDB 更新（次回起動から反映）`);
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
