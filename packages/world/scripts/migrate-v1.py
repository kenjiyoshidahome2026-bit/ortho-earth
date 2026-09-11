# v1（日本語名結合・ja.wikipedia スクレイピング）→ v2 seed（key/QID・英語基軸）への一回限りの移行。記録のために残す（2026-09-11）
# 入力: bucket の v1 DB（scratchpad に保存済み）＋ Wikidata。出力: seed/*.csv|json
import json, csv, os, sys, re, time, urllib.request, urllib.parse
S = sys.argv[1]; os.chdir(os.path.dirname(os.path.abspath(__file__)) + "/..")
UA = "ortho-earth-migrate/1.0 (kenji.yoshida.home.2026@gmail.com)"
def get(u):
    for i in range(4):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={'User-Agent': UA}), timeout=90))
        except Exception as e: print(' retry', i, e, file=sys.stderr); time.sleep(2 * (i + 1))
def ja2qid(pageids):
    out = {}
    for i in range(0, len(pageids), 50):
        v = get('https://ja.wikipedia.org/w/api.php?format=json&action=query&prop=pageprops&ppprop=wikibase_item&pageids=' + '|'.join(map(str, pageids[i:i + 50])))
        for pid, p in v['query']['pages'].items():
            q = (p.get('pageprops') or {}).get('wikibase_item'); q and out.__setitem__(int(pid), q)
    return out
N = json.load(open(f'{S}/NationDB.live.json')); C = json.load(open(f'{S}/CityDB.live.json'))['items']; K = json.load(open(f'{S}/Conflicts.live.json'))['items']
WD = json.load(open(f'{S}/wd-nations.json'))
qid = {int(k): v for k, v in json.load(open(f'{S}/nation-qids.json'))['qid'].items()}
byJa = {t['name']['ja']: t for t in N}; keyOf = lambda ja: byJa[ja]['key'] if ja in byJa else None
# ── 都市の QID（CityDB 554 + CityDB 未収蔵の首都）
cityIds = sorted({t['wiki']['ja'] for t in C} | {t['capital']['wiki']['ja'] for t in N if t.get('capital') and t['capital'].get('wiki', {}).get('ja')})
cq = ja2qid(cityIds); print('city qid', len(cq), '/', len(cityIds), 'missing', [i for i in cityIds if i not in cq])
# ── 都市 QID の健全性: 曖昧さ回避（P31=Q4167410）は捨てる（v1 は記事名解決で曖昧さ回避ページを掴んでいた）
cityEnt = {}
cqs = sorted(set(cq.values()))
for i in range(0, len(cqs), 50):
    cityEnt.update(get('https://www.wikidata.org/w/api.php?format=json&action=wbgetentities&props=claims&ids=' + '|'.join(cqs[i:i + 50])).get('entities', {}))
def isDisamb(q):
    return any((c.get('mainsnak', {}).get('datavalue', {}).get('value', {}) or {}).get('id') == 'Q4167410' for c in cityEnt.get(q, {}).get('claims', {}).get('P31', []))
bad = {q for q in cqs if isDisamb(q)}; print('曖昧さ回避の都市 QID（捨てる）:', len(bad), sorted(bad)[:20])
# ── Wikidata の「現在の」値（preferred があればそれ・無ければ終了日 P582 の無い normal）
def current(e, p):
    cl = e.get('claims', {}).get(p, []); pref = [c for c in cl if c.get('rank') == 'preferred']
    if pref: cl = pref
    else: cl = [c for c in cl if c.get('rank') == 'normal' and 'P582' not in c.get('qualifiers', {})]
    return [c['mainsnak']['datavalue']['value'] for c in cl if c.get('mainsnak', {}).get('datavalue')]
# ── nations.csv
rows = []; capOverride = {}
for t in N:
    q = qid[t['wiki']['ja']]; e = WD.get(q, {})
    capQ = t.get('capital') and cq.get(t['capital']['wiki']['ja'])
    wdCaps = [v['id'] for v in current(e, 'P36') if isinstance(v, dict)]
    capCol = ''
    if capQ in bad: capQ = None   # v1 が曖昧さ回避を掴んでいた首都＝Wikidata P36 に任せる
    if capQ and (len(wdCaps) != 1 or wdCaps[0] != capQ): capCol = capQ; capOverride[t['key']] = (t['capital']['name']['en'], wdCaps)
    if not capQ and not wdCaps: print('首都未解決（seed の capital 列で明示が必要）:', t['key'], t['name']['en'], t.get('capital', {}).get('name', {}).get('en'))
    rows.append({'key': t['key'], 'qid': q, 'name_en': t['name']['en'], 'official_en': (t.get('extend') or {}).get('en', ''), 'region': t['region'],
                 'territory': keyOf(t['territory']) if t.get('territory') else '', 'conflict': keyOf(t['conflict']) if t.get('conflict') else '', 'capital': capCol})
