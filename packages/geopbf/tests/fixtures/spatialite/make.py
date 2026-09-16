#!/usr/bin/env python3
# tests/fixtures/spatialite/make.py ── t-spatialite.mjs が読む SpatiaLite 固定資料。python3 標準 sqlite3 ＋ mod_spatialite（brew install libspatialite）。
# 生成物: mixed.sqlite  page_size 1024・places 300 点（型付き属性・overflow の長文・BLOB・NULL）・lines（XYZ・圧縮/非圧縮）・
#         polys（XYZM・穴）・multi（GEOMETRY＝MultiPoint/MultiLineString 圧縮/MultiPolygon/GeometryCollection/NULL）・
#         merc（EPSG:3857）・jpr（EPSG:6677 平面直角 IX）・tiny（TinyPoint XY）・tinyz（TinyPoint XYZ）・attrs_only（幾何なし）
# 再生成: python3 tests/fixtures/spatialite/make.py
import os, sqlite3
HERE = os.path.dirname(os.path.abspath(__file__))
path = os.path.join(HERE, "mixed.sqlite")
if os.path.exists(path): os.remove(path)
c = sqlite3.connect(path); c.enable_load_extension(True); c.load_extension("mod_spatialite")
c.execute("PRAGMA page_size=1024")
c.execute("SELECT InitSpatialMetadata(1, 'NONE')")   # 全 EPSG（数千行・8 MB）は入れず、使う 3 つだけ
for srid in (4326, 3857, 6677): c.execute("SELECT InsertEpsgSrid(?)", (srid,))
G = lambda wkt, srid=4326: f"ST_GeomFromText('{wkt}', {srid})"

c.execute("CREATE TABLE places (id INTEGER PRIMARY KEY, name TEXT, pop INTEGER, ratio REAL, flag BOOLEAN, d DATE, dt DATETIME, note TEXT, photo BLOB, nil TEXT)")
c.execute("SELECT AddGeometryColumn('places', 'geom', 4326, 'POINT', 'XY')")
for i in range(300):
    c.execute("INSERT INTO places (id, name, pop, ratio, flag, d, dt, note, photo, nil, geom) VALUES (?,?,?,?,?,?,?,?,?,?, MakePoint(?, ?, 4326))",
              (i + 1, f"駅{i}", i * 1000, i / 7, i % 2, "2026-09-16", "2026-09-16T10:00:00Z", ("n" * 5000 if i == 299 else "n" * (i % 7)), bytes([0x89, 0x50, 0x4E, 0x47]) + bytes(60), None, 139 + i * 0.001, 35 + i * 0.0005))

c.execute("CREATE TABLE lines (id INTEGER PRIMARY KEY, n TEXT)")
c.execute("SELECT AddGeometryColumn('lines', 'geom', 4326, 'LINESTRING', 'XYZ')")
c.execute(f"INSERT INTO lines VALUES (1, 'compressed', CompressGeometry({G('LINESTRING Z(139 35 1, 139.5 35.5 2, 140 36 3)')}))")
c.execute(f"INSERT INTO lines VALUES (2, 'plain', {G('LINESTRING Z(139.123456 35.654321 1, 139.223456 35.754321 2, 139.323456 35.854321 3, 139.5 36 4)')})")
c.execute(f"INSERT INTO lines VALUES (3, 'compressed-odd', CompressGeometry({G('LINESTRING Z(139.123456 35.654321 1, 139.223456 35.754321 2, 139.323456 35.854321 3, 139.5 36 4)')}))")

c.execute("CREATE TABLE polys (id INTEGER PRIMARY KEY, n TEXT)")
c.execute("SELECT AddGeometryColumn('polys', 'geom', 4326, 'POLYGON', 'XYZM')")
c.execute(f"INSERT INTO polys VALUES (1, 'hole', {G('POLYGON ZM((139 35 1 10, 140 35 1 11, 140 36 1 12, 139 36 1 13, 139 35 1 14), (139.2 35.2 1 20, 139.4 35.2 1 21, 139.4 35.4 1 22, 139.2 35.4 1 23, 139.2 35.2 1 24))')})")
c.execute(f"INSERT INTO polys VALUES (2, 'compressed', CompressGeometry({G('POLYGON ZM((0 0 0 0, 1 0 0 0, 1 1 0 0, 0 1 0 0, 0 0 0 0))')}))")

