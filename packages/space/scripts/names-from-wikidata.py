#!/usr/bin/env python3
# 星座名・メシエ天体名の正本（names.json）を Wikidata から組み直す道具（2026-09-19 初版で使用）。
# 普段は使わない＝names.json が正本（手で直してよい）。言語を足す・見出しを取り直す時だけ走らせる。
#   python3 scripts/names-from-wikidata.py <dir>   ＝<dir> に下の 3 本を置いてから
#   wd-const.json   : SELECT ?c ?abbr ?lang ?label WHERE { ?c wdt:P31 wd:Q8928; wdt:P1813 ?abbr . ?c rdfs:label ?label .
#                     BIND(LANG(?label) AS ?lang) FILTER(?lang IN (<26 言語>)) }            （星座＝Q8928・短縮名＝IAU 略号）
#   wd-const2.json  : おひつじ座 Q10584・かに座 Q8849（短縮名の登録が無く上で漏れる）の rdfs:label
#   wd-messier.json : SELECT ?c ?code ?lang ?label WHERE { ?c p:P528 ?st . ?st ps:P528 ?code; pq:P972 wd:Q14530 .
#                     ?c rdfs:label ?label . BIND(LANG(?label) AS ?lang) FILTER(...) }       （メシエ・カタログ Q14530）
#   取得＝https://query.wikidata.org/sparql（Accept: application/sparql-results+json）
# 規則：ja/en/zh/pl と メシエの en/ja/zh は手当て（下の表）・他は Wikidata の見出しから百科事典の曖昧さ回避
# （「(…)」・hu の「csillagkép」）とカタログ番号型（Messier 13 など）を除去・同言語の星座名と同じメシエ見出しは捨てる。
# 取り違えの当て直しは下の「当て直す」行（抜き取り検査で見つけたもの）。
import sys
D = sys.argv[1]
OUT = __file__.rsplit("/scripts/", 1)[0] + "/names.json"
import json, re, unicodedata
L = "en ja zh ko fr de es pt it nl pl ru uk hu sv tr el id vi th bn hi ar fa ur he".split()
# 正（ja＝日本天文学会の標準和名・en＝IAU 名）＝ortho-japan skynames.js の表
T = [(a, v["en"].replace("Boötes", "Bootes"), v["ja"]) for a, v in json.load(open(OUT))["constellations"].items()]   # 正（en/ja）は names.json 自身＝ortho-japan skynames.js の表から写したもの
assert len(T) == 88, len(T)
IAU = {a: la for a, la, ja in T}; IAU["Boo"] = "Boötes"
JA = {a: ja for a, la, ja in T}
ZH = dict(zip([a for a, _, _ in T], "仙女座 唧筒座 天燕座 宝瓶座 天鹰座 天坛座 白羊座 御夫座 牧夫座 雕具座 鹿豹座 巨蟹座 猎犬座 大犬座 小犬座 摩羯座 船底座 仙后座 半人马座 仙王座 鲸鱼座 蝘蜓座 圆规座 天鸽座 后发座 南冕座 北冕座 乌鸦座 巨爵座 南十字座 天鹅座 海豚座 剑鱼座 天龙座 小马座 波江座 天炉座 双子座 天鹤座 武仙座 时钟座 长蛇座 水蛇座 印第安座 蝎虎座 狮子座 小狮座 天兔座 天秤座 豺狼座 天猫座 天琴座 山案座 显微镜座 麒麟座 苍蝇座 矩尺座 南极座 蛇夫座 猎户座 孔雀座 飞马座 英仙座 凤凰座 绘架座 双鱼座 南鱼座 船尾座 罗盘座 网罟座 天箭座 人马座 天蝎座 玉夫座 盾牌座 巨蛇座 六分仪座 金牛座 望远镜座 三角座 南三角座 杜鹃座 大熊座 小熊座 船帆座 室女座 飞鱼座 狐狸座".split()))
PL = dict(zip([a for a, _, _ in T], ["Andromeda", "Pompa", "Ptak Rajski", "Wodnik", "Orzeł", "Ołtarz", "Baran", "Woźnica", "Wolarz", "Rylec", "Żyrafa", "Rak", "Psy Gończe", "Wielki Pies", "Mały Pies", "Koziorożec", "Kil", "Kasjopeja", "Centaur", "Cefeusz", "Wieloryb", "Kameleon", "Cyrkiel", "Gołąb", "Warkocz Bereniki", "Korona Południowa", "Korona Północna", "Kruk", "Puchar", "Krzyż Południa", "Łabędź", "Delfin", "Złota Ryba", "Smok", "Źrebię", "Erydan", "Piec", "Bliźnięta", "Żuraw", "Herkules", "Zegar", "Hydra", "Wąż Wodny", "Indianin", "Jaszczurka", "Lew", "Mały Lew", "Zając", "Waga", "Wilk", "Ryś", "Lutnia", "Góra Stołowa", "Mikroskop", "Jednorożec", "Mucha", "Węgielnica", "Oktant", "Wężownik", "Orion", "Paw", "Pegaz", "Perseusz", "Feniks", "Malarz", "Ryby", "Ryba Południowa", "Rufa", "Kompas", "Sieć", "Strzała", "Strzelec", "Skorpion", "Rzeźbiarz", "Tarcza", "Wąż", "Sekstant", "Byk", "Luneta", "Trójkąt", "Trójkąt Południowy", "Tukan", "Wielka Niedźwiedzica", "Mała Niedźwiedzica", "Żagiel", "Panna", "Ryba Latająca", "Lisek"]))
assert len(ZH) == 88 and len(PL) == 88
wd = {}
for x in json.load(open(f"{D}/wd-const.json"))["results"]["bindings"]:
    a = x["abbr"]["value"]
    if a != "Pomum": wd.setdefault(a, {})[x["lang"]["value"]] = x["label"]["value"]
