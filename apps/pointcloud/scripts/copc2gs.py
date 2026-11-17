# COPC（図郭）→ Gaussian splat の 3D Tiles（2026-11-17・静岡市の広域表示）：区画 8 m → 四分（5×5 図郭）4 m → 図郭 1 m（FINE=1 なら → 0.5 m）
#   python3 copc2gs.py <COPC の置き場（<図郭>.copc.laz）> <出力>   … 出力＝tileset.json ＋ <区画>/*.glb（KHR_gaussian_splatting＋SPZ・glb は gs-glb.mjs が sdk/splat の書き出しで作る）
#   SHEETS=<JSON {図郭: URL}>（県 S3 の .zip か HF の .copc.laz）なら <COPC の置き場> の代わりに URL から先読みして読み、読んだら消す（2026-11-18・静岡市全域：元の zip は 3.2 TB で手元に置けない）。
#     BLOCKS=08ND68,08NE70 で区画を絞る・PREFETCH（同時に落とす数・既定 4）・AHEAD（先読みの枚数・既定 6）
#   python3 copc2gs.py merge <出力> <元の tileset.json> <区画ごとの出力>...   … 区画ごとに作った tileset を元の tileset に足す（同じ区画は差し替え）
#   段の作り方は sdk/splat の cloud.ts と同じ式（セルの平均・共分散＋子の中心のばらつき・fill と cap）を numpy でまとめて。level 0 は近傍でなくセルの中の点の散らばり（セル 0.5 m に点が十数個入る密度が前提）
#   1 m の段で 1 図郭 5〜16 MB（115 図郭で 732 MB＝COPC の約 1/10）。0.5 m は 1 図郭 15〜34 MB で COPC に近いので既定では作らない
# 位置は 区画 の東北上（ENU・錨＝区画の中心・高さ 0）。各タイルの局所＝区画の ENU をタイル中心へ平行移動しただけ
import sys, os, json, glob, subprocess, time, re, shutil, zipfile, urllib.request
import numpy as np
from pyproj import Transformer
toLL = Transformer.from_crs("EPSG:6676", "EPSG:4326", always_xy=True)
# 図郭番号 → VIII 系の範囲（pointcloud-sheets.ts と同じ式）
def sheet_box(s):
    # 08 + 行字 + 列字 + 5000 の行・列 + 500 の行・列
    R, C = "ABCDEFGHIJKLMNOPQRST".index(s[2]), "ABCDEFGHIJKLMNOPQRST".index(s[3])
    r5, c5, r0, c0 = int(s[4]), int(s[5]), int(s[6]), int(s[7])
    x0 = -160000 + C * 40000 + c5 * 4000 + c0 * 400; y1 = 300000 - R * 30000 - r5 * 3000 - r0 * 300
    return x0, y1 - 300, x0 + 400, y1
def region(blocks):   # 区画の並び → tileset の region（ラジアン）
    lons, lats = [], []
    for blk in blocks:
        for s in (blk + "00", blk + "99"):
            a = sheet_box(s); lo, la = toLL.transform([a[0], a[2]], [a[1], a[3]]); lons += list(lo); lats += list(la)
    return [np.radians(min(lons)), np.radians(min(lats)), np.radians(max(lons)), np.radians(max(lats)), -100, 3500]
if sys.argv[1] == "merge":   # 区画の根を差し替え・足して tileset.json を書く
    OUT, base, parts = sys.argv[2], json.load(open(sys.argv[3])), sys.argv[4:]
    roots = {c["content"]["uri"].split("/")[0]: c for c in base["root"]["children"]}; splats = {}
    for d in parts:
        if not os.path.exists(f"{d}/tileset.json"): continue
        for c in json.load(open(f"{d}/tileset.json"))["root"]["children"]: roots[c["content"]["uri"].split("/")[0]] = c
        st = json.load(open(f"{d}/stats.json")); splats.update(st.get("_splats", {}))
    base["root"]["children"] = [roots[k] for k in sorted(roots)]; base["root"]["boundingVolume"] = {"region": region(sorted(roots))}
    os.makedirs(OUT, exist_ok=True); json.dump(base, open(f"{OUT}/tileset.json", "w"), default=float)
    json.dump(splats, open(f"{OUT}/splats-new.json", "w")); print("blocks", len(roots), "new splats", sum(splats.values())); sys.exit(0)
