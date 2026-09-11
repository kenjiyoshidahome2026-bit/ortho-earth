# seed/terrains.csv を作る。基準＝「世界の優秀な高校生が知っている地形」（Kenji 2026-09-11）。
#   骨格＝Natural Earth 10m（v5.1.2 固定）の scalerank（地図帳での目立ち度）で機械的に選ぶ → wikidataid で Wikidata に結ぶ
#   → seed/terrains-manual.json（追加・除外・分類の上書き・形状の結合・手書き軸線）を重ねる
#   → 英語版 Wikipedia の記事が無いものは落とす（「wiki に無いものはいらない」）。位置は Wikidata P625、無ければ NE の代表点（lon/lat 列）
#   出力列: qid, category, name_en（enwiki 記事名・同名は括弧で区別）, ne_extra, axis, rank（NE scalerank）, lon, lat（NE の代表点）
#   使い方: python3 scripts/terrains-from-ne.py   （NE は .cache/ne/ に取得・再利用）
import json, csv, os, sys, urllib.request, urllib.parse, time, collections, re
os.chdir(os.path.dirname(os.path.abspath(__file__)) + "/..")
UA = "ortho-earth-world-build/2.0 (kenji.yoshida.home.2026@gmail.com)"
NE_TAG = "v5.1.2"
NE = ["ne_10m_geography_regions_polys", "ne_10m_geography_regions_points", "ne_10m_geography_regions_elevation_points", "ne_10m_geography_marine_polys", "ne_10m_lakes", "ne_10m_rivers_lake_centerlines_scale_rank"]
def fetch(url, path=None):
    for i in range(4):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': UA}), timeout=120); b = r.read()
            if path: open(path, 'wb').write(b)
            return json.loads(b)
        except Exception as e: print('  retry', i, e, file=sys.stderr); time.sleep(2 * (i + 1))
    raise SystemExit('fetch failed: ' + url)
def ne(name):
    os.makedirs('.cache/ne', exist_ok=True); p = f'.cache/ne/{name}.{NE_TAG}.geojson'
    g = json.load(open(p)) if os.path.exists(p) else fetch(f'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/{NE_TAG}/geojson/{name}.geojson', p)
    for f in g['features']: f['properties'] = {k.lower(): v for k, v in f['properties'].items()}
    return g['features']
