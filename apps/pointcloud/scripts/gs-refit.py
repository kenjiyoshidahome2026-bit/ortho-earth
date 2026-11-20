# 広域 GS の潰れた粗い段を子から作り直す（2026-11-21・東静岡〜沓谷の帯）
#   旧 encodeSpzRaw は位置を frac 12（±2048 m）で詰め、越えた位置を端に寄せて潰した＝4 km の区画の 8 m 段（中心から 2048 m より先）と
#   2022 の大きい四分の 4 m 段で、端の帯が 1 本の線に潰れていた（区画の境に帯状の穴・細かい段が届くまで地図が透ける）。
#   潰れた段は元の位置が残っていないので、子の glb（潰れていない）を読み、copc2gs.py と同じ式（セルの重心・共分散＋ばらつき・fill と cap）でまとめ直す。
#   子の点の重み（元の点の数）は glb に残らないので 1 つずつ同じ重み。tileset.json は変えない（transform・box は元のまま＝中身はその箱に収まる）
#   python3 gs-refit.py <出力> [区画,…]   … <出力>/<区画>/<名前>.glb を作る（gs-glb.mjs＝今の encodeSpzRaw で frac を自動で下げる）。上げるのは別：
#   hf upload KenjiYoshida/shizuoka-pointcloud <出力> gs/2021-LP-Original --repo-type dataset --include "*.glb"
import sys, os, json, gzip, struct, subprocess, time, urllib.request, urllib.error
import numpy as np
from concurrent.futures import ThreadPoolExecutor
HF = os.environ.get("HF_BASE", "https://huggingface.co/datasets/KenjiYoshida/shizuoka-pointcloud/resolve/main/gs/2021-LP-Original/")
OUT = sys.argv[1]; ONLY = set(sys.argv[2].split(",")) if len(sys.argv) > 2 else None
FILL, CAP, GE, LIM = 0.35, 4.0, 16, 2048.0
SH_C0 = 0.28209479177387814
os.makedirs(OUT, exist_ok=True)
def get(uri, rng=None):
    for i in range(10):
        try:
            r = urllib.request.Request(HF + uri, headers={"Range": rng} if rng else {})
            return urllib.request.urlopen(r, timeout=300).read()
        except urllib.error.HTTPError as e:
            if e.code != 429 and e.code < 500: raise
            time.sleep(min(300, 20 * (i + 1)))
        except Exception:
            time.sleep(10 * (i + 1))
    raise RuntimeError("fetch failed " + uri)
# ── glb（KHR_gaussian_splatting＋SPZ v2/v3）→ 東北上の中心・共分散 6・色 ──
def decode(b):
    jl = struct.unpack_from("<I", b, 12)[0]; j = json.loads(b[20:20 + jl]); bin0 = 20 + jl + 8
    p = j["meshes"][0]["primitives"][0]["extensions"]; bv = j["bufferViews"][next(v for k, v in p.items() if k.startswith("KHR_gaussian_splatting_compression_spz"))["bufferView"]]
    u = gzip.decompress(b[bin0 + bv.get("byteOffset", 0): bin0 + bv.get("byteOffset", 0) + bv["byteLength"]])
    magic, ver, n, shd, frac = struct.unpack_from("<IIIBB", u, 0); assert magic == 0x5053474e and ver in (2, 3), (magic, ver)
    a = np.frombuffer(u, np.uint8); o = 16
    q = a[o:o + 9 * n].reshape(n * 3, 3).astype(np.int32); o += 9 * n
    v = q[:, 0] | (q[:, 1] << 8) | (q[:, 2] << 16); v = np.where(v & 0x800000, v - (1 << 24), v)
    pos = (v / float(1 << frac)).reshape(n, 3); o += n   # 不透明度（広域 GS は全部 255）
    col = np.clip((0.5 + SH_C0 * ((a[o:o + 3 * n].reshape(n, 3) / 255 - 0.5) / 0.15)) * 255, 0, 255); o += 3 * n
    sc = np.exp(a[o:o + 3 * n].reshape(n, 3) / 16 - 10); o += 3 * n
    if ver >= 3:
        c = np.frombuffer(u[o:o + 4 * n], "<u4").astype(np.int64); big = c >> 30; qq = np.zeros((n, 4))
        rest = c.copy(); ss = np.zeros(n)
        for k in (3, 2, 1, 0):
            m = big != k; mag = rest & 511; neg = (rest >> 9) & 1; val = np.sqrt(0.5) * mag / 511; val = np.where(neg == 1, -val, val)
            qq[m, k] = val[m]; ss[m] += val[m] ** 2; rest = np.where(m, rest >> 10, rest)
        qq[np.arange(n), big] = np.sqrt(np.maximum(0, 1 - ss))
    else:
        r = a[o:o + 3 * n].reshape(n, 3) / 127.5 - 1; qq = np.concatenate([r, np.sqrt(np.maximum(0, 1 - (r ** 2).sum(1)))[:, None]], 1)
    qq /= np.linalg.norm(qq, axis=1, keepdims=True)
    x, y, z, w = qq.T
    R = np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
                  2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], -1).reshape(n, 3, 3)
    M = R * sc[:, None, :]; C = M @ M.transpose(0, 2, 1)
    P = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float)   # glTF（x=E, y=U, z=−N）→ 東北上
    C = P @ C @ P.T; ctr = pos @ P.T
    cov = np.stack([C[:, 0, 0], C[:, 0, 1], C[:, 0, 2], C[:, 1, 1], C[:, 1, 2], C[:, 2, 2]], -1)
    return ctr, cov, col, frac, np.abs(pos).max() if n else 0