import laspy
SRC = sys.argv[1]; OUT = sys.argv[2]; os.makedirs(OUT, exist_ok=True)
SHEETS = json.load(open(os.environ["SHEETS"])) if os.environ.get("SHEETS") else None
BLOCKS = set(os.environ["BLOCKS"].split(",")) if os.environ.get("BLOCKS") else None
FILL, CAP, GE = 0.35, 4.0, 16
FINE = os.environ.get("FINE") == "1"
# MASK=<GeoJSON（EPSG:6676 の多角形）> なら外の点を落とす（2026-11-17・静岡市の境界＝N03 の葵・駿河・清水の和）。要 shapely。図郭が丸ごと外なら作らない
MASK = None
if os.environ.get("MASK"):
    import shapely
    from shapely.geometry import shape, box as sbox
    MASK = shapely.union_all([shape(f["geometry"]) for f in json.load(open(os.environ["MASK"]))["features"]]); shapely.prepare(MASK)
WA, WE2 = 6378137.0, 6.69437999014e-3
def ecef(lon, lat, h):
    l, f = np.radians(lon), np.radians(lat); N = WA / np.sqrt(1 - WE2 * np.sin(f)**2)
    return np.stack([(N + h) * np.cos(f) * np.cos(l), (N + h) * np.cos(f) * np.sin(l), (N * (1 - WE2) + h) * np.sin(f)], -1)
def enu_frame(lon, lat):
    l, f = np.radians(lon), np.radians(lat); sl, cl, sf, cf = np.sin(l), np.cos(l), np.sin(f), np.cos(f)
    R = np.array([[-sl, cl, 0], [-sf * cl, -sf * sl, cf], [cf * cl, cf * sl, sf]])   # 行＝E, N, U
    return R, ecef(np.array(lon), np.array(lat), np.array(0.0))
class Lv:   # 段＝中心・共分散 6・重み・色
    def __init__(s, ctr, cov, w, col): s.ctr, s.cov, s.w, s.col = ctr, cov, w, col
    @property
    def n(s): return len(s.w)
def group(ctr, c):
    k = np.floor(ctr / c).astype(np.int64); k -= k.min(0)
    key = (k[:, 0] * 1_000_003 + k[:, 1]) * 100_003 + k[:, 2]
    u, inv = np.unique(key, return_inverse=True); return inv, len(u)
def finish(C, c):
    C[:, 0] += (FILL * c)**2; C[:, 3] += (FILL * c)**2; C[:, 5] += (FILL * c)**2
    tr = C[:, 0] + C[:, 3] + C[:, 5]; s = np.minimum(1, (CAP * c)**2 / np.maximum(tr, 1e-12)); return C * s[:, None]
def from_points(p, rgb, c):
    inv, m = group(p, c); w = np.bincount(inv, minlength=m).astype(np.float64)
    mu = np.stack([np.bincount(inv, p[:, k], m) for k in range(3)], -1) / w[:, None]
    d = p - mu[inv]; C = np.stack([np.bincount(inv, d[:, a] * d[:, b], m) for a, b in ((0,0),(0,1),(0,2),(1,1),(1,2),(2,2))], -1) / w[:, None]
    few = w < 3; C[few] = 0; C[few, 0] = C[few, 3] = C[few, 5] = (0.5 * c)**2
    col = np.stack([np.bincount(inv, rgb[:, k], m) for k in range(3)], -1) / w[:, None]
    return Lv(mu, finish(C, c), w, col)