rows.sort(key=lambda r: r['key'])
with open('seed/nations.csv', 'w', encoding='utf-8', newline='') as f:
    w = csv.DictWriter(f, fieldnames=['key', 'qid', 'name_en', 'official_en', 'region', 'territory', 'conflict', 'capital']); w.writeheader(); w.writerows(rows)
print('nations.csv', len(rows), '| capital 明示', len(capOverride), {k: v for k, v in list(capOverride.items())[:8]})
# ── cities.csv（QID・国 key・首都フラグ）
cities = {}
for t in C:
    q = cq.get(t['wiki']['ja']); ns = t['nation'] if isinstance(t['nation'], list) else [t['nation']]
    n = '|'.join(k for k in map(keyOf, ns) if k)   # 複数国にまたがる都市（v1 は配列）は | 連結
    if not q or not n or q in bad: print('city skip', t['name']['ja'], t['nation'], q); continue
    cities[q] = {'qid': q, 'nation': n, 'capital': 1 if t.get('capital') else ''}
for t in N:   # CityDB に無い首都も収録
    if t.get('capital') and cq.get(t['capital']['wiki']['ja']) and cq[t['capital']['wiki']['ja']] not in cities and cq[t['capital']['wiki']['ja']] not in bad:
        cities[cq[t['capital']['wiki']['ja']]] = {'qid': cq[t['capital']['wiki']['ja']], 'nation': t['key'], 'capital': 1}
with open('seed/cities.csv', 'w', encoding='utf-8', newline='') as f:
    w = csv.DictWriter(f, fieldnames=['qid', 'nation', 'capital']); w.writeheader(); w.writerows(sorted(cities.values(), key=lambda r: (r['nation'], r['qid'])))
print('cities.csv', len(cities))
# ── ja.json（日本語固有: 読み・正式名の "_" 型）
kana = re.compile(r'^[ァ-ヶー]')
ja = {'nations': {}, 'cities': {}}
for t in N:
    d = {}
    if not kana.match(t['name']['ja']) and t.get('yomi'): d['yomi'] = t['yomi']
    if (t.get('extend') or {}).get('ja'): d['official'] = t['extend']['ja']
    if d: ja['nations'][t['key']] = d
for t in C:
    q = cq.get(t['wiki']['ja'])
    if q and t.get('yomi') and not kana.match(t['name']['ja']): ja['cities'][q] = {'yomi': t['yomi']}
json.dump(ja, open('seed/ja.json', 'w'), ensure_ascii=False, indent=1)
print('ja.json nations', len(ja['nations']), 'cities', len(ja['cities']))
# ── capital-notes.json（都市は QID・国は key）
FIX = {'ブジュンブラ': 'Q3854'}   # CityDB 未収蔵の旧首都
cityQ = lambda ja: FIX.get(ja) or next((cq[t['wiki']['ja']] for t in C if t['name']['ja'] == ja and cq.get(t['wiki']['ja'])), None)
notes = {}
for t in N:
    n = t.get('capitalNote'); 
    if not n: continue
    if 'defacto' in n: notes[t['key']] = {'defacto': cityQ(n['defacto'])}
    elif 'changed' in n: notes[t['key']] = {'changed': [n['changed'][0], cityQ(n['changed'][1])]}
    elif 'multi' in n: notes[t['key']] = {'multi': {{'立法': 'legislative', '司法': 'judicial', '行政': 'executive'}[k]: cityQ(v) for k, v in n['multi'].items()}}
    elif 'text' in n: notes[t['key']] = {'text': keyOf(n['text']) or {'スヴァールバル諸島': 'Svalbard'}.get(n['text'], n['text'])}   # 国 key か英語の翻訳キー