# ── copc2gs.py と同じまとめ方 ──
def group(ctr, c):
    k = np.floor(ctr / c).astype(np.int64); k -= k.min(0)
    key = (k[:, 0] * 1_000_003 + k[:, 1]) * 100_003 + k[:, 2]
    u, inv = np.unique(key, return_inverse=True); return inv, len(u)
def finish(C, c):
    C[:, 0] += (FILL * c)**2; C[:, 3] += (FILL * c)**2; C[:, 5] += (FILL * c)**2
    tr = C[:, 0] + C[:, 3] + C[:, 5]; s = np.minimum(1, (CAP * c)**2 / np.maximum(tr, 1e-12)); return C * s[:, None]
def merge(ctr, cov, col, c):
    inv, m = group(ctr, c); W = np.bincount(inv, minlength=m).astype(np.float64)
    mu = np.stack([np.bincount(inv, ctr[:, k], m) for k in range(3)], -1) / W[:, None]
    d = ctr - mu[inv]; idx = ((0,0),(0,1),(0,2),(1,1),(1,2),(2,2))
    C = np.stack([np.bincount(inv, cov[:, t] + d[:, a] * d[:, b], m) for t, (a, b) in enumerate(idx)], -1) / W[:, None]
    cl = np.stack([np.bincount(inv, col[:, k], m) for k in range(3)], -1) / W[:, None]
    return mu, finish(C, c), cl
def to_quat(V):
    m = V; tr = m[:, 0, 0] + m[:, 1, 1] + m[:, 2, 2]; q = np.zeros((len(m), 4))
    s = np.sqrt(np.maximum(tr + 1, 1e-12)) * 2; a = tr > 0
    q[a] = np.stack([(m[a, 2, 1] - m[a, 1, 2]) / s[a], (m[a, 0, 2] - m[a, 2, 0]) / s[a], (m[a, 1, 0] - m[a, 0, 1]) / s[a], s[a] / 4], -1)
    for i, (j, k) in enumerate(((1, 2), (2, 0), (0, 1))):
        b = (~a) & (m[:, i, i] >= m[:, j, j]) & (m[:, i, i] >= m[:, k, k]) & np.all(q == 0, 1)
        s2 = np.sqrt(np.maximum(1 + m[b, i, i] - m[b, j, j] - m[b, k, k], 1e-12)) * 2
        r = np.zeros((b.sum(), 4)); r[:, i] = s2 / 4; r[:, j] = (m[b, j, i] + m[b, i, j]) / s2; r[:, k] = (m[b, k, i] + m[b, i, k]) / s2; r[:, 3] = (m[b, k, j] - m[b, j, k]) / s2
        q[b] = r
    return q / np.linalg.norm(q, axis=1, keepdims=True)
