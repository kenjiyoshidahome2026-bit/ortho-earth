#!/usr/bin/env python3
# tests/fixtures/gpkg/make.py ── t-gpkg.mjs が読む GeoPackage 固定資料を組む（python3 標準の sqlite3 だけ・GDAL 不要）。
# 生成物は決定的（時刻は固定文字列）。再生成: python3 tests/fixtures/gpkg/make.py
#   mixed.gpkg  page_size 1024・places 1200 点（多段 B-tree・overflow ページ・rowid 別名 fid・型付き属性・BLOB 列）
#               shapes（全ジオメトリ種・穴・Z・null・empty フラグ・BE envelope）・merc（EPSG:3857）・attrs_only（非地物表）
#               ＋ view・rtree 索引（GDAL が書くのと同じ影表）・gpkg_extensions
#   utf16.gpkg  PRAGMA encoding=UTF-16le・INTEGER PRIMARY KEY を明示 id で
#   tiny.gpkg   ラスタ（タイル表）＝3857 全世界格子の単色 PNG 7 枚（歯抜け）＋ 4326 世界格子 2 枚。地理院タイルの実物は make-raster.py
import os, sqlite3, struct, math

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- WKB（LE） -------------------------------------------------------------
T = {"Point": 1, "LineString": 2, "Polygon": 3, "MultiPoint": 4, "MultiLineString": 5, "MultiPolygon": 6, "GeometryCollection": 7}
def wkb(g, z=False, be=False):
    e = ">" if be else "<"; bo = b"\x00" if be else b"\x01"
    def pt(c): return struct.pack(e + ("ddd" if z else "dd"), *c[:3] if z else c[:2])
    def ring(r): return struct.pack(e + "I", len(r)) + b"".join(pt(c) for c in r)
    t = T[g["type"]] + (1000 if z else 0)
    head = bo + struct.pack(e + "I", t)
    if g["type"] == "Point": return head + pt(g["coordinates"])
    if g["type"] == "LineString": return head + ring(g["coordinates"])
    if g["type"] == "Polygon": return head + struct.pack(e + "I", len(g["coordinates"])) + b"".join(ring(r) for r in g["coordinates"])
    if g["type"] == "GeometryCollection": return head + struct.pack(e + "I", len(g["geometries"])) + b"".join(wkb(x, z, be) for x in g["geometries"])
    inner = {"MultiPoint": "Point", "MultiLineString": "LineString", "MultiPolygon": "Polygon"}[g["type"]]
    return head + struct.pack(e + "I", len(g["coordinates"])) + b"".join(wkb({"type": inner, "coordinates": c}, z, be) for c in g["coordinates"])

def coords(g):
    if g["type"] == "GeometryCollection":
        for x in g["geometries"]: yield from coords(x)
    else:
        def walk(c):
            if isinstance(c[0], (int, float)): yield c
            else:
                for x in c: yield from walk(x)
        yield from walk(g["coordinates"])

# GeoPackage 幾何 BLOB: "GP" ver flags srs_id [envelope] wkb
def gpb(g, srs=4326, env=True, be_env=False, z=False, empty=False, wkb_be=False):
    flags = (0 if be_env else 1) | ((1 if env else 0) << 1) | ((1 if empty else 0) << 4)
    e = ">" if be_env else "<"
    out = b"GP\x00" + bytes([flags]) + struct.pack(e + "i", srs)
    if env:
        cs = list(coords(g)); xs = [c[0] for c in cs]; ys = [c[1] for c in cs]
        out += struct.pack(e + "dddd", min(xs), max(xs), min(ys), max(ys))
    return out + wkb(g, z=z, be=wkb_be)

