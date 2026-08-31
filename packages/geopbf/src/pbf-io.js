import { GeoPBF } from "./pbf-base.js";
import { gunzip } from "./modules/gzip.js";
import { decodeZIP } from "./modules/decodeZIP.js";
import { fname2mime } from "./modules/fname2mime.js";

// bucket provider が注入されない時の素の代役（npm 単体利用の既定）：
//  - Fetch＝直 fetch（proxy 無し）。zip#target は同梱 decodeZIP で展開＝URL/File/GeoJSON 変換と gint は全部動く
//  - Cache＝無効（毎回変換＝動くが再訪は速くならない）・Bucket 名前引き＝不可（明確なエラーで案内）
// フル機能（IDBキャッシュ・proxy fetch・バケツ名前引き）は createGeopbf(apiBase, { bucket: nativeBucket }) で注入する。
const plainProvider = () => ({
	Bucket: async () => ({ url: null, list: async () => [],
		put: () => { throw new Error("geopbf: bucket provider not injected — pass { bucket } to createGeopbf()"); },
		del: () => { throw new Error("geopbf: bucket provider not injected — pass { bucket } to createGeopbf()"); },
		etag: async () => null }),
	Cache: async () => (async () => null),   // 呼び出し3形（list/get/set）全てを null/no-op で受ける
	Fetch: async (url, { target, encoding } = {}) => {
		if (target) return decodeZIP(url, { target, encoding });
		const res = await fetch(url);
		if (!res.ok) throw new Error(`fetch failed: ${url} (HTTP ${res.status})`);
		const blob = await res.blob();
		const name = decodeURIComponent(url.split("/").pop().split("?")[0] || "download");
		return new File([blob], name, { type: fname2mime(name) });
	},
});

// ETag の表記ゆれ吸収：レスポンスヘッダ＝W/"16進"・?meta=1 の JSON＝素の16進。比較は正規形で
const normETag = s => String(s || "").replace(/^W\//, "").replace(/"/g, "");

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
        if (!this.bucket?.url) {   // plain provider＝バケツ名前引きは対象外（URL/File/GeoJSON 変換は index.js 側の経路で全て動く）
            console.error(`[geopbf] ${name}: bucket provider not injected — named bucket loads need createGeopbf(apiBase, { bucket })`);
            return null;
        }
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
        // gint:false の層（below_sea_land 等＝塗りだけ・GINT を焼かない）は PBF だけで即返す：
        // 従来は GINT 必須の条件からこぼれて毎回ネットワーク＝ブラウザ HTTP キャッシュの古い実体を
        // 掴み続け、焼き直しが何度リロードしても届かなかった（2026-09-01 実測の片翼）。
        if (val && val.PBF && (val.GINT || opts.gint === false)) {
            const cached = opts.gint === false ? await new GeoPBF().set(val.PBF).catch(() => null) : await fromCache(val);
            if (cached) {
                this.revalidate(name, val.ETag, opts).catch(() => {});
                return cached;
            }
            console.warn(`[geopbf] ${name}: キャッシュの GintBUF が読めない（旧フォーマット）→ 再焼き`);
        }
        try {
            // 取得も HTTP キャッシュの古い実体を掴まない：版を ?meta=1（キャッシュバスト）で照会し、
            // 本体は ?v=<ETag>（内容アドレス＝どの層にキャッシュされても常に正しい）で引く。
            // meta 不達は素の GET（縮退＝従来挙動・オフライン等）。revalidate と同じ理屈（CDN s-maxage=1h/ブラウザ max-age=4h 対策）。
            const meta = await fetch(`${this.bucket.url}${name}?meta=1&v=${Date.now()}`).then(r => r.ok ? r.json() : null).catch(() => null);
            const cur = normETag(meta?.data?.ETag);
            const res = await fetch(`${this.bucket.url}${name}${cur ? `?v=${encodeURIComponent(cur)}` : ""}`, { cache: 'default' });
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
    // ⚠素の GET は CDN(s-maxage=1h)+ブラウザ(max-age=4h) の HTTP キャッシュが「古い実体＋旧 ETag」を返すため、
    // 焼き直し後もここが「新版なし」に見えて永遠に更新されない（below_sea_land 再焼きが何度リロードしても
    // 届かない実測 2026-09-01）。版の照会は ?meta=1 をクエリでキャッシュバスト（応答は百数十B）し、
    // 版が違う時だけ本体を ?v=<ETag>（内容アドレス＝どの層にキャッシュされても常に正しい）で取得する。
    async revalidate(name, oldETag, opts = {}) {
        if (!this.bucket?.url) return;
        const meta = await fetch(`${this.bucket.url}${name}?meta=1&v=${Date.now()}`).then(r => r.ok ? r.json() : null).catch(() => null);
        const cur = meta?.data?.ETag;
        if (!cur || normETag(cur) === normETag(oldETag)) return;
        const res = await fetch(`${this.bucket.url}${name}?v=${encodeURIComponent(normETag(cur))}`, { cache: 'default' });
        if (!res.ok) return;
        const ETag = res.headers.get("etag");
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
    // options.bucket＝bucket provider ファクトリの注入口（例: native-bucket の nativeBucket）。
    // 形＝(apiBase, options) → { Bucket, Cache, Fetch }。未注入＝plainProvider（上記の素の縮退）。
    // これにより geopbf(npm/MIT) は私有インフラ（native-bucket）への依存ゼロで自己完結する（依存の向き反転 2026-08-21）。
    const provider = options.bucket || plainProvider;
    const nb = provider(apiBase, options);
    return (dire) => new PBFIO(nb, dire).open();
}