def write_bin(ctr, C, col, path):   # copc2gs.py の write_tile と同じ .bin（中心＝タイルの原点＝元の transform のまま）
    n = len(ctr); M = np.zeros((n, 3, 3))
    M[:, 0, 0], M[:, 0, 1], M[:, 0, 2], M[:, 1, 1], M[:, 1, 2], M[:, 2, 2] = C.T
    M[:, 1, 0], M[:, 2, 0], M[:, 2, 1] = M[:, 0, 1], M[:, 0, 2], M[:, 1, 2]
    ev, V = np.linalg.eigh(M); V[np.linalg.det(V) < 0, :, 2] *= -1
    sc = np.sqrt(np.maximum(ev, 1e-12)); q = to_quat(V)
    rgba = np.concatenate([np.clip(np.rint(col), 0, 255), np.full((n, 1), 255)], 1).astype(np.uint8)
    with open(path + ".bin", "wb") as f:
        f.write(np.uint32(n).tobytes()); f.write(ctr.astype(np.float32).tobytes()); f.write(sc.astype(np.float32).tobytes()); f.write(q.astype(np.float32).tobytes()); f.write(rgba.tobytes())
# ── 直す物＝中身（box − 余白）が原点から 2048 m を越えるタイル。深い方から（四分を直してから区画） ──
t = json.loads(get("tileset.json")); todo = []
def walk(n, depth):
    if "content" in n:
        b = n["boundingVolume"]["box"]; ge = n["geometricError"]; pad = 2 * ge / GE if ge else 1
        if max(abs(b[k]) + b[3 + 4 * k] - pad for k in range(3)) >= LIM and n.get("children") and (not ONLY or n["content"]["uri"].split("/")[0] in ONLY):
            todo.append((depth, n))
    for c in n.get("children", []): walk(c, depth + 1)
walk(t["root"], 0); todo.sort(key=lambda x: -x[0])
print("tiles to rebuild", len(todo), flush=True)
local = {}   # 作り直した uri → 手元の glb
def child_bytes(uri):
    if uri in local: return open(local[uri], "rb").read()
    return get(uri)
log = []
for _, n in todo:
    uri = n["content"]["uri"]; c = n["geometricError"] / GE; t0 = time.time()
    kids = n["children"]
    with ThreadPoolExecutor(4) as ex: blobs = list(ex.map(lambda k: child_bytes(k["content"]["uri"]), kids))
    parts = []
    for k, b in zip(kids, blobs):
        ctr, cov, col, frac, m = decode(b); off = np.array(k.get("transform", [0] * 12 + [0, 0, 0, 1])[12:15])
        parts.append((ctr + off, cov, col))
    ctr, cov, col = (np.concatenate([p[i] for p in parts]) for i in range(3))
    mu, C, cl = merge(ctr, cov, col, c)
    dst = os.path.join(OUT, uri); os.makedirs(os.path.dirname(dst), exist_ok=True)
    write_bin(mu, C, cl, dst)
    jobs = os.path.join(os.path.dirname(dst), "jobs.json"); json.dump([{"src": dst + ".bin", "dst": dst}], open(jobs, "w"))
    subprocess.run(["node", os.path.join(os.path.dirname(os.path.abspath(__file__)), "gs-glb.mjs"), jobs], check=True); os.remove(jobs)
    _, _, _, frac, m = decode(open(dst, "rb").read())
    old = decode(get(uri))
    b = n["boundingVolume"]["box"]; inbox = all(abs(mu[:, k] - b[k]).max() <= b[3 + 4 * k] + 1 for k in range(3))
    clipped_old = int((np.abs(np.abs(old[0]) - LIM) < 1e-3).any(1).sum())
    local[uri] = dst
    rec = {"uri": uri, "cell": c, "kids": len(kids), "splats_old": len(old[0]), "splats_new": len(mu), "clipped_old": clipped_old, "frac_new": frac, "max_abs_new": round(float(m), 1), "in_box": inbox, "s": round(time.time() - t0)}
    log.append(rec); print(json.dumps(rec), flush=True)
json.dump(log, open(os.path.join(OUT, "refit-log.json"), "w"), indent=1)
print("done", len(log), "not in box", [r["uri"] for r in log if not r["in_box"]])