for x in json.load(open(f"{D}/wd-const2.json"))["results"]["bindings"]:
    a = {"Q10584": "Ari", "Q8849": "Cnc"}[x["c"]["value"].rsplit("/", 1)[1]]
    wd.setdefault(a, {})[x["lang"]["value"]] = x["label"]["value"]
cap = lambda s: s[:1].upper() + s[1:] if s[:1].isalpha() and unicodedata.category(s[0]) == "Ll" else s
def clean_const(l, s):
    s = re.sub(r"\s*\([^)]*\)", "", s).strip()
    if l == "hu": s = re.sub(r"\s+csillagkép$", "", s)
    return cap(s)
C = {}; fb = {}
for a, la, ja in T:
    row = {"en": IAU[a], "ja": JA[a], "zh": ZH[a], "pl": PL[a]}
    for l in L:
        if l in row: continue
        v = wd.get(a, {}).get(l)
        if v: row[l] = clean_const(l, v)
        else: fb.setdefault(l, []).append(a)   # 無い＝IAU 名で埋める（loader 側の既定）
    C[a] = {l: row[l] for l in L if l in row}
# Wikidata の取り違えを当て直す（抜き取り検査で発見 2026-09-19）
C["CMa"]["bn"] = "বৃহৎ কুকুর মণ্ডল"   # Wikidata は「যুগল মণ্ডল」（別物）。こいぬ座（ক্ষুদ্র কুকুর মণ্ডল）と対の形
# メシエ：広く知られた通称だけ。en/ja/zh＝手当て・他＝Wikidata（カタログ番号型の見出しは捨てる）
MESS = {
 "M1": ("Crab Nebula", "かに星雲", "蟹状星云"), "M6": ("Butterfly Cluster", "バタフライ星団", "蝴蝶星团"),
 "M7": ("Ptolemy Cluster", "トレミー星団", "托勒密星团"), "M8": ("Lagoon Nebula", "干潟星雲", "礁湖星云"),
 "M11": ("Wild Duck Cluster", "野鴨星団", "野鸭星团"), "M13": ("Great Hercules Cluster", "ヘルクレス座球状星団", "武仙座球状星团"),
 "M16": ("Eagle Nebula", "わし星雲", "鹰状星云"), "M17": ("Omega Nebula", "オメガ星雲", "欧米茄星云"),
 "M20": ("Trifid Nebula", "三裂星雲", "三叶星云"), "M27": ("Dumbbell Nebula", "亜鈴状星雲", "哑铃星云"),
 "M31": ("Andromeda Galaxy", "アンドロメダ銀河", "仙女座星系"), "M33": ("Triangulum Galaxy", "さんかく座銀河", "三角座星系"),
 "M42": ("Orion Nebula", "オリオン大星雲", "猎户座大星云"), "M44": ("Beehive Cluster", "プレセペ星団", "蜂巢星团"),
 "M45": ("Pleiades", "プレアデス星団", "昴星团"), "M51": ("Whirlpool Galaxy", "子持ち銀河", "涡状星系"),
 "M57": ("Ring Nebula", "環状星雲", "环状星云"), "M63": ("Sunflower Galaxy", "ひまわり銀河", "向日葵星系"),
 "M64": ("Black Eye Galaxy", "黒眼銀河", "黑眼睛星系"), "M76": ("Little Dumbbell Nebula", "小亜鈴状星雲", "小哑铃星云"),
 "M81": ("Bode's Galaxy", "ボーデの銀河", "波德星系"), "M82": ("Cigar Galaxy", "葉巻銀河", "雪茄星系"),
 "M83": ("Southern Pinwheel Galaxy", "南の回転花火銀河", "南风车星系"), "M87": ("Virgo A", "おとめ座A", "室女座A"),
 "M97": ("Owl Nebula", "ふくろう星雲", "猫头鹰星云"), "M101": ("Pinwheel Galaxy", "回転花火銀河", "风车星系"),
 "M104": ("Sombrero Galaxy", "ソンブレロ銀河", "草帽星系"),
}
wm = {}
for x in json.load(open(f"{D}/wd-messier.json"))["results"]["bindings"]:
    code = x["code"]["value"].replace(" ", "")
    wm.setdefault(code, {})[x["lang"]["value"]] = x["label"]["value"]
