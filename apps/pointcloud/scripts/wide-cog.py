# 静岡の 2021/LP の Ortho（0.2 m）と Grid（0.5 m DTM）を、元の座標系（JGD2011 平面直角 VIII 系＝EPSG:6676）のまま COG にする（2026-11-24・共通化 段 1）。
#   COPC と同じ流儀で配る：ヘッダと IFD を読めば、要るタイル・overview だけを HTTP Range で取れる（エンジン：map.raster.add({cog})・map.setTerrain({source:{type:"cog"}})）。
#   pmtiles（wide-tiles.py）は Mercator に焼き直した表示用（オルソ約 0.5 m・標高は地理院 PNG の 1 cm 刻み）。こちらは元の解像度・float の標高のまま＝正本。
#   WORK=<作業の置き場> BLOCKS=ND77,ND87 J=8 python3 wide-cog.py
#   出力：$WORK/shizuoka-2021-ortho-<blocks>.cog.tif（RGB・WebP 85・512 タイル）・$WORK/shizuoka-2021-dem-<blocks>.cog.tif（float32・deflate＋predictor 3・nodata −9999）
#   要るもの：rasterio（GDAL 3.6 以上の wheel＝COG ドライバと WebP 入り）・numpy。図郭の一覧は県の目録 CSV（key,bytes）
import csv, io, os, sys, time, zipfile, urllib.request, concurrent.futures as cf
import numpy as np, rasterio
from rasterio.transform import Affine
from rasterio.shutil import copy as rcopy

S3 = "https://virtual-shizuoka.s3.ap-northeast-1.amazonaws.com/"
WORK = os.environ.get("WORK", "work")
BLOCKS = os.environ.get("BLOCKS", "ND77,ND87").split(",")
LIST = os.environ.get("LIST", "virtual-shizuoka-all-files.csv")
J = int(os.environ.get("J", "8"))
NODATA = -9999.0
os.makedirs(f"{WORK}/ortho", exist_ok=True); os.makedirs(f"{WORK}/dem", exist_ok=True)

def get(url):
    for i in range(6):
        try:
            with urllib.request.urlopen(url, timeout=120) as r: return r.read()
        except Exception:
            if i == 5: raise
            time.sleep(2 * (i + 1))

keys = {}
for r in csv.DictReader(open(LIST)):
    k = r["key"]
    for b in BLOCKS:
        for kind in ("Ortho", "Grid"):
            if k.startswith(f"2021/LP/{kind}/08/{b[:2]}/{b[2:]}/"): keys.setdefault(k.rsplit("/", 1)[1][:8], {})[kind] = k
sheets = sorted(s for s, v in keys.items() if len(v) == 2)
print(f"{len(sheets)} 図郭（{','.join(BLOCKS)}）", flush=True)

def ortho(s):
    out = f"{WORK}/ortho/{s}.tif"
    if os.path.exists(out): return
    z = zipfile.ZipFile(io.BytesIO(get(S3 + keys[s]["Ortho"])))
    tif = [n for n in z.namelist() if n.lower().endswith(".tif")][0]; tfw = [n for n in z.namelist() if n.lower().endswith(".tfw")][0]
    t = [float(v) for v in z.read(tfw).split()]
    with rasterio.MemoryFile(z.read(tif)) as mf, mf.open() as src:
        a = src.read()
    tr = Affine(t[0], 0, t[4] - t[0] / 2, 0, t[3], t[5] - t[3] / 2)   # tfw は左上の画素の中心＝角へ半画素
    with rasterio.open(out + ".tmp", "w", driver="GTiff", width=a.shape[2], height=a.shape[1], count=3, dtype="uint8", crs="EPSG:6676", transform=tr, tiled=True, compress="deflate") as d:
        d.write(a[:3])
    os.replace(out + ".tmp", out)

def dem(s):
    out = f"{WORK}/dem/{s}.tif"
    if os.path.exists(out): return
    z = zipfile.ZipFile(io.BytesIO(get(S3 + keys[s]["Grid"])))
    rows = [l.replace(",", " ").split() for l in z.read(z.namelist()[0]).decode("ascii", "replace").splitlines() if l.strip()]
    a = np.array([[float(v) for v in (r[1:4] if len(r) >= 5 else r[:3])] for r in rows])   # 「番号,X,Y,標高,印」か「X Y 標高」
    x, y, h = a[:, 0], a[:, 1], a[:, 2]
    # 図郭の枠＝400×300 m（格子点は 0.5 m の画素の中心）。縁の欠けは nodata
    x0 = np.floor((x.min() - 0.25) / 100) * 100; y1 = np.ceil((y.max() + 0.25) / 100) * 100   # 図郭の角は 100 m の倍数（縁の点が欠けても戻る）
    W, H = 800, 600
    g = np.full((H, W), NODATA, np.float32)
    i = np.round((x - x0) / 0.5 - 0.5).astype(int); j = np.round((y1 - y) / 0.5 - 0.5).astype(int)
    ok = (i >= 0) & (i < W) & (j >= 0) & (j < H) & (h > -9000)
    g[j[ok], i[ok]] = h[ok]
    with rasterio.open(out + ".tmp", "w", driver="GTiff", width=W, height=H, count=1, dtype="float32", crs="EPSG:6676", transform=Affine(0.5, 0, x0, 0, -0.5, y1), nodata=NODATA, tiled=True, compress="deflate", predictor=3) as d:
        d.write(g, 1)
    os.replace(out + ".tmp", out)

