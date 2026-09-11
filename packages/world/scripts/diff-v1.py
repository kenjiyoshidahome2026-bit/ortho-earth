# v2 out/ と v1（bucket 実データ）の突合＝移行の取りこぼし検出（一回限り・記録用）
import json, sys
S = sys.argv[1]
V1 = {t['key']: t for t in json.load(open(f'{S}/NationDB.live.json'))}
V2 = {t['key']: t for t in json.load(open('out/NationDB.json'))['items']}
C2 = {c['qid']: c for c in json.load(open('out/CityDB.json'))['items']}
diffs = {}
def d(f, k, a, b): diffs.setdefault(f, []).append((k, a, b))
for k, a in V1.items():
    b = V2.get(k)
    if not b: d('missing', k, a['name']['en'], None); continue
    if (a.get('iso') or None) != (b.get('iso') or None) and not (a.get('iso') and b.get('iso') and a['iso'][:2] == b['iso'][:2]): d('iso', k, a.get('iso'), b.get('iso'))
    if (a.get('ioc') or [None])[0] != b.get('ioc'): d('ioc', k, a.get('ioc'), b.get('ioc'))
    ua = a['un'][0].replace('/', '-') if a.get('un') else None
    if ua != b.get('un'): d('un', k, ua, b.get('un'))
    ca = a['capital']['name']['en'] if a.get('capital') else None; cb = C2[b['capital']]['name'].get('en') if b.get('capital') else None
    if (ca or '').lower().replace('the ', '') != (cb or '').lower().replace('the ', ''): d('capital', k, ca, cb)
    if set(a.get('languages') or []) != set(b.get('languages') or []): d('languages', k, a.get('languages'), b.get('languages'))
    if set(a.get('currency') or []) != set(b.get('currency') or []): d('currency', k, a.get('currency'), b.get('currency'))
    aa, ab = a.get('area') or 0, b.get('area') or 0
    if not (aa and ab and 0.9 < aa / ab < 1.1): d('area', k, aa, ab)
    pa = (a.get('population') or [0, 0])[1]; pb = (b.get('population') or [0, 0])[1]
    if not ((pa == pb) or (pa and pb and 0.9 < pa / pb < 1.1)): d('population', k, a.get('population', [None, None])[:2], b.get('population', [None, None])[:2])
    if bool(a.get('anthem')) != bool(b.get('anthem')): d('anthem', k, bool(a.get('anthem')), bool(b.get('anthem')))
    if set(a.get('sovereignt') or []) != set(b.get('sovereignt') or []): d('sovereignt', k, a.get('sovereignt'), b.get('sovereignt'))
    if set(a.get('claim') or []) != set(b.get('claim') or []): d('claim', k, a.get('claim'), b.get('claim'))
    for f in ['gdp', 'hdi', 'gpi', 'homicide', 'gni']:
        if bool(a.get(f)) != bool(b.get(f)): d(f + '有無', k, bool(a.get(f)), bool(b.get(f)))
for f, v in diffs.items():
    print(f'== {f}: {len(v)}'); [print('   ', x) for x in v[:12]]
print('v2 のみ:', [k for k in V2 if k not in V1])