c.execute("CREATE TABLE multi (id INTEGER PRIMARY KEY, n TEXT)")
c.execute("SELECT AddGeometryColumn('multi', 'geom', 4326, 'GEOMETRY', 'XY')")
c.execute(f"INSERT INTO multi VALUES (1, 'mpoint', {G('MULTIPOINT(1 2, 3 4)')})")
c.execute(f"INSERT INTO multi VALUES (2, 'mline', CompressGeometry({G('MULTILINESTRING((1 2, 1.5 2.5, 3 4), (5 6, 7 8))')}))")
c.execute(f"INSERT INTO multi VALUES (3, 'mpoly', {G('MULTIPOLYGON(((0 0, 1 0, 1 1, 0 1, 0 0)), ((2 2, 3 2, 3 3, 2 3, 2 2), (2.2 2.2, 2.4 2.2, 2.4 2.4, 2.2 2.4, 2.2 2.2)))')})")
c.execute(f"INSERT INTO multi VALUES (4, 'gc', {G('GEOMETRYCOLLECTION(POINT(1 2), LINESTRING(1 2, 3 4))')})")
c.execute("INSERT INTO multi VALUES (5, 'null', NULL)")

c.execute("CREATE TABLE merc (id INTEGER PRIMARY KEY, n TEXT)")
c.execute("SELECT AddGeometryColumn('merc', 'geom', 3857, 'POINT', 'XY')")
c.execute("INSERT INTO merc VALUES (1, 'tokyo', ST_Transform(MakePoint(139.7, 35.7, 4326), 3857))")
c.execute("CREATE TABLE jpr (id INTEGER PRIMARY KEY, n TEXT)")
c.execute("SELECT AddGeometryColumn('jpr', 'geom', 6677, 'POINT', 'XY')")
c.execute("INSERT INTO jpr VALUES (1, 'tokyo', ST_Transform(MakePoint(139.7, 35.7, 4326), 6677))")

c.execute("CREATE TABLE tiny (id INTEGER PRIMARY KEY, n TEXT)")
c.execute("SELECT AddGeometryColumn('tiny', 'geom', 4326, 'POINT', 'XY')")
c.execute("INSERT INTO tiny VALUES (1, 'tp', TinyPointEncode(MakePoint(139.5, 35.5, 4326)))")
c.execute("CREATE TABLE tinyz (id INTEGER PRIMARY KEY, n TEXT)")
c.execute("SELECT AddGeometryColumn('tinyz', 'geom', 4326, 'POINT', 'XYZ')")
c.execute("INSERT INTO tinyz VALUES (1, 'tpz', TinyPointEncode(MakePointZ(139.5, 35.5, 7, 4326)))")

c.execute("CREATE TABLE attrs_only (id INTEGER PRIMARY KEY, n TEXT)")
c.execute("INSERT INTO attrs_only VALUES (1, 'x')")
c.commit()
c.execute("VACUUM")
chk = {t: c.execute(f"SELECT count(*), typeof(geom) FROM {t}").fetchone() for t in ["places", "lines", "polys", "multi", "merc", "jpr", "tiny", "tinyz"]}
mp = c.execute("SELECT X(geom), Y(geom) FROM merc").fetchone(); jp = c.execute("SELECT X(geom), Y(geom) FROM jpr").fetchone()
tp = c.execute("SELECT hex(geom) FROM tiny").fetchone()[0]
c.close()
print("wrote", path, os.path.getsize(path), "bytes", chk, "merc", mp, "jpr", jp, "tiny", tp[:8])
