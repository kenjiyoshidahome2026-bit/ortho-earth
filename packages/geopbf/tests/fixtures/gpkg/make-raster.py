#!/usr/bin/env python3
# tests/fixtures/gpkg/make-raster.py ── 地理院タイルからラスタ GeoPackage を組む（python3 標準のみ・GDAL 不要）。
# 出力: gsi-tokyo.gpkg  東京駅周辺・EPSG:3857・全世界格子（tile_row = XYZ の y）・2 表
#   std    標準地図 PNG  z10–14   https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png
#   photo  全国最新写真（シームレス）JPEG z12–14   .../xyz/seamlessphoto/{z}/{x}/{y}.jpg
# 出典: 国土地理院 地理院タイル（https://maps.gsi.go.jp/development/ichiran.html）。gpkg_contents.description に明記。
# 再生成: python3 tests/fixtures/gpkg/make-raster.py  （取得は数十枚・0.1 秒間隔）
import os, sqlite3, math, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "gsi-tokyo.gpkg")
BBOX = (139.74, 35.66, 139.79, 35.70)          # lon0 lat0 lon1 lat1（東京駅〜皇居〜日本橋）
ORIGIN = 20037508.342789244                   # 3857 の世界半幅
UA = "ortho-earth geopbf fixture builder (https://www.ortho-earth.com/)"

def tile_xy(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    y = int((1 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat))) / math.pi) / 2 * n)
    return x, y
def merc(lon, lat):
    R = 6378137.0
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r: return r.read()

def add_tiles(c, table, url_fmt, zooms, ident, desc):
    c.execute(f'''CREATE TABLE "{table}" (id INTEGER PRIMARY KEY AUTOINCREMENT, zoom_level INTEGER NOT NULL, tile_column INTEGER NOT NULL,
      tile_row INTEGER NOT NULL, tile_data BLOB NOT NULL, UNIQUE (zoom_level, tile_column, tile_row))''')
    c.execute("INSERT INTO gpkg_tile_matrix_set VALUES (?,?,?,?,?,?)", (table, 3857, -ORIGIN, -ORIGIN, ORIGIN, ORIGIN))
    n_total = 0
    for z in zooms:
        x0, y0 = tile_xy(BBOX[0], BBOX[3], z); x1, y1 = tile_xy(BBOX[2], BBOX[1], z)
        px = 2 * ORIGIN / (256 * 2 ** z)
        c.execute("INSERT INTO gpkg_tile_matrix VALUES (?,?,?,?,?,?,?,?)", (table, z, 2 ** z, 2 ** z, 256, 256, px, px))
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                data = fetch(url_fmt.format(z=z, x=x, y=y))
                c.execute(f'INSERT INTO "{table}" (zoom_level, tile_column, tile_row, tile_data) VALUES (?,?,?,?)', (z, x, y, data))
                n_total += 1; time.sleep(0.1)
        print(f"  {table} z{z}: {(x1 - x0 + 1) * (y1 - y0 + 1)} tiles")
    mx0, my0 = merc(BBOX[0], BBOX[1]); mx1, my1 = merc(BBOX[2], BBOX[3])
    c.execute("INSERT INTO gpkg_contents (table_name,data_type,identifier,description,last_change,min_x,min_y,max_x,max_y,srs_id) VALUES (?,?,?,?,?,?,?,?,?,?)",
              (table, "tiles", ident, desc, "2026-09-12T00:00:00.000Z", mx0, my0, mx1, my1, 3857))
    return n_total

def main():
    if os.path.exists(OUT): os.remove(OUT)
    c = sqlite3.connect(OUT)
    c.execute("PRAGMA application_id=1196444487"); c.execute("PRAGMA user_version=10300")
    c.executescript("""
    CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL,
      organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT);
    CREATE TABLE gpkg_contents (table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER);
    CREATE TABLE gpkg_tile_matrix_set (table_name TEXT NOT NULL PRIMARY KEY, srs_id INTEGER NOT NULL, min_x DOUBLE NOT NULL, min_y DOUBLE NOT NULL,
      max_x DOUBLE NOT NULL, max_y DOUBLE NOT NULL);
    CREATE TABLE gpkg_tile_matrix (table_name TEXT NOT NULL, zoom_level INTEGER NOT NULL, matrix_width INTEGER NOT NULL, matrix_height INTEGER NOT NULL,
      tile_width INTEGER NOT NULL, tile_height INTEGER NOT NULL, pixel_x_size DOUBLE NOT NULL, pixel_y_size DOUBLE NOT NULL,
      CONSTRAINT pk_ttm PRIMARY KEY (table_name, zoom_level));
    """)
    c.executemany("INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)", [
        ("Undefined cartesian SRS", -1, "NONE", -1, "undefined", None),
        ("Undefined geographic SRS", 0, "NONE", 0, "undefined", None),
        ("WGS 84 geodetic", 4326, "EPSG", 4326, 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]', None),
        ("WGS 84 / Pseudo-Mercator", 3857, "EPSG", 3857, 'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]', None),
    ])
    n = add_tiles(c, "std", "https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png", range(10, 15), "GSI std", "地理院タイル 標準地図（出典: 国土地理院）")
    n += add_tiles(c, "photo", "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg", range(12, 15), "GSI seamlessphoto", "地理院タイル 全国最新写真（シームレス）（出典: 国土地理院）")
    c.commit(); c.execute("VACUUM"); c.close()
    print(OUT, os.path.getsize(OUT), "bytes,", n, "tiles")

main()
