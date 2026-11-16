# 静岡市の広域表示の材料（2026-11-17）：県の 2021/LP/Ortho と Grid を図郭ごとに取り、縮めて保存（ortho: 0.4 m JPEG＋置き場の json、grid: 0.5 m float32 npz）
#   WORK=<作業の置き場> SHEETS=<図郭の一覧 CSV（set,key,bytes・2021/LP/Original の行の図郭）> J=16 python3 wide-fetch.py [始め 終わり]
#   取り直しは済んだ図郭を飛ばす。Grid のテキストは「番号,X,Y,標高,印」と「X Y 標高」の 2 通りがある（図郭の縁は格子が欠ける）
import csv, io, sys, zipfile, json, os, time, urllib.request, concurrent.futures as cf
import numpy as np
from PIL import Image
Image.MAX_IMAGE_PIXELS = None
SP = os.environ.get("WORK", "work")   # 作業の置き場（中間ファイル）
S3 = "https://virtual-shizuoka.s3.ap-northeast-1.amazonaws.com/"
sheets = sorted({r['key'].rsplit('/',1)[1].split('.')[0] for r in csv.DictReader(open(os.environ.get('SHEETS', 'shizuoka-city-files.csv'))) if r['set']=='2021/LP/Original'})
def get(url):
    for i in range(6):
        try:
            with urllib.request.urlopen(url, timeout=120) as r: return r.read()
        except Exception as e:
            if i == 5: raise
            time.sleep(2 * (i + 1))
def path(kind, s): return f"2021/LP/{kind}/{s[:2]}/{s[2:4]}/{s[4:6]}/{s}.zip"
def one(s):
    out_o, out_g = f"{SP}/ortho/{s}.jpg", f"{SP}/grid/{s}.npz"
    meta = {}
    if not os.path.exists(out_o):
        z = zipfile.ZipFile(io.BytesIO(get(S3 + path("Ortho", s))))
        tif = [n for n in z.namelist() if n.lower().endswith('.tif')][0]; tfw = [n for n in z.namelist() if n.lower().endswith('.tfw')][0]
        t = [float(v) for v in z.read(tfw).split()]
        im = np.asarray(Image.open(io.BytesIO(z.read(tif))).convert('RGB'), dtype=np.uint16)
        h, w = im.shape[:2]; im = im[:h//2*2, :w//2*2]
        im = ((im[0::2,0::2] + im[1::2,0::2] + im[0::2,1::2] + im[1::2,1::2] + 2) // 4).astype(np.uint8)
        Image.fromarray(im).save(out_o + ".tmp", "JPEG", quality=92); os.replace(out_o + ".tmp", out_o)
        # 左上の画素の角（中心 − 半画素）と大きさ
        json.dump({"x0": t[4] - t[0]/2, "y0": t[5] - t[3]/2, "px": t[0]*2, "w": im.shape[1], "h": im.shape[0]}, open(f"{SP}/ortho/{s}.json", "w"))
    if not os.path.exists(out_g):
        z = zipfile.ZipFile(io.BytesIO(get(S3 + path("Grid", s))))
        txt = z.read(z.namelist()[0]).decode('ascii', 'replace')
        lines = txt.replace(',', ' ').split('\n'); ncol = len(lines[0].split())
        a = np.array(' '.join(lines).split(), dtype=np.float64).reshape(-1, ncol)
        if ncol == 3: a = np.concatenate([np.zeros((len(a), 1)), a, np.zeros((len(a), 1))], 1)
        xmin, ymax = a[:,1].min(), a[:,2].max()
        ix = np.rint((a[:,1] - xmin) / 0.5).astype(int); iy = np.rint((ymax - a[:,2]) / 0.5).astype(int)
        xs, ys = [xmin], [ymax]
        g = np.full((iy.max() + 1, ix.max() + 1), np.nan, np.float32)
        v = a[:,3].astype(np.float32); v[v < -1000] = np.nan
        g[iy, ix] = v
        np.savez_compressed(out_g + ".tmp.npz", h=g, x0=xs[0] - 0.25, y0=ys[0] + 0.25, px=0.5); os.replace(out_g + ".tmp.npz", out_g)
    return s
if __name__ == "__main__":
    os.makedirs(f"{SP}/ortho", exist_ok=True); os.makedirs(f"{SP}/grid", exist_ok=True)
    todo = sheets[int(sys.argv[1]):int(sys.argv[2])] if len(sys.argv) > 2 else sheets
    t0 = time.time(); n = 0
    with cf.ThreadPoolExecutor(int(os.environ.get("J", "16"))) as ex:
        for f in cf.as_completed([ex.submit(one, s) for s in todo]):
            try: f.result(); n += 1
            except Exception as e: print("ERR", e, flush=True)
            if n % 100 == 0: print(n, len(todo), round(time.time() - t0), flush=True)
    print("done", n, round(time.time() - t0))