bad = re.compile(r"messier|mesier|مسي|مسیه|मेसियर|เมซีเย|মেসিয়ার|ngc|^m\s?\d|^hd\b|\d", re.I)
M = {}; mrej = {}
for m, (en, ja, zh) in MESS.items():
    row = {"en": en, "ja": ja, "zh": zh}
    for l in L:
        if l in row: continue
        v = wm.get(m, {}).get(l)
        if v and not bad.search(v): row[l] = cap(re.sub(r"\s*\([^)]*\)", "", v).strip())
        elif v: mrej.setdefault(l, []).append(f"{m}:{v}")
    for l in list(row):   # 同じ言語の星座名と同じ見出し＝星座の項目を指している（ar の M31 など）＝捨てる
        if l not in ("en", "ja", "zh") and any(C[a].get(l) == row[l] for a in C): mrej.setdefault(l, []).append(f"{m}:{row.pop(l)}(=constellation)")
    M[m] = {l: row[l] for l in L if l in row}
M["M31"]["ar"] = "مجرة المرأة المسلسلة"; M["M31"]["ur"] = "اینڈرومیڈا کہکشاں"; M["M42"]["es"] = "Nebulosa de Orión"; M["M31"]["pt"] = "Galáxia de Andrômeda"
prev = json.load(open(OUT))   # 天体（bodies）は Wikidata 由来でない＝そのまま持ち越す
out = {"source": "ja=日本天文学会の標準和名（ortho-japan skynames.js の表から写した）・en=IAU 名・zh/pl=標準名を手当て・メシエの en/ja/zh=手当て・他言語=Wikidata の見出し（2026-09-19 取得・百科事典の曖昧さ回避と カタログ番号型の見出しを除去）。天体（bodies＝太陽・惑星・月・冥王星・衛星 20）＝ortho-solar の UI 辞書（i18n/ui.json・26 言語）から写した。欠けた言語は loader が英語（星座＝IAU 名・メシエ＝英語の通称）に落とす",
       "constellations": C, "messier": M, "bodies": prev.get("bodies", {})}
json.dump(out, open(OUT, "w"), ensure_ascii=False, indent="\t"); open(OUT, "a").write("\n")
print("const fallback:", {l: len(v) for l, v in fb.items()})
for l in L:
    seen = {}
    for a in C:
        v = C[a].get(l)
        if v: seen.setdefault(v, []).append(a)
    d = {v: a for v, a in seen.items() if len(a) > 1}
    if d: print("DUP", l, d)
print("messier coverage:", {l: sum(1 for m in M if l in M[m]) for l in L})
print("messier rejected sample:", {l: v[:3] for l, v in mrej.items()})
