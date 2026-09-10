# 地形.txt（-category 見出し＋ja.wikipedia 記事名・// はコメント行）→ 地形.csv（26 言語名・QID・en 記事名・座標）
# 経路: ja 記事名 → pageid/QID（redirect 解決）→ Wikidata labels（ui.json の言語）+ enwiki sitelink + P625 座標。国名 i18n（createI18N）と同じ手筋
import json, urllib.request, urllib.parse, time, csv, sys, os
os.chdir(os.path.dirname(os.path.abspath(__file__)) + "/..")
UA = "ortho-earth-terrain/1.0 (kenji.yoshida.home.2026@gmail.com)"
def get(u):
    for i in range(4):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA}), timeout=60))
        except Exception as e: print(' retry', i, e, file=sys.stderr); time.sleep(2 * (i + 1))
LANGS = [l['code'] for l in json.load(open('i18n/ui.json'))['langs']]
rows, cat, seen = [], None, set()
for line in open('地形.txt', encoding='utf-8'):
    t = line.strip()
    if not t or t.startswith('//'): continue          # 空行・コメント行
    if t.startswith('-'): cat = t[1:].strip(); continue
    if (cat, t) in seen: print('重複:', cat, t); continue
    seen.add((cat, t)); rows.append({'category': cat, 'ja': t})
titles = [r['ja'] for r in rows]; info = {}
for i in range(0, len(titles), 50):
    b = titles[i:i + 50]
    v = get('https://ja.wikipedia.org/w/api.php?format=json&action=query&redirects=1&prop=pageprops&ppprop=wikibase_item&titles=' + urllib.parse.quote('|'.join(b)))
    red = {x['from']: x['to'] for x in v['query'].get('redirects', [])}; norm = {x['from']: x['to'] for x in v['query'].get('normalized', [])}
    pages = {p['title']: p for p in v['query']['pages'].values()}
    for t in b:
        p = pages.get(red.get(norm.get(t, t), norm.get(t, t)))
        info[t] = {'pageid': p.get('pageid', 0) if p else 0, 'qid': (p.get('pageprops', {}) or {}).get('wikibase_item') if p else None, 'title': p['title'] if p else None}
print('ja 記事なし:', [t for t in titles if not info[t]['pageid']]); print('QID なし:', [t for t in titles if info[t]['pageid'] and not info[t]['qid']])
qids = sorted({info[t]['qid'] for t in titles if info[t]['qid']}); ent = {}
for i in range(0, len(qids), 50):
    ent.update(get('https://www.wikidata.org/w/api.php?format=json&action=wbgetentities&props=labels|sitelinks|claims&languages=' + '|'.join(LANGS) + '&sitefilter=enwiki&ids=' + '|'.join(qids[i:i + 50])).get('entities', {}))
out, missing = [], {l: 0 for l in LANGS}
for r in rows:
    q = info[r['ja']]; e = ent.get(q['qid'] or '', {}); lab = e.get('labels', {}); coord = None
    for c in e.get('claims', {}).get('P625', []):
        dv = c.get('mainsnak', {}).get('datavalue', {}).get('value')
        if dv: coord = (dv['latitude'], dv['longitude']); break
    row = {'category': r['category'], 'qid': q['qid'] or '', 'ja_pageid': q['pageid'] or '', 'en_wiki': (e.get('sitelinks', {}).get('enwiki', {}) or {}).get('title', ''), 'lat': coord[0] if coord else '', 'lon': coord[1] if coord else ''}
    for l in LANGS:
        v = (q['title'] or r['ja']) if l == 'ja' else lab.get(l, {}).get('value', '')
        if not v: missing[l] += 1
        row[l] = v
    out.append(row)
cols = ['category', 'qid', 'ja_pageid', 'en_wiki', 'lat', 'lon'] + LANGS
with open('地形.csv', 'w', encoding='utf-8-sig', newline='') as f:
    w = csv.DictWriter(f, fieldnames=cols); w.writeheader(); w.writerows(out)
print('地形.csv:', len(out), '件 /', {c: sum(1 for r in out if r['category'] == c) for c in dict.fromkeys(r['category'] for r in out)})
print('欠け（言語別）:', {l: n for l, n in missing.items() if n}); print('座標なし:', [r['ja'] for r in out if r['lat'] == ''])
