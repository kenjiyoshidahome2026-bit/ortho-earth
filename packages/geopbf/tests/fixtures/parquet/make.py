# tests/fixtures/parquet/make.py ── t-parquet-encodings の固定具を pyarrow で作る（結果は commit 済み・検定は pyarrow 無しで走る）。
#   python3 -m venv v && v/bin/pip install pyarrow && v/bin/python make.py   （pyarrow 26.0.0 で作成・2026-10-12）
# 読み手が対応する符号化（DELTA_BINARY_PACKED / DELTA_LENGTH_BYTE_ARRAY / DELTA_BYTE_ARRAY / BYTE_STREAM_SPLIT / RLE boolean / INT96）と
# 入れ子の葉名 "a.b" の衝突を、他所の writer が実際に書く形で用意する。expected.json が正解。
import json, random, datetime, os
import pyarrow as pa, pyarrow.parquet as pq
here = os.path.dirname(os.path.abspath(__file__))
rnd = random.Random(7)
N = 1000
def opt(xs, every=7): return [None if i % every == 3 else x for i, x in enumerate(xs)]
i32 = opt([rnd.randint(-2**31, 2**31 - 1) if i % 50 == 0 else i * 3 - 100 for i in range(N)])
i64 = opt([(-1) ** i * rnd.randint(0, 2**52) if i % 10 == 0 else 2**40 + i for i in range(N)])
words = ["tokyo", "tokyo-to", "tokyo-to-chiyoda", "osaka", "osaka-fu", "東京", "東京都", "", "kyoto", "kyoto-fu-kyoto-shi"]
s = opt([words[i % len(words)] + ("" if i % 3 else str(i)) for i in range(N)])
s2 = opt([("x" * (i % 17)) + str(i) for i in range(N)])
f32 = opt([float(i) / 8 for i in range(N)])
f64 = opt([rnd.random() * 1e6 - 5e5 for i in range(N)])
b = opt([(i * 7) % 3 == 0 for i in range(N)], 11)
fixed = opt([bytes([i % 256, (i * 3) % 256, (i * 5) % 256, 0]) for i in range(N)])
t = pa.table({
    "i32": pa.array(i32, pa.int32()), "i64": pa.array(i64, pa.int64()),
    "s": pa.array(s, pa.string()), "s2": pa.array(s2, pa.string()),
    "f32": pa.array(f32, pa.float32()), "f64": pa.array(f64, pa.float64()),
    "b": pa.array(b, pa.bool_()), "fixed": pa.array(fixed, pa.binary(4)),
})
enc = {"i32": "DELTA_BINARY_PACKED", "i64": "DELTA_BINARY_PACKED", "s": "DELTA_BYTE_ARRAY", "s2": "DELTA_LENGTH_BYTE_ARRAY",
       "f32": "BYTE_STREAM_SPLIT", "f64": "BYTE_STREAM_SPLIT", "b": "RLE", "fixed": "DELTA_BYTE_ARRAY"}
pq.write_table(t, os.path.join(here, "encodings-v2.parquet"), use_dictionary=False, column_encoding=enc, compression="none",
               data_page_version="2.0", row_group_size=600, data_page_size=2048, write_statistics=True)
pq.write_table(t, os.path.join(here, "encodings-v1-snappy.parquet"), use_dictionary=False, column_encoding=enc, compression="snappy",
               data_page_version="1.0", row_group_size=600, data_page_size=2048)
# INT96 timestamp（旧式）＋ 普通の timestamp
ts = opt([datetime.datetime(2020, 1, 1) + datetime.timedelta(seconds=i * 86401, milliseconds=i * 7) for i in range(N)], 5)
t96 = pa.table({"ts": pa.array(ts, pa.timestamp("ms")), "k": pa.array(list(range(N)), pa.int32())})
pq.write_table(t96, os.path.join(here, "int96.parquet"), use_deprecated_int96_timestamps=True, compression="none")
# 入れ子の葉 a/b と実在の "a.b" 列
tc = pa.table({"a": pa.array([{"b": i} for i in range(5)], pa.struct([("b", pa.int32())])), "a.b": pa.array(["x%d" % i for i in range(5)])})
pq.write_table(tc, os.path.join(here, "collide.parquet"), compression="none")
def f32r(v): return None if v is None else float(pa.array([v], pa.float32())[0].as_py())
exp = {"n": N, "i32": i32, "i64": i64, "s": s, "s2": s2, "f32": [f32r(v) for v in f32], "f64": f64, "b": b,
       "fixed": [None if v is None else list(v) for v in fixed],
       "ts": [None if v is None else int(v.timestamp() * 1000) for v in ts], "k": list(range(N)),
       "collide": {"a.b": list(range(5)), "a.b#2": ["x%d" % i for i in range(5)]}}
json.dump(exp, open(os.path.join(here, "expected.json"), "w"), separators=(",", ":"))
for f in os.listdir(here):
    if f.endswith(".parquet"):
        md = pq.ParquetFile(os.path.join(here, f)).metadata
        print(f, os.path.getsize(os.path.join(here, f)), "B", md.num_row_groups, "row groups", [md.row_group(0).column(i).encodings for i in range(md.num_columns)])