def rep_point(g):   # 代表点: Point はそのまま・線は中間頂点・面は最大リングの頂点平均
    t, c = g['type'], g['coordinates']
    if t == 'Point': return c
    if t == 'LineString': return c[len(c) // 2]
    if t == 'MultiLineString': l = max(c, key=len); return l[len(l) // 2]
    rings = [p[0] for p in c] if t == 'MultiPolygon' else [c[0]]
    r = max(rings, key=len); return [sum(p[0] for p in r) / len(r), sum(p[1] for p in r) / len(r)]

M = json.load(open('seed/terrains-manual.json', encoding='utf-8'))
nations = {r['qid'] for r in csv.DictReader(open('seed/nations.csv', encoding='utf-8'))}
regions, points, elev, marine, lakes, rivers = [ne(n) for n in NE]
sel = {}   # qid → dict(category, rank, ne_name, lon, lat)
ALIAS = M.get('alias', {})   # NE の wikidataid が英語記事の無い重複項目を指す時、正規の項目へ読み替える（Q15120268 → Q1978 プリンスエドワード島 など）
def pick(f, cat, rank):
    p = f['properties']; q = p.get('wikidataid'); q = ALIAS.get(q, q)
    if not q or not f.get('geometry'): return
    if q in nations and q not in M.get('allow_nation', []): return   # 国そのもの（Japan・Kiribati…）は NationDB 側
    if q not in sel or rank < sel[q]['rank']:
        lon, lat = rep_point(f['geometry']); sel[q] = dict(category=cat, rank=rank, ne_name=p.get('name_en') or p.get('name'), lon=round(lon, 3), lat=round(lat, 3))
ANT = lambda p: p.get('region') == 'Antarctica'
ANT_OK = {'Transantarctic Mountains', 'Ellsworth Mountains', 'Antarctic Plateau', 'East Antarctica', 'West Antarctica', 'Alexander Island'}
# 1) 地形ポリゴン
POLY = {'Range/mtn': ('range', 4), 'Plateau': ('plateau', 4), 'Desert': ('desert', 4), 'Pen/cape': ('peninsula', 4), 'Peninsula': ('peninsula', 5), 'Island': ('island', 4), 'Island group': ('islands', 3),
        'Geoarea': ('region', 2), 'Tundra': ('region', 1), 'Plain': ('plain', 3), 'Lowland': ('plain', 3), 'Delta': ('delta', 4), 'Basin': ('basin', 4), 'Depression': ('basin', 5), 'Valley': ('valley', 5), 'Gorge': ('valley', 4),
        'Isthmus': ('isthmus', 3), 'Wetlands': ('wetland', 5), 'Continent': ('continent', 0)}
for f in regions:
    p = f['properties']; m = POLY.get(p['featurecla']); sr = p.get('scalerank')
    if not m or sr is None or sr > m[1]: continue
    if ANT(p) and (p.get('name_en') not in ANT_OK): continue
    pick(f, m[0], sr)
# 2) 海域
MAR = {'ocean': ('ocean', 0), 'sea': ('sea', 5), 'gulf': ('bay', 4), 'bay': ('bay', 4), 'sound': ('bay', 4), 'fjord': ('bay', 4), 'lagoon': ('bay', 6), 'river': ('bay', 4), 'strait': ('strait', 5), 'channel': ('strait', 5), 'reef': ('reef', 5)}
for f in marine:
    p = f['properties']; m = MAR.get(p['featurecla'])
    if m and p['scalerank'] <= m[1]: pick(f, m[0], p['scalerank'])
# 3) 湖（面積基準の scalerank）
for f in lakes:
    if f['properties']['scalerank'] <= 3: pick(f, 'lake', f['properties']['scalerank'])
# 4) 標高点（山）・峠
for f in elev:
    p = f['properties']
    if p['featurecla'] == 'mountain' and p['scalerank'] <= 3 and not ANT(p): pick(f, 'peak', p['scalerank'])
    if p['featurecla'] == 'pass' and p['scalerank'] <= 3: pick(f, 'pass', p['scalerank'])
# 5) 点（岬・滝）
for f in points:
    p = f['properties']
    if p['featurecla'] == 'cape' and p['scalerank'] <= 3: pick(f, 'cape', p['scalerank'])
    if p['featurecla'] == 'waterfall': pick(f, 'waterfall', p['scalerank'])
# 6) 川＝QID ごとの最小 scalerank ≤4（5 は手動層で名指し）。結合先（merge の値側）は単独では入れない
merged_into = {x for xs in M['merge'].values() for x in xs}
rmin = {}
for f in rivers:
    p = f['properties']; q = ALIAS.get(p.get('wikidataid'), p.get('wikidataid'))
    if not q or p['featurecla'] == 'Canal': continue
    if q not in rmin or p['scalerank'] < rmin[q][0]: rmin[q] = (p['scalerank'], f)
for q, (sr, f) in rmin.items():
    if sr <= 4 and q not in merged_into: pick(f, 'river', sr)
# 6b) NE の名指し追加（閾値外でも入れる）: manual.add_ne = { NE name_en: category }
for name, cat in M.get('add_ne', {}).items():
    hit = None
    for F in (regions, marine, lakes, points, elev):
        for f in F:
            if f['properties'].get('name_en') == name or f['properties'].get('name') == name: hit = (f, f['properties'].get('scalerank', 9)); break
        if hit: break
    if not hit and name in {f['properties'].get('name_en') for _, f in rmin.values()}: q = next(q for q, (sr, f) in rmin.items() if f['properties'].get('name_en') == name); hit = (rmin[q][1], rmin[q][0])
    hit and pick(hit[0], cat, hit[1]) or (hit or print('  add_ne: NE に無い', name))
ne_cnt = collections.Counter(v['category'] for v in sel.values())
# 7) 手動層
for e in M['add']:
    q = e['qid']
    if q in nations and q not in M.get('allow_nation', []): continue   # 手動層でも国の QID は入れない（Cuba・Jamaica…＝島の項目は NE から入る）
    if q in sel: sel[q]['category'] = e.get('category', sel[q]['category']); continue
    r = rmin.get(q)
    if r: lon, lat = rep_point(r[1]['geometry']); sel[q] = dict(category=e['category'], rank=r[0], ne_name=e.get('name'), lon=round(lon, 3), lat=round(lat, 3))
    else: sel[q] = dict(category=e['category'], rank=None, ne_name=e.get('name'), lon=e.get('lon'), lat=e.get('lat'))   # 手動の lon/lat＝Wikidata に座標が無い項目（南海トラフ・楯状地）の位置
drop_q = {d for d in M['drop'] if d.startswith('Q')}; drop_n = {d for d in M['drop'] if not d.startswith('Q')}
for q in list(sel):
    if q in drop_q or sel[q]['ne_name'] in drop_n or q in merged_into: del sel[q]
for k, cat in M['category'].items():
    if k.startswith('Q'): k in sel and sel[k].__setitem__('category', cat)
    else:
        for q, v in sel.items():
            if v['ne_name'] == k: v['category'] = cat
# 8) Wikidata: 英語版記事名（無ければ落とす）と P625 の有無
ids = sorted(sel); wiki = {}; hasCoord = set()
for i in range(0, len(ids), 50):
    v = fetch('https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks|claims&sitefilter=enwiki&ids=' + '|'.join(ids[i:i + 50]))
    for q, e in v.get('entities', {}).items():
        q0 = (e.get('redirects') or {}).get('from') or q   # リダイレクト（旧 QID → 新 QID）は要求した側の QID で受ける
        t = (e.get('sitelinks', {}).get('enwiki') or {}).get('title'); t and wiki.__setitem__(q0, t)
        'P625' in e.get('claims', {}) and hasCoord.add(q0)
    time.sleep(0.2)
nowiki = [(q, sel[q]['category'], sel[q]['ne_name']) for q in ids if q not in wiki]
for q, _, _ in nowiki: del sel[q]
for q in [q for q in sel if wiki[q] in drop_n]: del sel[q]   # enwiki 記事名での除外
# 同じ英語記事に落ちる QID（統合済み項目・NE の別 QID）は rank の小さい方＝先に見つかった方だけ残す
seen_t = {}
for q in sorted(sel, key=lambda q: (sel[q]['rank'] if sel[q]['rank'] is not None else 9)):
    t = wiki[q]
    if t in seen_t: del sel[q]
    else: seen_t[t] = q
# 9) 名前＝enwiki 記事名。同じ基底名（括弧を外した名）に NE 由来と手動由来が並んだら NE 由来（島の項目など）を残す
byb = collections.defaultdict(list)
for q in sel: byb[re.sub(r' \(.*\)$', '', wiki[q])].append(q)
for b, qs in byb.items():
    if len(qs) > 1 and any(sel[q]['rank'] is not None for q in qs):
        for q in qs:
            if sel[q]['rank'] is None: del sel[q]
base = collections.Counter(re.sub(r' \(.*\)$', '', wiki[q]) for q in sel)
for q in sel:
    t = wiki[q]; b = re.sub(r' \(.*\)$', '', t); sel[q]['name'] = (b if base[b] == 1 else t).replace(', Greenland', '')
    sel[q]['coord_src'] = 'wikidata' if q in hasCoord else ('ne' if sel[q]['lon'] is not None else 'NONE')
noloc = [(q, v['category'], v['name']) for q, v in sel.items() if v['coord_src'] == 'NONE']
for q, _, _ in noloc: del sel[q]
# 10) 書き出し（分類の順・rank・名前）
ORDER = ['continent', 'ocean', 'region', 'shield', 'sea', 'bay', 'strait', 'reef', 'island', 'islands', 'peninsula', 'cape', 'isthmus', 'range', 'peak', 'pass', 'plateau', 'plain', 'basin', 'valley', 'desert', 'delta', 'wetland', 'ice', 'lake', 'river', 'waterfall', 'canal', 'trench', 'ridge', 'pole']
rows = sorted(sel.items(), key=lambda t: (ORDER.index(t[1]['category']) if t[1]['category'] in ORDER else 99, t[1]['rank'] if t[1]['rank'] is not None else 9, t[1]['name']))
with open('seed/terrains.csv', 'w', encoding='utf-8', newline='') as f:
    w = csv.writer(f, lineterminator='\n'); w.writerow(['qid', 'category', 'name_en', 'ne_extra', 'axis', 'rank', 'lon', 'lat'])
    for q, v in rows: w.writerow([q, v['category'], v['name'], '|'.join(M['merge'].get(q, [])), M['axis'].get(q, ''), '' if v['rank'] is None else v['rank'], '' if v['lon'] is None else v['lon'], '' if v['lat'] is None else v['lat']])
cnt = collections.Counter(v['category'] for _, v in rows)
print(f"terrains.csv: {len(rows)} 件（NE 閾値 {sum(ne_cnt.values())} + 手動 {len(M['add'])} − 除外/結合/記事なし）")
print('  分類別:', ', '.join(f"{c} {cnt[c]}" for c in ORDER if cnt[c]))
print(f"  enwiki 記事なし＝除外 {len(nowiki)}:", ', '.join(f"{n}({c} {q})" for q, c, n in nowiki))
print(f"  位置なし＝除外 {len(noloc)}:", ', '.join(f"{n}({c})" for _, c, n in noloc))
print(f"  座標が NE 代表点のみ（Wikidata P625 なし）: {sum(1 for _, v in rows if v['coord_src'] == 'ne')} 件")
dup = [n for n, k in collections.Counter(v['name'] for _, v in rows).items() if k > 1]; dup and print('  同名:', dup)
if '--review' in sys.argv:
    for c in ORDER:
        L = [f"{v['name']}[{'' if v['rank'] is None else v['rank']}{'' if v['coord_src'] == 'wikidata' else '·ne'}]" for _, v in rows if v['category'] == c]
        L and print(f"\n## {c} ({len(L)}): " + ', '.join(L))
