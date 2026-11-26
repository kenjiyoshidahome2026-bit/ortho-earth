# tests/fixtures/healpix-healpy.json を作る（healpy の値＝healpix.ts の検定の基準）。
#   python3 -m venv hp && hp/bin/pip install healpy numpy && hp/bin/python scripts/healpix-fixtures.py && mv healpix-healpy.json tests/fixtures/
import json, numpy as np, healpy as hp
rng = np.random.default_rng(20261126)
out = {"healpy": hp.__version__, "points": [], "centers": [], "neighbors": [], "corners": []}
lon = np.concatenate([rng.uniform(-180, 180, 300), [0, 90, 180, -180, -90, 45, 135, -45, -135, 0, 0, 139.7, 10, 10]])
lat = np.concatenate([np.degrees(np.arcsin(rng.uniform(-1, 1, 300))), [0.001, -0.001, 0.002, 0.003, -0.002, 41.8103, -41.8103, 41.82, -41.80, 89.999, -89.999, 35.68, 41.8103148957, -41.8103148957]])
orders = [0, 1, 3, 10, 18, 24]
for lo, la in zip(lon, lat):
    out["points"].append([float(lo), float(la)] + [int(hp.ang2pix(2**k, lo, la, nest=True, lonlat=True)) for k in orders])
out["orders"] = orders
for k in [0, 1, 2, 5, 13]:
    n = hp.nside2npix(2**k)
    ids = sorted(set([0, 1, 2, 3, n-1, n//2, n//3] + [int(x) for x in rng.integers(0, n, 40)])) if n > 60 else list(range(n))
    for p in ids:
        lo, la = hp.pix2ang(2**k, p, nest=True, lonlat=True)
        out["centers"].append([k, p, float(lo), float(la)])
        out["neighbors"].append([k, p] + [int(x) for x in hp.get_all_neighbours(2**k, p, nest=True)])
        v = hp.boundaries(2**k, p, step=1, nest=True)  # 3x4: N, W, S, E
        lo2, la2 = hp.vec2ang(v.T, lonlat=True)
        out["corners"].append([k, p] + [[float(a), float(b)] for a, b in zip(lo2, la2)])
json.dump(out, open("healpix-healpy.json", "w"), separators=(",", ":"))
print(len(out["points"]), len(out["centers"]))
