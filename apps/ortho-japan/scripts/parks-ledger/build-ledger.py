import json
raw=json.load(open('parks-raw.json')); prefs=json.load(open('prefs-labels.json'))
bnd=json.load(open('parks-boundary.geojson'))
PREF=",北海道,青森県,岩手県,宮城県,秋田県,山形県,福島県,茨城県,栃木県,群馬県,埼玉県,千葉県,東京都,神奈川県,新潟県,富山県,石川県,福井県,山梨県,長野県,岐阜県,静岡県,愛知県,三重県,滋賀県,京都府,大阪府,兵庫県,奈良県,和歌山県,鳥取県,島根県,岡山県,広島県,山口県,徳島県,香川県,愛媛県,高知県,福岡県,佐賀県,長崎県,熊本県,大分県,宮崎県,鹿児島県,沖縄県".split(",")
code=lambda n: "%02d"%PREF.index(n)
# 公式値（環境省 国立公園一覧・2024）：id, 名称(nps_all), 地方, 陸域面積ha, 指定日, 都道府県
OFF=[
("rishiri-rebun-sarobetsu","利尻礼文サロベツ","hokkaido",24512,"1974-09-20",["北海道"]),
("shiretoko","知床","hokkaido",38954,"1964-06-01",["北海道"]),
("akan-mashu","阿寒摩周","hokkaido",91413,"1934-12-04",["北海道"]),
("kushiro-shitsugen","釧路湿原","hokkaido",28788,"1987-07-31",["北海道"]),
("daisetsuzan","大雪山","hokkaido",226764,"1934-12-04",["北海道"]),
("shikotsu-toya","支笏洞爺","hokkaido",99473,"1949-05-16",["北海道"]),
("hidaka","日高山脈襟裳十勝","hokkaido",245668,"2024-06-25",["北海道"]),
("towada-hachimantai","十和田八幡平","tohoku",85551,"1936-02-01",["青森県","岩手県","秋田県"]),
("sanriku-fukko","三陸復興","tohoku",28539,"2013-05-24",["青森県","岩手県","宮城県"]),
("bandai-asahi","磐梯朝日","tohoku",186389,"1950-09-05",["山形県","福島県","新潟県"]),
("nikko","日光","kanto",114908,"1934-12-04",["福島県","栃木県","群馬県"]),
("oze","尾瀬","kanto",37222,"2007-08-30",["福島県","栃木県","群馬県","新潟県"]),
("joshinetsu-kogen","上信越高原","chubu",148194,"1949-09-07",["群馬県","新潟県","長野県"]),
("chichibu-tama-kai","秩父多摩甲斐","kanto",126259,"1950-07-10",["埼玉県","東京都","山梨県","長野県"]),
("ogasawara","小笠原","kanto",6629,"1972-10-16",["東京都"]),
("fuji-hakone-izu","富士箱根伊豆","kanto",121749,"1936-02-01",["東京都","神奈川県","山梨県","静岡県"]),
("chubu-sangaku","中部山岳","chubu",174323,"1934-12-04",["新潟県","富山県","長野県","岐阜県"]),
("myoko-togakushi","妙高戸隠連山","chubu",39772,"2015-03-27",["新潟県","長野県"]),
("hakusan","白山","chubu",49900,"1962-11-12",["富山県","石川県","福井県","岐阜県"]),
("minami-alps","南アルプス","chubu",35752,"1964-06-01",["山梨県","長野県","静岡県"]),
("ise-shima","伊勢志摩","chubu",55544,"1946-11-20",["三重県"]),
("yoshino-kumano","吉野熊野","kinki",61406,"1936-02-01",["三重県","奈良県","和歌山県"]),
("sanin-kaigan","山陰海岸","kinki",8783,"1963-07-15",["京都府","兵庫県","鳥取県"]),
("setonaikai","瀬戸内海","kinki",67308,"1934-03-16",["大阪府","兵庫県","和歌山県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","福岡県","大分県"]),
("daisen-oki","大山隠岐","chugoku-shikoku",35353,"1936-02-01",["鳥取県","島根県","岡山県"]),
("ashizuri-uwakai","足摺宇和海","chugoku-shikoku",11345,"1972-11-10",["愛媛県","高知県"]),
("saikai","西海","kyushu-okinawa",24646,"1955-03-16",["長崎県"]),
("unzen-amakusa","雲仙天草","kyushu-okinawa",28279,"1934-03-16",["長崎県","熊本県","鹿児島県"]),
("aso-kuju","阿蘇くじゅう","kyushu-okinawa",73017,"1934-12-04",["熊本県","大分県"]),
("kirishima-kinkowan","霧島錦江湾","kyushu-okinawa",36605,"1934-03-16",["宮崎県","鹿児島県"]),
("yakushima","屋久島","kyushu-okinawa",24566,"2012-03-16",["鹿児島県"]),
("amami-gunto","奄美群島","kyushu-okinawa",42196,"2017-03-07",["鹿児島県"]),
("yanbaru","やんばる","kyushu-okinawa",17352,"2016-09-15",["沖縄県"]),
("kerama","慶良間諸島","kyushu-okinawa",3520,"2014-03-05",["沖縄県"]),
("iriomote-ishigaki","西表石垣","kyushu-okinawa",40653,"1972-05-15",["沖縄県"]),
]
byja={p['name']['ja'].replace('国立公園',''):p for p in raw}
bb={}
def walk(c,b):
    if isinstance(c[0],(int,float)):
        b[0]=min(b[0],c[0]);b[1]=min(b[1],c[1]);b[2]=max(b[2],c[0]);b[3]=max(b[3],c[1])
    else:
        for x in c: walk(x,b)