# ---- GeoPackage の骨格 -----------------------------------------------------
def skeleton(c, page_size=None, encoding=None):
    if encoding: c.execute(f"PRAGMA encoding='{encoding}'")
    if page_size: c.execute(f"PRAGMA page_size={page_size}")
    c.execute("PRAGMA application_id=1196444487")   # 'GPKG'
    c.execute("PRAGMA user_version=10300")
    c.executescript("""
    CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL,
      organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);
    CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
      srs_id INTEGER, CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
    CREATE TABLE gpkg_geometry_columns (table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
      z TINYINT NOT NULL, m TINYINT NOT NULL, CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name));
    """)
    c.executemany("INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)", [
        ("Undefined cartesian SRS", -1, "NONE", -1, "undefined", "undefined cartesian coordinate reference system"),
        ("Undefined geographic SRS", 0, "NONE", 0, "undefined", "undefined geographic coordinate reference system"),
        ("WGS 84 geodetic", 4326, "EPSG", 4326, 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]', "longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid"),
        ("WGS 84 / Pseudo-Mercator", 3857, "EPSG", 3857, 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84"]]', None),
    ])

def add_layer(c, table, gtype, srs, features, cols, ident=None, desc="", z=0, rtree=False, pk="fid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL"):
    # features: [(geom_blob|None, {col: val})]
    c.execute(f'CREATE TABLE "{table}" ({pk}, "geom" {gtype}, {", ".join(cols)})')
    names = [x.split()[0].strip('"') for x in cols]
    for blob, props in features:
        c.execute(f'INSERT INTO "{table}" ("geom", {", ".join(chr(34)+n+chr(34) for n in names)}) VALUES ({",".join("?"*(len(names)+1))})',
                  [blob] + [props.get(n) for n in names])
    c.execute("INSERT INTO gpkg_contents (table_name,data_type,identifier,description,last_change,min_x,min_y,max_x,max_y,srs_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
              (table, "features", ident or table, desc, "2026-09-12T00:00:00.000Z", None, None, None, None, srs))
    c.execute("INSERT INTO gpkg_geometry_columns VALUES (?,?,?,?,?,?)", (table, "geom", gtype, srs, z, 0))
    if rtree:
        c.executescript(f"""
        CREATE VIRTUAL TABLE "rtree_{table}_geom" USING rtree(id, minx, maxx, miny, maxy);
        CREATE TRIGGER "rtree_{table}_geom_insert" AFTER INSERT ON "{table}" WHEN (new."geom" NOT NULL AND NOT ST_IsEmpty(NEW."geom"))
          BEGIN INSERT OR REPLACE INTO "rtree_{table}_geom" VALUES (NEW.fid, ST_MinX(NEW."geom"), ST_MaxX(NEW."geom"), ST_MinY(NEW."geom"), ST_MaxY(NEW."geom")); END;
        """)
        c.executemany(f'INSERT INTO "rtree_{table}_geom" VALUES (?,?,?,?,?)', [(i + 1, 0, 1, 0, 1) for i in range(5)])
        c.execute("CREATE TABLE IF NOT EXISTS gpkg_extensions (table_name TEXT, column_name TEXT, extension_name TEXT NOT NULL, definition TEXT NOT NULL, scope TEXT NOT NULL)")
        c.execute("INSERT INTO gpkg_extensions VALUES (?,?,?,?,?)", (table, "geom", "gpkg_rtree_index", "http://www.geopackage.org/spec120/#extension_rtree", "write-only"))

def mixed():
    path = os.path.join(HERE, "mixed.gpkg")
    if os.path.exists(path): os.remove(path)
    c = sqlite3.connect(path)
    skeleton(c, page_size=1024)
    # places: 1200 点＝多段 B-tree。先頭 5 行は検定用の固定値、以降は決定的な生成
    feats = []
    fixed = [
        ({"name": "東京駅", "pop": 1_000_000, "ratio": 0.5, "flag": 1, "d": "2026-09-12", "dt": "2026-09-12T01:02:03Z", "big": 2**40 + 7, "note": "n" * 5000, "photo": b"\x89PNG\r\n\x1a\n" + bytes(range(256)), "nothing": None}, [139.767125, 35.681236]),
        ({"name": "Ōsaka", "pop": -42, "ratio": -1.25, "flag": 0, "d": None, "dt": None, "big": -(2**40), "note": "", "photo": None, "nothing": None}, [135.5, 34.7]),
        ({"name": "zero", "pop": 0, "ratio": 0.0, "flag": None, "d": "1970-01-02", "dt": "1970-01-01T00:00:00Z", "big": 0, "note": None, "photo": None, "nothing": None}, [0, 0]),
        ({"name": "int8/16/24/32/48 境目", "pop": 127, "ratio": 1.0, "flag": 1, "d": None, "dt": None, "big": 2**31, "note": "a", "photo": None, "nothing": None}, [-179.999999, -89.999999]),
        ({"name": "quote \"and\" 'apos'", "pop": 32767, "ratio": 1e300, "flag": 0, "d": None, "dt": None, "big": 2**47, "note": None, "photo": None, "nothing": None}, [179.999999, 89.999999]),
    ]
    for props, xy in fixed: feats.append((gpb({"type": "Point", "coordinates": xy}), props))
    for i in range(5, 1200):
        x = round(-180 + (i * 37 % 3600) / 10, 6); y = round(-85 + (i * 53 % 1700) / 10, 6)
        feats.append((gpb({"type": "Point", "coordinates": [x, y]}, env=(i % 2 == 0)),
                      {"name": f"p{i}", "pop": i * 1000, "ratio": i / 7, "flag": i % 2, "d": None, "dt": None, "big": i * 2**33, "note": None, "photo": None, "nothing": None}))
    add_layer(c, "places", "POINT", 4326, feats,
              ['"name" TEXT', '"pop" INTEGER', '"ratio" REAL', '"flag" BOOLEAN', '"d" DATE', '"dt" DATETIME', '"big" INTEGER', '"note" TEXT(8000)', '"photo" BLOB', '"nothing" TEXT'],
              ident="Places", desc="1200 points", rtree=True)
    c.execute('CREATE VIEW v_places AS SELECT fid, name FROM places')
    # shapes: 全種
    sq = lambda x0, y0, x1, y1: [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]
    shp = [
        (gpb({"type": "Polygon", "coordinates": [sq(139.5, 35.5, 139.8, 35.8), sq(139.6, 35.6, 139.7, 35.7)]}), {"kind": "polygon+hole"}),
        (gpb({"type": "MultiPolygon", "coordinates": [[sq(15, 15, 16, 16)], [sq(20, 20, 21, 21)]]}, be_env=True), {"kind": "multipolygon(BE envelope)"}),
        (gpb({"type": "LineString", "coordinates": [[139.5, 35.5], [139.65, 35.3], [139.8, 35.5]]}, env=False), {"kind": "line(no envelope)"}),
        (gpb({"type": "MultiLineString", "coordinates": [[[0.5, 0.5], [1, 1]], [[2, 2], [3, 4]]]}), {"kind": "multiline"}),
        (gpb({"type": "MultiPoint", "coordinates": [[1, 1], [2, 2]]}), {"kind": "multipoint"}),
        (gpb({"type": "GeometryCollection", "geometries": [{"type": "Point", "coordinates": [5, 5]}, {"type": "LineString", "coordinates": [[5, 5], [6, 6]]}]}), {"kind": "collection"}),
        (gpb({"type": "Point", "coordinates": [140.1, 36.1, 123.4]}, z=True), {"kind": "pointZ"}),
        (gpb({"type": "Polygon", "coordinates": [sq(10, 10, 11, 11)]}, wkb_be=True), {"kind": "polygon(BE wkb)"}),
        (None, {"kind": "null geometry"}),
        (b"GP\x00" + bytes([0x11]) + struct.pack("<i", 4326) + b"\x01\x01\x00\x00\x00" + struct.pack("<dd", math.nan, math.nan), {"kind": "empty flag"}),
    ]
    add_layer(c, "shapes", "GEOMETRY", 4326, shp, ['"kind" TEXT'], desc="all geometry kinds")
    # merc: EPSG:3857 の点（東京駅・null island）
    R = 6378137.0
    def merc(lon, lat): return [R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))]
    add_layer(c, "merc", "POINT", 3857, [
        (gpb({"type": "Point", "coordinates": merc(139.767125, 35.681236)}, srs=3857), {"name": "tokyo"}),
        (gpb({"type": "Point", "coordinates": [0, 0]}, srs=3857), {"name": "null island"}),
    ], ['"name" TEXT'])
    # 非地物表
    c.execute('CREATE TABLE attrs_only (id INTEGER PRIMARY KEY, v TEXT)')
    c.execute("INSERT INTO attrs_only VALUES (1,'x')")
    c.execute("INSERT INTO gpkg_contents (table_name,data_type,identifier,last_change) VALUES ('attrs_only','attributes','attrs_only','2026-09-12T00:00:00.000Z')")
    c.commit(); c.execute("VACUUM"); c.close()
    print(path, os.path.getsize(path), "bytes")

