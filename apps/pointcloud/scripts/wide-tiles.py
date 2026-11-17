# 静岡市の広域表示（2026-11-17）：wide-fetch.py が縮めた県の Ortho（0.4 m）と Grid（0.5 m）→ Web メルカトルのタイル → PMTiles 1 本ずつ
#   ortho＝WebP（z8〜18・範囲の縁は α）／dem＝地理院形式の PNG 標高（z8〜17・0.01 m・範囲の外は無効値 2^23＝地図の既定の地形へ）
#   python3 rtiles.py base <kind> <out_dir>   … 最大ズームのタイル（並列）
#   python3 rtiles.py pyr <kind> <out_dir>    … 下のズームを 2×2 で作る
#   MASK=city.geojson python3 rtiles.py mask <kind> <out_dir>   … 最大ズームのタイルを境界の外で切る（ortho＝α 0・dem＝無効値）→ そのあと pyr
#   python3 rtiles.py pack <kind> <out_dir> <out.pmtiles>
import sys, os, json, glob, io, math, functools, multiprocessing as mp
import numpy as np
from PIL import Image
from pyproj import Transformer
SP = os.environ.get("WORK", "work")   # 作業の置き場（中間ファイル）
MAXZ = {"ortho": 18, "dem": 17}; MINZ = 8; T = 256
def sheet_of(x, y): return np.floor((x + 160000) / 400).astype(np.int64), np.floor((300000 - y) / 300).astype(np.int64)
def index():
    idx = {}
    for f in glob.glob(f"{SP}/ortho/*.json"):
        s = os.path.basename(f)[:8]; m = json.load(open(f)); ci, ri = sheet_of(np.array(m["x0"] + 1), np.array(m["y0"] - 1)); idx[(int(ci), int(ri))] = s
    return idx
@functools.lru_cache(maxsize=160)
def load(kind, s):
    if kind == "ortho":
        m = json.load(open(f"{SP}/ortho/{s}.json")); a = np.asarray(Image.open(f"{SP}/ortho/{s}.jpg").convert("RGB"), dtype=np.float32)
        return a, m["x0"], m["y0"], m["px"]
    z = np.load(f"{SP}/grid/{s}.npz"); return z["h"][..., None], float(z["x0"]), float(z["y0"]), float(z["px"])
def sample(kind, s, x, y):
    a, x0, y0, px = load(kind, s); h, w = a.shape[:2]
    fx = np.clip((x - x0) / px - 0.5, 0, w - 1); fy = np.clip((y0 - y) / px - 0.5, 0, h - 1)
    i0, j0 = np.floor(fx).astype(int), np.floor(fy).astype(int); i1, j1 = np.minimum(i0 + 1, w - 1), np.minimum(j0 + 1, h - 1)
    dx, dy = (fx - i0)[:, None], (fy - j0)[:, None]
    return a[j0, i0] * (1 - dx) * (1 - dy) + a[j0, i1] * dx * (1 - dy) + a[j1, i0] * (1 - dx) * dy + a[j1, i1] * dx * dy
TR = None; IDX = None
def tile_xy(z, x, y):   # 画素の中心の Web メルカトル座標
    n = 2 ** z; R = 6378137 * math.pi; size = 2 * R / n
    u = (np.arange(T) + 0.5) / T; X = -R + (x + u) * size; Y = R - (y + u) * size
    return np.meshgrid(X, Y)
def enc_gsi(h):   # 地理院の PNG 標高タイル（0.01 m・2^23＝無効）
    x = np.where(np.isfinite(h), np.rint(np.nan_to_num(h) * 100), 2 ** 23).astype(np.int64); x = np.where(x < 0, x + 2 ** 24, x)
    return np.stack([(x >> 16) & 255, (x >> 8) & 255, x & 255], -1).astype(np.uint8)
def save(kind, out, z, x, y, arr, valid):
    os.makedirs(f"{out}/{z}/{x}", exist_ok=True)
    if kind == "ortho":
        if valid.all(): Image.fromarray(arr.astype(np.uint8)).save(f"{out}/{z}/{x}/{y}.webp", "WEBP", quality=80, method=4)
        else: Image.fromarray(np.dstack([arr.astype(np.uint8), (valid * 255).astype(np.uint8)])).save(f"{out}/{z}/{x}/{y}.webp", "WEBP", quality=80, method=4)
    else:
        np.save(f"{out}/{z}/{x}/{y}.npy", np.where(valid, arr[..., 0], np.nan).astype(np.float32))