for f in bnd['features']:
    b=[1e9,1e9,-1e9,-1e9];walk(f['geometry']['coordinates'],b);bb[f['properties']['name']]=[round(x,4) for x in b]
out=[];keys=set()
for pid,key,region,ha,date,pf in OFF:
    w=byja[key];keys.add(key)
    ph=w.get('photo') or {}
    out.append({"id":pid,"key":key,"qid":w['qid'],"region":region,"designated":date,"areaHa":ha,"prefs":[code(x) for x in pf],
      "coord":w.get('coord'),"bbox":bb[key],"name":w['name'],"wiki":w['wiki'],"site":w.get('site'),
      "photo":{"src":ph.get('thumb'),"page":ph.get('page'),"artist":ph.get('artist'),"license":ph.get('license'),"licenseUrl":ph.get('licenseUrl')} if ph else None})
assert keys==set(bb), set(bb)-keys
# 都道府県名の表（Wikidata ラベル・ja は PREF の正本）
pt={c:{**v,"ja":PREF[int(c)]} for c,v in prefs.items()}
# 外周 GeoPBF の属性も id を持たせる
id_of={key:pid for pid,key,*_ in OFF}
for f in bnd['features']: f['properties']={"id":id_of[f['properties']['name']],"name":f['properties']['name']}
json.dump(bnd,open('parks-boundary.geojson','w'),ensure_ascii=False)
doc={"_":"日本の国立公園 35 の台帳（parks.html）。名前 26 言語・Wikipedia の頁名＝Wikidata（CC0）／写真＝Wikimedia Commons（各写真の artist/license を表示する義務）／面積（陸域 ha）・指定日・都道府県＝環境省 国立公園一覧（2024）／外周 bbox＝環境省 nps_all（apps/uploader）から zones を溶かした parks.geopbf。生成＝scripts/parks-ledger（scratchpad の fetch-parks.mjs + build-ledger.py を移植したもの）",
 "source":{"boundary":"環境省 環境ジオポータル 国立公園区域等（nps_all／nps_hokkaido）","facts":"環境省 国立公園一覧","names":"Wikidata","photos":"Wikimedia Commons"},
 "prefNames":pt,"parks":out}
json.dump(doc,open('parks.json','w'),ensure_ascii=False,indent=1)
import os;print(len(out),'parks', os.path.getsize('parks.json'),'bytes'); print([p['id'] for p in out if not p['photo'] or not p['photo']['src']])
print(json.dumps(out[6],ensure_ascii=False)[:600])