def run(fn, name):
    t0 = time.time(); n = 0
    with cf.ThreadPoolExecutor(J) as ex:
        for f in cf.as_completed([ex.submit(fn, s) for s in sheets]):
            f.result(); n += 1
            if n % 20 == 0: print(f"  {name} {n}/{len(sheets)} {time.time() - t0:.0f}s", flush=True)

# 図郭の GeoTIFF を並べた VRT（同じ画素の大きさ・軸平行）→ COG ドライバで 1 本に
def vrt(kind, files, dtype, bands, nodata=None):
    infos = []
    for f in files:
        with rasterio.open(f) as d: infos.append((f, d.transform, d.width, d.height))
    px = infos[0][1].a
    X0 = min(t.c for _, t, _, _ in infos); Y1 = max(t.f for _, t, _, _ in infos)
    X1 = max(t.c + w * px for _, t, w, _ in infos); Y0 = min(t.f - h * px for _, t, _, h in infos)
    W, H = round((X1 - X0) / px), round((Y1 - Y0) / px)
    wkt = rasterio.crs.CRS.from_epsg(6676).to_wkt()
    out = [f'<VRTDataset rasterXSize="{W}" rasterYSize="{H}"><SRS>{wkt.replace("&", "&amp;").replace("<", "&lt;")}</SRS><GeoTransform>{X0},{px},0,{Y1},0,{-px}</GeoTransform>']
    for b in range(1, bands + 1):
        out.append(f'<VRTRasterBand dataType="{dtype}" band="{b}">' + (f"<NoDataValue>{nodata}</NoDataValue>" if nodata is not None else "") + (f"<ColorInterp>{['Red','Green','Blue'][b-1]}</ColorInterp>" if bands == 3 else ""))
        for f, t, w, h in infos:
            xo, yo = round((t.c - X0) / px), round((Y1 - t.f) / px)
            out.append(f'<SimpleSource><SourceFilename relativeToVRT="0">{os.path.abspath(f)}</SourceFilename><SourceBand>{b}</SourceBand><SrcRect xOff="0" yOff="0" xSize="{w}" ySize="{h}"/><DstRect xOff="{xo}" yOff="{yo}" xSize="{w}" ySize="{h}"/></SimpleSource>')
        out.append("</VRTRasterBand>")
    out.append("</VRTDataset>")
    p = f"{WORK}/{kind}.vrt"; open(p, "w").write("".join(out))
    print(f"  {kind}.vrt {W}×{H} px", flush=True)
    return p

tag = "-".join(b.lower() for b in BLOCKS)
run(ortho, "ortho"); run(dem, "dem")
with rasterio.Env(GDAL_NUM_THREADS="ALL_CPUS", GDAL_CACHEMAX=2048):
    t0 = time.time()
    o = f"{WORK}/shizuoka-2021-ortho-{tag}.cog.tif"
    rcopy(vrt("ortho", [f"{WORK}/ortho/{s}.tif" for s in sheets], "Byte", 3), o, driver="COG", COMPRESS="WEBP", QUALITY=85, BLOCKSIZE=512, OVERVIEW_RESAMPLING="AVERAGE", BIGTIFF="IF_SAFER", NUM_THREADS="ALL_CPUS")
    print(f"ortho COG {os.path.getsize(o) / 1e6:.0f} MB {time.time() - t0:.0f}s", flush=True)
    t0 = time.time()
    d = f"{WORK}/shizuoka-2021-dem-{tag}.cog.tif"
    rcopy(vrt("dem", [f"{WORK}/dem/{s}.tif" for s in sheets], "Float32", 1, NODATA), d, driver="COG", COMPRESS="DEFLATE", PREDICTOR="FLOATING_POINT", BLOCKSIZE=256, OVERVIEW_RESAMPLING="AVERAGE", BIGTIFF="IF_SAFER", NUM_THREADS="ALL_CPUS")
    print(f"dem COG {os.path.getsize(d) / 1e6:.0f} MB {time.time() - t0:.0f}s", flush=True)