def base_one(args):
    global TR, IDX
    kind, out, z, x, y = args
    if TR is None: TR = Transformer.from_crs("EPSG:3857", "EPSG:6676", always_xy=True); IDX = index()
    X, Y = tile_xy(z, x, y); px, py = TR.transform(X.ravel(), Y.ravel())
    ci, ri = sheet_of(px, py); C = 3 if kind == "ortho" else 1
    res = np.zeros((T * T, C), np.float32); valid = np.zeros(T * T, bool)
    keys = ci * 100000 + ri
    for k in np.unique(keys):
        s = IDX.get((int(k // 100000), int(k % 100000)))
        if not s or (kind == "dem" and not os.path.exists(f"{SP}/grid/{s}.npz")): continue   # Grid が無い図郭（県に無い）は飛ばす
        m = keys == k; res[m] = sample(kind, s, px[m], py[m]); valid[m] = True
    if kind == "dem": valid &= np.isfinite(res[:, 0])
    if not valid.any(): return 0
    save(kind, out, z, x, y, res.reshape(T, T, C), valid.reshape(T, T)); return 1
def base(kind, out):
    to = Transformer.from_crs("EPSG:6676", "EPSG:4326", always_xy=True); z = MAXZ[kind]; tiles = set(); n = 2 ** z
    for (ci, ri), s in index().items():
        x0, y1 = ci * 400 - 160000, 300000 - ri * 300
        lon, lat = to.transform([x0, x0 + 400, x0, x0 + 400], [y1, y1, y1 - 300, y1 - 300])
        tx = [int((l + 180) / 360 * n) for l in lon]; ty = [int((1 - math.asinh(math.tan(math.radians(a))) / math.pi) / 2 * n) for a in lat]
        for tx_ in range(min(tx), max(tx) + 1):
            for ty_ in range(min(ty), max(ty) + 1): tiles.add((tx_, ty_))
    todo = sorted(tiles, key=lambda t: (t[0] >> 5, t[1] >> 5, t))   # z13 の塊ごと＝図郭の使い回し
    todo = [t for t in todo if not os.path.exists(f"{out}/{z}/{t[0]}/{t[1]}.{'webp' if kind == 'ortho' else 'npy'}")]
    print(kind, "tiles", len(tiles), "todo", len(todo), flush=True)
    with mp.Pool(int(os.environ.get("P", "3"))) as pool:
        done = 0
        for i, r in enumerate(pool.imap(base_one, [(kind, out, z, x, y) for x, y in todo], chunksize=64)):
            done += r
            if i % 2000 == 0: print(i, done, flush=True)
    print("base done", done)
def read(kind, out, z, x, y):
    p = f"{out}/{z}/{x}/{y}." + ("webp" if kind == "ortho" else "npy")
    if not os.path.exists(p): return None
    if kind == "ortho":
        im = np.asarray(Image.open(p).convert("RGBA"), dtype=np.float32); return im[..., :3], im[..., 3] / 255
    h = np.load(p); return h[..., None], np.isfinite(h).astype(np.float32)
def pyr(kind, out):
    for z in range(MAXZ[kind] - 1, MINZ - 1, -1):
        kids = set()
        for d in glob.glob(f"{out}/{z + 1}/*"):
            for f in os.listdir(d): kids.add((int(os.path.basename(d)) // 2, int(f.split(".")[0]) // 2))
        for x, y in kids:
            C = 3 if kind == "ortho" else 1; acc = np.zeros((2 * T, 2 * T, C), np.float32); wt = np.zeros((2 * T, 2 * T), np.float32)
            for dx in (0, 1):
                for dy in (0, 1):
                    r = read(kind, out, z + 1, 2 * x + dx, 2 * y + dy)
                    if r is None: continue
                    a, w = r; a = np.nan_to_num(a); acc[dy * T:(dy + 1) * T, dx * T:(dx + 1) * T] = a * w[..., None]; wt[dy * T:(dy + 1) * T, dx * T:(dx + 1) * T] = w
            A = acc.reshape(T, 2, T, 2, C).sum((1, 3)); W = wt.reshape(T, 2, T, 2).sum((1, 3))
            valid = W > (0.5 if kind == "ortho" else 0); res = np.where(valid[..., None], A / np.maximum(W, 1e-6)[..., None], 0)
            save(kind, out, z, x, y, res, valid if kind == "dem" else W >= 3.9)
            if kind == "ortho" and not (W >= 3.9).all():   # 縁は α を割合で
                Image.fromarray(np.dstack([res.astype(np.uint8), np.clip(W / 4 * 255, 0, 255).astype(np.uint8)])).save(f"{out}/{z}/{x}/{y}.webp", "WEBP", quality=80, method=4)
        print("z", z, len(kids), flush=True)
def mask(kind, out):   # 境界（GeoJSON の Polygon/MultiPolygon・経緯度）の外を落とす
    from shapely.geometry import shape, box
    from shapely.prepared import prep
    from PIL import ImageDraw
    g = json.load(open(os.environ["MASK"])); g = shape(g.get("geometry", g)); pg = prep(g); z = MAXZ[kind]; n = 2 ** z
    def gpx(lon, lat): return (lon + 180) / 360 * n * T, (1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n * T
    def lonlat(x, y): return x / n * 360 - 180, math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    polys = list(g.geoms) if g.geom_type == "MultiPolygon" else [g]
    rings = [([gpx(*c) for c in p.exterior.coords], [[gpx(*c) for c in r.coords] for r in p.interiors]) for p in polys]
    keep = drop = cut = 0
    for xd in glob.glob(f"{out}/{z}/*"):
        x = int(os.path.basename(xd))
        for f in os.listdir(xd):
            y = int(f.split(".")[0]); p = f"{xd}/{f}"; (w_, n_), (e_, s_) = lonlat(x, y), lonlat(x + 1, y + 1); bb = box(w_, s_, e_, n_)
            if pg.contains(bb): keep += 1; continue
            if not pg.intersects(bb): os.remove(p); drop += 1; continue
            im = Image.new("L", (T * 4, T * 4), 0); d = ImageDraw.Draw(im); ox, oy = x * T, y * T
            for ext, holes in rings:
                d.polygon([((u - ox) * 4, (v - oy) * 4) for u, v in ext], fill=255)
                for h in holes: d.polygon([((u - ox) * 4, (v - oy) * 4) for u, v in h], fill=0)
            m = np.asarray(im.resize((T, T), Image.BILINEAR), dtype=np.float32) / 255
            if kind == "ortho":
                a = np.asarray(Image.open(p).convert("RGBA"), dtype=np.float32); al = a[..., 3] * m
                if not (al > 0).any(): os.remove(p); drop += 1; continue
                Image.fromarray(np.dstack([a[..., :3], al]).astype(np.uint8)).save(p, "WEBP", quality=80, method=4)
            else:
                h = np.load(p); h = np.where(m >= 0.5, h, np.nan).astype(np.float32)
                if not np.isfinite(h).any(): os.remove(p); drop += 1; continue
                np.save(p, h)
            cut += 1
    print("mask", kind, "keep", keep, "cut", cut, "drop", drop, flush=True)
def pack(kind, out, dst):
    from pmtiles.writer import Writer
    from pmtiles.tile import zxy_to_tileid, TileType, Compression
    ents = []
    for zd in glob.glob(f"{out}/*"):
        z = int(os.path.basename(zd))
        for xd in glob.glob(f"{zd}/*"):
            x = int(os.path.basename(xd))
            for f in os.listdir(xd): ents.append((zxy_to_tileid(z, x, int(f.split(".")[0])), z, x, int(f.split(".")[0]), f"{xd}/{f}"))
    ents.sort(); to = Transformer.from_crs("EPSG:6676", "EPSG:4326", always_xy=True)
    zs = [e[1] for e in ents]; lo = [e for e in ents if e[1] == max(zs)]
    with open(dst, "wb") as fo:
        w = Writer(fo)
        for tid, z, x, y, p in ents:
            if kind == "ortho": data = open(p, "rb").read()
            else:
                h = np.load(p); bad = ~np.isfinite(h)
                if bad.all(): continue
                b = io.BytesIO(); Image.fromarray(enc_gsi(h)).save(b, "PNG", optimize=True); data = b.getvalue()   # 範囲の外＝無効値（地図の既定の地形へ）
            w.write_tile(tid, data)
        n = 2 ** max(zs); xs = [e[2] for e in lo]; ys = [e[3] for e in lo]
        lon = lambda x: x / n * 360 - 180; lat = lambda y: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
        W_, E_, N_, S_ = lon(min(xs)), lon(max(xs) + 1), lat(min(ys)), lat(max(ys) + 1)
        w.finalize({"tile_type": TileType.WEBP if kind == "ortho" else TileType.PNG, "tile_compression": Compression.NONE, "min_zoom": min(zs), "max_zoom": max(zs),
                    "min_lon_e7": int(W_ * 1e7), "min_lat_e7": int(S_ * 1e7), "max_lon_e7": int(E_ * 1e7), "max_lat_e7": int(N_ * 1e7), "center_zoom": 12, "center_lon_e7": int((W_ + E_) / 2 * 1e7), "center_lat_e7": int((S_ + N_) / 2 * 1e7)},
                   {"name": f"shizuoka-city-2021-{kind}", "attribution": "VIRTUAL SHIZUOKA (Shizuoka Prefecture, CC BY 4.0)", **({"encoding": "gsi"} if kind == "dem" else {})})
    print("packed", len(ents), os.path.getsize(dst))
if __name__ == "__main__":
    cmd, kind, out = sys.argv[1:4]
    {"base": lambda: base(kind, out), "pyr": lambda: pyr(kind, out), "mask": lambda: mask(kind, out), "pack": lambda: pack(kind, out, sys.argv[4])}[cmd]()