def utf16():
    path = os.path.join(HERE, "utf16.gpkg")
    if os.path.exists(path): os.remove(path)
    c = sqlite3.connect(path)
    skeleton(c, encoding="UTF-16le")
    c.execute('CREATE TABLE pts ("id" INTEGER PRIMARY KEY, geom POINT, "名前" TEXT, n INTEGER)')
    c.execute('INSERT INTO pts VALUES (7, ?, ?, ?)', (gpb({"type": "Point", "coordinates": [139.767125, 35.681236]}), "東京", 1))
    c.execute('INSERT INTO pts VALUES (9, ?, ?, ?)', (gpb({"type": "Point", "coordinates": [135.5, 34.7]}), "大阪 🗼", 2))
    c.execute("INSERT INTO gpkg_contents (table_name,data_type,identifier,last_change,srs_id) VALUES ('pts','features','pts','2026-09-12T00:00:00.000Z',4326)")
    c.execute("INSERT INTO gpkg_geometry_columns VALUES ('pts','geom','POINT',4326,0,0)")
    c.commit(); c.close()
    print(path, os.path.getsize(path), "bytes")

import zlib
def png_solid(w, h, rgb):
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

def raster():
    # tiny.gpkg: 3857 全世界格子（XYZ 同型）の "tiny"（z0:1・z1:4・z2:2 枚＝歯抜け）と、4326 世界格子（2×1）の "geo"＝xyz でない例
    path = os.path.join(HERE, "tiny.gpkg")
    if os.path.exists(path): os.remove(path)
    c = sqlite3.connect(path)
    skeleton(c, page_size=1024)
    c.executescript("""
    CREATE TABLE gpkg_tile_matrix_set (table_name TEXT NOT NULL PRIMARY KEY, srs_id INTEGER NOT NULL, min_x DOUBLE NOT NULL, min_y DOUBLE NOT NULL, max_x DOUBLE NOT NULL, max_y DOUBLE NOT NULL);
    CREATE TABLE gpkg_tile_matrix (table_name TEXT NOT NULL, zoom_level INTEGER NOT NULL, matrix_width INTEGER NOT NULL, matrix_height INTEGER NOT NULL,
      tile_width INTEGER NOT NULL, tile_height INTEGER NOT NULL, pixel_x_size DOUBLE NOT NULL, pixel_y_size DOUBLE NOT NULL, CONSTRAINT pk_ttm PRIMARY KEY (table_name, zoom_level));
    """)
    W = 20037508.342789244
    def tile_table(name, srs, ext, mats, tiles, ident):
        c.execute(f'CREATE TABLE "{name}" (id INTEGER PRIMARY KEY AUTOINCREMENT, zoom_level INTEGER NOT NULL, tile_column INTEGER NOT NULL, tile_row INTEGER NOT NULL, tile_data BLOB NOT NULL, UNIQUE (zoom_level, tile_column, tile_row))')
        c.execute("INSERT INTO gpkg_tile_matrix_set VALUES (?,?,?,?,?,?)", (name, srs, *ext))
        for z, w, h in mats: c.execute("INSERT INTO gpkg_tile_matrix VALUES (?,?,?,?,?,?,?,?)", (name, z, w, h, 256, 256, (ext[2] - ext[0]) / (256 * w), (ext[3] - ext[1]) / (256 * h)))
        for z, x, y, rgb in tiles: c.execute(f'INSERT INTO "{name}" (zoom_level, tile_column, tile_row, tile_data) VALUES (?,?,?,?)', (z, x, y, png_solid(256, 256, rgb)))
        c.execute("INSERT INTO gpkg_contents (table_name,data_type,identifier,description,last_change,min_x,min_y,max_x,max_y,srs_id) VALUES (?,?,?,?,?,?,?,?,?,?)", (name, "tiles", ident, "synthetic", "2026-09-12T00:00:00.000Z", *ext, srs))
    tile_table("tiny", 3857, (-W, -W, W, W), [(0, 1, 1), (1, 2, 2), (2, 4, 4)],
               [(0, 0, 0, (255, 0, 0)), (1, 0, 0, (0, 255, 0)), (1, 1, 0, (0, 0, 255)), (1, 0, 1, (255, 255, 0)), (1, 1, 1, (0, 255, 255)), (2, 3, 1, (255, 0, 255)), (2, 1, 2, (10, 20, 30))], "Tiny")
    tile_table("geo", 4326, (-180, -90, 180, 90), [(0, 2, 1)], [(0, 0, 0, (1, 2, 3)), (0, 1, 0, (4, 5, 6))], "Geo")
    c.commit(); c.execute("VACUUM"); c.close()
    print(path, os.path.getsize(path), "bytes")

mixed(); utf16(); raster()