json.dump(notes, open('seed/capital-notes.json', 'w'), ensure_ascii=False, indent=1); print('capital-notes', notes)
# ── conflicts.json（v1 の Conflicts に QID を添える・名前は i18n へ）
enIds = [t['wiki']['en'] for t in K if t.get('wiki', {}).get('en')]; kq = {}
for i in range(0, len(enIds), 50):
    v = get('https://en.wikipedia.org/w/api.php?format=json&action=query&prop=pageprops&ppprop=wikibase_item&pageids=' + '|'.join(map(str, enIds[i:i + 50])))
    for pid, p in v['query']['pages'].items():
        q = (p.get('pageprops') or {}).get('wikibase_item'); q and kq.__setitem__(int(pid), q)
# territory＝その係争地が属する海外領土等（v1 の iso 欄）。国側の sovereignt 配列は territory があればそこへ・無ければ sovereignt（主権国）へ付く
conf = [{'key': t['key'], 'qid': kq.get(t.get('wiki', {}).get('en'), ''), 'type': t['type'], 'region': t['region'], 'name_en': t['name']['en'], 'exist': t.get('exist', True),
         'sovereignt': t.get('sovereignt', ''), 'territory': t.get('iso', ''), 'claim': t.get('claim', [])} for t in K]
json.dump(conf, open('seed/conflicts.json', 'w'), ensure_ascii=False, indent=1); print('conflicts', len(conf), 'qid なし', [c['key'] for c in conf if not c['qid']])
# ── overrides.json（コードに散っていた例外表を集約。値は v2 の形）
ov = {}
def add(key, field, value, why): ov.setdefault(key, {})[field] = value; ov[key].setdefault('_why', {})[field] = why
for ja_, v in {"クリッパートン島": [-1, 0], "トケラウ": [2016, 1499], "イギリス領インド洋地域": [-1, 3500], "スヴァールバル諸島およびヤンマイエン島": [-1, 2630],
               "ハード島とマクドナルド諸島": [-1, 0], "ブーベ島": [-1, 0], "フランス領南方・南極地域": [-1, 140], "合衆国領有小離島": [2009, 300], "南ジョージア島・南サンドイッチ諸島": [-1, 0], "南極": [-1, 1000]}.items():
    keyOf(ja_) and add(keyOf(ja_), 'population', v, '無人・非常駐（v1 既定表）')
for ja_, v in {"クリッパートン島": 6, "トケラウ": 10, "アルツァフ共和国": 3170, "ドネツク人民共和国": 8539, "フランス領南方・南極地域": 7781, "米領バージン諸島": 347, "西サハラ": 266000, "オランダ": 37354, "デンマーク": 43094, "ノルウェー": 323802}.items():
    keyOf(ja_) and add(keyOf(ja_), 'area', v, 'v1 の面積既定表（本土のみ等）')
for ja_, v in {"アフガニスタン・イスラム共和国": ["AFN"], "ドネツク人民共和国": ["RUB"], "ルガンスク人民共和国": ["RUB"], "クリミア共和国": ["RUB"], "アルツァフ共和国": ["AMD"], "サハラ・アラブ民主共和国": ["MAD", "DZD"]}.items():
    keyOf(ja_) and add(keyOf(ja_), 'currency', v, '事実上の流通通貨（Kenji 裁定 2026-09-09）')
add('EH', 'languages', ['ar', 'ber', 'es'], '西サハラ（v1 固定値）')
for ja_, v in {"サハラ・アラブ民主共和国": ["B28"], "北キプロス・トルコ共和国": ["B20"], "ソマリランド": ["B30"], "アブハジア": ["B35"], "沿ドニエストル共和国": ["B36"], "南オセチア": ["B37"],
               "アルツァフ共和国": ["B38"], "コソボ": ["B57"], "クリミア共和国": ["B89"], "ドネツク人民共和国": ["C02"], "ルガンスク人民共和国": ["C03"]}.items():
    keyOf(ja_) and add(keyOf(ja_), 'sovereignt', v, '非 ISO 主体の実効支配域（Conflicts の B コード）')
add('AFX', 'claim', ['AF'], 'v1'); add('B28', 'claim', ['B19'], 'SADR の主張域（v1・西サハラの ISO 準拠整理 2026-08-31）')
add('EH', 'sovereignt', ['B19', 'B28'], '西サハラ＝B19（モロッコ実効支配）+B28（自由地帯）。主張は EH に帰属させない')
for k in ['US', 'CA', 'RU', 'UM', 'AQ']: add(k, 'pole', True, '極域を含む（地図描画用）')
add('XK', 'iso', ['XK', 'KSV', 111], 'コソボ＝ISO 未割当の暫定コード（v1）')
json.dump(ov, open('seed/overrides.json', 'w'), ensure_ascii=False, indent=1); print('overrides', len(ov))