def merge(L, c):
    inv, m = group(L.ctr, c); w = L.w; W = np.bincount(inv, w, m)
    mu = np.stack([np.bincount(inv, w * L.ctr[:, k], m) for k in range(3)], -1) / W[:, None]
    d = L.ctr - mu[inv]; idx = ((0,0),(0,1),(0,2),(1,1),(1,2),(2,2))
    C = np.stack([np.bincount(inv, w * (L.cov[:, t] + d[:, a] * d[:, b]), m) for t, (a, b) in enumerate(idx)], -1) / W[:, None]
    col = np.stack([np.bincount(inv, w * L.col[:, k], m) for k in range(3)], -1) / W[:, None]
    return Lv(mu, finish(C, c), W, col)
def cat(ls): return Lv(np.concatenate([l.ctr for l in ls]), np.concatenate([l.cov for l in ls]), np.concatenate([l.w for l in ls]), np.concatenate([l.col for l in ls]))
def to_quat(V):   # 回転行列（列＝軸）→ 四元数 x,y,z,w
    m = V; tr = m[:, 0, 0] + m[:, 1, 1] + m[:, 2, 2]; q = np.zeros((len(m), 4))
    s = np.sqrt(np.maximum(tr + 1, 1e-12)) * 2; a = tr > 0
    q[a] = np.stack([(m[a, 2, 1] - m[a, 1, 2]) / s[a], (m[a, 0, 2] - m[a, 2, 0]) / s[a], (m[a, 1, 0] - m[a, 0, 1]) / s[a], s[a] / 4], -1)
    for i, (j, k) in enumerate(((1, 2), (2, 0), (0, 1))):
        b = (~a) & (m[:, i, i] >= m[:, j, j]) & (m[:, i, i] >= m[:, k, k]) & np.all(q == 0, 1)
        s2 = np.sqrt(np.maximum(1 + m[b, i, i] - m[b, j, j] - m[b, k, k], 1e-12)) * 2
        r = np.zeros((b.sum(), 4)); r[:, i] = s2 / 4; r[:, j] = (m[b, j, i] + m[b, i, j]) / s2; r[:, k] = (m[b, k, i] + m[b, i, k]) / s2; r[:, 3] = (m[b, k, j] - m[b, j, k]) / s2
        q[b] = r
    return q / np.linalg.norm(q, axis=1, keepdims=True)
NSPLAT = {}   # 区画ごとの splat の数（全段の和）
def write_tile(L, center, path, jobs):
    b = os.path.basename(os.path.dirname(path)); NSPLAT[b] = NSPLAT.get(b, 0) + int(L.n)
    M = np.zeros((L.n, 3, 3)); C = L.cov
    M[:, 0, 0], M[:, 0, 1], M[:, 0, 2], M[:, 1, 1], M[:, 1, 2], M[:, 2, 2] = C.T
    M[:, 1, 0], M[:, 2, 0], M[:, 2, 1] = M[:, 0, 1], M[:, 0, 2], M[:, 1, 2]
    ev, V = np.linalg.eigh(M); V[np.linalg.det(V) < 0, :, 2] *= -1
    sc = np.sqrt(np.maximum(ev, 1e-12)); q = to_quat(V)
    pos = (L.ctr - center).astype(np.float32)
    rgba = np.concatenate([np.clip(np.rint(L.col), 0, 255), np.full((L.n, 1), 255)], 1).astype(np.uint8)
    with open(path + ".bin", "wb") as f:
        f.write(np.uint32(L.n).tobytes()); f.write(pos.tobytes()); f.write(sc.astype(np.float32).tobytes()); f.write(q.astype(np.float32).tobytes()); f.write(rgba.tobytes())
    jobs.append({"src": path + ".bin", "dst": path})
