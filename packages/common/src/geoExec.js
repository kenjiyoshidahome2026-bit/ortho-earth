/**
 * geoExec — GIS データロード + プレビュー生成の共通パイプライン
 *
 * @param {object} info  - { target, name, precision, license, description, attribution, link, nocache, format }
 * @param {object} opts
 * @param {Function}      opts.geopbf     - geopbf() 関数（DI で渡す）
 * @param {screenLogger}  [opts.logger]   - screenLogger インスタンス（省略可）
 * @param {Function}      [opts.cache]    - IDB キャッシュ関数 (key, value?) → value（省略可）
 * @param {Function}      [opts.onSuccess]- callback(pbf, { previewCanvas, profileHtml, logger })
 * @param {Function}      [opts.onError]  - callback(err, { logger, info })
 */
export async function geoExec(info, { geopbf, logger, cache = null, onSuccess, onError } = {}) {
    const def = { target:"", name:"", precision:6, license:"", description:"", attribution:"", link:"", nocache:false, format:"" };
    const { target, name, precision, license, description, attribution, link, nocache, format } =
        Object.assign({}, def, info);

    try {
        logger?.clear().show();
        let inExec = true;

        let p = logger?.title(name, description);
        if (p && link) p.style("cursor","pointer").on("click", () => open(link, "_link_"));

        const cacheKey = typeof target === 'string' ? target
            : (target instanceof File
                ? `FILE::${target.name}::${target.size}::${target.lastModified}`
                : null);
        const cached = cacheKey && !nocache && cache && await cache(cacheKey).catch(() => null);

        p = logger?.log(`Requesting: ${target.name || target} <span class="cancel">cancel</span>`);
        const cancel = p?.select?.("span").hide().on("click", () => location.reload());
        setTimeout(() => inExec && cancel?.show?.(), 1000);

        const pbf = await geopbf(target, { name, precision, license, description, attribution, nocache, format });

        inExec = false;
        cancel?.hide?.();

        if (!pbf?.length) {
            logger?.error("Failed to load data.");
            await onError?.(new Error("Empty data"), { logger, info });
            return;
        }

        logger?.success(`${name} (length: ${pbf.size})`);

        let previewCanvas = null, profileHtml = null;

        if (cached?.PREVIEW && cached?.PROFILE) {
            // キャッシュヒット
            profileHtml = cached.PROFILE;
            const bitmap = await createImageBitmap(cached.PREVIEW);
            previewCanvas = document.createElement("canvas");
            previewCanvas.width  = bitmap.width;
            previewCanvas.height = bitmap.height;
            previewCanvas.style.width  = (bitmap.width  / 2) + "px";
            previewCanvas.style.height = (bitmap.height / 2) + "px";
            previewCanvas.getContext("2d").drawImage(bitmap, 0, 0);
            trimCanvas(previewCanvas);
        } else {
            // プレビュー + プロファイル生成
            previewCanvas = document.createElement("canvas");
            const [bitmap, html] = await Promise.all([
                pbf.preview(previewCanvas, { size:256, stroke:"#fff", fill:"#222", minDist:0.5, dpr:2 }),
                pbf.profile({ nohead: true }),
            ]);
            profileHtml = html;

            // キャッシュ保存（非同期、エラーは無視）
            if (cacheKey && cache && bitmap instanceof ImageBitmap) {
                const oc = new OffscreenCanvas(previewCanvas.width, previewCanvas.height);
                oc.getContext("2d").drawImage(previewCanvas, 0, 0);
                oc.convertToBlob({ type:'image/png', quality:0.9 }).then(blob =>
                    cache(cacheKey, { PREVIEW: blob, PROFILE: profileHtml }).catch(console.error)
                );
            }
            trimCanvas(previewCanvas);
        }

        // logger があれば canvas + profile を表示
        if (logger) {
            const p = logger.empty();
            p.node().appendChild(previewCanvas);
            logger.log(profileHtml);
        }

        await onSuccess?.(pbf, { previewCanvas, profileHtml, logger });

    } catch (err) {
        logger?.error(`Failed to load ${target?.name || target}: ${err.message}`);
        await onError?.(err, { logger, info });
    }
}

export function trimCanvas(canvas) {
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    const px = ctx.getImageData(0, 0, w, h).data;
    const row = y => { for (let x = 0; x < w; x++) if (px[(y*w+x)*4+3]) return true; };
    let t = 0, b = h - 1;
    while (t < h && !row(t)) t++;
    if (t >= h) return;
    while (b > t && !row(b)) b--;
    if (t === 0 && b === h - 1) return;
    const dpr = w / parseFloat(canvas.style.width);
    const trimH = b - t + 1;
    const img = ctx.getImageData(0, t, w, trimH);
    canvas.height = trimH;
    ctx.putImageData(img, 0, 0);
    canvas.style.height = (trimH / dpr) + "px";
}
