#!/usr/bin/env python3
# tests/fixtures/table/make.py ── t-table.mjs の固定資料（python3 標準のみ）。再生成: python3 tests/fixtures/table/make.py
#   sjis.csv   Shift_JIS（cp932）・BOM 無し・経度/緯度列・CRLF
#   book.xlsx  手組みの Excel ブック: sharedStrings（重複文字列の共有）・inlineStr・数値・論理値・数式（キャッシュ値）・空セル・2 シート
import os, zipfile
HERE = os.path.dirname(os.path.abspath(__file__))

open(os.path.join(HERE, "sjis.csv"), "wb").write("名前,経度,緯度,備考\r\n東京駅,139.767125,35.681236,丸の内\r\n大阪駅,135.4959,34.7024,\"梅田,北区\"\r\n".encode("cp932"))

def xlsx():
    ss = ["名前", "lon", "lat", "flag", "memo", "東京", "大阪", "重複"]   # sharedStrings（index で参照）
    def si(i): return f'<c r="{{}}" t="s"><v>{i}</v></c>'
    sheet1 = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>'
        '<row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2"><v>139.767125</v></c><c r="C2"><v>35.681236</v></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="inlineStr"><is><t xml:space="preserve">inline &amp; text</t></is></c></row>'
        '<row r="3"><c r="A3" t="s"><v>6</v></c><c r="B3"><f>B2-4.27</f><v>135.497125</v></c><c r="C3"><v>34.7024</v></c><c r="D3" t="b"><v>0</v></c></row>'
        '<row r="4"><c r="A4" t="s"><v>7</v></c><c r="B4"/><c r="C4"/><c r="E4" t="s"><v>7</v></c></row>'
        '<row r="5"><c r="A5" t="str"><v>nolat</v></c><c r="B5"><v>1</v></c></row>'
        '</sheetData></worksheet>')
    sheet2 = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
              '<row r="1"><c r="A1" t="inlineStr"><is><t>wkt</t></is></c><c r="B1" t="inlineStr"><is><t>n</t></is></c></row>'
              '<row r="2"><c r="A2" t="inlineStr"><is><t>LINESTRING(0 0, 1 1)</t></is></c><c r="B2"><v>7</v></c></row></sheetData></worksheet>')
    sst = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="8" uniqueCount="8">'
           + "".join(f"<si><t>{s}</t></si>" for s in ss) + "</sst>")
    wb = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          '<sheets><sheet name="地点" sheetId="1" r:id="rId1"/><sheet name="Lines" sheetId="2" r:id="rId2"/></sheets></workbook>')
    rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
            '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>'
            '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>')
    ct = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
          '<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
          '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>')
    root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                 '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    path = os.path.join(HERE, "book.xlsx")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n, d in [("[Content_Types].xml", ct), ("_rels/.rels", root_rels), ("xl/workbook.xml", wb), ("xl/_rels/workbook.xml.rels", rels), ("xl/sharedStrings.xml", sst), ("xl/worksheets/sheet1.xml", sheet1), ("xl/worksheets/sheet2.xml", sheet2)]:
            zi = zipfile.ZipInfo(n, date_time=(2026, 9, 12, 0, 0, 0)); zi.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(zi, d)
    print(path, os.path.getsize(path), "bytes")
xlsx()