def box(L, center, pad):
    lo, hi = L.ctr.min(0) - center - pad, L.ctr.max(0) - center + pad; c = (lo + hi) / 2; h = np.maximum((hi - lo) / 2, 1)
    return {"box": [*c, h[0], 0, 0, 0, h[1], 0, 0, 0, h[2]]}
def tile(L, center, parent_center, uri, ge, children=None):
    t = {"transform": [1,0,0,0, 0,1,0,0, 0,0,1,0, *(center - parent_center), 1], "boundingVolume": box(L, center, 2 * ge / GE if ge else 1), "geometricError": ge, "refine": "REPLACE", "content": {"uri": uri}}
    if children: t["children"] = children
    return t
files = sorted(SHEETS) if SHEETS else sorted(glob.glob(f"{SRC}/*.copc.laz"))[:int(os.environ.get("LIMIT", "100000"))]; byblock = {}
for f in files:
    s = os.path.basename(f)[:8]
    if BLOCKS and s[:6] not in BLOCKS: continue
    if MASK is not None and not MASK.intersects(sbox(*sheet_box(s))): continue   # 丸ごと外
    byblock.setdefault(s[:6], []).append(s)
# URL から読むとき：先読み（落とす→zip なら LAS を取り出す）・読んだら消す
CACHE = os.environ.get("CACHE", f"{OUT}/.cache")
def fetch(s):
    url, dst = SHEETS[s], f"{CACHE}/{s}"; os.makedirs(CACHE, exist_ok=True)
    for i in range(6):
        try:
            with urllib.request.urlopen(url, timeout=300) as r, open(dst + ".part", "wb") as f: shutil.copyfileobj(r, f, 1 << 22)
            if url.endswith(".zip"):
                with zipfile.ZipFile(dst + ".part") as z:
                    m = [n for n in z.namelist() if n.lower().endswith(".las")][0]
                    with z.open(m) as a, open(dst + ".las", "wb") as b: shutil.copyfileobj(a, b, 1 << 22)
                os.remove(dst + ".part"); return dst + ".las"
            os.replace(dst + ".part", dst + ".copc.laz"); return dst + ".copc.laz"
        except Exception as e:
            if i == 5: raise
            print("retry", s, e, flush=True); time.sleep(10 * 2 ** i)
order = [s for blk in sorted(byblock) for s in byblock[blk]]; pos = {s: i for i, s in enumerate(order)}; fut, nxt = {}, 0
if SHEETS:
    from concurrent.futures import ThreadPoolExecutor
    pool = ThreadPoolExecutor(int(os.environ.get("PREFETCH", "4"))); AHEAD = int(os.environ.get("AHEAD", "6"))
def read_sheet(s):
    global nxt
    if not SHEETS: return laspy.read(f"{SRC}/{s}.copc.laz")
    while nxt < len(order) and nxt <= pos[s] + AHEAD: fut[order[nxt]] = pool.submit(fetch, order[nxt]); nxt += 1
    path = fut.pop(s).result(); las = laspy.read(path); os.remove(path); return las
