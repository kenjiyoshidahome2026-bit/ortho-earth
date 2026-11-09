# 静岡県の点群（VIRTUAL SHIZUOKA の図郭の LAS）→ COPC（2026-11-09・apps/pointcloud の pc-copc.ts が読む Hugging Face の dataset を作った物）。
# 使い方: python3 las2copc.py <in.las> <out.copc.laz> [節の最小点数=20000]（要 laspy・copclib・pyproj・numpy）
# 中身＝PDRF 7（RGB）に詰め直し、根 128³ の格子で段ごとに 1 セル 1 点の八分木。残りが最小点数未満の節はその段で全部置く（細かい節を作らない）・節の中は GPS 時刻順（LAZ がよく縮む）。
# 座標系＝EPSG:6676（平面直角 VIII 系）＋EPSG:6695（標高）の WKT を書く。元の RIEGL Amplitude 欄は落とす。
import sys, time, numpy as np, laspy, copclib as copc
from pyproj import CRS
src, dst = sys.argv[1], sys.argv[2]
t0 = time.time()
las = laspy.read(src)
X, Y, Z = las.X.astype(np.int64), las.Y.astype(np.int64), las.Z.astype(np.int64)  # 生の整数（scale 0.01）
sc, of = las.header.scales, las.header.offsets
x = X * sc[0] + of[0]; y = Y * sc[1] + of[1]; z = Z * sc[2] + of[2]
n = len(x)
mn = np.array([x.min(), y.min(), z.min()]); mx = np.array([x.max(), y.max(), z.max()])
c = (mn + mx) / 2; h = (mx - mn).max() / 2 + 0.01
off = np.round(c, 0)
# PDRF 7 の生のバイト
dt = np.dtype([('X','<i4'),('Y','<i4'),('Z','<i4'),('i','<u2'),('r','u1'),('f','u1'),('c','u1'),('u','u1'),('a','<i2'),('p','<u2'),('t','<f8'),('R','<u2'),('G','<u2'),('B','<u2')])
rec = np.zeros(n, dt)
rec['X'] = np.round((x - off[0]) / 0.01); rec['Y'] = np.round((y - off[1]) / 0.01); rec['Z'] = np.round((z - off[2]) / 0.01)
rec['i'] = las.intensity
rn = np.clip(np.asarray(las.return_number), 0, 15); nr = np.clip(np.asarray(las.number_of_returns), 0, 15)
rec['r'] = rn | (nr << 4)
rec['c'] = las.classification; rec['p'] = las.point_source_id; rec['t'] = las.gps_time
rec['a'] = np.round(np.asarray(las.scan_angle_rank) / 0.006).astype(np.int16)
rec['R'], rec['G'], rec['B'] = las.red, las.green, las.blue
t1 = time.time()
# 八分木（根は 128³ の格子・段ごとに倍・空いたセルに 1 点ずつ）
rng = np.random.default_rng(0); rem = rng.permutation(n)
P = np.stack([x, y, z], 1); lo = c - h
nodes = {}; d = 0; MAXD = 10; MINN = int(sys.argv[3]) if len(sys.argv) > 3 else 20000
while len(rem):
    G = 128 << d
    cell = np.clip(((P[rem] - lo) / (2 * h) * G).astype(np.int64), 0, G - 1)
    if d == MAXD or len(rem) < MINN:
        take = np.arange(len(rem))
    else:
        key = (cell[:, 0] * G + cell[:, 1]) * G + cell[:, 2]
        _, take = np.unique(key, return_index=True)
        # 残りが少ない節（MINN 未満）はこの段で全部置く＝細かい節を作らない
        nk0 = cell // 128; k0 = (nk0[:, 0] * (1 << d) + nk0[:, 1]) * (1 << d) + nk0[:, 2]
        u, inv, cnt = np.unique(k0, return_inverse=True, return_counts=True)
        small = cnt[inv] < MINN
        if small.any(): take = np.union1d(take, np.flatnonzero(small))
    nk = cell[take] // 128
    nkey = (nk[:, 0] * (1 << d) + nk[:, 1]) * (1 << d) + nk[:, 2]
    order = np.argsort(nkey, kind='stable'); nkey = nkey[order]; idx = rem[take][order]; nk = nk[order]
    bounds = np.flatnonzero(np.diff(nkey)) + 1
    for s, e in zip(np.r_[0, bounds], np.r_[bounds, len(nkey)]):
        nodes[(d, *map(int, nk[s]))] = idx[s:e]
    mask = np.ones(len(rem), bool); mask[take] = False; rem = rem[mask]; d += 1
t2 = time.time()
wkt = CRS("EPSG:6676+6695").to_wkt("WKT1_GDAL")
cfg = copc.CopcConfigWriter(7, copc.Vector3(0.01, 0.01, 0.01), copc.Vector3(*off), wkt)
w = copc.FileWriter(dst, cfg)
hd = w.copc_config.las_header if hasattr(w, 'copc_config') else None
info = w.copc_config.copc_info
info.center_x, info.center_y, info.center_z = map(float, c); info.halfsize = float(h); info.spacing = float(2 * h / 128)
hd.min = copc.Vector3(*mn); hd.max = copc.Vector3(*mx)
for k, ii in nodes.items():
    ii = ii[np.argsort(rec['t'][ii], kind='stable')]   # 節の中は計測順（GPS 時刻）＝LAZ がよく縮む
    w.AddNode(copc.VoxelKey(*k), copc.VectorChar(np.frombuffer(rec[ii].tobytes(), np.int8)))
w.Close()
t3 = time.time()
import os
print(f"{os.path.basename(src)} n={n} depth={d} nodes={len(nodes)} read={t1-t0:.1f}s octree={t2-t1:.1f}s write={t3-t2:.1f}s size={os.path.getsize(dst)/1e6:.1f}MB")