roots, t0 = [], time.time(); stats = {}
for blk, sheets in sorted(byblock.items()):
    bx0, by1, bx1, by0 = sheet_box(blk + "00")[0], sheet_box(blk + "00")[3], sheet_box(blk + "99")[2], sheet_box(blk + "99")[1]
    lon0, lat0 = toLL.transform((bx0 + bx1) / 2, (by0 + by1) / 2); R, O = enu_frame(lon0, lat0)
    os.makedirs(f"{OUT}/{blk}", exist_ok=True); jobs = []; quads = {}
    for s in sheets:
        las = read_sheet(s); keep = ~np.isin(np.asarray(las.classification), [7, 18])
        if MASK is not None and not MASK.contains(sbox(*sheet_box(s))):   # 境界にかかる図郭だけ点ごとに判定
            keep &= shapely.contains_xy(MASK, np.asarray(las.x), np.asarray(las.y))
        if not keep.any(): continue
        x, y, z = np.asarray(las.x)[keep], np.asarray(las.y)[keep], np.asarray(las.z)[keep]
        lon, lat = toLL.transform(x, y); p = (ecef(lon, lat, z) - O) @ R.T
        rgb = np.stack([np.asarray(las.red), np.asarray(las.green), np.asarray(las.blue)], -1)[keep].astype(np.float64)
        if rgb.max() > 255: rgb /= 257
        L05 = from_points(p, rgb, 0.5); L1 = merge(L05, 1.0)
        sc = L1.ctr.mean(0) * [1, 1, 0] + [0, 0, np.median(L1.ctr[:, 2])]
        FINE and write_tile(L05, sc, f"{OUT}/{blk}/{s}_05.glb", jobs); write_tile(L1, sc, f"{OUT}/{blk}/{s}_1.glb", jobs)
        q = (int(s[6]) // 5, int(s[7]) // 5); quads.setdefault(q, []).append((s, sc, L05 if FINE else None, L1))
        stats[s] = (len(x), L05.n, L1.n); print(blk, s, len(x), L05.n, L1.n, round(time.time() - t0), flush=True)
    if not quads: print("block", blk, "empty"); continue
    qtiles, q4s = [], []
    for q, items in sorted(quads.items()):
        L4 = merge(merge(cat([it[3] for it in items]), 2.0), 4.0); qc = L4.ctr.mean(0) * [1, 1, 0] + [0, 0, np.median(L4.ctr[:, 2])]
        write_tile(L4, qc, f"{OUT}/{blk}/q{q[0]}{q[1]}_4.glb", jobs); q4s.append(L4)
        kids = [tile(it[3], it[1], qc, f"{blk}/{it[0]}_1.glb", 1.0 * GE, [tile(it[2], it[1], it[1], f"{blk}/{it[0]}_05.glb", 0)]) if FINE else tile(it[3], it[1], qc, f"{blk}/{it[0]}_1.glb", 0) for it in items]
        qtiles.append((L4, qc, f"{blk}/q{q[0]}{q[1]}_4.glb", kids))
    L8 = merge(cat(q4s), 8.0); bc = L8.ctr.mean(0) * [1, 1, 0] + [0, 0, np.median(L8.ctr[:, 2])]
    write_tile(L8, bc, f"{OUT}/{blk}/{blk}_8.glb", jobs)
    root = tile(L8, bc, np.zeros(3), f"{blk}/{blk}_8.glb", 8.0 * GE, [tile(L4, qc, bc, u, 4.0 * GE, kids) for L4, qc, u, kids in qtiles])
    # 区画の根の transform＝ENU→ECEF（列優先）× 平行移動
    E = np.eye(4); E[:3, :3] = R.T; E[:3, 3] = O; T = np.eye(4); T[:3, 3] = bc
    root["transform"] = list((E @ T).T.reshape(-1))
    roots.append(root)
    json.dump(jobs, open(f"{OUT}/{blk}/jobs.json", "w"))
    subprocess.run(["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "gs-glb.mjs"), f"{OUT}/{blk}/jobs.json"], check=True); os.remove(f"{OUT}/{blk}/jobs.json")
    print("block", blk, "L8", L8.n, "L4", [l.n for l in q4s], round(time.time() - t0), flush=True)
if not roots: print("done (nothing inside MASK)"); sys.exit(0)
# 根＝中身なし・区画の子
ts = {"asset": {"version": "1.1"}, "geometricError": 8.0 * GE * 8, "extensionsUsed": ["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"],
      "root": {"boundingVolume": {"region": region(byblock)}, "geometricError": 8.0 * GE * 4, "refine": "REPLACE", "children": roots}}
json.dump(ts, open(f"{OUT}/tileset.json", "w"), default=float)
json.dump({**stats, "_splats": NSPLAT}, open(f"{OUT}/stats.json", "w"))
print("done", round(time.time() - t0))
